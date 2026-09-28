/**
 * Server-side half of landing pages: reading a landing page and its offer.
 *
 * Both readers of an offer go through `resolveLandingOffer`:
 *
 *   • GET /api/landing/<slug>  — the landing page itself, on its own domain,
 *     reads the percentage it prints from here;
 *   • GET /api/promos/landing  — the storefront reads the code it puts into
 *     the checkout's discount field from here;
 *
 * and `/api/checkout/puramass` resolves the same offer again at hand-off. So
 * the figure on the landing page, the code in the field and the money taken
 * off all come from one row — the discount code the landing page points at.
 *
 * Fails closed throughout: a missing table (landing-pages-migration.sql not
 * run), an inactive page or a read error all mean "no offer".
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { shapeDiscountCodeRow, type DiscountCodeRow } from '@/lib/affiliate/discount-codes';
import { landingOfferFrom, normalizeLandingSlug, type LandingOffer } from './landing';

export interface LandingPageRow {
  id: string;
  slug: string;
  name: string;
  domain: string | null;
  destination_path: string;
  discount_code_id: string | null;
  active: boolean;
  notes: string | null;
  created_at: string;
  updated_at?: string;
}

export interface LoadedLandingPage {
  landing: LandingPageRow;
  code: (DiscountCodeRow & { first_order_only: boolean; excluded_product_ids: string[] }) | null;
}

/** A landing page and its discount code, or null when there is no such page. */
export async function loadLandingPage(
  db: SupabaseClient<any, any, any>,
  rawSlug: unknown,
): Promise<LoadedLandingPage | null> {
  const slug = normalizeLandingSlug(rawSlug);
  if (!slug) return null;
  try {
    const { data, error } = await db.from('landing_pages').select('*').eq('slug', slug).maybeSingle();
    if (error || !data) return null;
    const landing = data as LandingPageRow;
    if (!landing.discount_code_id) return { landing, code: null };
    const { data: code, error: codeError } = await db
      .from('discount_codes')
      .select('*')
      .eq('id', landing.discount_code_id)
      .maybeSingle();
    if (codeError || !code) return { landing, code: null };
    return { landing, code: shapeDiscountCodeRow(code as DiscountCodeRow) };
  } catch {
    return null;
  }
}

/**
 * The offer a landing page is making right now, or null when it makes none —
 * no such page, the page is switched off, it has no code, or the code is off,
 * not started, ended or not a percentage.
 *
 * Only facts that hold for every visitor are checked. Whether a particular
 * buyer may use it is `lookupDiscountCode`'s job, at checkout.
 */
export async function resolveLandingOffer(
  db: SupabaseClient<any, any, any>,
  rawSlug: unknown,
  now: number = Date.now(),
): Promise<{ offer: LandingOffer; loaded: LoadedLandingPage } | null> {
  const loaded = await loadLandingPage(db, rawSlug);
  if (!loaded || !loaded.landing.active) return null;
  const offer = landingOfferFrom(loaded.landing.slug, loaded.code, now);
  if (!(offer.percent > 0) || !offer.code) return null;
  return { offer, loaded };
}

/** Names of the products an offer excludes, for its fine print. */
export async function productNames(
  db: SupabaseClient<any, any, any>,
  ids: string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  try {
    const { data } = await db.from('products').select('id, name').in('id', ids);
    return ((data ?? []) as { name: string | null }[])
      .map((p) => String(p.name ?? '').trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

const BAC_WATER = /bacteriostatic|bac[\s-]?water/i;

/**
 * Excluded products as one phrase for the fine print: every bacteriostatic
 * water size collapses to "bacteriostatic water" (there are four, and "*excl.
 * Bacteriostatic Water 3mL, Bacteriostatic Water 10mL, …" helps nobody), and
 * anything else is named, up to three, then counted.
 */
export function exclusionsPhrase(names: string[]): string | null {
  const bac = names.filter((n) => BAC_WATER.test(n));
  const rest = names.filter((n) => !BAC_WATER.test(n));
  const parts = [...(bac.length ? ['bacteriostatic water'] : []), ...rest];
  if (parts.length === 0) return null;
  if (parts.length <= 3) {
    return parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  }
  return `${parts.slice(0, 3).join(', ')} and ${parts.length - 3} more`;
}

/**
 * The asterisk under the headline, built from the offer itself so it cannot
 * say something checkout does not do: "*First order only. Excludes
 * bacteriostatic water."
 */
export function landingFinePrint(offer: LandingOffer, exclusions: string | null): string | null {
  const parts: string[] = [];
  if (offer.firstOrderOnly) parts.push('First order only');
  if (exclusions) parts.push(`Excludes ${exclusions}`);
  if (offer.endsAt) {
    const date = new Date(offer.endsAt);
    if (!Number.isNaN(date.getTime())) {
      parts.push(
        `Ends ${date.toLocaleDateString('en-CA', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Toronto' })}`,
      );
    }
  }
  return parts.length ? `*${parts.join('. ')}.` : null;
}
