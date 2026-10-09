/**
 * Affiliate economics — discount + commission rates and referral attribution.
 *
 * Both the customer discount and the affiliate commission are 10% of the
 * (discounted) subtotal. Attribution prefers a bound customer over a raw
 * referral code, and never credits a self-referral.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export const AFFILIATE_DISCOUNT_RATE = 0.10;
export const AFFILIATE_COMMISSION_RATE = 0.10;

/** Round to 2 decimal places. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface AffiliateAttribution {
  affiliateId: string;
  referralCodeId: string | null;
  referralCode: string | null;
  /**
   * Percentage override from the affiliate discount code the referral link
   * carried (see `resolveReferralCodeOwner`); null = the affiliate's own rate.
   */
  commissionRate?: number | null;
}

/**
 * The form a captured code is looked up in: exactly as entered, only trimmed
 * and upper-cased (every stored code is upper case). Nothing is stripped or
 * corrected, so "PALM-BELLA10" never quietly becomes "PALMBELLA10".
 */
export function referralLookupCode(raw: string | null | undefined): string {
  return (raw ?? '').trim().toUpperCase();
}

/** Who a `?ref=` code belongs to, and how it was recognised. */
export interface ReferralCodeOwner {
  affiliateId: string;
  /**
   * - `referral_code`: a live `referral_codes` row — the normal case.
   * - `discount_code`: an affiliate's discount code handed out as a `?ref=`
   *   link. It took nothing off (the cookie never reaches the discount field),
   *   but it names the affiliate as plainly as their referral code does.
   */
  via: 'referral_code' | 'discount_code';
  /** The code as stored. */
  code: string;
  /** The affiliate's live referral code row, when they have one. */
  referralCodeId: string | null;
  /** Percentage override on a matched discount code; null otherwise. */
  commissionRate: number | null;
}

/**
 * Resolve a referral code captured at checkout to the affiliate it names.
 *
 * The `ref_code` cookie is whatever `?ref=` carried, unvalidated, and
 * affiliates often share their discount code as a referral link
 * (`?ref=PALMBELLA10` instead of `?discount=`). Matching only `referral_codes`
 * dropped those sales on the floor. So, in order:
 *
 *   1. an active `referral_codes` row;
 *   2. an active, affiliate-assigned `discount_codes` row.
 *
 * Exact matches only (see `referralLookupCode`): no punctuation stripped, no
 * near-misses, no codes the affiliate has since given up. The owner must still
 * be an active affiliate. Never throws; null = nobody.
 */
export async function resolveReferralCodeOwner(
  db: SupabaseClient,
  raw: string | null | undefined,
): Promise<ReferralCodeOwner | null> {
  const code = referralLookupCode(raw);
  if (!code) return null;

  let owner: ReferralCodeOwner | null = null;
  try {
    // (1) A live referral code.
    const { data: ref } = await db
      .from('referral_codes')
      .select('id, code, affiliate_id, active')
      .eq('code', code)
      .eq('active', true)
      .limit(1)
      .maybeSingle();
    if (ref?.affiliate_id) {
      owner = {
        affiliateId: ref.affiliate_id,
        via: 'referral_code',
        code: ref.code ?? code,
        referralCodeId: ref.id ?? null,
        commissionRate: null,
      };
    }

    // (2) An affiliate's discount code, shared as a referral link.
    if (!owner) {
      const { data: dc } = await db
        .from('discount_codes')
        .select('id, code, affiliate_id, commission_rate, active')
        .eq('code', code)
        .limit(1)
        .maybeSingle();
      if (dc?.affiliate_id && dc.active !== false) {
        const rate = dc.commission_rate == null ? null : Number(dc.commission_rate);
        owner = {
          affiliateId: dc.affiliate_id,
          via: 'discount_code',
          code: dc.code ?? code,
          referralCodeId: null,
          commissionRate: rate != null && Number.isFinite(rate) ? rate : null,
        };
      }
    }

    if (!owner) return null;

    // A code is only honoured while the affiliate who owns it is active.
    // Without this a switched-off partner's code still books a commission
    // nobody intends to pay.
    const { data: affiliate } = await db
      .from('affiliates')
      .select('active')
      .eq('id', owner.affiliateId)
      .maybeSingle();
    if (!affiliate || affiliate.active === false) return null;

    // Credit lands on the affiliate's live referral code (its uses_count and
    // history), whichever code the buyer actually arrived with.
    if (!owner.referralCodeId) {
      const { data: live } = await db
        .from('referral_codes')
        .select('id')
        .eq('affiliate_id', owner.affiliateId)
        .eq('active', true)
        .limit(1)
        .maybeSingle();
      owner.referralCodeId = live?.id ?? null;
    }
    return owner;
  } catch (err) {
    console.error('[affiliate] resolving referral code %s failed:', code, err);
    return null;
  }
}

/**
 * Resolve which affiliate (if any) should be credited for a customer's order.
 *
 * Priority:
 *   1. Bound customer — `customers.affiliate_id`. If that affiliate has an
 *      active referral code, it is credited too.
 *   2. Referral code — see `resolveReferralCodeOwner` for what counts.
 *
 * Self-referral (the buying customer is also the affiliate) is rejected.
 */
export async function resolveAffiliateAttribution(
  db: SupabaseClient,
  { customerId, referralCode }: { customerId?: string | null; referralCode?: string | null },
): Promise<AffiliateAttribution | null> {
  // (1) Bound customer wins.
  if (customerId) {
    const { data: customer } = await db
      .from('customers')
      .select('affiliate_id')
      .eq('id', customerId)
      .single();

    if (customer?.affiliate_id && customer.affiliate_id !== customerId) {
      const { data: code } = await db
        .from('referral_codes')
        .select('id, code')
        .eq('affiliate_id', customer.affiliate_id)
        .eq('active', true)
        .limit(1)
        .maybeSingle();

      return {
        affiliateId: customer.affiliate_id,
        referralCodeId: code?.id ?? null,
        referralCode: code?.code ?? null,
      };
    }
  }

  // (2) Fall back to the referral code the buyer arrived with.
  if (referralCode) {
    const owner = await resolveReferralCodeOwner(db, referralCode);
    if (owner && owner.affiliateId !== customerId) {
      return {
        affiliateId: owner.affiliateId,
        referralCodeId: owner.referralCodeId,
        referralCode: owner.code,
        commissionRate: owner.commissionRate,
      };
    }
  }

  return null;
}

/**
 * Normalise a stored commission rate to a fraction.
 *
 * `affiliates.commission_rate` is written both ways in this codebase — the
 * create-affiliate route stores a fraction (0.10), older rows and the admin
 * form store a percentage (10) — and the affiliates list already reads it
 * defensively the same way. Anything <= 1 is a fraction; anything above is a
 * percentage. A missing or nonsensical value falls back to the standard rate.
 */
export function normalizeCommissionRate(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return AFFILIATE_COMMISSION_RATE;
  const fraction = n <= 1 ? n : n / 100;
  // A rate above 100% is a data error, not an instruction to pay it out.
  return fraction > 1 ? AFFILIATE_COMMISSION_RATE : fraction;
}

export interface RecordCommissionInput {
  /** The invoice the sale materialised as. Hosted checkout has no orders row. */
  invoiceId: string;
  /** Goods subtotal in cents, excluding shipping and tax. */
  subtotalCents?: number | null;
  customerId?: string | null;
  referralCode?: string | null;
  /**
   * The discount code the buyer typed at checkout, if any. A code assigned to
   * an affiliate is explicit attribution for this order and outranks both the
   * bound customer and the referral cookie.
   */
  discountCodeId?: string | null;
}

interface DiscountCodeCredit {
  affiliateId: string;
  discountCodeId: string;
  /** Percentage override on the code; null = the affiliate's own rate. */
  commissionRate: number | null;
}

/**
 * The affiliate a discount code credits, if it credits anyone. Self-use is
 * refused at checkout already; it is re-checked here because this is where
 * the money is booked.
 */
async function resolveDiscountCodeCredit(
  db: SupabaseClient,
  discountCodeId: string | null | undefined,
  customerId: string | null | undefined,
): Promise<DiscountCodeCredit | null> {
  if (!discountCodeId) return null;
  const { data, error } = await db
    .from('discount_codes')
    .select('id, affiliate_id, commission_rate')
    .eq('id', discountCodeId)
    .maybeSingle();
  if (error || !data?.affiliate_id) return null;
  if (customerId && data.affiliate_id === customerId) return null;
  const rate = data.commission_rate == null ? null : Number(data.commission_rate);
  return {
    affiliateId: data.affiliate_id,
    discountCodeId: data.id,
    commissionRate: rate != null && Number.isFinite(rate) ? rate : null,
  };
}

export type RecordCommissionResult =
  | { recorded: true; commissionId: string; amount: number }
  | { recorded: false; reason: 'no-attribution' | 'no-base' | 'already-recorded' | 'error' };

/**
 * Record the affiliate's cut for a paid invoice.
 *
 * Called on the `paid` transition of a hosted (Stealth Health) sale, from all
 * three paths that can observe it — the webhook, the cron poller and the admin
 * refresh — so it has to be safe to call repeatedly for the same invoice.
 *
 * Idempotency is layered: a pre-check skips the common case cheaply, and the
 * unique index on `commissions.invoice_id` (see
 * affiliate-commission-hosted-checkout-migration.sql) catches the race the
 * pre-check cannot, since the webhook and a poll can land at the same instant.
 * A duplicate-key error is therefore a success, not a failure.
 *
 * The base is the goods SUBTOTAL. Shipping is Stealth Health's flat fee and is not
 * the affiliate's to earn on — note this differs from the sales-person stream
 * in app/api/admin/invoices/route.ts, which commissions on the invoice total.
 *
 * Never throws: a paid order must be recorded even if crediting fails.
 */
export async function recordAffiliateCommission(
  db: SupabaseClient,
  input: RecordCommissionInput,
): Promise<RecordCommissionResult> {
  try {
    const { invoiceId, customerId, referralCode } = input;

    // Cheap pre-check — the webhook and poller both re-observe paid orders.
    const { data: existing } = await db
      .from('commissions')
      .select('id')
      .eq('invoice_id', invoiceId)
      .maybeSingle();
    if (existing) return { recorded: false, reason: 'already-recorded' };

    const codeCredit = await resolveDiscountCodeCredit(db, input.discountCodeId, customerId);
    const attribution = codeCredit
      ? { affiliateId: codeCredit.affiliateId, referralCodeId: null, referralCode: null }
      : await resolveAffiliateAttribution(db, { customerId, referralCode });
    if (!attribution) return { recorded: false, reason: 'no-attribution' };

    const base =
      typeof input.subtotalCents === 'number' && Number.isFinite(input.subtotalCents)
        ? round2(input.subtotalCents / 100)
        : 0;
    // No subtotal reported means no defensible base to pay on. Skipping leaves
    // the invoice uncredited rather than writing a zero-value row that would
    // then block the real one via the unique index.
    if (base <= 0) return { recorded: false, reason: 'no-base' };

    const { data: affiliate } = await db
      .from('affiliates')
      .select('commission_rate')
      .eq('id', attribution.affiliateId)
      .maybeSingle();

    // A code's own rate wins — the code typed at checkout, else an affiliate
    // discount code the referral link carried; 0% is a legitimate "discount
    // only" code. It is a percentage, so it is not run through
    // normalizeCommissionRate, which would read 1 (1%) as a fraction (100%).
    const codeRate = codeCredit ? codeCredit.commissionRate : attribution.commissionRate ?? null;
    const rate =
      codeRate != null
        ? Math.min(1, Math.max(0, codeRate / 100))
        : normalizeCommissionRate(affiliate?.commission_rate);
    const amount = round2(base * rate);

    const row: Record<string, unknown> = {
      affiliate_id: attribution.affiliateId,
      invoice_id: invoiceId,
      order_id: null,
      referral_code_id: attribution.referralCodeId,
      amount,
      order_total: base,
      // Stored as a percentage — that is what every reader renders.
      commission_rate: round2(rate * 100),
      status: 'pending',
    };
    if (codeCredit) row.discount_code_id = codeCredit.discountCodeId;

    const { data: commission, error } = await db
      .from('commissions')
      .insert(row)
      .select('id')
      .single();

    if (error) {
      // 23505 = unique violation: another path recorded it between our
      // pre-check and this insert. That is the guarantee working, not a fault.
      if ((error as { code?: string }).code === '23505') {
        return { recorded: false, reason: 'already-recorded' };
      }
      console.error('[affiliate] commission insert failed:', error);
      return { recorded: false, reason: 'error' };
    }

    return { recorded: true, commissionId: commission.id, amount };
  } catch (err) {
    console.error('[affiliate] recordAffiliateCommission threw:', err);
    return { recorded: false, reason: 'error' };
  }
}
