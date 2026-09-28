/**
 * POST /api/landing/<slug>/arrive — count a click-through from a landing page.
 *
 * Sent by the storefront (lib/promos/landing-client.ts) when a page loads with
 * `?lp=<slug>` on its URL: someone pressed the landing page's button and
 * arrived here. Body: `{ first: boolean }` — true when this browser has never
 * arrived through this page before, which makes it a new visitor.
 *
 * Only an anonymous tally is written — one more arrival, maybe one more
 * visitor, for this page today. Nothing identifies the browser, so unlike the
 * per-visitor journey this is recorded whether or not the cookie banner was
 * accepted. That is what makes the Landing Pages report count every visitor.
 *
 * Always 204: a counter must never surface an error on a page that works.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import { normalizeLandingSlug } from '@/lib/promos/landing';
import { bumpLandingCounters } from '@/lib/promos/landing-server';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// A person arrives once; a burst from one IP is a script, and dropping it
// keeps the tally honest.
const LIMIT = { max: 20, windowMs: 60_000 };

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const done = new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  const slug = normalizeLandingSlug((await params).slug);
  if (!slug) return done;
  if (!checkRateLimit(`landing-arrive:${getClientIp(req)}`, LIMIT).allowed) return done;

  const body = await req.json().catch(() => ({}));
  await bumpLandingCounters(db, slug, { arrivals: true, visitors: body?.first === true });
  return done;
}
