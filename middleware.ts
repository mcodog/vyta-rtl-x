import { NextRequest, NextResponse } from 'next/server';
import {
  parseTouch,
  isMeaningfulTouch,
  encodeTouch,
  decodeTouch,
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_LAST_COOKIE,
  ATTRIBUTION_MAX_AGE,
  VISITOR_COOKIE,
} from '@/lib/analytics/attribution';
import { isValidReferralCodeFormat, normalizeReferralCode } from '@/lib/affiliate/utils';
import {
  LANDING_COOKIE,
  LANDING_COOKIE_MAX_AGE,
  LANDING_PARAM,
  normalizeLandingSlug,
} from '@/lib/promos/landing';

const REF_COOKIE = 'ref_code';
const REF_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/** Per-visit id. No max-age — it dies with the browser session, which is the point. */
const SESSION_COOKIE = 'aminocan_sid';

/**
 * All four cookies are first-party, readable by client JS (the checkout reads
 * them to stamp an order) and never shared with a third party. They carry no
 * personal data — an opaque id and the campaign that produced the visit.
 */
const COOKIE_BASE = { path: '/', sameSite: 'lax' as const, httpOnly: false };

function randomId(): string {
  // crypto.randomUUID is available in the edge runtime middleware runs in.
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * Middleware runs on every storefront request and is the only place that sees
 * a visitor's very first landing URL — by the time React hydrates, a
 * client-side navigation may already have replaced it. It does three things:
 *
 *   1. mints the anonymous visitor + session ids the activity log is keyed by;
 *   2. records the first and last marketing touch (Google Ads gclid, Meta
 *      fbclid, UTM tagging, referring host) as cookies;
 *   3. keeps the existing affiliate `?ref=` capture;
 *   4. remembers which off-site landing page (`?lp=`) sent the visitor, so its
 *      offer can be put into the checkout's discount field (lib/promos/landing.ts).
 *
 * Only `?ref=` is stripped from the URL. `gclid` and friends are deliberately
 * left in place: Google's own conversion linker and GA4 auto-tagging read them
 * from the address bar, and removing them breaks Ads reporting — the thing
 * this is meant to support.
 *
 * Note on consent: these cookies are set on arrival, before the banner is
 * answered, exactly as the pre-existing `ref_code` cookie already was. What
 * consent gates is persistence — nothing is written to the database until
 * `isTrackingAllowed` in lib/analytics/attribution-server.ts says so.
 */
export function middleware(req: NextRequest) {
  const url = req.nextUrl;
  const ref = url.searchParams.get('ref');
  // The format lives in lib/affiliate/utils. An inline `{8}` here would drop
  // the cookie for every vanity code with no error anywhere, and the affiliate
  // would simply never be credited.
  const refCode = ref ? normalizeReferralCode(ref) : null;
  const validRef = !!refCode && isValidReferralCodeFormat(refCode);

  // A valid ?ref= is stripped from the address bar, which means a redirect.
  // Everything else continues, with cookies attached to the passthrough.
  let response: NextResponse;
  if (validRef) {
    const clean = url.clone();
    clean.searchParams.delete('ref');
    response = NextResponse.redirect(clean);
    // First referrer wins — never overwrite an existing affiliate cookie.
    if (!req.cookies.get(REF_COOKIE)) {
      response.cookies.set(REF_COOKIE, refCode!, {
        ...COOKIE_BASE,
        maxAge: REF_COOKIE_MAX_AGE,
      });
    }
  } else {
    response = NextResponse.next();
  }

  // 1. Visitor id — the key every anonymous event is recorded against, and
  //    what ties a pre-signup journey to the account it eventually becomes.
  if (!req.cookies.get(VISITOR_COOKIE)) {
    response.cookies.set(VISITOR_COOKIE, randomId(), {
      ...COOKIE_BASE,
      maxAge: ATTRIBUTION_MAX_AGE,
    });
  }
  if (!req.cookies.get(SESSION_COOKIE)) {
    response.cookies.set(SESSION_COOKIE, randomId(), COOKIE_BASE);
  }

  // 2. Attribution. Parse against the *original* URL, so a ?ref= redirect does
  //    not lose the affiliate code before it is classified.
  const touch = parseTouch({
    url: new URL(url.toString()),
    referrer: req.headers.get('referer'),
    selfHost: url.hostname,
  });

  // A visit with no acquisition signal (typed the domain, opened a bookmark)
  // must not overwrite anything — otherwise every returning visitor decays to
  // `direct` and the campaign that won them loses the credit.
  if (isMeaningfulTouch(touch)) {
    const encoded = encodeTouch(touch);
    // First touch is written once, for the life of the cookie.
    if (!decodeTouch(req.cookies.get(ATTRIBUTION_COOKIE)?.value)) {
      response.cookies.set(ATTRIBUTION_COOKIE, encoded, {
        ...COOKIE_BASE,
        maxAge: ATTRIBUTION_MAX_AGE,
      });
    }
    // Last touch always moves forward.
    response.cookies.set(ATTRIBUTION_LAST_COOKIE, encoded, {
      ...COOKIE_BASE,
      maxAge: ATTRIBUTION_MAX_AGE,
    });
  }

  // 3. Landing page. The most recent one wins — unlike the affiliate cookie —
  //    because this cookie carries an OFFER, and the offer checkout honours
  //    must be the one the visitor was most recently shown. Which page first
  //    won them is kept separately, on the first touch above.
  //
  //    Re-set on every landing arrival, so a repeat click restarts the 30 days.
  //    Such a request already writes the last-touch cookie above, so this adds
  //    no Set-Cookie to a response that would otherwise have been cacheable.
  //
  //    Left in the address bar: it is harmless there, GA4 sees it, and
  //    stripping it would cost a redirect on the one request an ad is paying
  //    for.
  const landing = normalizeLandingSlug(url.searchParams.get(LANDING_PARAM));
  if (landing) {
    response.cookies.set(LANDING_COOKIE, landing, {
      ...COOKIE_BASE,
      maxAge: LANDING_COOKIE_MAX_AGE,
    });
  }

  return response;
}

export const config = {
  // Run on all pages except Next.js internals and static files.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/).*)'],
};
