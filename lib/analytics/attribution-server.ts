/**
 * Server-side half of marketing attribution.
 *
 * Reads the cookies `middleware.ts` wrote, decides whether the visitor has
 * consented to being recorded, and writes the `visitor_attribution` row that
 * ties a campaign to everything that visitor goes on to do.
 *
 * Every function here is best-effort: attribution is reporting, and a failed
 * write must never take an order or a signup down with it. Callers are not
 * expected to try/catch.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  decodeTouch,
  toAttributionPayload,
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_LAST_COOKIE,
  VISITOR_COOKIE,
  CONSENT_COOKIE,
  type AttributionTouch,
} from './attribution';
import { isMissingColumnError } from '@/lib/payments/puramass-columns';
import { LANDING_COOKIE, normalizeLandingSlug } from '@/lib/promos/landing';

const SESSION_COOKIE = 'aminocan_sid';
const REF_COOKIE = 'ref_code';

/** Minimal shape of what we need from a request — keeps this testable. */
export interface CookieReader {
  get(name: string): { value: string } | undefined;
}

/** Everything the server knows about who is making this request. */
export interface VisitorContext {
  anonymousId: string | null;
  sessionId: string | null;
  first: AttributionTouch | null;
  last: AttributionTouch | null;
  refCode: string | null;
  /**
   * Slug of the landing page whose offer this visitor holds — the `vyta_lp`
   * cookie, validated. Distinct from `first/last.landing_page`: see
   * lib/promos/landing.ts for why the offer has a cookie of its own.
   */
  landingPage: string | null;
}

/** Pull the visitor + attribution cookies off a request. */
export function readVisitorContext(cookies: CookieReader): VisitorContext {
  const value = (name: string) => cookies.get(name)?.value ?? null;
  return {
    anonymousId: value(VISITOR_COOKIE),
    sessionId: value(SESSION_COOKIE),
    first: decodeTouch(value(ATTRIBUTION_COOKIE)),
    last: decodeTouch(value(ATTRIBUTION_LAST_COOKIE)),
    refCode: value(REF_COOKIE),
    landingPage: normalizeLandingSlug(value(LANDING_COOKIE)),
  };
}

/**
 * The landing page to credit for this visitor, if any: the one whose offer
 * they hold, else the one on their first touch, else their last.
 *
 * The offer cookie leads because it is the page they were most recently shown
 * — the one whose promise the order is being placed on.
 */
export function landingPageOf(ctx: VisitorContext): string | null {
  return ctx.landingPage ?? ctx.first?.landing_page ?? ctx.last?.landing_page ?? null;
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/**
 * `tracking_consent_required` is an admin toggle that rarely changes, and this
 * is read on every tracked event — so it is cached briefly rather than turned
 * into a database round trip per page view.
 */
let consentRequiredCache: { value: boolean; at: number } | null = null;
const CONSENT_CACHE_MS = 60_000;

async function isConsentRequired(db: SupabaseClient): Promise<boolean> {
  const now = Date.now();
  if (consentRequiredCache && now - consentRequiredCache.at < CONSENT_CACHE_MS) {
    return consentRequiredCache.value;
  }
  try {
    const { data } = await db
      .from('site_settings')
      .select('tracking_consent_required')
      .limit(1)
      .maybeSingle();
    // Fail closed: if the column or row is missing we assume consent IS
    // required, so an unconfigured install does not record anyone silently.
    const value = data?.tracking_consent_required !== false;
    consentRequiredCache = { value, at: now };
    return value;
  } catch {
    return true;
  }
}

/**
 * May this visitor's behaviour be written to the database?
 *
 * When the consent banner is switched off in Admin → Branding & Tracking,
 * everything is recordable. When it is on, only a visitor who pressed Accept
 * is — the decision reaches the server through the `aminocan_consent` cookie
 * that `SiteTracking` mirrors from localStorage.
 *
 * A signed-in customer is a separate case: they have an account with us and
 * their order history is recorded regardless, so their storefront journey is
 * first-party service data rather than consent-gated analytics.
 */
export async function isTrackingAllowed(
  db: SupabaseClient,
  cookies: CookieReader,
  opts?: { signedIn?: boolean },
): Promise<boolean> {
  if (opts?.signedIn) return true;
  if (!(await isConsentRequired(db))) return true;
  return cookies.get(CONSENT_COOKIE)?.value === 'granted';
}

// ---------------------------------------------------------------------------
// visitor_attribution
// ---------------------------------------------------------------------------

function firstTouchColumns(touch: AttributionTouch | null) {
  if (!touch) return {};
  return {
    first_channel: touch.channel,
    first_source: touch.source,
    first_medium: touch.medium,
    first_campaign: touch.campaign,
    first_term: touch.term,
    first_content: touch.content,
    first_click_id: touch.click_id,
    first_click_param: touch.click_id_param,
    first_referrer: touch.referrer_host,
    first_landing: touch.landing_path,
    first_ref_code: touch.ref_code,
    first_seen_at: touch.at,
    ...(touch.landing_page ? { first_landing_page: touch.landing_page } : {}),
  };
}

function lastTouchColumns(touch: AttributionTouch | null) {
  if (!touch) return {};
  return {
    last_channel: touch.channel,
    last_source: touch.source,
    last_medium: touch.medium,
    last_campaign: touch.campaign,
    last_click_id: touch.click_id,
    last_click_param: touch.click_id_param,
    last_referrer: touch.referrer_host,
    last_landing: touch.landing_path,
    last_seen_at: touch.at,
    ...(touch.landing_page ? { last_landing_page: touch.landing_page } : {}),
  };
}

/** Added by landing-pages-migration.sql — see `writeVisitorRow`. */
const LANDING_VISITOR_COLUMNS = ['first_landing_page', 'last_landing_page'];

function withoutLandingColumns(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!LANDING_VISITOR_COLUMNS.includes(k)) out[k] = v;
  }
  return out;
}

/**
 * Run a `visitor_attribution` write, and if the database does not know the
 * landing-page columns yet, run it again without them.
 *
 * The landing columns are only present on a row when the touch actually came
 * from a landing page, so an unmigrated database costs nothing for anyone
 * else — but for a landing visitor it must not cost the whole attribution row.
 */
async function writeVisitorRow(
  row: Record<string, unknown>,
  write: (row: Record<string, unknown>) => PromiseLike<{ error: unknown }>,
): Promise<void> {
  const { error } = await write(row);
  if (!error || !isMissingColumnError(error)) return;
  const stripped = withoutLandingColumns(row);
  if (Object.keys(stripped).length === Object.keys(row).length) return;
  await write(stripped);
}

/**
 * Ensure a `visitor_attribution` row exists for this visitor.
 *
 * `ignoreDuplicates` makes this insert-if-absent in one statement: the first
 * touch is written exactly once and can never be overwritten by a later visit,
 * which is the whole point of first-touch attribution.
 */
export async function ensureVisitorAttribution(
  db: SupabaseClient,
  ctx: VisitorContext,
): Promise<void> {
  if (!ctx.anonymousId) return;
  try {
    await writeVisitorRow(
      {
        anonymous_id: ctx.anonymousId,
        ...firstTouchColumns(ctx.first ?? ctx.last),
        ...lastTouchColumns(ctx.last ?? ctx.first),
      },
      (row) =>
        db
          .from('visitor_attribution')
          .upsert(row, { onConflict: 'anonymous_id', ignoreDuplicates: true }),
    );
  } catch {
    /* attribution is reporting — never fail the caller */
  }
}

/** Move the last-touch forward on an existing visitor row. */
export async function refreshLastTouch(
  db: SupabaseClient,
  ctx: VisitorContext,
): Promise<void> {
  if (!ctx.anonymousId || !ctx.last) return;
  const anonymousId = ctx.anonymousId;
  try {
    await writeVisitorRow(
      { ...lastTouchColumns(ctx.last), updated_at: new Date().toISOString() },
      (row) => db.from('visitor_attribution').update(row).eq('anonymous_id', anonymousId),
    );
  } catch {
    /* best-effort */
  }
}

/** Funnel milestones, each stamped at most once per visitor. */
export type VisitorMilestone = 'signed_up_at' | 'checkout_at' | 'purchased_at';

/**
 * Stamp a milestone, without clobbering an earlier one — `is(column, null)`
 * makes the update a no-op once it is already set, so the reported time is
 * always the first time the visitor reached that step.
 */
export async function stampVisitorMilestone(
  db: SupabaseClient,
  anonymousId: string | null | undefined,
  milestone: VisitorMilestone,
  patch?: Record<string, unknown>,
): Promise<void> {
  if (!anonymousId) return;
  try {
    await db
      .from('visitor_attribution')
      .update({ [milestone]: new Date().toISOString(), updated_at: new Date().toISOString(), ...(patch ?? {}) })
      .eq('anonymous_id', anonymousId)
      .is(milestone, null);
  } catch {
    /* best-effort */
  }
}

/**
 * The three columns every attributed row carries, derived from the visitor's
 * cookies. Spread straight into an insert.
 *
 * Channel and campaign come from the FIRST touch: the campaign that earned the
 * visitor is the one the acquisition report should credit for their revenue.
 * The last touch travels along inside the JSONB for anyone who wants to look.
 */
export function attributionColumns(ctx: VisitorContext): {
  attribution_channel: string | null;
  attribution_campaign: string | null;
  attribution: Record<string, unknown> | null;
} {
  const primary = ctx.first ?? ctx.last;
  return {
    attribution_channel: primary?.channel ?? null,
    attribution_campaign: primary?.campaign ?? null,
    attribution: toAttributionPayload(
      { first: ctx.first ?? undefined, last: ctx.last ?? undefined },
      ctx.anonymousId ? { anonymous_id: ctx.anonymousId, session_id: ctx.sessionId } : undefined,
    ),
  };
}

// ---------------------------------------------------------------------------
// Resolving a visitor to a person
// ---------------------------------------------------------------------------

/**
 * Attach an email (and optionally a customer) to a visitor.
 *
 * The email is what makes hosted-checkout purchases attributable: Stealth Health
 * owns that payment page, so the only thing that comes back through the
 * webhook or the poller is an email address. Recording it here at checkout
 * time is what lets `attributeEmailPurchase` close the loop later.
 */
export async function linkVisitorIdentity(
  db: SupabaseClient,
  anonymousId: string | null | undefined,
  identity: { email?: string | null; customerId?: string | null },
): Promise<void> {
  if (!anonymousId) return;
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (identity.email) patch.customer_email = identity.email.trim().toLowerCase();
  if (identity.customerId) patch.customer_id = identity.customerId;
  if (Object.keys(patch).length === 1) return;
  try {
    await db.from('visitor_attribution').update(patch).eq('anonymous_id', anonymousId);
  } catch {
    /* best-effort */
  }
}

/**
 * Mark the visitor(s) behind an email address as having purchased.
 *
 * Called when a payment is confirmed off-site — the hosted-checkout webhook or
 * the poller — where an email is all we have to go on. A visitor may have more
 * than one row against the same email (two devices, cleared cookies), so this
 * stamps every match rather than picking one; the acquisition report counts
 * distinct visitors, so a duplicate does not double-count revenue.
 *
 * Returns the first-touch channel found, if any, so the caller can stamp it
 * onto the order row too.
 */
export async function attributeEmailPurchase(
  db: SupabaseClient,
  email: string | null | undefined,
): Promise<{ channel: string | null; campaign: string | null } | null> {
  const normalized = String(email ?? '').trim().toLowerCase();
  if (!normalized) return null;
  try {
    const { data } = await db
      .from('visitor_attribution')
      .select('anonymous_id, first_channel, first_campaign, purchased_at, first_seen_at')
      .eq('customer_email', normalized)
      .order('first_seen_at', { ascending: true })
      .limit(20);

    const rows = data ?? [];
    if (rows.length === 0) return null;

    const now = new Date().toISOString();
    const unstamped = rows.filter((r: any) => !r.purchased_at).map((r: any) => r.anonymous_id);
    if (unstamped.length > 0) {
      await db
        .from('visitor_attribution')
        .update({ purchased_at: now, updated_at: now })
        .in('anonymous_id', unstamped);
    }

    // Earliest touch wins — that is the visit that originally won the customer.
    const earliest = rows[0] as any;
    return {
      channel: earliest.first_channel ?? null,
      campaign: earliest.first_campaign ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Close the attribution loop on a hosted-checkout payment.
 *
 * The buyer paid on Stealth Health's domain, so nothing about the click that brought
 * them in travels with the confirmation — the webhook and the poller both see
 * only a ledger row and an email. Called from each of them when an order flips
 * to `paid`.
 *
 * Two things happen: the visitor(s) behind that email are marked as having
 * purchased, and if the ledger row somehow has no channel of its own (a
 * checkout that predates this feature, or one started with cookies blocked)
 * the channel found by the email join is backfilled onto it.
 *
 * Best-effort throughout: a payment is confirmed whether or not we can say
 * which ad produced it.
 */
export async function attributeHostedPurchase(
  db: SupabaseClient,
  order: { id: string; customer_email?: string | null; attribution_channel?: string | null },
): Promise<void> {
  try {
    const found = await attributeEmailPurchase(db, order.customer_email);
    if (!found?.channel || order.attribution_channel) return;
    await db
      .from('puramass_orders')
      .update({
        attribution_channel: found.channel,
        attribution_campaign: found.campaign,
      })
      .eq('id', order.id)
      .is('attribution_channel', null);
  } catch {
    /* best-effort */
  }
}
