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
  /**
   * Anonymous tallies (landing-page-counters-migration.sql): landing page
   * loads, click-throughs to vytabio.com, and browsers arriving for the first
   * time. Null until that migration has run.
   */
  views: number | null;
  clicks: number | null;
  visitors: number | null;
  /** Accounts created during a visit from this page. Null if unreadable. */
  signups: number | null;
  /** Distinct buyers (by email) who reached the payment page from it. */
  checkouts: number;
  /** Distinct buyers with a paid order from it. */
  purchasers: number;
  /** Paid hosted orders frozen to this page. */
  orders: number;
  /** Goods revenue after discounts, by currency, in major units. */
  revenue: Record<string, number>;
  /** Everything taken off those orders, in major units of CAD. */
  discount_given: number;
}

/**
 * Traffic, funnel and revenue per landing page.
 *
 * Nothing here depends on the cookie banner. The first version counted
 * visitors from `visitor_attribution`, which only records an anonymous visitor
 * who pressed Accept — so most landing traffic, and every fresh incognito test,
 * never showed. Now:
 *
 *   • views / clicks / visitors are the anonymous daily tallies, which carry no
 *     identifier and so are kept for everyone;
 *   • sign-ups are `customers.attribution_landing_page`, stamped on the account
 *     at sign-in whatever the consent state;
 *   • checkouts, purchasers, orders and revenue are the hosted-order ledger,
 *     stamped at hand-off whatever the consent state.
 *
 * `countersMissing` is true when the tallies table does not exist yet.
 */
export async function landingStats(
  db: SupabaseClient<any, any, any>,
  slugs: string[],
  since: string | null,
): Promise<{ stats: Map<string, LandingStats>; countersMissing: boolean }> {
  const stats = new Map<string, LandingStats>();
  for (const slug of slugs) {
    stats.set(slug, {
      views: null,
      clicks: null,
      visitors: null,
      signups: null,
      checkouts: 0,
      purchasers: 0,
      orders: 0,
      revenue: {},
      discount_given: 0,
    });
  }
  if (slugs.length === 0) return { stats, countersMissing: false };

  // 1. The tallies. Days are stored in the store's time zone; a range starting
  //    part-way through a day includes that whole day.
  let tallies = db.from('landing_page_daily').select('slug, views, arrivals, visitors').in('slug', slugs);
  if (since) tallies = tallies.gte('day', since.slice(0, 10));
  const { data: dayRows, error: talliesError } = await tallies.limit(20000);
  const countersMissing = !!talliesError;
  if (!talliesError) {
    for (const slug of slugs) Object.assign(stats.get(slug)!, { views: 0, clicks: 0, visitors: 0 });
    for (const row of (dayRows ?? []) as any[]) {
      const s = stats.get(row.slug);
      if (!s) continue;
      s.views! += Number(row.views) || 0;
      s.clicks! += Number(row.arrivals) || 0;
      s.visitors! += Number(row.visitors) || 0;
    }
  }

  // 2. Sign-ups, counted in the database per page.
  await Promise.all(
    slugs.map(async (slug) => {
      let q = db
        .from('customers')
        .select('id', { count: 'exact', head: true })
        .eq('attribution_landing_page', slug);
      if (since) q = q.gte('created_at', since);
      const { count, error } = await q;
      stats.get(slug)!.signups = error ? null : count ?? 0;
    }),
  );

  // 3. The ledger: every hand-off from a landing page, paid or not.
  let orders = db
    .from('puramass_orders')
    .select('id, landing_page, status, customer_email, subtotal_cents, ad_discount_cents, currency')
    .in('landing_page', slugs)
    .limit(20000);
  if (since) orders = orders.gte('created_at', since);
  const { data } = await orders;
  const checkoutEmails = new Map<string, Set<string>>();
  const paidEmails = new Map<string, Set<string>>();
  for (const o of (data ?? []) as any[]) {
    const s = stats.get(o.landing_page);
    if (!s) continue;
    // Distinct by buyer; an order with no email counts on its own.
    const email = String(o.customer_email ?? '').trim().toLowerCase() || `order:${o.id}`;
    if (!checkoutEmails.has(o.landing_page)) checkoutEmails.set(o.landing_page, new Set());
    checkoutEmails.get(o.landing_page)!.add(email);
    if (o.status !== 'paid') continue;
    if (!paidEmails.has(o.landing_page)) paidEmails.set(o.landing_page, new Set());
    paidEmails.get(o.landing_page)!.add(email);
    s.orders += 1;
    const currency = String(o.currency || 'CAD').toUpperCase();
    s.revenue[currency] = (s.revenue[currency] ?? 0) + (Number(o.subtotal_cents) || 0) / 100;
    s.discount_given += (Number(o.ad_discount_cents) || 0) / 100;
  }
  for (const [slug, s] of stats) {
    s.checkouts = checkoutEmails.get(slug)?.size ?? 0;
    s.purchasers = paidEmails.get(slug)?.size ?? 0;
    for (const k of Object.keys(s.revenue)) s.revenue[k] = Math.round(s.revenue[k] * 100) / 100;
    s.discount_given = Math.round(s.discount_given * 100) / 100;
  }
  return { stats, countersMissing };
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
