/**
 * GET /api/promos/landing — the landing-page offer this visitor holds.
 *
 * Reads the `vyta_lp` cookie `middleware.ts` set when the visitor arrived from
 * a landing page, and answers with the discount code the checkout should put
 * into its discount field, plus what the storefront needs to show it: the
 * percentage, the excluded products and whether it is first-order only.
 *
 * Display only, like every other promo read. `/api/checkout/puramass` reads the
 * same cookie, resolves the same offer and looks the code up against the real
 * cart and buyer before anything is taken off — and applies it even if the
 * browser never put it in the field.
 *
 * `eligible` is false only when we KNOW the offer is not theirs: a signed-in
 * customer who has already ordered. A guest's history is not known until they
 * type an email at checkout, so a guest is shown the offer and it is checked at
 * hand-off.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { LANDING_COOKIE, normalizeLandingSlug } from '@/lib/promos/landing';
import { exclusionsPhrase, productNames, resolveLandingOffer } from '@/lib/promos/landing-server';
import { firstOrderStatus } from '@/lib/promos/first-order';
import { firstOrderRejection, REJECTION_MESSAGES } from '@/lib/affiliate/discount-codes';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(req: NextRequest) {
  const slug = normalizeLandingSlug(req.cookies.get(LANDING_COOKIE)?.value);
  if (!slug) return NextResponse.json({ offer: null }, { headers: NO_STORE });

  const resolved = await resolveLandingOffer(db, slug);
  if (!resolved) return NextResponse.json({ offer: null, slug }, { headers: NO_STORE });
  const { offer } = resolved;

  let eligible = true;
  let reason: string | null = null;
  if (offer.firstOrderOnly) {
    const token = req.headers.get('authorization')?.replace('Bearer ', '');
    if (token) {
      try {
        const { data: { user } } = await db.auth.getUser(token);
        if (user) {
          const rejection = firstOrderRejection(
            await firstOrderStatus(db, { customerId: user.id, email: user.email }),
          );
          if (rejection) {
            eligible = false;
            reason = REJECTION_MESSAGES[rejection];
          }
        }
      } catch {
        /* Unknown is treated as a guest: shown, and checked at hand-off. */
      }
    }
  }

  return NextResponse.json(
    {
      offer: {
        slug: offer.slug,
        code: offer.code,
        percent: offer.percent,
        first_order_only: offer.firstOrderOnly,
        excluded_product_ids: offer.excludedProductIds,
        exclusions: exclusionsPhrase(await productNames(db, offer.excludedProductIds)),
        ends_at: offer.endsAt,
      },
      eligible,
      reason,
    },
    { headers: NO_STORE },
  );
}
