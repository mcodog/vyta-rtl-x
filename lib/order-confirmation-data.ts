/**
 * Pure helpers for the paid-order confirmation email: build the payload the
 * mailer needs from an order row (storefront `orders` or a Stealth Health
 * hand-off + its invoice), drop addresses we can't deliver to, and fold the
 * `fulfillment_email_log` history into the summary the admin screens show.
 *
 * No imports, so it runs in the browser and under `node --test` alike. The
 * server side (claim / send / log) lives in lib/order-confirmation.ts.
 */

export interface ConfirmationLine {
  name: string;
  quantity: number;
  /** Price of ONE unit; the email shows unit price × quantity. */
  price: number;
  strength?: string;
  unit?: 'vial' | 'case';
  vialsPerBox?: number;
}

export interface ConfirmationEmailData {
  to: string;
  customerName: string;
  orderNumber: string;
  items: ConfirmationLine[];
  subtotal: number;
  discount: number;
  shipping: number;
  total: number;
  currency: string;
}

/** One `fulfillment_email_log` row, as much of it as the summary needs. */
export interface ConfirmationLogRow {
  created_at: string;
  to_email: string | null;
  success: boolean;
  error?: string | null;
  /** NULL = the automatic send on payment; otherwise the admin who sent it. */
  sent_by_email?: string | null;
}

export interface ConfirmationSummary {
  /** Successful sends, automatic and manual. */
  sendCount: number;
  lastSentAt: string | null;
  lastSentTo: string | null;
  /** Admin email of the last successful send; null = sent automatically. */
  lastSentBy: string | null;
  /** The most recent attempt (of any outcome) failed. */
  lastAttemptFailed: boolean;
  lastError: string | null;
}

export const EMPTY_CONFIRMATION_SUMMARY: ConfirmationSummary = {
  sendCount: 0,
  lastSentAt: null,
  lastSentTo: null,
  lastSentBy: null,
  lastAttemptFailed: false,
  lastError: null,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A trimmed, plausible address — or null when there's nothing to send to. */
export function deliverableEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim();
  if (!EMAIL_RE.test(email)) return null;
  // Placeholder domains (RFC 2606/6761) never deliver.
  if (/@[^@]*\.(local|invalid|test|example)$/i.test(email)) return null;
  return email;
}

/**
 * Orders placed through a storefront checkout that the admin marks paid. VYTA
 * has none today — its storefront sells through the Stealth Health hosted
 * checkout (`puramass_orders`), admin-created orders are invoiced by hand and
 * legacy crypto orders get their own "payment confirmed" email — so nothing in
 * `orders` is sent automatically. A future own-checkout should write a source
 * starting with `e-transfer` (or extend this) to opt its orders in.
 */
export function isStorefrontCheckoutSource(source: unknown): boolean {
  return typeof source === 'string' && source.startsWith('e-transfer');
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function qty(v: unknown): number {
  return Math.max(1, Math.round(num(v)) || 1);
}

function currencyCode(...candidates: unknown[]): string {
  for (const c of candidates) {
    const code = str(c).toUpperCase();
    if (code) return code;
  }
  return 'CAD';
}

/**
 * Payload for a storefront order. `order.items` are the priced JSONB lines
 * (`{ name, quantity, price, strength?, unit?, vials_per_box? }`); the server
 * fills them from `order_items` first when the JSONB is empty.
 */
export function storefrontConfirmationData(order: Record<string, any>): ConfirmationEmailData | null {
  const to = deliverableEmail(order?.email);
  if (!to) return null;

  const rawItems: unknown[] = Array.isArray(order.items) ? order.items : [];
  const items: ConfirmationLine[] = rawItems
    .filter((it): it is Record<string, any> => !!it && typeof it === 'object')
    .map((it) => {
      const line: ConfirmationLine = {
        name: str(it.name) || 'Item',
        quantity: qty(it.quantity),
        price: round2(num(it.price)),
      };
      const strength = str(it.strength);
      if (strength) line.strength = strength;
      if (it.unit === 'vial' || it.unit === 'case') line.unit = it.unit;
      const perBox = num(it.vials_per_box);
      if (perBox > 0) line.vialsPerBox = perBox;
      return line;
    });

  const lineSum = items.reduce((s, l) => s + l.price * l.quantity, 0);
  const shipping = num(order.shipping_cost);
  const discount = Math.max(0, num(order.discount_total ?? order.discount_amount));
  const subtotal = order.subtotal != null ? num(order.subtotal) : lineSum;
  const total = order.total != null ? num(order.total) : subtotal - discount + shipping;

  const addr = order.shipping_address && typeof order.shipping_address === 'object'
    ? order.shipping_address
    : {};
  const customerName =
    [str(addr.firstName ?? addr.first_name), str(addr.lastName ?? addr.last_name)]
      .filter(Boolean)
      .join(' ') || 'there';

  return {
    to,
    customerName,
    orderNumber: str(order.order_number) || String(order.id ?? ''),
    items,
    subtotal: round2(subtotal),
    discount: round2(discount),
    shipping: round2(shipping),
    total: round2(total),
    currency: currencyCode(order.currency),
  };
}

/**
 * Payload for a Stealth Health hand-off. The invoice carries the number the
 * buyer sees and the money; prices on its lines already have any discount
 * applied, so there is no separate discount row.
 */
export function stealthHealthConfirmationData(
  ledger: Record<string, any>,
  invoice: Record<string, any>,
  lines: Array<Record<string, any>>,
): ConfirmationEmailData | null {
  const to = deliverableEmail(ledger?.customer_email) ?? deliverableEmail(invoice?.customer_email);
  if (!to) return null;

  const items: ConfirmationLine[] = (lines ?? []).map((l) => ({
    name: str(l.description) || 'Item',
    quantity: qty(l.qty),
    price: round2(num(l.unit_price)),
  }));
  const lineSum = items.reduce((s, l) => s + l.price * l.quantity, 0);
  const shipping = num(invoice.shipping_cost);
  const subtotal = invoice.subtotal != null ? num(invoice.subtotal) : lineSum;
  const total = invoice.total != null ? num(invoice.total) : subtotal + shipping;

  return {
    to,
    customerName: str(ledger.customer_name) || str(invoice.customer_name) || 'there',
    orderNumber: str(invoice.invoice_number) || str(ledger.partner_reference) || String(ledger.id ?? ''),
    items,
    subtotal: round2(subtotal),
    discount: 0,
    shipping: round2(shipping),
    total: round2(total),
    currency: currencyCode(invoice.currency, ledger.currency),
  };
}

/** Fold a send history (any order) into the summary the admin screens show. */
export function summarizeConfirmationLog(rows: ConfirmationLogRow[] | null | undefined): ConfirmationSummary {
  const sorted = [...(rows ?? [])].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  if (sorted.length === 0) return { ...EMPTY_CONFIRMATION_SUMMARY };

  const successes = sorted.filter((r) => r.success);
  const lastOk = successes[0] ?? null;
  const newest = sorted[0];
  const failing = !newest.success;

  return {
    sendCount: successes.length,
    lastSentAt: lastOk?.created_at ?? null,
    lastSentTo: lastOk?.to_email ?? null,
    lastSentBy: lastOk?.sent_by_email ?? null,
    lastAttemptFailed: failing,
    lastError: failing ? newest.error ?? 'Send failed' : null,
  };
}
