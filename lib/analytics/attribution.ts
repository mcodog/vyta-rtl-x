/**
 * Marketing attribution — what brought a visitor to the site.
 *
 * Isomorphic on purpose: the middleware parses a request URL with it, the
 * browser reads the cookies it wrote, and the admin analytics route classifies
 * stored rows with it. Nothing here touches `window` or `next/server`.
 *
 * The model is two touches per visitor:
 *
 *   first — the campaign that earned the visit. Written once and never
 *           overwritten, so a Google Ads click still gets the credit when the
 *           visitor comes back a week later by typing the domain in.
 *   last  — the most recent non-direct touch, rewritten whenever a new one
 *           arrives. Useful for "what closed the sale" reporting.
 *
 * Both are stored in cookies by `middleware.ts` and copied onto the customer /
 * order rows at signup and checkout, so reporting never has to re-derive them.
 */

import { isValidReferralCodeFormat, normalizeReferralCode } from '@/lib/affiliate/utils';
import { LANDING_PARAM, normalizeLandingSlug } from '@/lib/promos/landing';

/** Ad-network click identifiers, in the order they are checked. */
export const CLICK_ID_PARAMS = [
  'gclid',    // Google Ads
  'gbraid',   // Google Ads, iOS web-to-app
  'wbraid',   // Google Ads, iOS app-to-web
  'fbclid',   // Meta (Facebook / Instagram)
  'msclkid',  // Microsoft Advertising (Bing)
  'ttclid',   // TikTok
  'li_fat_id',// LinkedIn
] as const;

export type ClickIdParam = (typeof CLICK_ID_PARAMS)[number];

/** Standard UTM parameters, stored verbatim (lower-cased). */
export const UTM_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
] as const;

/**
 * The channel taxonomy. Reporting groups by this, so it is deliberately small
 * and stable — campaign-level detail lives in `campaign` alongside it.
 *
 * `*_ads` means paid: a click identifier was present, or the medium says paid.
 * `*_organic` means the visitor arrived from that platform without one.
 */
export const CHANNELS = [
  'google_ads',
  'meta_ads',
  'bing_ads',
  'tiktok_ads',
  'linkedin_ads',
  'other_paid',
  'google_organic',
  'meta_organic',
  'email',
  'affiliate',
  'referral',
  'direct',
] as const;

export type Channel = (typeof CHANNELS)[number];

/** Channels that cost money — the set the ad-spend reporting sums over. */
export const PAID_CHANNELS: readonly Channel[] = [
  'google_ads',
  'meta_ads',
  'bing_ads',
  'tiktok_ads',
  'linkedin_ads',
  'other_paid',
];

export function isPaidChannel(channel: string | null | undefined): boolean {
  return PAID_CHANNELS.includes(channel as Channel);
}

/** A single attribution touch — one arrival at the site. */
export interface AttributionTouch {
  channel: Channel;
  /** utm_source, or the referrer host when there is no UTM tagging. */
  source: string | null;
  medium: string | null;
  campaign: string | null;
  term: string | null;
  content: string | null;
  /** The click identifier that was present, if any. */
  click_id: string | null;
  /** Which parameter it came from — 'gclid', 'fbclid', … */
  click_id_param: ClickIdParam | null;
  /** Referring host only (no path), or null for a direct arrival. */
  referrer_host: string | null;
  /** Path of the page the visitor landed on. Never carries a query string. */
  landing_path: string | null;
  /** Affiliate code from ?ref=, when one rode along on the same URL. */
  ref_code: string | null;
  /**
   * Slug of the off-site landing page that sent this visit (`?lp=`), or null.
   * A dimension alongside the channel, not a channel of its own: the ad that
   * put someone on the landing page is still what `channel` reports, and this
   * says which page it put them on. See lib/promos/landing.ts.
   */
  landing_page: string | null;
  /** ISO timestamp of the touch. */
  at: string;
}

/** Both touches as they are persisted against a visitor. */
export interface VisitorAttribution {
  first: AttributionTouch;
  last: AttributionTouch;
}

const MAX_FIELD = 200;

/** Trim, lower-case and length-cap a query-string value. Empty becomes null. */
function norm(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim().slice(0, MAX_FIELD);
  return trimmed ? trimmed.toLowerCase() : null;
}

/**
 * Click identifiers are opaque and case-sensitive, so they keep their case —
 * only whitespace and length are normalised.
 */
function normClickId(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim().slice(0, MAX_FIELD);
  return trimmed || null;
}

/**
 * Host of a referrer URL, without `www.`. Null for anything unparseable.
 *
 * Only http(s) referrers count. `new URL` happily parses `android-app://` and
 * the like and hands back a package name as the hostname, which would show up
 * in reports as a referring site that does not exist. Those arrivals fall back
 * to whatever UTM tagging the link carried, which is how email and app links
 * are meant to be tracked anyway.
 */
export function referrerHost(referrer: string | null | undefined): string | null {
  if (!referrer) return null;
  try {
    const url = new URL(referrer);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase();
    return host.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** True when the referrer is this site — a same-site navigation, not a touch. */
export function isSelfReferral(referrer: string | null | undefined, selfHost: string | null): boolean {
  const host = referrerHost(referrer);
  if (!host || !selfHost) return false;
  const self = selfHost.toLowerCase().replace(/^www\./, '');
  return host === self || host.endsWith(`.${self}`);
}

/** Media the ad platforms use to mark paid traffic in utm_medium. */
const PAID_MEDIA = new Set([
  'cpc', 'ppc', 'paid', 'paidsearch', 'paid_search', 'paid-search',
  'cpm', 'cpv', 'cpa', 'display', 'banner', 'retargeting', 'remarketing',
  'paidsocial', 'paid_social', 'paid-social',
]);

const EMAIL_MEDIA = new Set(['email', 'e-mail', 'newsletter', 'mail']);

const META_HOSTS = /(^|\.)(facebook|instagram|fb|messenger|threads)\.(com|me|net)$/;
const GOOGLE_HOSTS = /(^|\.)google\.[a-z.]{2,}$/;

/** Source names that mean Meta, however the campaign spelled them. */
const META_SOURCES = new Set([
  'facebook', 'fb', 'instagram', 'ig', 'meta', 'facebook.com', 'instagram.com',
  'audience_network', 'messenger',
]);

const GOOGLE_SOURCES = new Set(['google', 'google.com', 'googleads', 'google_ads', 'adwords']);
const BING_SOURCES = new Set(['bing', 'bing.com', 'microsoft', 'msn']);
const TIKTOK_SOURCES = new Set(['tiktok', 'tiktok.com', 'ttclid']);
const LINKEDIN_SOURCES = new Set(['linkedin', 'linkedin.com']);

/**
 * Decide the channel from the parts of a touch.
 *
 * Click identifiers win outright: a `gclid` is proof of a paid Google click no
 * matter how the campaign tagged (or failed to tag) its UTMs, which is exactly
 * the case auto-tagging produces. Everything below that is inference.
 */
export function classifyChannel(parts: {
  clickIdParam?: ClickIdParam | null;
  source?: string | null;
  medium?: string | null;
  referrerHost?: string | null;
  refCode?: string | null;
}): Channel {
  const source = norm(parts.source);
  const medium = norm(parts.medium);
  const host = norm(parts.referrerHost);

  // 1. A click identifier names the network outright.
  switch (parts.clickIdParam) {
    case 'gclid':
    case 'gbraid':
    case 'wbraid':
      return 'google_ads';
    case 'fbclid':
      return 'meta_ads';
    case 'msclkid':
      return 'bing_ads';
    case 'ttclid':
      return 'tiktok_ads';
    case 'li_fat_id':
      return 'linkedin_ads';
  }

  // 2. UTM tagging that declares itself paid.
  const isPaid = !!medium && PAID_MEDIA.has(medium);
  if (isPaid) {
    if (source && GOOGLE_SOURCES.has(source)) return 'google_ads';
    if (source && META_SOURCES.has(source)) return 'meta_ads';
    if (source && BING_SOURCES.has(source)) return 'bing_ads';
    if (source && TIKTOK_SOURCES.has(source)) return 'tiktok_ads';
    if (source && LINKEDIN_SOURCES.has(source)) return 'linkedin_ads';
    return 'other_paid';
  }

  if (medium && EMAIL_MEDIA.has(medium)) return 'email';
  if (medium === 'affiliate' || parts.refCode) return 'affiliate';

  // 3. Untagged, or tagged non-paid — fall back to where they came from.
  if (source && GOOGLE_SOURCES.has(source)) return 'google_organic';
  if (source && META_SOURCES.has(source)) return 'meta_organic';
  if (host && GOOGLE_HOSTS.test(host)) return 'google_organic';
  if (host && META_HOSTS.test(host)) return 'meta_organic';

  // 4. Any other referrer, or a UTM-tagged link from somewhere untracked.
  if (host || source) return 'referral';
  return 'direct';
}

/**
 * Build a touch from a landing URL and the document referrer.
 *
 * `selfHost` suppresses same-site referrers so internal navigation is not
 * mistaken for a fresh arrival from "our own site".
 */
export function parseTouch(input: {
  url: URL | string;
  referrer?: string | null;
  selfHost?: string | null;
  at?: Date;
}): AttributionTouch {
  const url = typeof input.url === 'string' ? new URL(input.url) : input.url;
  const params = url.searchParams;

  let clickId: string | null = null;
  let clickIdParam: ClickIdParam | null = null;
  for (const name of CLICK_ID_PARAMS) {
    const value = normClickId(params.get(name));
    if (value) {
      clickId = value;
      clickIdParam = name;
      break;
    }
  }

  const selfHost = input.selfHost ?? url.hostname;
  const referrer = isSelfReferral(input.referrer, selfHost) ? null : input.referrer;
  const host = referrerHost(referrer);

  const source = norm(params.get('utm_source'));
  const medium = norm(params.get('utm_medium'));
  const refCode = normalizeReferralCode(params.get('ref')) || null;

  return {
    channel: classifyChannel({
      clickIdParam,
      source,
      medium,
      referrerHost: host,
      refCode,
    }),
    // With no utm_source, the referring host is the most useful stand-in — it
    // is what a report would otherwise show as "(none)".
    source: source ?? host,
    medium,
    campaign: norm(params.get('utm_campaign')),
    term: norm(params.get('utm_term')),
    content: norm(params.get('utm_content')),
    click_id: clickId,
    click_id_param: clickIdParam,
    referrer_host: host,
    landing_path: url.pathname.slice(0, MAX_FIELD) || '/',
    // Measured against the shared format contract, never an inline pattern:
    // a stale `{8}` here silently drops every vanity code from attribution.
    ref_code: refCode && isValidReferralCodeFormat(refCode) ? refCode : null,
    landing_page: normalizeLandingSlug(params.get(LANDING_PARAM)),
    at: (input.at ?? new Date()).toISOString(),
  };
}

/**
 * True when a touch carries real acquisition signal.
 *
 * A direct arrival with no referrer tells us nothing, so it must not overwrite
 * a stored last-touch — otherwise every visitor decays to `direct` the moment
 * they navigate back to the site from a bookmark.
 */
export function isMeaningfulTouch(touch: AttributionTouch): boolean {
  return (
    touch.channel !== 'direct' ||
    !!touch.click_id ||
    !!touch.source ||
    !!touch.campaign ||
    !!touch.ref_code ||
    !!touch.landing_page
  );
}

// ---------------------------------------------------------------------------
// Cookie encoding
// ---------------------------------------------------------------------------

/** Cookie holding the first touch. Written once, never overwritten. */
export const ATTRIBUTION_COOKIE = 'aminocan_attr';
/** Cookie holding the most recent meaningful touch. */
export const ATTRIBUTION_LAST_COOKIE = 'aminocan_attr_last';
/** Cookie holding the anonymous visitor id that ties pre-signup events together. */
export const VISITOR_COOKIE = 'aminocan_vid';
/** Cookie mirroring the consent banner decision so the server can read it. */
export const CONSENT_COOKIE = 'aminocan_consent';

/** ~13 months, the longest a Google Ads click is worth attributing. */
export const ATTRIBUTION_MAX_AGE = 60 * 60 * 24 * 400;

/**
 * Touches are stored as compact JSON with short keys — cookies travel on every
 * request, and the long-form key names roughly double the payload.
 */
const COOKIE_KEYS: Record<string, keyof AttributionTouch> = {
  c: 'channel',
  s: 'source',
  m: 'medium',
  n: 'campaign',
  t: 'term',
  o: 'content',
  i: 'click_id',
  p: 'click_id_param',
  r: 'referrer_host',
  l: 'landing_path',
  f: 'ref_code',
  lp: 'landing_page',
  a: 'at',
};

export function encodeTouch(touch: AttributionTouch): string {
  const compact: Record<string, unknown> = {};
  for (const [short, full] of Object.entries(COOKIE_KEYS)) {
    const value = touch[full];
    if (value != null && value !== '') compact[short] = value;
  }
  return encodeURIComponent(JSON.stringify(compact));
}

export function decodeTouch(raw: string | null | undefined): AttributionTouch | null {
  if (!raw) return null;
  try {
    const compact = JSON.parse(decodeURIComponent(raw));
    if (!compact || typeof compact !== 'object') return null;
    const touch: Record<string, unknown> = {};
    for (const [short, full] of Object.entries(COOKIE_KEYS)) {
      touch[full] = compact[short] ?? null;
    }
    // A cookie without a recognised channel is corrupt or from an older format.
    if (!CHANNELS.includes(touch.channel as Channel)) return null;
    return touch as unknown as AttributionTouch;
  } catch {
    return null;
  }
}

/**
 * Flatten a first/last pair into the `attribution` JSONB column.
 *
 * Kept as one object rather than two dozen columns: the channel and campaign
 * that reporting groups by are promoted to their own columns by the callers,
 * and everything else is detail you read when looking at a single row.
 */
export function toAttributionPayload(
  attribution: Partial<VisitorAttribution>,
  extra?: Record<string, unknown>,
): Record<string, unknown> | null {
  const { first, last } = attribution;
  if (!first && !last) return null;
  return {
    first: first ?? null,
    last: last ?? null,
    ...(extra ?? {}),
  };
}
