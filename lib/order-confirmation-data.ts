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
  /** Catalog product, used to look up the line's image. */
  productId?: string;
  /** Absolute product image URL — filled in by the server before sending. */
  imageUrl?: string;
}

/** Where the order ships, as the email shows it. */
export interface ConfirmationShipTo {
  name: string | null;
  /** Street, city/province/postal, country — one entry per printed line. */
  lines: string[];
  phone: string | null;
}

export interface ConfirmationEmailData {
  to: string;
  customerName: string;
  orderNumber: string;
  items: ConfirmationLine[];
  subtotal: number;
  discount: number;
  /** What the discount was, e.g. "VYTA20 + 5% limited-time offer". */
  discountLabel?: string;
  shipping: number;
  total: number;
  currency: string;
  /** When the order was paid / placed (timestamp or YYYY-MM-DD). */
  orderDate?: string;
  /** Shown in the header strip; the email is only sent for paid orders. */
  paymentStatus?: string;
  tax?: number;
  shipTo?: ConfirmationShipTo;
  /** Id the customer order page is keyed by (orders.id or the invoice id). */
  accountOrderId?: string;
  /** "View Order Details" target — filled in by the server before sending. */
  viewOrderUrl?: string;
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function productIdOf(v: unknown): string | undefined {
  const id = str(v);
  return UUID_RE.test(id) ? id : undefined;
}

/** A JSONB address (camelCase or snake_case keys) as printable lines. */
export function shipToFrom(
  raw: unknown,
  fallback: { name?: unknown; phone?: unknown } = {},
): ConfirmationShipTo | undefined {
  let addr: Record<string, any> | null = null;
  if (raw && typeof raw === 'object') addr = raw as Record<string, any>;
  else if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try {
      addr = JSON.parse(raw);
    } catch {
      addr = null;
    }
  }
  if (!addr) return undefined;

  const street = [str(addr.address ?? addr.address1 ?? addr.line1), str(addr.address2 ?? addr.line2)]
    .filter(Boolean)
    .join(', ');
  const region = [str(addr.state ?? addr.province), str(addr.zip ?? addr.postalCode ?? addr.postal_code)]
    .filter(Boolean)
    .join(' ');
  const cityLine = [str(addr.city), region].filter(Boolean).join(', ');
  const country = str(addr.country);
  const lines = [street, cityLine, country === 'CA' ? 'Canada' : country === 'US' ? 'United States' : country]
    .filter(Boolean);
  if (lines.length === 0) return undefined;

  const name =
    [str(addr.firstName ?? addr.first_name), str(addr.lastName ?? addr.last_name)].filter(Boolean).join(' ') ||
    str(addr.name) ||
    str(fallback.name) ||
    null;
  const phone = str(addr.phone) || str(fallback.phone) || null;
  return { name, lines, phone };
}

/**
 * Split a Stealth Health invoice description ("GLP-3 20mg — Pack of 5") into
 * the product name and the pack it was sold as.
 */
function splitPackSuffix(description: string): { name: string; pack: number | null } {
  const m = description.match(/^(.*?)\s+[—-]\s+(?:Pack of (\d+)|Single vial)\s*$/i);
  if (!m) return { name: description, pack: null };
  return { name: m[1].trim() || description, pack: m[2] ? Number(m[2]) : 1 };
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
      const productId = productIdOf(it.product_id ?? it.id);
      if (productId) line.productId = productId;
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

  const data: ConfirmationEmailData = {
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
  const orderDate = str(order.payment_confirmed_at) || str(order.created_at);
  if (orderDate) data.orderDate = orderDate;
  const shipTo = shipToFrom(order.shipping_address, { phone: order.phone });
  if (shipTo) data.shipTo = shipTo;
  if (order.id) data.accountOrderId = String(order.id);
  return data;
}

/**
 * Payload for a Stealth Health hand-off. The invoice carries the number the
 * buyer sees and the money. Its line prices already have any discount
 * applied; when the hand-off recorded each line's list price, the lines are
 * shown at list price with the difference as a Discount row, so Subtotal −
 * Discount + Shipping + Tax is still exactly the invoice total. Without list
 * prices (older hand-offs, or lines an admin changed) the charged prices are
 * shown with no discount row.
 */
export function stealthHealthConfirmationData(
  ledger: Record<string, any>,
  invoice: Record<string, any>,
  lines: Array<Record<string, any>>,
): ConfirmationEmailData | null {
  const to = deliverableEmail(ledger?.customer_email) ?? deliverableEmail(invoice?.customer_email);
  if (!to) return null;

  const items: ConfirmationLine[] = (lines ?? []).map((l) => {
    const description = str(l.description) || 'Item';
    const { name, pack } = splitPackSuffix(description);
    const perUnit = num(l.vials_per_unit) || pack || 0;
    const line: ConfirmationLine = {
      name: pack != null ? name : description,
      quantity: qty(l.qty),
      price: round2(num(l.unit_price)),
    };
    if (l.price_type === 'vial' || pack === 1) line.unit = 'vial';
    else if (l.price_type === 'box' || (pack ?? 0) > 1) line.unit = 'case';
    if (line.unit === 'case' && perUnit > 1) line.vialsPerBox = perUnit;
    const productId = productIdOf(l.product_id);
    if (productId) line.productId = productId;
    return line;
  });
  const lineSum = items.reduce((s, l) => s + l.price * l.quantity, 0);
  const shipping = num(invoice.shipping_cost);
  const tax = num(invoice.tax_total);
  const chargedSubtotal = invoice.subtotal != null ? num(invoice.subtotal) : lineSum;
  const total = invoice.total != null ? num(invoice.total) : chargedSubtotal + shipping + tax;

  let subtotal = chargedSubtotal;
  let discount = 0;
  const listPrices = listUnitPrices(ledger.items, lines ?? []);
  if (listPrices) {
    const listSum = round2(listPrices.reduce((s, p, i) => s + p * items[i].quantity, 0));
    if (listSum - chargedSubtotal >= 0.01) {
      listPrices.forEach((p, i) => {
        items[i].price = p;
      });
      subtotal = listSum;
      discount = listSum - chargedSubtotal;
    }
  }

  const data: ConfirmationEmailData = {
    to,
    customerName: str(ledger.customer_name) || str(invoice.customer_name) || 'there',
    orderNumber: str(invoice.invoice_number) || str(ledger.partner_reference) || String(ledger.id ?? ''),
    items,
    subtotal: round2(subtotal),
    discount: round2(discount),
    shipping: round2(shipping),
    total: round2(total),
    currency: currencyCode(invoice.currency, ledger.currency),
  };

  const orderDate = str(invoice.paid_at) || str(ledger.paid_at) || str(invoice.created_at);
  if (orderDate) data.orderDate = orderDate;
  if (invoice.status === 'paid' || ledger.status === 'paid') data.paymentStatus = 'Paid';
  data.tax = round2(tax);
  if (discount > 0) {
    const label = discountLabelFor(ledger);
    if (label) data.discountLabel = label;
  }

  const shipTo = shipToFrom(ledger.shipping_address, {
    name: ledger.customer_name || invoice.customer_name,
    phone: ledger.customer_phone || invoice.customer_phone,
  });
  if (shipTo) data.shipTo = shipTo;
  if (invoice.id) data.accountOrderId = String(invoice.id);
  return data;
}

/**
 * Each invoice line's list unit price (CAD), matched to the hand-off's lines by
 * product and pack size — or null unless every line has one.
 */
function listUnitPrices(
  ledgerItems: unknown,
  lines: Array<Record<string, any>>,
): number[] | null {
  if (!Array.isArray(ledgerItems) || lines.length === 0) return null;
  const byKey = new Map<string, number>();
  for (const it of ledgerItems) {
    if (!it || typeof it !== 'object') continue;
    const cents = num((it as any).list_unit_price_cents);
    const productId = productIdOf((it as any).product_id);
    if (!productId || cents <= 0) continue;
    byKey.set(`${productId.toLowerCase()}|${Math.max(1, num((it as any).pack_size) || 1)}`, cents / 100);
  }
  const out: number[] = [];
  for (const l of lines) {
    const productId = productIdOf(l.product_id);
    const pack = Math.max(1, num(l.vials_per_unit) || splitPackSuffix(str(l.description)).pack || 1);
    const price = productId ? byKey.get(`${productId.toLowerCase()}|${pack}`) : undefined;
    // A list price below what was charged means the line was repriced since.
    if (price == null || price + 0.005 < num(l.unit_price)) return null;
    out.push(round2(price));
  }
  return out;
}

/** "VYTA20 + 5% limited-time offer" — the promos the checkout recorded. */
function discountLabelFor(ledger: Record<string, any>): string | null {
  const parts = [
    str(ledger.discount_code) && num(ledger.discount_code_percent) > 0 ? str(ledger.discount_code) : '',
    num(ledger.ad_discount_percent) > 0 ? `${num(ledger.ad_discount_percent)}% first-order discount` : '',
    num(ledger.cart_offer_percent) > 0 ? `${num(ledger.cart_offer_percent)}% limited-time offer` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' + ') : null;
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
