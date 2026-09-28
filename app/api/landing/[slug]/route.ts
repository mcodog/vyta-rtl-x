/**
 * GET /api/landing/<slug> — the offer a landing page displays.
 *
 * Called from the landing page's own domain, so it is public and answers CORS
 * from anywhere. It is how the page and the checkout stay in agreement: the
 * page prints the `percent` it gets here, and that percentage is the discount
 * code checkout puts into the discount field (lib/promos/landing-server.ts).
 * Change the code in Admin → Landing Pages and the page follows on its next
 * load, with no redeploy of the landing page.
 *
 * What leaves the building is only what the page prints. The code itself is
 * not in the response: the landing page has no use for it, and the storefront
 * reads it from /api/promos/landing for visitors who actually arrive.
 *
 *   200 { ok: true, active: true,  percent: 35, … }  — show the offer
 *   200 { ok: true, active: false, percent: 0,  … }  — page exists, no offer
 *                                                     right now: hide the number
 *   404 { ok: false, active: false, percent: 0 }       — no such landing page
 *
 * A landing page must never print a percentage this endpoint did not return —
 * see LANDING_PAGES.md, "The number on the page".
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import { SITE_URL } from '@/lib/config';
import { formatPercent, landingCtaUrl, normalizeLandingSlug } from '@/lib/promos/landing';
import {
  exclusionsPhrase,
  landingFinePrint,
  loadLandingPage,
  productNames,
  resolveLandingOffer,
} from '@/lib/promos/landing-server';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Generous: one call per landing-page view, and a burst of ad traffic from one
// carrier NAT can share an IP.
const LIMIT = { max: 240, windowMs: 60_000 };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  // Always fresh: a percentage switched off in admin must stop being printed
  // on the next page view, not when a cache expires.
  'Cache-Control': 'no-store, max-age=0',
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const rl = checkRateLimit(`landing:${getClientIp(req)}`, LIMIT);
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: 'Too many requests' },
      { status: 429, headers: { ...CORS, 'Retry-After': String(rl.retryAfter) } },
    );
  }

  const slug = normalizeLandingSlug((await params).slug);
  const notFound = () =>
    NextResponse.json({ ok: false, active: false, percent: 0 }, { status: 404, headers: CORS });
  if (!slug) return notFound();

  const resolved = await resolveLandingOffer(db, slug);
  if (!resolved) {
    // Tell "exists but offers nothing right now" apart from "no such page":
    // the first still has a button to render, the second is a typo in the
    // landing page's config.
    const loaded = await loadLandingPage(db, slug);
    if (!loaded || !loaded.landing.active) return notFound();
    return NextResponse.json(
      {
        ok: true,
        slug,
        active: false,
        percent: 0,
        cta_url: landingCtaUrl(SITE_URL, loaded.landing.destination_path, slug),
      },
      { headers: CORS },
    );
  }

  const { offer, loaded } = resolved;
  const exclusions = exclusionsPhrase(await productNames(db, offer.excludedProductIds));

  return NextResponse.json(
    {
      ok: true,
      slug,
      active: true,
      percent: offer.percent,
      percent_label: formatPercent(offer.percent),
      first_order_only: offer.firstOrderOnly,
      exclusions,
      fine_print: landingFinePrint(offer, exclusions),
      ends_at: offer.endsAt,
      cta_url: landingCtaUrl(SITE_URL, loaded.landing.destination_path, slug),
    },
    { headers: CORS },
  );
}
