/**
 * The money breakdown the admin invoice page shows under its line items: list
 * price before discount, the discount and what it was, and the affiliate's cut.
 *
 * The before-discount figures come from the same builders as the paid-order
 * emails (`stealthHealthOrderSummary` / `manualInvoiceOrderSummary`), so the
 * invoice page and the email a customer received can never disagree about
 * what the discount was.
 *
 * `buildInvoiceBreakdown` is pure (unit-tested); `loadInvoiceBreakdown` reads
 * the rows it needs with the service-role client, since the hand-off ledger,
 * discount codes and commissions are all service-role only.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  discountLabelFor,
  manualInvoiceOrderSummary,
  stealthHealthOrderSummary,
} from '@/lib/order-confirmation-data';
import { normalizeReferralCode } from '@/lib/affiliate/utils';
import { resolveReferralCodeOwner } from '@/lib/affiliate/commission';

/** One promo that went into the discount, as recorded at checkout. */
export interface InvoiceDiscountPart {
  /** "Discount code", "First-order discount", "Limited-time offer", "Line discount". */
  kind: 'discount_code' | 'first_order' | 'cart_offer' | 'line';
  label: string;
  /** e.g. "VYTA20 · 20%" or "15%". */
  detail: string | null;
}

export interface InvoiceBreakdownLine {
  lineId: string;
  /** Unit price before any discount. */
  listUnitPrice: number;
  /** How far below list the line was charged, as a percentage (e.g. 20). */
  discountPct: number;
}

export interface InvoiceAffiliateCredit {
  affiliateId: string;
  name: string | null;
  email: string | null;
  /** What tied the sale to the affiliate. */
  via: 'discount_code' | 'referral_code' | 'bound_customer' | null;
  /** The code that did it (discount code or referral code), when known. */
  code: string | null;
  /** Null when no commission row exists for this sale (yet). */
  commission: {
    id: string;
    amount: number;
    /** Percentage, e.g. 10 for 10%. */
    rate: number;
    /** What the rate was applied to — the goods subtotal after discount. */
    base: number;
    status: string;
    paidAt: string | null;
  } | null;
}

export interface InvoiceBreakdown {
  /** Goods at list price, before any discount. */
  subtotalBeforeDiscount: number;
  /** Total taken off the goods. 0 when nothing was. */
  discount: number;
  /** subtotalBeforeDiscount − discount: the goods subtotal as charged. */
  chargedSubtotal: number;
  /** One-line summary, e.g. "VYTA20 + 5% limited-time offer". */
  discountLabel: string | null;
  discountParts: InvoiceDiscountPart[];
  /** Per-line list price, only for lines whose list price differs from the charged one. */
  lines: InvoiceBreakdownLine[];
  /**
   * What the line items' Disc. column shows on a line that has no list price
   * of its own: the checkout's order-wide promo percentages, e.g. "20%" or
   * "20% + 5%". Set only for a hosted sale whose list prices can't be
   * recovered, where it is the one record of the discount. Null otherwise.
   */
  lineDiscountFallback: string | null;
  /** Referral code the buyer arrived with (hosted checkout), if any. */
  referralCode: string | null;
  affiliate: InvoiceAffiliateCredit | null;
}

type Row = Record<string, any>;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function pct(n: number): string {
  return `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

export interface BreakdownInput {
  invoice: Row;
  /** `invoice_line_items` rows, in the order the page lists them. */
  lines: Row[];
  /** The Stealth Health hand-off behind the invoice, if it is one. */
  ledger: Row | null;
  customer?: Row | null;
  client?: Row | null;
  /** The `commissions` row for this sale, if one was recorded. */
  commission?: Row | null;
  /** The affiliate credited (or that a code points at), if any. */
  affiliate?: Row | null;
  /** How the affiliate was tied to the sale, and by which code. */
  attribution?: { via: InvoiceAffiliateCredit['via']; code: string | null } | null;
}

export function buildInvoiceBreakdown(input: BreakdownInput): InvoiceBreakdown {
  const { invoice, lines, ledger } = input;
  const summary = ledger
    ? stealthHealthOrderSummary(ledger, invoice, lines, input.customer ?? null)
    : manualInvoiceOrderSummary(invoice, lines, input.customer ?? null, input.client ?? null);

  const discount = round2(summary.discount);
  const subtotalBeforeDiscount = round2(summary.subtotal);

  // The summary's items are built 1:1 from `lines`, in order.
  const breakdownLines: InvoiceBreakdownLine[] = [];
  if (discount > 0) {
    lines.forEach((l, i) => {
      const item = summary.items[i];
      if (!item || !l?.id) return;
      // A manual invoice's unit price already is the list price (its discount
      // is the line's %), so only lines charged below list get one.
      if (item.price - num(l.unit_price) >= 0.005) {
        breakdownLines.push({
          lineId: String(l.id),
          listUnitPrice: round2(item.price),
          discountPct: Math.round((1 - num(l.unit_price) / item.price) * 1000) / 10,
        });
      }
    });
  }

  const parts: InvoiceDiscountPart[] = [];
  if (ledger) {
    const code = str(ledger.discount_code);
    const codePct = num(ledger.discount_code_percent);
    if (code) {
      parts.push({
        kind: 'discount_code',
        label: 'Discount code',
        // 0% = a bigger promo won, so the code only credited its affiliate.
        detail: codePct > 0 ? `${code} · ${pct(codePct)}` : `${code} · credit only`,
      });
    }
    if (num(ledger.ad_discount_percent) > 0) {
      parts.push({ kind: 'first_order', label: 'First-order discount', detail: pct(num(ledger.ad_discount_percent)) });
    }
    if (num(ledger.cart_offer_percent) > 0) {
      parts.push({ kind: 'cart_offer', label: 'Limited-time offer', detail: pct(num(ledger.cart_offer_percent)) });
    }
  } else {
    const pcts = [...new Set(lines.map((l) => num(l.discount_pct)).filter((p) => p > 0))];
    if (pcts.length > 0) {
      parts.push({ kind: 'line', label: 'Line discount', detail: pcts.map(pct).join(', ') });
    }
  }

  // No list prices to compare against, but the checkout recorded the promos:
  // the lines were still charged below list, by these.
  let lineDiscountFallback: string | null = null;
  if (ledger && discount <= 0) {
    const pcts = [ledger.discount_code_percent, ledger.ad_discount_percent, ledger.cart_offer_percent]
      .map(num)
      .filter((p) => p > 0);
    if (pcts.length > 0) lineDiscountFallback = pcts.map(pct).join(' + ');
  }

  let discountLabel: string | null = summary.discountLabel ?? (ledger ? discountLabelFor(ledger) : null);
  if (!discountLabel && !ledger && parts.length > 0) discountLabel = `${parts[0].detail} line discount`;

  let affiliate: InvoiceAffiliateCredit | null = null;
  const aff = input.affiliate ?? null;
  const c = input.commission ?? null;
  const affiliateId = str(c?.affiliate_id) ?? str(aff?.id);
  if (affiliateId) {
    const name = [str(aff?.first_name), str(aff?.last_name)].filter(Boolean).join(' ') || null;
    affiliate = {
      affiliateId,
      name,
      email: str(aff?.email),
      via: input.attribution?.via ?? null,
      code: input.attribution?.code ?? null,
      commission: c
        ? {
            id: String(c.id),
            amount: round2(num(c.amount)),
            rate: round2(num(c.commission_rate)),
            base: round2(num(c.order_total)),
            status: str(c.status) ?? 'pending',
            paidAt: str(c.paid_at),
          }
        : null,
    };
  }

  return {
    subtotalBeforeDiscount,
    discount,
    chargedSubtotal: round2(subtotalBeforeDiscount - discount),
    discountLabel: discount > 0 ? discountLabel : null,
    discountParts: discount > 0 || parts.some((p) => p.kind === 'discount_code') ? parts : [],
    lines: breakdownLines,
    lineDiscountFallback,
    referralCode: str(ledger?.referral_code),
    affiliate,
  };
}

async function maybeOne(
  db: SupabaseClient,
  table: string,
  column: string,
  value: unknown,
  select = '*',
): Promise<Row | null> {
  if (typeof value !== 'string' || !value) return null;
  const { data, error } = await db.from(table).select(select).eq(column, value).limit(1);
  if (error) {
    console.error(`[invoice-breakdown] reading ${table}.${column} failed:`, error.message);
    return null;
  }
  return ((data ?? [])[0] as Row | undefined) ?? null;
}

/**
 * Everything `buildInvoiceBreakdown` needs, read with the service-role client.
 * Null when the invoice doesn't exist. Lookups that fail (an unmigrated
 * column, a deleted affiliate) leave their part of the breakdown empty rather
 * than failing the whole thing.
 */
export async function loadInvoiceBreakdown(
  db: SupabaseClient,
  invoiceId: string,
): Promise<InvoiceBreakdown | null> {
  const [{ data: invoice }, { data: lines }, ledger] = await Promise.all([
    db.from('invoices').select('*').eq('id', invoiceId).maybeSingle(),
    db.from('invoice_line_items').select('*').eq('invoice_id', invoiceId),
    maybeOne(db, 'puramass_orders', 'invoice_id', invoiceId),
  ]);
  if (!invoice) return null;

  const [customer, client, commission] = await Promise.all([
    maybeOne(db, 'customers', 'id', invoice.customer_id ?? ledger?.customer_id),
    invoice.ships_to_client ? maybeOne(db, 'customer_clients', 'id', invoice.client_id) : Promise.resolve(null),
    // A hosted sale's commission hangs off the invoice; a storefront order's
    // off the order.
    maybeOne(db, 'commissions', 'invoice_id', invoiceId).then(
      (row) => row ?? maybeOne(db, 'commissions', 'order_id', invoice.order_id),
    ),
  ]);

  // Who the sale credits and why — mirroring recordAffiliateCommission's
  // priority: an affiliate's discount code, then the referral code, then a
  // customer bound to an affiliate.
  let attribution: BreakdownInput['attribution'] = null;
  let affiliateId: string | null = str(commission?.affiliate_id);
  const discountCode =
    (await maybeOne(db, 'discount_codes', 'id', commission?.discount_code_id ?? ledger?.discount_code_id)) ?? null;
  // The code the buyer arrived with, as they saw it — which may be an
  // affiliate's discount code or a code since renamed, not a live referral
  // code (see resolveReferralCodeOwner). Else the commission's own code.
  let referral: Row | null = null;
  const arrivedWith = str(ledger?.referral_code);
  if (arrivedWith) {
    referral = await maybeOne(db, 'referral_codes', 'code', normalizeReferralCode(arrivedWith));
    if (!referral) {
      const owner = await resolveReferralCodeOwner(db, arrivedWith);
      if (owner) referral = { affiliate_id: owner.affiliateId, code: owner.code };
    }
  }
  if (!referral && commission?.referral_code_id) {
    referral = await maybeOne(db, 'referral_codes', 'id', commission.referral_code_id);
  }
  const matches = (id: unknown) => typeof id === 'string' && !!id && (!affiliateId || id === affiliateId);

  if (matches(discountCode?.affiliate_id)) {
    affiliateId = discountCode!.affiliate_id;
    attribution = { via: 'discount_code', code: str(discountCode!.code) };
  } else if (matches(customer?.affiliate_id) && (commission || ledger)) {
    // Only claimed without a commission row for a hosted sale, the one kind
    // that earns affiliate commission; a manual invoice pays a sales person.
    affiliateId = customer!.affiliate_id;
    attribution = { via: 'bound_customer', code: referral?.affiliate_id === affiliateId ? str(referral?.code) : null };
  } else if (matches(referral?.affiliate_id)) {
    affiliateId = referral!.affiliate_id;
    attribution = { via: 'referral_code', code: str(referral!.code) };
  }

  const affiliate = affiliateId
    ? await maybeOne(db, 'affiliates', 'id', affiliateId, 'id, first_name, last_name, email')
    : null;

  return buildInvoiceBreakdown({
    invoice,
    lines: lines ?? [],
    ledger,
    customer,
    client,
    commission,
    affiliate: affiliate ?? (affiliateId ? { id: affiliateId } : null),
    attribution,
  });
}
