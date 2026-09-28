/**
 * Landing pages — an offer made on another domain, honoured here.
 *
 * A landing page lives on its own domain and links to vytabio.com with
 * `?lp=<slug>`. `middleware.ts` turns that into two things:
 *
 *   • `landing_page` on the attribution touch (lib/analytics/attribution.ts),
 *     so the visitor row, the customer row at signup and every hosted order
 *     record which page sent them;
 *   • the `vyta_lp` cookie, which carries the page's OFFER to checkout. The
 *     offer is a discount code (`landing_pages.discount_code_id`); the checkout
 *     puts it into the discount field for the buyer, and `/api/checkout/puramass`
 *     applies it server-side even when the browser never did.
 *
 * Why a separate cookie as well as the touch: the last touch moves forward on
 * every campaign arrival, and the first touch is frozen on the very first one.
 * Neither is "the landing page whose offer this visitor was last shown", which
 * is what checkout has to honour — so that fact gets a cookie of its own.
 *
 * Everything here is pure and isomorphic: the edge middleware imports it, and
 * so do the browser and the API routes. Database reads live in
 * `landing-server.ts`.
 *
 * See LANDING_PAGES.md for the whole flow, and landing-pages-migration.sql for
 * the schema.
 */

/** The query parameter a landing page's button carries. */
export const LANDING_PARAM = 'lp';

/** Cookie holding the slug of the landing page whose offer this visitor holds. */
export const LANDING_COOKIE = 'vyta_lp';

/**
 * 30 days — the same window the affiliate `ref_code` cookie gives a referral.
 * Long enough to cover someone who lands, leaves, and comes back to buy at the
 * end of the week; short enough that a click from last season does not keep
 * discounting.
 */
export const LANDING_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

/**
 * Lower-case letters, digits and dashes, 2–40 long, not starting with a dash.
 * The same CHECK constraint `landing_pages.slug` carries, so a slug that passes
 * here can always be looked up, and one that fails can never exist.
 */
export const LANDING_SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,39}$/;

/**
 * Normalise a slug from a URL, a cookie or an admin form. Returns null for
 * anything that is not a valid slug, so callers can treat "absent" and
 * "garbage" the same way.
 *
 * Only case and surrounding whitespace are forgiven. Rewriting underscores or
 * spaces into dashes would make `lp=my_page` quietly match `my-page`, and a
 * typo in an ad URL is better found in the admin report than papered over.
 */
export function normalizeLandingSlug(raw: unknown): string | null {
  if (raw == null) return null;
  const slug = String(raw).trim().toLowerCase();
  return LANDING_SLUG_REGEX.test(slug) ? slug : null;
}

/**
 * Where a landing page's button should send people: the destination path on
 * this store with `?lp=<slug>` on it. Any other parameters the landing page
 * received (fbclid, gclid, utm_*) are appended by the landing page itself —
 * see LANDING_PAGES.md, "Forward every query parameter".
 */
export function landingCtaUrl(origin: string, destinationPath: string, slug: string): string {
  const path = normalizeDestinationPath(destinationPath);
  const url = new URL(path, origin);
  url.searchParams.set(LANDING_PARAM, slug);
  return url.toString();
}

/**
 * A destination is a path on THIS site, never a full URL: a landing page whose
 * button could be pointed anywhere is an open redirect with our name on it.
 * Anything that is not a plain absolute path falls back to the catalogue.
 */
export function normalizeDestinationPath(raw: unknown): string {
  const path = String(raw ?? '').trim();
  if (!path.startsWith('/') || path.startsWith('//') || /[\s\\]/.test(path)) {
    return '/products';
  }
  return path.slice(0, 200);
}

/**
 * The offer a landing page is making, as the storefront and the landing page
 * see it. Derived from the landing row and its discount code.
 */
export interface LandingOffer {
  slug: string;
  /** Percentage off, 0 when the page offers nothing (or the offer is off). */
  percent: number;
  /** The code the checkout puts into the discount field. */
  code: string | null;
  /** The code is refused to anyone who has ordered before. */
  firstOrderOnly: boolean;
  /** Products the percentage is not taken off. */
  excludedProductIds: string[];
  /** ISO end of the offer, when the code has one. */
  endsAt: string | null;
}

/** Minimal shape of a code row this module needs — keeps it testable. */
export interface LandingCodeFields {
  code: string;
  discount_type: 'percent' | 'fixed';
  discount_value: number | string;
  active: boolean;
  starts_at: string | null;
  expires_at: string | null;
  first_order_only?: boolean | null;
  excluded_product_ids?: string[] | null;
}

/**
 * Is this code usable by anyone at all right now, and for what percentage?
 *
 * Only the facts that are the same for every visitor are checked here —
 * switched on, started, not ended, a percentage. Whether THIS buyer may use it
 * (first order, the cart's minimum, the usage limit) is decided at checkout by
 * `lookupDiscountCode`, against the actual cart and the actual buyer.
 *
 * A landing page promises a percentage, so a fixed-amount code — whose
 * percentage depends on the cart — offers nothing a page could print.
 */
export function landingOfferFrom(
  slug: string,
  code: LandingCodeFields | null | undefined,
  now: number = Date.now(),
): LandingOffer {
  const none: LandingOffer = {
    slug,
    percent: 0,
    code: null,
    firstOrderOnly: false,
    excludedProductIds: [],
    endsAt: null,
  };
  if (!code || !code.active) return none;
  if (code.discount_type !== 'percent') return none;
  if (code.starts_at && Date.parse(code.starts_at) > now) return none;
  if (code.expires_at && Date.parse(code.expires_at) <= now) return none;
  const percent = Math.round((Number(code.discount_value) || 0) * 100) / 100;
  if (!(percent > 0)) return none;
  return {
    slug,
    percent: Math.min(99, percent),
    code: code.code,
    firstOrderOnly: !!code.first_order_only,
    excludedProductIds: Array.isArray(code.excluded_product_ids)
      ? code.excluded_product_ids.filter((id) => typeof id === 'string' && id)
      : [],
    endsAt: code.expires_at ?? null,
  };
}

/** "35%" — or "12.5%" — for copy. */
export function formatPercent(percent: number): string {
  return `${+Number(percent).toFixed(2)}%`;
}

// ---------------------------------------------------------------------------
// Admin input
// ---------------------------------------------------------------------------

/** The offer half of the landing-page form — becomes the page's discount code. */
export interface LandingOfferInput {
  code: string;
  percent: number;
  first_order_only: boolean;
  excluded_product_ids: string[];
  starts_at: string | null;
  expires_at: string | null;
  max_uses: number | null;
}

export interface LandingPageInput {
  slug: string;
  name: string;
  domain: string | null;
  destination_path: string;
  active: boolean;
  notes: string | null;
  /** Null = the page records attribution but offers nothing. */
  offer: LandingOfferInput | null;
}

/**
 * The host a landing page is served from, from whatever an admin pasted:
 * "https://www.GetVyta.ca/offer?x=1" → "www.getvyta.ca". Null when blank or
 * not a hostname.
 */
export function normalizeLandingDomain(raw: unknown): string | null {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return null;
  const host = text.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '');
  return /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ? host : null;
}

/**
 * A code for a landing page's offer when the admin does not type one:
 * "standards" at 35% → "STANDARDS35". Letters and digits only, like every code.
 */
export function suggestLandingCode(slug: string, percent: number): string {
  const stem = String(slug ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24) || 'WELCOME';
  const pct = Math.round(Number(percent) || 0);
  return `${stem}${pct > 0 ? pct : ''}`.slice(0, 32);
}

/**
 * Validate the landing-page form. The discount code rules themselves (format,
 * percentage cap, dates) are applied afterwards by `shapeDiscountCodeInput`, so
 * a landing page's code is held to exactly the rules every other code is.
 */
export function shapeLandingPageInput(
  body: Record<string, unknown>,
): { ok: true; value: LandingPageInput } | { ok: false; error: string } {
  const slug = normalizeLandingSlug(body.slug);
  if (!slug) {
    return {
      ok: false,
      error: 'The slug is 2–40 lower-case letters, numbers or dashes, e.g. "standards".',
    };
  }
  const name = String(body.name ?? '').trim().slice(0, 120);
  if (!name) return { ok: false, error: 'Give the landing page a name.' };

  const domainRaw = String(body.domain ?? '').trim();
  const domain = normalizeLandingDomain(domainRaw);
  if (domainRaw && !domain) return { ok: false, error: 'That domain does not look right, e.g. "getvyta.ca".' };

  const destinationRaw = String(body.destination_path ?? '').trim() || '/products';
  const destination_path = normalizeDestinationPath(destinationRaw);
  if (destination_path !== destinationRaw) {
    return { ok: false, error: 'The destination is a path on this site, e.g. "/products".' };
  }

  const notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null;

  let offer: LandingOfferInput | null = null;
  const rawOffer = body.offer as Record<string, unknown> | null | undefined;
  if (rawOffer && typeof rawOffer === 'object') {
    const percent = Number(rawOffer.percent);
    if (!Number.isFinite(percent) || percent <= 0) {
      return { ok: false, error: 'Enter the percentage the landing page offers.' };
    }
    const maxUsesRaw = rawOffer.max_uses === '' || rawOffer.max_uses == null ? null : Number(rawOffer.max_uses);
    offer = {
      code: String(rawOffer.code ?? '').trim() || suggestLandingCode(slug, percent),
      percent,
      first_order_only: rawOffer.first_order_only !== false,
      excluded_product_ids: Array.isArray(rawOffer.excluded_product_ids)
        ? (rawOffer.excluded_product_ids as unknown[]).map(String)
        : [],
      starts_at: (rawOffer.starts_at as string) || null,
      expires_at: (rawOffer.expires_at as string) || null,
      max_uses: maxUsesRaw == null || !Number.isFinite(maxUsesRaw) ? null : maxUsesRaw,
    };
  }

  return {
    ok: true,
    value: { slug, name, domain, destination_path, active: body.active !== false, notes, offer },
  };
}
