/**
 * The local invoice behind a Stealth Health (PuraMass hosted checkout) order.
 *
 * Lifecycle:
 *   1. Hand-off — `createPendingStealthHealthInvoice` writes the invoice the
 *      moment the buyer is sent to the hosted checkout: the exact lines, the
 *      shipping they were charged and the courier they picked, in CAD, with
 *      status `pending_payment`. It stays out of the warehouse queue, the
 *      customer's account and every revenue figure until it is paid.
 *   2. Paid — `materializeStealthHealthFulfillment` (webhook, poller, admin
 *      refresh) flips it to `paid`. Every pass takes the stock, credits the
 *      affiliate, books the Easyship shipment and emails the buyer and the
 *      admins (each email claimed once per order) (all idempotent, so a failure on one pass is retried
 *      by the next — and `healStealthHealthPaidOrders` retries from the cron
 *      for an order no webhook or poll will touch again).
 *      A hand-off made before invoices were created up front has none, so
 *      this creates it already paid.
 *   3. Lapsed — `expireStealthHealthInvoice` moves an unpaid invoice to
 *      `expired` when the payment link expires or is cancelled.
 *
 * Stealth Health owns payment and taxes; the invoice exists for fulfillment
 * and reconciliation. It is marked `source = 'stealth_health'` and its ship-to
 * is read live from the hand-off ledger (`puramass_orders.shipping_address`).
 *
 * Nothing here throws — a failure must never break a webhook ACK, a poll, or
 * the checkout redirect.
 */
import { todayInAppTz } from '@/lib/datetime';
import type { SupabaseClient } from '@supabase/supabase-js';
import { recordAffiliateCommission } from '@/lib/affiliate/commission';
import { isMissingColumnError } from '@/lib/payments/puramass-columns';
import { splitName, trackPlacedOrder } from '@/lib/klaviyo/events';
import { adjustInvoiceStock } from '@/lib/admin/stock-ledger';

export interface StealthHealthLedgerRow {
  id: string;
  customer_id?: string | null;
  customer_email?: string | null;
  /** Buyer name from the Stealth Health customer block, when it reported one. */
  customer_name?: string | null;
  items?: StealthHealthLedgerItem[] | null;
  subtotal_cents?: number | null;
  invoice_id?: string | null;
  /** Referral code captured at hand-off, if the buyer arrived through one. */
  referral_code?: string | null;
}

/** One line of the hand-off as the ledger stores it. */
export interface StealthHealthLedgerItem {
  sku?: string;
  quantity?: number;
  unit_price_cents?: number;
  /** Product and pack size the line was sold as — hand-offs since the stock ledger. */
  product_id?: string | null;
  pack_size?: number | null;
}

export interface StealthHealthPaidItem {
  sku?: string;
  name?: string;
  quantity?: number;
  unit_price_cents?: number;
}

/** One invoice line as the hand-off knows it. */
export interface StealthHealthInvoiceLine {
  product_id: string | null;
  description: string;
  qty: number;
  /** What was charged for one unit, in CAD (discounts already applied). */
  unit_price: number;
  price_type: 'box' | 'vial';
  /** Vials in one unit — 1 for a single vial, N for a pack of N. */
  vials_per_unit: number;
}

/** Statuses of a Stealth Health invoice that has not been paid. */
export const UNPAID_HANDOFF_INVOICE_STATUSES = ['pending_payment', 'expired'] as const;

/**
 * Which pricing unit a Stealth Health line was sold in.
 *
 * The SKU suffix is the authoritative signal — `…-vial` is the single-vial
 * listing, everything else (`…-case`, `…-10-pack`, plain) is a full box. The
 * partner's product *name* is free text, so it is only a fallback.
 */
export function puramassPriceType(
  item: { sku?: string | null; name?: string | null },
): 'box' | 'vial' {
  const sku = (item.sku ?? '').trim().toLowerCase();
  if (sku) return sku.endsWith('-vial') ? 'vial' : 'box';
  // Pre-`paid_items` ledger rows have no SKU on the line — fall back to the
  // name, which suffixes the vial listing with "(Single Vial)".
  return /\(\s*single\s+vial\s*\)$/i.test((item.name ?? '').trim()) ? 'vial' : 'box';
}

const STEALTH_HEALTH_NOTE =
  'Placed via the Stealth Health checkout. Payment and taxes are handled by Stealth Health.';

/**
 * The shipping stamped on a hand-off that recorded no figure of its own.
 * Every hand-off since the checkout started pricing shipping itself carries
 * `shipping_total_cents`; this only covers rows older than that.
 */
export const PURAMASS_LEGACY_SHIPPING = 35;

/**
 * The shipment fee to stamp on the invoice: exactly what the buyer was
 * charged at hand-off. Stealth Health orders are always in CAD.
 */
export function resolveFulfillmentShipping(
  ledger: { shipping_total_cents?: number | null },
): { shipping: number; currency: 'CAD' } {
  const cents = ledger.shipping_total_cents;
  if (typeof cents === 'number' && Number.isFinite(cents) && cents >= 0) {
    return { shipping: +(cents / 100).toFixed(2), currency: 'CAD' };
  }
  return { shipping: PURAMASS_LEGACY_SHIPPING, currency: 'CAD' };
}

function trimOrNull(v: unknown): string | null {
  const t = typeof v === 'string' ? v.trim() : '';
  return t ? t : null;
}

const round2 = (n: number) => +n.toFixed(2);

// ---------------------------------------------------------------------------
// 1. Hand-off
// ---------------------------------------------------------------------------

/**
 * Insert invoice lines. `vials_per_unit` arrives with
 * stealth-health-pending-invoice-migration.sql (or stock-ledger-migration.sql);
 * without it the stock RPC would read a pack of 5 as one vial, so the retry
 * drops `product_id` from pack lines, which then take no stock and are listed
 * under Stock Ledger → Needs attention. A single vial is one vial either way,
 * so it keeps its product.
 */
async function insertLines(
  db: SupabaseClient,
  invoiceId: string,
  lines: StealthHealthInvoiceLine[],
): Promise<void> {
  if (lines.length === 0) return;
  const rows = lines.map((l) => ({
    invoice_id: invoiceId,
    product_id: l.product_id,
    description: l.description,
    qty: l.qty,
    unit_price: l.unit_price,
    line_total: round2(l.qty * l.unit_price),
    discount_pct: 0,
    price_type: l.price_type,
    vials_per_unit: Math.max(1, Math.round(l.vials_per_unit) || 1),
    qty_fulfilled: 0,
    qty_backordered: 0,
  }));
  let { error } = await db.from('invoice_line_items').insert(rows);
  if (error && isMissingColumnError(error)) {
    ({ error } = await db
      .from('invoice_line_items')
      .insert(
        rows.map((r) => {
          const rest: Record<string, unknown> = { ...r };
          if (r.vials_per_unit !== 1) delete rest.product_id;
          delete rest.vials_per_unit;
          return rest;
        }),
      ));
  }
  if (error) console.error('[stealth-health] invoice line insert failed:', error);
}

/** Insert the invoice header, shedding `easyship_courier_id` if unmigrated. */
async function insertInvoice(
  db: SupabaseClient,
  row: Record<string, unknown>,
  courierId: string | null,
): Promise<{ id: string; invoice_number: string | null } | null> {
  // Stamp the New York day; the column's CURRENT_DATE default is UTC.
  row = { issue_date: todayInAppTz(), ...row };
  let { data, error } = await db
    .from('invoices')
    .insert(courierId ? { ...row, easyship_courier_id: courierId } : row)
    .select('id, invoice_number')
    .single();
  if (error && courierId && isMissingColumnError(error)) {
    ({ data, error } = await db.from('invoices').insert(row).select('id, invoice_number').single());
  }
  if (error || !data) {
    console.error('[stealth-health] invoice insert failed:', error);
    return null;
  }
  return data as { id: string; invoice_number: string | null };
}

/**
 * Write the invoice for a hand-off that has just been created, in
 * `pending_payment`, and link it to the ledger row. Returns the invoice id, or
 * null when it could not be written — the order is then invoiced on payment
 * instead, exactly as before this existed.
 */
export async function createPendingStealthHealthInvoice(
  db: SupabaseClient,
  args: {
    ledgerId: string;
    customerId: string | null;
    customerEmail: string;
    customerName: string | null;
    customerPhone: string | null;
    lines: StealthHealthInvoiceLine[];
    /** Goods subtotal in CAD, after discounts. */
    subtotal: number;
    /** Shipping charged, in CAD. */
    shipping: number;
    /** Easyship service the buyer picked; null for the flat fee. */
    courierId: string | null;
    /** Extra note line, e.g. the discount that was applied. */
    note?: string | null;
  },
): Promise<string | null> {
  try {
    const subtotal = round2(args.subtotal);
    const shipping = round2(args.shipping);
    const invoice = await insertInvoice(
      db,
      {
        source: 'stealth_health',
        customer_id: args.customerId,
        customer_email: args.customerEmail,
        customer_name: args.customerName,
        customer_phone: args.customerPhone,
        fulfillment_type: 'shipment',
        fulfillment_status: 'pending',
        status: 'pending_payment',
        currency: 'CAD',
        subtotal,
        tax_total: 0,
        shipping_cost: shipping,
        total: round2(subtotal + shipping),
        is_backorder: false,
        non_payable: false,
        notes: [STEALTH_HEALTH_NOTE, args.note].filter(Boolean).join('\n'),
      },
      trimOrNull(args.courierId),
    );
    if (!invoice) return null;

    await insertLines(db, invoice.id, args.lines);

    const { error: linkErr } = await db
      .from('puramass_orders')
      .update({ invoice_id: invoice.id })
      .eq('id', args.ledgerId)
      .is('invoice_id', null);
    if (linkErr) console.error('[stealth-health] invoice link failed:', linkErr);

    return invoice.id;
  } catch (err) {
    console.error('[stealth-health] createPendingStealthHealthInvoice threw:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 2. Paid
// ---------------------------------------------------------------------------

/**
 * The ledger row as stored, read with `*` so columns from migrations that have
 * not run are simply absent rather than failing the read. Callers each select
 * a different subset, so the fields this module depends on (shipping, courier,
 * address, discount code) are read here rather than threaded through them.
 */
async function readLedger(db: SupabaseClient, ledgerId: string): Promise<Record<string, any>> {
  try {
    const { data } = await db.from('puramass_orders').select('*').eq('id', ledgerId).maybeSingle();
    return (data as Record<string, any>) ?? {};
  } catch {
    return {};
  }
}

/**
 * Map a legacy hand-off's SKUs to products. Only single-vial SKUs are resolved:
 * a case SKU covers every pack size, and the pack size of an old hand-off was
 * never recorded, so its vial count cannot be known and it takes no stock.
 */
async function vialSkuProducts(
  db: SupabaseClient,
  skus: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = [...new Set(skus.filter(Boolean))];
  if (wanted.length === 0) return out;
  try {
    const { data } = await db
      .from('products')
      .select('id, puramass_sku_vial')
      .in('puramass_sku_vial', wanted);
    for (const p of (data ?? []) as any[]) {
      if (p.puramass_sku_vial && !out.has(p.puramass_sku_vial)) out.set(p.puramass_sku_vial, p.id);
    }
  } catch {
    /* no mapping → no stock taken */
  }
  return out;
}

/**
 * Invoice lines straight from the ledger, for a hand-off that recorded the
 * product and pack size of every line. Null when any line lacks them.
 */
async function linesFromLedger(
  db: SupabaseClient,
  items: StealthHealthLedgerItem[] | null | undefined,
): Promise<StealthHealthInvoiceLine[] | null> {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return null;
  if (!list.every((i) => typeof i.product_id === 'string' && i.product_id && Number(i.pack_size) >= 1)) {
    return null;
  }
  const names = new Map<string, string>();
  try {
    const { data } = await db
      .from('products')
      .select('id, name')
      .in('id', [...new Set(list.map((i) => i.product_id as string))]);
    for (const p of (data ?? []) as any[]) names.set(String(p.id), String(p.name ?? ''));
  } catch {
    /* names are cosmetic */
  }
  return list.map((i) => {
    const pack = Math.max(1, Math.round(Number(i.pack_size)) || 1);
    const name = names.get(i.product_id as string) || i.sku || 'Stealth Health item';
    return {
      product_id: i.product_id as string,
      description: pack > 1 ? `${name} — Pack of ${pack}` : `${name} — Single vial`,
      qty: Math.max(1, Math.round(Number(i.quantity ?? 1)) || 1),
      unit_price: typeof i.unit_price_cents === 'number' ? i.unit_price_cents / 100 : 0,
      price_type: pack > 1 ? 'box' : 'vial',
      vials_per_unit: pack,
    };
  });
}

/** Create the invoice, already paid, for a hand-off that never got one. */
async function createPaidInvoice(
  db: SupabaseClient,
  ledger: StealthHealthLedgerRow,
  stored: Record<string, any>,
  paidItems: StealthHealthPaidItem[] | null | undefined,
): Promise<string | null> {
  let lines = await linesFromLedger(db, ledger.items ?? stored.items);

  if (!lines) {
    const source: StealthHealthPaidItem[] =
      Array.isArray(paidItems) && paidItems.length > 0
        ? paidItems
        : (ledger.items ?? []).map((i) => ({ sku: i.sku, quantity: i.quantity }));

    const vialProducts = await vialSkuProducts(
      db,
      source.filter((it) => puramassPriceType(it) === 'vial').map((it) => it.sku ?? ''),
    );

    lines = source.map((it) => {
      const priceType = puramassPriceType(it);
      return {
        product_id: priceType === 'vial' ? vialProducts.get(it.sku ?? '') ?? null : null,
        description: (it.name || it.sku || 'Stealth Health item').toString(),
        qty: Math.max(1, Math.round(Number(it.quantity ?? 1)) || 1),
        unit_price: typeof it.unit_price_cents === 'number' ? it.unit_price_cents / 100 : 0,
        price_type: priceType,
        vials_per_unit: 1,
      };
    });
  }

  const lineSum = lines.reduce((s, l) => s + l.qty * l.unit_price, 0);
  const subtotal =
    typeof ledger.subtotal_cents === 'number'
      ? round2(ledger.subtotal_cents / 100)
      : round2(lineSum);
  const { shipping } = resolveFulfillmentShipping(stored);
  const courierId = trimOrNull(stored.shipping_courier_id);

  const invoice = await insertInvoice(
    db,
    {
      source: 'stealth_health',
      customer_id: ledger.customer_id ?? null,
      customer_email: ledger.customer_email ?? null,
      customer_name: ledger.customer_name ?? null,
      fulfillment_type: 'shipment',
      fulfillment_status: 'pending',
      status: 'paid',
      currency: 'CAD',
      subtotal,
      tax_total: 0,
      shipping_cost: shipping,
      total: round2(subtotal + shipping),
      is_backorder: false,
      non_payable: false,
      notes: STEALTH_HEALTH_NOTE,
    },
    courierId,
  );
  if (!invoice) return null;

  await insertLines(db, invoice.id, lines);

  await db
    .from('puramass_orders')
    .update({ invoice_id: invoice.id })
    .eq('id', ledger.id)
    .is('invoice_id', null);

  return invoice.id;
}

/**
 * Flip a hand-off invoice to paid. An `expired` one is included: a buyer can
 * pay in the grace window after our sweep has already lapsed the link. Returns
 * true only for the call that made the change, so the once-only side effects
 * fire once however many webhooks and polls race in.
 */
async function markInvoicePaid(
  db: SupabaseClient,
  invoiceId: string,
  ledger: StealthHealthLedgerRow,
): Promise<boolean> {
  const patch: Record<string, unknown> = { status: 'paid' };
  if (ledger.customer_email) patch.customer_email = ledger.customer_email;
  if (ledger.customer_name) patch.customer_name = ledger.customer_name;
  const { data, error } = await db
    .from('invoices')
    .update(patch)
    .eq('id', invoiceId)
    .in('status', [...UNPAID_HANDOFF_INVOICE_STATUSES])
    .select('id');
  if (error) {
    console.error('[stealth-health] mark paid failed:', error);
    return false;
  }
  return (data ?? []).length > 0;
}

export async function materializeStealthHealthFulfillment(
  db: SupabaseClient,
  ledger: StealthHealthLedgerRow,
  paidItems: StealthHealthPaidItem[] | null | undefined,
): Promise<{ created: boolean; invoiceId?: string }> {
  try {
    const stored = await readLedger(db, ledger.id);
    let invoiceId: string | null = ledger.invoice_id ?? stored.invoice_id ?? null;
    let invoiceStatus: string | null = null;

    if (invoiceId) {
      const { data: inv } = await db
        .from('invoices')
        .select('id, status')
        .eq('id', invoiceId)
        .maybeSingle();
      // A linked invoice that has since been deleted is recreated below.
      if (inv) invoiceStatus = inv.status as string;
      else invoiceId = null;
    }

    let firstPaid = false;
    if (!invoiceId) {
      invoiceId = await createPaidInvoice(db, ledger, stored, paidItems);
      if (!invoiceId) return { created: false };
      firstPaid = true;
    } else if (
      invoiceStatus &&
      (UNPAID_HANDOFF_INVOICE_STATUSES as readonly string[]).includes(invoiceStatus)
    ) {
      firstPaid = await markInvoicePaid(db, invoiceId, ledger);
    }

    // Stock on EVERY pass, not only the one that flipped the invoice to paid:
    // a decrement that failed once is retried by the next webhook or poll.
    // Idempotent in the database via invoices.stock_adjusted.
    await takeStealthHealthStock(db, invoiceId);

    if (firstPaid) await onFirstPaid(db, invoiceId, ledger, stored);

    await creditAffiliate(db, ledger, invoiceId, stored.discount_code_id ?? null);
    // Retried on every pass so a shipment that failed to book once is picked
    // up by the next webhook or poll; a no-op once the invoice carries one.
    await bookShipment(db, invoiceId, trimOrNull(stored.shipping_courier_id));
    // Every pass too: the buyer's order confirmation goes out once (claimed on
    // the ledger row), and a send that failed is retried by the next pass.
    await sendConfirmation(db, ledger.id);
    // Same for the admins' "new order paid" email.
    await sendAdminAlert(db, ledger.id, firstPaid);

    // `created` reads as "this call put the order into the fulfillment queue".
    return { created: firstPaid, invoiceId };
  } catch (err) {
    console.error('[stealth-health] materializeStealthHealthFulfillment threw:', err);
    return { created: false };
  }
}

/** Who the ledger credits for a Stealth Health stock move. */
const STOCK_ACTOR = 'stealth-health';

/**
 * Take a paid invoice's stock if it has not been taken yet, then report the
 * lines that carry no product — those took nothing and need linking by hand
 * (Stock Ledger → Needs attention). Every ledger row this writes points at the
 * invoice. Never throws.
 */
export async function takeStealthHealthStock(
  db: SupabaseClient,
  invoiceId: string,
): Promise<{ taken: boolean; unlinked: string[] }> {
  try {
    const { data: inv, error: invErr } = await db
      .from('invoices')
      .select('status, stock_adjusted')
      .eq('id', invoiceId)
      .maybeSingle();
    if (invErr) console.error('[stealth-health] stock status read failed:', invErr);
    if (!inv || inv.status !== 'paid') return { taken: false, unlinked: [] };

    let taken = false;
    if (inv.stock_adjusted !== true) {
      const res = await adjustInvoiceStock(db, invoiceId, STOCK_ACTOR);
      if (res.ok) taken = true;
      else console.error('[stealth-health] stock decrement failed for invoice %s: %s', invoiceId, res.error);
    }

    const { data: lines } = await db
      .from('invoice_line_items')
      .select('product_id, description, qty')
      .eq('invoice_id', invoiceId);
    const all = (lines ?? []) as any[];
    const productIds = [...new Set(all.map((l) => l.product_id).filter(Boolean) as string[])];
    const unlinked = all
      .filter((l) => !l.product_id)
      .map((l) => `${String(l.description ?? 'Item')} × ${Number(l.qty) || 0}`);

    if (unlinked.length > 0) {
      console.error(
        '[stealth-health] invoice %s has lines with no product — no stock taken for: %s',
        invoiceId,
        unlinked.join('; '),
      );
    }
    if (taken && productIds.length > 0) {
      const { checkLowStockForProducts } = await import('@/lib/admin/low-stock');
      await checkLowStockForProducts(db, productIds);
    }
    return { taken, unlinked };
  } catch (err) {
    console.error('[stealth-health] stock step threw:', err);
    return { taken: false, unlinked: [] };
  }
}

/**
 * Self-heal for the cron: an order the webhook or poll marked paid, but whose
 * invoice is still unpaid (the pass threw), is materialized again; a paid
 * invoice whose stock was never taken takes it now. Once the poller has seen
 * `paid` it never revisits an order, so without this a single failed pass
 * would leave the stock untouched for good. Bounded and never throws.
 */
export async function healStealthHealthPaidOrders(
  db: SupabaseClient,
  opts: { days?: number; limit?: number } = {},
): Promise<{ rematerialized: number; stockTaken: number }> {
  const since = new Date(Date.now() - (opts.days ?? 14) * 86_400_000).toISOString();
  const limit = opts.limit ?? 50;
  let rematerialized = 0;
  let stockTaken = 0;

  try {
    // 1. Paid ledger rows whose invoice is still unpaid. A row with no invoice,
    //    or one whose invoice is gone, is left alone: an admin may have deleted
    //    it on purpose, and recreating it would take stock again.
    const { data: paid } = await db
      .from('puramass_orders')
      .select('id, customer_id, customer_email, items, subtotal_cents, invoice_id, referral_code')
      .eq('status', 'paid')
      .not('invoice_id', 'is', null)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(200);
    const rows = (paid ?? []) as any[];
    const invoiceIds = rows.map((r) => r.invoice_id).filter(Boolean) as string[];
    const statusById = new Map<string, string>();
    if (invoiceIds.length > 0) {
      const { data: invs } = await db.from('invoices').select('id, status').in('id', invoiceIds);
      for (const i of (invs ?? []) as any[]) statusById.set(String(i.id), String(i.status));
    }
    const stuck = rows
      .filter((r) => {
        const status = statusById.get(String(r.invoice_id));
        return !!status && (UNPAID_HANDOFF_INVOICE_STATUSES as readonly string[]).includes(status);
      })
      .slice(0, limit);
    for (const r of stuck) {
      const res = await materializeStealthHealthFulfillment(
        db,
        {
          id: r.id,
          customer_id: r.customer_id ?? null,
          customer_email: r.customer_email ?? null,
          items: r.items ?? null,
          subtotal_cents: r.subtotal_cents ?? null,
          invoice_id: r.invoice_id ?? null,
          referral_code: r.referral_code ?? null,
        },
        null,
      );
      if (res.created) rematerialized += 1;
    }

    // 2. Paid Stealth Health invoices whose stock was never taken.
    const { data: unstocked } = await db
      .from('invoices')
      .select('id')
      .eq('source', 'stealth_health')
      .eq('status', 'paid')
      .eq('stock_adjusted', false)
      .gte('created_at', since)
      .limit(limit);
    for (const inv of (unstocked ?? []) as any[]) {
      const res = await takeStealthHealthStock(db, String(inv.id));
      if (res.taken) stockTaken += 1;
    }
  } catch (err) {
    console.error('[stealth-health] heal sweep threw:', err);
  }
  return { rematerialized, stockTaken };
}

/**
 * Everything that happens once, when an order is first known to be paid: tell
 * Klaviyo. (The admin email is claimed per order and retried on every pass —
 * see `sendAdminAlert`.)
 */
async function onFirstPaid(
  db: SupabaseClient,
  invoiceId: string,
  ledger: StealthHealthLedgerRow,
  stored: Record<string, any>,
): Promise<void> {
  // Klaviyo "Placed Order" + "Ordered Product". Once, on first payment; keyed
  // on the invoice id so Klaviyo drops any duplicate. Never throws.
  try {
    const [{ data: inv }, { data: lines }] = await Promise.all([
      db
        .from('invoices')
        .select('invoice_number, subtotal, shipping_cost, total, currency, customer_name, customer_email')
        .eq('id', invoiceId)
        .maybeSingle(),
      db
        .from('invoice_line_items')
        .select('*')
        .eq('invoice_id', invoiceId),
    ]);
    const email = (inv?.customer_email as string | null) ?? ledger.customer_email ?? null;
    if (email) {
      const { first, last } = splitName(
        (inv?.customer_name as string | null) ?? ledger.customer_name ?? null,
      );
      await trackPlacedOrder(db, {
        orderId: invoiceId,
        orderNumber: (inv?.invoice_number as string | null) ?? null,
        email,
        firstName: first,
        lastName: last,
        customerId: ledger.customer_id ?? null,
        items: ((lines ?? []) as any[]).map((l) => ({
          productId: l.product_id ?? null,
          name: String(l.description ?? 'Item'),
          quantity: Number(l.qty) || 1,
          price: Number(l.unit_price) || 0,
          variant: l.price_type === 'vial' ? 'Single vial' : 'Box',
        })),
        subtotal: Number(inv?.subtotal) || 0,
        shipping: Number(inv?.shipping_cost) || 0,
        discountCode: trimOrNull(stored.discount_code),
        total: Number(inv?.total) || 0,
        currency: String(inv?.currency ?? 'CAD'),
        source: 'stealth_health',
      });
    }
  } catch (err) {
    console.error('[stealth-health] klaviyo placed order failed:', err);
  }
}

// ---------------------------------------------------------------------------
// 3. Lapsed
// ---------------------------------------------------------------------------

/** Move unpaid hand-off invoices to `expired`. Paid ones are never touched. */
export async function expireStealthHealthInvoices(
  db: SupabaseClient,
  invoiceIds: (string | null | undefined)[],
): Promise<void> {
  const ids = [...new Set(invoiceIds.filter(Boolean) as string[])];
  if (ids.length === 0) return;
  try {
    const { error } = await db
      .from('invoices')
      .update({ status: 'expired' })
      .in('id', ids)
      .eq('status', 'pending_payment');
    if (error) console.error('[stealth-health] invoice expiry failed:', error);
  } catch (err) {
    console.error('[stealth-health] invoice expiry threw:', err);
  }
}

// ---------------------------------------------------------------------------
// Shared side effects
// ---------------------------------------------------------------------------

/**
 * Book the Easyship shipment for a paid order.
 *
 * Every paid order gets a shipment record, whatever the site-wide auto-create
 * toggle says (`force`). A buyer who chose a courier on our checkout has
 * already paid for that exact service, so it is booked as-is. A flat-fee or
 * free-shipping order picked no service — live rates weren't on screen — so
 * the fastest allowed service from a fresh quote is booked instead. The
 * shipment is a DRAFT; buying the label stays governed by
 * `easyship_auto_buy_label`.
 *
 * Imported lazily: the Easyship client builds a Supabase client at module
 * scope, which would make merely importing this module need server env.
 */
async function bookShipment(
  db: SupabaseClient,
  invoiceId: string,
  courierId: string | null,
): Promise<void> {
  try {
    const { autoCreateShipmentForInvoice } = await import('@/lib/shipping/auto-shipment');
    await autoCreateShipmentForInvoice(
      db,
      invoiceId,
      true,
      courierId ? { courierIdOverride: courierId } : { courierPreference: 'fastest' },
    );
  } catch (err) {
    console.error('[stealth-health] shipment booking failed:', err);
  }
}

/**
 * Email the buyer their paid-order confirmation, once. Imported lazily for the
 * same reason as `bookShipment`; best-effort, never breaks a webhook ACK.
 */
async function sendConfirmation(db: SupabaseClient, ledgerId: string): Promise<void> {
  try {
    const { sendStealthHealthOrderConfirmationOnce } = await import('@/lib/order-confirmation');
    const res = await sendStealthHealthOrderConfirmationOnce(db, ledgerId);
    if (!res.sent && res.reason === 'send_failed') {
      console.error(`[stealth-health] order confirmation email for ${ledgerId} failed; will retry`);
    }
  } catch (err) {
    console.error('[stealth-health] order confirmation email failed:', err);
  }
}

/**
 * Email the admin notification list that the order is paid, once (claimed on
 * the ledger row). Lazily imported and best-effort, like `sendConfirmation`.
 */
async function sendAdminAlert(db: SupabaseClient, ledgerId: string, firstPaid: boolean): Promise<void> {
  try {
    const { sendStealthHealthPaidAlertOnce } = await import('@/lib/admin/stealth-health-paid-alert');
    const res = await sendStealthHealthPaidAlertOnce(db, ledgerId, {
      transition: firstPaid,
      paidVia: 'checkout',
    });
    if (!res.sent && res.reason === 'send_failed') {
      console.error(`[stealth-health] admin paid-order email for ${ledgerId} failed; will retry`);
    }
  } catch (err) {
    console.error('[stealth-health] admin paid-order email failed:', err);
  }
}

/**
 * Credit the affiliate for this sale. Best-effort: an uncredited commission is
 * a bookkeeping problem, while a thrown error would break a webhook ACK.
 * Guarded against double credit by a unique index on `commissions.invoice_id`.
 */
async function creditAffiliate(
  db: SupabaseClient,
  ledger: StealthHealthLedgerRow,
  invoiceId: string,
  discountCodeId: string | null,
): Promise<void> {
  try {
    await recordAffiliateCommission(db, {
      invoiceId,
      subtotalCents: ledger.subtotal_cents ?? null,
      customerId: ledger.customer_id ?? null,
      referralCode: ledger.referral_code ?? null,
      discountCodeId,
    });
  } catch (err) {
    console.error('[stealth-health] affiliate commission failed:', err);
  }
}
