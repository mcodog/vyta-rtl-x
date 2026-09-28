/**
 * Shared by the Admin → Landing Pages routes: turning a landing page's offer
 * into its discount code, and the funnel each page has produced.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  hasRestrictions,
  RESTRICTIONS_NEED_MIGRATION,
  shapeDiscountCodeInput,
  shapeDiscountCodeRow,
  withoutRestrictions,
  type DiscountCodeRow,
} from '@/lib/affiliate/discount-codes';
import { isMissingColumnError } from '@/lib/payments/puramass-columns';
import { SITE_URL } from '@/lib/config';
import { landingCtaUrl, landingOfferFrom, type LandingOfferInput } from '@/lib/promos/landing';
import type { LandingPageRow } from '@/lib/promos/landing-server';

export const MIGRATION_MESSAGE =
  'Run landing-pages-migration.sql in the Supabase SQL editor to enable landing pages.';

/** 42P01 = undefined table: landing-pages-migration.sql has not been run. */
export function isMissingTable(error: { code?: string; message?: string } | null | undefined): boolean {
  return !!error && (error.code === '42P01' || /landing_pages/.test(error.message ?? ''));
}

/**
 * The discount-code row a landing page's offer becomes. Validated by the same
 * `shapeDiscountCodeInput` every code goes through, so a landing page cannot
 * create a code the Discount Codes page would refuse.
 */
export function offerToCode(slug: string, offer: LandingOfferInput) {
  return shapeDiscountCodeInput({
    code: offer.code,
    affiliate_id: null,
    discount_type: 'percent',
    discount_value: offer.percent,
    commission_rate: null,
    min_subtotal: null,
    max_uses: offer.max_uses,
    starts_at: offer.starts_at,
    expires_at: offer.expires_at,
    active: true,
    notes: `Offer for the "${slug}" landing page.`,
    first_order_only: offer.first_order_only,
    excluded_product_ids: offer.excluded_product_ids,
  });
}

type Write = (row: Record<string, unknown>) => PromiseLike<{ data: any; error: any }>;

/**
 * Run a discount_codes write, retrying without the restriction columns on an
 * install that does not have them yet — unless a restriction was actually
 * asked for, in which case the admin is told to run the migration instead of
 * getting a looser code than they set.
 */
export async function writeCode(
  row: Record<string, unknown>,
  write: Write,
): Promise<{ data: any; error: any; message?: string; status?: number }> {
  let result = await write(row);
  if (result.error && isMissingColumnError(result.error)) {
    if (hasRestrictions(row as any)) {
      return { data: null, error: result.error, message: RESTRICTIONS_NEED_MIGRATION, status: 400 };
    }
    result = await write(withoutRestrictions(row));
  }
  if (result.error?.code === '23505') {
    return { ...result, message: `${row.code} is already used by another discount code.`, status: 409 };
  }
  return result;
}

export interface LandingStats {
  /** Distinct visitors whose first or last touch came from this page. */
  visitors: number | null;
  signups: number | null;
  checkouts: number | null;
  purchasers: number | null;
  /** Paid hosted orders frozen to this page. */
  orders: number;
  /** Goods revenue after discounts, by currency, in major units. */
  revenue: Record<string, number>;
  /** Everything taken off those orders, in major units of CAD. */
  discount_given: number;
}

/**
 * Funnel and revenue per landing page.
 *
 * Visitors are counted from `visitor_attribution`, which only records people
 * who accepted cookies (or everyone, when the banner is off) — so these are a
 * floor, the same caveat as the Acquisition tab. Orders are exact: every hosted
 * order is stamped with its landing page at hand-off whatever the consent
 * state, because the ledger row is order data, not analytics.
 */
export async function landingStats(
  db: SupabaseClient<any, any, any>,
  slugs: string[],
  since: string | null,
): Promise<Map<string, LandingStats>> {
  const stats = new Map<string, LandingStats>();
  for (const slug of slugs) {
    stats.set(slug, {
      visitors: null,
      signups: null,
      checkouts: null,
      purchasers: null,
      orders: 0,
      revenue: {},
      discount_given: 0,
    });
  }
  if (slugs.length === 0) return stats;

  // Counted in the database: a landing page with real ad spend behind it can
  // have tens of thousands of visitor rows, and none of them need to travel.
  const count = async (slug: string, milestone: string | null): Promise<number | null> => {
    // Slugs are [a-z0-9-] by constraint, so they are safe inside an or() filter.
    let q = db
      .from('visitor_attribution')
      .select('anonymous_id', { count: 'exact', head: true })
      .or(`first_landing_page.eq.${slug},last_landing_page.eq.${slug}`);
    if (since) q = q.gte('last_seen_at', since);
    if (milestone) q = q.not(milestone, 'is', null);
    const { count: n, error } = await q;
    return error ? null : n ?? 0;
  };

  await Promise.all(
    slugs.map(async (slug) => {
      const [visitors, signups, checkouts, purchasers] = await Promise.all([
        count(slug, null),
        count(slug, 'signed_up_at'),
        count(slug, 'checkout_at'),
        count(slug, 'purchased_at'),
      ]);
      Object.assign(stats.get(slug)!, { visitors, signups, checkouts, purchasers });
    }),
  );

  let orders = db
    .from('puramass_orders')
    .select('landing_page, subtotal_cents, ad_discount_cents, currency')
    .in('landing_page', slugs)
    .eq('status', 'paid')
    .limit(10000);
  if (since) orders = orders.gte('created_at', since);
  const { data } = await orders;
  for (const o of (data ?? []) as any[]) {
    const s = stats.get(o.landing_page);
    if (!s) continue;
    s.orders += 1;
    const currency = String(o.currency || 'CAD').toUpperCase();
    s.revenue[currency] = (s.revenue[currency] ?? 0) + (Number(o.subtotal_cents) || 0) / 100;
    s.discount_given += (Number(o.ad_discount_cents) || 0) / 100;
  }
  for (const s of stats.values()) {
    for (const k of Object.keys(s.revenue)) s.revenue[k] = Math.round(s.revenue[k] * 100) / 100;
    s.discount_given = Math.round(s.discount_given * 100) / 100;
  }
  return stats;
}

/** A landing row as Admin → Landing Pages shows it. */
export function presentLanding(
  landing: LandingPageRow,
  code: DiscountCodeRow | null,
  stats: LandingStats | undefined,
) {
  const shaped = code ? shapeDiscountCodeRow(code) : null;
  const offer = landingOfferFrom(landing.slug, shaped);
  return {
    ...landing,
    code: shaped
      ? {
          id: shaped.id,
          code: shaped.code,
          discount_type: shaped.discount_type,
          percent: Number(shaped.discount_value),
          first_order_only: shaped.first_order_only,
          excluded_product_ids: shaped.excluded_product_ids,
          starts_at: shaped.starts_at,
          expires_at: shaped.expires_at,
          max_uses: shaped.max_uses,
          active: shaped.active,
        }
      : null,
    // What the landing page is printing right now: the page must be on, and
    // its code live and a percentage.
    live_percent: landing.active ? offer.percent : 0,
    cta_url: landingCtaUrl(SITE_URL, landing.destination_path, landing.slug),
    api_url: `${SITE_URL}/api/landing/${landing.slug}`,
    stats: stats ?? null,
  };
}
