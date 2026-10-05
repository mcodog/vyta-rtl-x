/**
 * Discount codes — admin-created checkout codes, optionally assigned to an
 * affiliate who then earns commission on every paid order that uses one.
 *
 * Distinct from a referral code (`referral_codes`): that is a tracking link,
 * one per affiliate, captured from `?ref=`, and it takes nothing off. A
 * discount code is typed at checkout and takes a configurable amount off.
 *
 * Everything that decides money lives here as pure functions so the checkout
 * route, the preview endpoint and the tests all measure the same way.
 * See affiliate-discount-codes-payouts-migration.sql for the schema.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { MAX_DISCOUNT_PERCENT } from '../promos/cart-offer';
import { firstOrderStatus, type FirstOrderStatus } from '../promos/first-order';

export type DiscountType = 'percent' | 'fixed';

export interface DiscountCodeRow {
  id: string;
  code: string;
  affiliate_id: string | null;
  discount_type: DiscountType;
  discount_value: number;
  commission_rate: number | null;
  min_subtotal: number | null;
  max_uses: number | null;
  starts_at: string | null;
  expires_at: string | null;
  active: boolean;
  notes: string | null;
  created_at: string;
  updated_at?: string;
  /**
   * Refused to a buyer who has ordered before (landing-pages-migration.sql).
   * Absent until that migration runs, which reads as false.
   */
  first_order_only?: boolean | null;
  /** Products the code takes nothing off. Absent/empty = the whole cart. */
  excluded_product_ids?: string[] | null;
}

/**
 * The columns every install has. Reads use `select('*')` instead, so the
 * restriction columns below come back once they exist without a query that
 * names them failing on an install that has not run the migration yet — and
 * `shapeDiscountCodeRow` defaults them when they are absent.
 */
export const DISCOUNT_CODE_COLUMNS =
  'id, code, affiliate_id, discount_type, discount_value, commission_rate, min_subtotal, max_uses, starts_at, expires_at, active, notes, created_at, updated_at';

/** Added by landing-pages-migration.sql. */
export const DISCOUNT_CODE_RESTRICTION_COLUMNS = ['first_order_only', 'excluded_product_ids'] as const;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A clean, de-duplicated list of product ids. Anything not a UUID is dropped. */
export function normalizeProductIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const value of raw) {
    const id = String(value ?? '').trim().toLowerCase();
    if (UUID_REGEX.test(id)) out.add(id);
    if (out.size >= 500) break;
  }
  return [...out];
}

/** Fill in the restriction fields an unmigrated row does not carry. */
export function shapeDiscountCodeRow<T extends Partial<DiscountCodeRow>>(
  row: T,
): T & { first_order_only: boolean; excluded_product_ids: string[] } {
  return {
    ...row,
    first_order_only: !!row.first_order_only,
    excluded_product_ids: normalizeProductIds(row.excluded_product_ids ?? []),
  };
}

/** The input sets a restriction an unmigrated database has nowhere to store. */
export function hasRestrictions(input: Partial<DiscountCodeInput>): boolean {
  return input.first_order_only === true || (input.excluded_product_ids?.length ?? 0) > 0;
}

/** The same write, minus the restriction columns. */
export function withoutRestrictions<T extends Record<string, unknown>>(input: T): T {
  const out: Record<string, unknown> = { ...input };
  for (const column of DISCOUNT_CODE_RESTRICTION_COLUMNS) delete out[column];
  return out as T;
}

/** Said to an admin who sets a restriction before the migration has run. */
export const RESTRICTIONS_NEED_MIGRATION =
  'Run landing-pages-migration.sql in the Supabase SQL editor to use first-order-only codes and product exclusions.';

/**
 * The part of a subtotal a code applies to: every line whose product is not
 * excluded. `amount` is the line's list total, in whatever unit the caller
 * counts in (CAD in the browser, cents at the hand-off).
 */
export function eligibleSubtotal(
  lines: { productId: string; amount: number }[],
  excludedProductIds: readonly string[] | null | undefined,
): number {
  const excluded = new Set((excludedProductIds ?? []).map((id) => String(id).toLowerCase()));
  return lines.reduce(
    (sum, line) =>
      excluded.has(String(line.productId).toLowerCase()) ? sum : sum + (Number(line.amount) || 0),
    0,
  );
}

export const DISCOUNT_CODE_REGEX = /^[A-Z0-9]{3,32}$/;

/** Hosted orders in these states have been paid for and count as a use. */
export const PAID_ORDER_STATUSES = ['paid'];

/** Uppercase and strip everything that is not [A-Z0-9]. Same rule as referral codes. */
export function normalizeDiscountCode(raw: unknown): string {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function numOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function dateOrNull(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export interface DiscountCodeInput {
  code: string;
  affiliate_id: string | null;
  discount_type: DiscountType;
  discount_value: number;
  commission_rate: number | null;
  min_subtotal: number | null;
  max_uses: number | null;
  starts_at: string | null;
  expires_at: string | null;
  active: boolean;
  notes: string | null;
  /**
   * Only present when the payload carried the field. A full edit from a form
   * that predates these fields must leave them as they are, not reset them to
   * "any order, whole cart" — which on a landing page's code would silently
   * turn a first-order welcome offer into a standing discount.
   */
  first_order_only?: boolean;
  excluded_product_ids?: string[];
}

/**
 * Validate an admin's create/edit payload into the row shape. Returns the
 * first problem as a sentence the admin can act on.
 */
export function shapeDiscountCodeInput(
  body: Record<string, unknown>,
): { ok: true; value: DiscountCodeInput } | { ok: false; error: string } {
  const code = normalizeDiscountCode(body.code);
  if (!DISCOUNT_CODE_REGEX.test(code)) {
    return { ok: false, error: 'Codes are 3-32 letters or numbers.' };
  }

  const discount_type: DiscountType = body.discount_type === 'fixed' ? 'fixed' : 'percent';
  const discount_value = numOrNull(body.discount_value);
  if (discount_value === null || discount_value <= 0) {
    return { ok: false, error: 'Enter how much the code takes off.' };
  }
  if (discount_type === 'percent' && discount_value > MAX_DISCOUNT_PERCENT) {
    return { ok: false, error: `A percentage discount can be at most ${MAX_DISCOUNT_PERCENT}%.` };
  }

  const commission_rate = numOrNull(body.commission_rate);
  if (commission_rate !== null && (commission_rate < 0 || commission_rate > 100)) {
    return { ok: false, error: 'Commission rate must be between 0 and 100%.' };
  }

  const min_subtotal = numOrNull(body.min_subtotal);
  if (min_subtotal !== null && min_subtotal < 0) {
    return { ok: false, error: 'Minimum order cannot be negative.' };
  }

  const maxUsesRaw = numOrNull(body.max_uses);
  const max_uses = maxUsesRaw === null ? null : Math.round(maxUsesRaw);
  if (max_uses !== null && max_uses <= 0) {
    return { ok: false, error: 'Usage limit must be at least 1, or blank for unlimited.' };
  }

  const starts_at = dateOrNull(body.starts_at);
  const expires_at = dateOrNull(body.expires_at);
  if (starts_at && expires_at && Date.parse(expires_at) <= Date.parse(starts_at)) {
    return { ok: false, error: 'The end date must be after the start date.' };
  }

  const affiliateRaw = typeof body.affiliate_id === 'string' ? body.affiliate_id.trim() : '';
  const notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null;

  return {
    ok: true,
    value: {
      code,
      affiliate_id: affiliateRaw || null,
      discount_type,
      discount_value: round2(discount_value),
      commission_rate: commission_rate === null ? null : round2(commission_rate),
      min_subtotal: min_subtotal ? round2(min_subtotal) : null,
      max_uses,
      starts_at,
      expires_at,
      active: body.active !== false,
      notes,
      ...('first_order_only' in body ? { first_order_only: body.first_order_only === true } : {}),
      ...('excluded_product_ids' in body
        ? { excluded_product_ids: normalizeProductIds(body.excluded_product_ids) }
        : {}),
    },
  };
}

export type DiscountCodeRejection =
  | 'not-found'
  | 'inactive'
  | 'not-started'
  | 'expired'
  | 'used-up'
  | 'below-minimum'
  | 'own-code'
  | 'first-order-only'
  | 'first-order-unverified'
  | 'nothing-eligible';

export const REJECTION_MESSAGES: Record<DiscountCodeRejection, string> = {
  'not-found': "That code isn't valid.",
  inactive: 'That code is no longer active.',
  'not-started': "That code isn't active yet.",
  expired: 'That code has expired.',
  'used-up': 'That code has reached its usage limit.',
  'below-minimum': 'Your order is below the minimum for that code.',
  'own-code': "You can't use your own affiliate code.",
  'first-order-only': 'That code is for first orders only.',
  'first-order-unverified': "We couldn't check that code right now. Please try again.",
  'nothing-eligible': "That code doesn't apply to the items in your cart.",
};

/** Map a first-order check onto a rejection, or null when the code may apply. */
export function firstOrderRejection(status: FirstOrderStatus): DiscountCodeRejection | null {
  switch (status) {
    case 'first':
      return null;
    case 'ordered':
      return 'first-order-only';
    default:
      return 'first-order-unverified';
  }
}

export type DiscountCodeEvaluation =
  | { ok: true; percent: number }
  | { ok: false; reason: DiscountCodeRejection };

/**
 * Is this code usable on this cart, and for what percentage off?
 *
 * The hosted order can only take money off by lowering line prices, so every
 * code is expressed as a percentage of the list subtotal — a fixed amount is
 * converted here. Capped at MAX_DISCOUNT_PERCENT: a zero line price is read
 * by Stealth Health as "use your own price" and charged at full list.
 */
export function evaluateDiscountCode(
  code: Pick<
    DiscountCodeRow,
    'discount_type' | 'discount_value' | 'min_subtotal' | 'max_uses' | 'starts_at' | 'expires_at' | 'active' | 'affiliate_id'
  > &
    Partial<Pick<DiscountCodeRow, 'first_order_only' | 'excluded_product_ids'>>,
  ctx: {
    subtotal: number;
    usesCount: number;
    now?: number;
    customerId?: string | null;
    /**
     * The part of `subtotal` the code applies to — the lines whose product it
     * does not exclude. Defaults to the whole subtotal. A fixed amount is
     * converted against THIS, since that is what it is taken off.
     */
    eligibleSubtotal?: number;
    /**
     * For a first-order-only code: where this buyer stands. Omitted means not
     * known yet — a guest previewing a code before typing their email — and is
     * let through, because `/api/checkout/puramass` always checks it for real
     * (it has the email by then) before any money is decided.
     */
    firstOrder?: FirstOrderStatus;
  },
): DiscountCodeEvaluation {
  const now = ctx.now ?? Date.now();
  if (!code.active) return { ok: false, reason: 'inactive' };
  if (code.starts_at && Date.parse(code.starts_at) > now) return { ok: false, reason: 'not-started' };
  if (code.expires_at && Date.parse(code.expires_at) <= now) return { ok: false, reason: 'expired' };
  if (code.max_uses != null && ctx.usesCount >= code.max_uses) return { ok: false, reason: 'used-up' };
  if (code.affiliate_id && ctx.customerId && code.affiliate_id === ctx.customerId) {
    return { ok: false, reason: 'own-code' };
  }

  if (code.first_order_only && ctx.firstOrder !== undefined) {
    const rejection = firstOrderRejection(ctx.firstOrder);
    if (rejection) return { ok: false, reason: rejection };
  }

  const subtotal = Number(ctx.subtotal) || 0;
  if (code.min_subtotal && subtotal < Number(code.min_subtotal)) {
    return { ok: false, reason: 'below-minimum' };
  }

  // A code that excludes products must have something left to apply to — a
  // cart of nothing but excluded items would otherwise report "applied" and
  // take nothing off.
  const eligible =
    ctx.eligibleSubtotal === undefined ? subtotal : Math.max(0, Number(ctx.eligibleSubtotal) || 0);
  if ((code.excluded_product_ids?.length ?? 0) > 0 && subtotal > 0 && eligible <= 0) {
    return { ok: false, reason: 'nothing-eligible' };
  }

  const value = Number(code.discount_value) || 0;
  let percent: number;
  if (code.discount_type === 'fixed') {
    if (eligible <= 0) return { ok: false, reason: 'below-minimum' };
    percent = (value / eligible) * 100;
  } else {
    percent = value;
  }
  percent = Math.min(MAX_DISCOUNT_PERCENT, Math.max(0, Math.round(percent * 100) / 100));
  if (percent <= 0) return { ok: false, reason: 'not-found' };
  return { ok: true, percent };
}

/** Human label: "15% off" / "$20.00 off". */
export function describeDiscount(code: Pick<DiscountCodeRow, 'discount_type' | 'discount_value'>): string {
  const v = Number(code.discount_value) || 0;
  return code.discount_type === 'fixed' ? `$${v.toFixed(2)} off` : `${+v.toFixed(2)}% off`;
}

/** How many paid hosted orders have used this code. */
export async function countDiscountCodeUses(db: SupabaseClient, codeId: string): Promise<number> {
  const { count, error } = await db
    .from('puramass_orders')
    .select('id', { count: 'exact', head: true })
    .eq('discount_code_id', codeId)
    .in('status', PAID_ORDER_STATUSES);
  if (error) {
    console.error('[discount-codes] use count failed:', error.message);
    return 0;
  }
  return count ?? 0;
}

export type DiscountCodeLookup =
  | {
      ok: true;
      /** The row, with the restriction fields defaulted when unmigrated. */
      code: DiscountCodeRow & { first_order_only: boolean; excluded_product_ids: string[] };
      /** Percentage off the ELIGIBLE lines. */
      percent: number;
    }
  | { ok: false; reason: DiscountCodeRejection; message: string };

/**
 * Find a code and decide whether it applies. Fails closed: a missing table
 * (migration not run) or any read error reads as "not a valid code", so the
 * buyer is charged list price rather than a discount nobody configured.
 *
 * A code assigned to an affiliate who has been switched off is inactive —
 * the same rule `resolveAffiliateAttribution` applies to referral codes.
 *
 * `lines` lets the lookup measure a code that excludes products against the
 * lines it actually applies to. Without them the whole subtotal is eligible,
 * which is only right for a code with no exclusions — so the hand-off always
 * passes them.
 *
 * For a first-order-only code the buyer's history is checked by `customerId`
 * and `email`. With neither (a guest previewing before typing an email) the
 * check is deferred, not skipped: see `evaluateDiscountCode`.
 */
export async function lookupDiscountCode(
  db: SupabaseClient,
  raw: unknown,
  ctx: {
    subtotal: number;
    customerId?: string | null;
    email?: string | null;
    lines?: { productId: string; amount: number }[];
  },
): Promise<DiscountCodeLookup> {
  const reject = (reason: DiscountCodeRejection): DiscountCodeLookup => ({
    ok: false,
    reason,
    message: REJECTION_MESSAGES[reason],
  });

  const normalized = normalizeDiscountCode(raw);
  if (!DISCOUNT_CODE_REGEX.test(normalized)) return reject('not-found');

  try {
    // `*`, not DISCOUNT_CODE_COLUMNS: see the note on that constant.
    const { data, error } = await db
      .from('discount_codes')
      .select('*')
      .eq('code', normalized)
      .maybeSingle();
    if (error || !data) return reject('not-found');
    const code = shapeDiscountCodeRow(data as unknown as DiscountCodeRow);

    if (code.affiliate_id) {
      const { data: owner } = await db
        .from('affiliates')
        .select('active')
        .eq('id', code.affiliate_id)
        .maybeSingle();
      if (owner && owner.active === false) return reject('inactive');
    }

    const usesCount = code.max_uses != null ? await countDiscountCodeUses(db, code.id) : 0;
    const firstOrder =
      code.first_order_only && (ctx.customerId || ctx.email)
        ? await firstOrderStatus(db, { customerId: ctx.customerId, email: ctx.email })
        : undefined;
    const result = evaluateDiscountCode(code, {
      subtotal: ctx.subtotal,
      usesCount,
      customerId: ctx.customerId ?? null,
      eligibleSubtotal: ctx.lines ? eligibleSubtotal(ctx.lines, code.excluded_product_ids) : undefined,
      firstOrder,
    });
    if (!result.ok) return reject(result.reason);
    return { ok: true, code, percent: result.percent };
  } catch (err) {
    console.error('[discount-codes] lookup threw:', err);
    return reject('not-found');
  }
}
