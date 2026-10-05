// Server-only helper: create a complete invoice record from an order.
//
// Runs with the service-role client passed in by the caller (order-creation
// API routes already hold one), so it inserts directly into `invoices` /
// `invoice_line_items` instead of going through the authenticated HTTP invoice
// API — that path relies on a browser session token and silently fails when
// called from the server.
//
// The invoice is created as a `draft` (orders are unpaid at placement) and
// carries the order's full customer + money detail so nothing has to be
// back-filled later. One invoice per order (uniq_invoices_order_id), so this is
// idempotent and safe to call from every order-creation site.

import { addDays, todayInAppTz } from '@/lib/datetime';
import type { SupabaseClient } from '@supabase/supabase-js';

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export interface OrderInvoiceResult {
  ok: boolean;
  invoice_id?: string;
  created?: boolean;
  error?: string;
}

interface DraftLine {
  product_variant_id: string | null;
  description: string;
  qty: number;
  unit_price: number;
  discount_pct: number;
  line_total: number;
  /** Box vs vial pricing marker, mirrored onto the invoice line. */
  price_type: 'box' | 'vial';
}

export async function createInvoiceForOrder(
  db: SupabaseClient,
  orderId: string,
): Promise<OrderInvoiceResult> {
  // Idempotent: reuse the order's existing invoice if there is one.
  const { data: existing } = await db
    .from('invoices')
    .select('id')
    .eq('order_id', orderId)
    .maybeSingle();
  if (existing?.id) {
    return { ok: true, invoice_id: existing.id, created: false };
  }

  const { data: order, error: orderErr } = await db
    .from('orders')
    .select('*, order_items(*)')
    .eq('id', orderId)
    .single();
  if (orderErr || !order) return { ok: false, error: 'Order not found' };

  // Line items: prefer the relational order_items table, fall back to the
  // orders.items JSONB column (the storefront e-Transfer checkout only writes
  // JSONB).
  const rawItems =
    Array.isArray(order.order_items) && order.order_items.length > 0
      ? order.order_items
      : Array.isArray(order.items)
        ? order.items
        : [];

  const lines: DraftLine[] = rawItems.map((it: any): DraftLine => {
    const qty = Number(it.qty ?? it.quantity ?? 1) || 1;
    const unit_price = Number(it.unit_price ?? it.price_at_time ?? it.price ?? 0) || 0;
    const discount_pct = Number(it.discount_pct ?? 0) || 0;
    const baseName = it.name_snapshot ?? it.product_name ?? it.name ?? 'Product';
    // Spell out what was actually ordered — a single vial vs. a pack of N —
    // so the invoice line is unambiguous. Storefront JSONB lines carry
    // `pack_size` (and, on orders placed before pack options,
    // `unit`/`vials_per_box`); relational/admin lines usually carry none.
    const vialsPerBox = Number(it.vials_per_box) > 0 ? Number(it.vials_per_box) : 10;
    const packSize =
      Number(it.pack_size) > 0
        ? Math.floor(Number(it.pack_size))
        : it.unit === 'case' ? vialsPerBox : it.unit === 'vial' ? 1 : 0;
    const description =
      packSize > 1
        ? `${baseName} — Pack of ${packSize} (${qty * packSize} vials)`
        : packSize === 1
          ? `${baseName} — Single vial`
          : baseName;
    // Carry the unit onto the invoice line too. `invoice_line_items.price_type`
    // is NOT NULL DEFAULT 'box', so leaving it off made every single-vial line
    // render a "Box" chip on the invoice PDF and the packing list — silently
    // contradicting the description we just built. Prefer an explicit
    // order_items.price_type, else derive it from the storefront's `unit`.
    const price_type: 'box' | 'vial' =
      it.price_type === 'vial' || it.price_type === 'box'
        ? it.price_type
        : packSize === 1
          ? 'vial'
          : 'box';
    return {
      product_variant_id: it.product_variant_id ?? null,
      description,
      qty,
      unit_price,
      discount_pct,
      line_total: round2(qty * unit_price * (1 - discount_pct / 100)),
      price_type,
    };
  });

  if (lines.length === 0) {
    return { ok: false, error: 'Order has no line items to invoice' };
  }

  // The invoices schema has no order-level discount field (only per-line
  // discount_pct), so prorate any order discount across the lines. That keeps
  // the invoice internally consistent — subtotal + tax + shipping == total —
  // and matches what the customer paid.
  const orderDiscount = round2(order.discount_total ?? order.discount_amount ?? 0);
  if (orderDiscount > 0) {
    const base = round2(lines.reduce((s, l) => s + l.line_total, 0));
    const frac = base > 0 ? Math.min(orderDiscount / base, 1) : 0;
    for (const l of lines) {
      const gross = l.qty * l.unit_price;
      const discounted = round2(l.line_total * (1 - frac));
      l.line_total = discounted;
      l.discount_pct =
        gross > 0 ? round2(100 * (1 - discounted / gross)) : l.discount_pct;
    }
  }

  // Money: subtotal from the (discounted) lines, then tax + shipping from the
  // order. Total is derived so the invoice always reconciles.
  const subtotal = round2(lines.reduce((s, l) => s + l.line_total, 0));
  const tax_total = round2(order.tax_total ?? 0);
  const shipping_cost = round2(order.shipping_cost ?? 0);
  const total = round2(subtotal + tax_total + shipping_cost);
  const currency = order.currency === 'USD' ? 'USD' : 'CAD';

  // Complete customer header, including guest orders that only carry an email
  // + shipping address (no linked customer record).
  const ship =
    order.shipping_address && typeof order.shipping_address === 'object'
      ? (order.shipping_address as Record<string, any>)
      : null;
  let customer_name: string | null = null;
  let customer_email: string | null = order.email ?? ship?.email ?? null;
  let customer_phone: string | null = ship?.phone ?? null;

  if (order.customer_id) {
    const { data: cust } = await db
      .from('customers')
      .select('first_name, last_name, email, phone')
      .eq('id', order.customer_id)
      .maybeSingle();
    if (cust) {
      customer_name =
        `${cust.first_name ?? ''} ${cust.last_name ?? ''}`.trim() || null;
      customer_email = cust.email ?? customer_email;
      customer_phone = cust.phone ?? customer_phone;
    }
  }
  if (!customer_name && ship) {
    customer_name =
      `${ship.firstName ?? ''} ${ship.lastName ?? ''}`.trim() || null;
  }

  const issueDate = todayInAppTz();
  const dueDate = addDays(issueDate, 30);

  const { data: invoice, error: invErr } = await db
    .from('invoices')
    .insert({
      order_id: orderId,
      customer_id: order.customer_id ?? null,
      customer_name,
      customer_email,
      customer_phone,
      status: 'draft',
      currency,
      issue_date: issueDate,
      due_date: dueDate,
      subtotal,
      tax_total,
      shipping_cost,
      total,
      fulfillment_type: order.fulfillment_type ?? 'shipment',
      fulfillment_status: 'pending',
      notes: order.notes ?? null,
      // Carry the order's stock flag so marking the invoice paid later doesn't
      // double-decrement goods the order already adjusted.
      stock_adjusted: !!order.stock_adjusted,
    })
    .select('id')
    .single();

  if (invErr || !invoice) {
    // A concurrent creator may have won the uniq_invoices_order_id race.
    const { data: raced } = await db
      .from('invoices')
      .select('id')
      .eq('order_id', orderId)
      .maybeSingle();
    if (raced?.id) return { ok: true, invoice_id: raced.id, created: false };
    return { ok: false, error: invErr?.message ?? 'Failed to create invoice' };
  }

  const lineRows = lines.map((l) => ({
    invoice_id: invoice.id,
    product_variant_id: l.product_variant_id,
    description: l.description,
    qty: l.qty,
    unit_price: l.unit_price,
    discount_pct: l.discount_pct,
    line_total: l.line_total,
    price_type: l.price_type,
  }));
  const { error: lineErr } = await db
    .from('invoice_line_items')
    .insert(lineRows);
  if (lineErr) {
    console.error('order invoice line-item insert error:', lineErr);
  }

  return { ok: true, invoice_id: invoice.id, created: true };
}
