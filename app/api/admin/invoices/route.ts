import { NextRequest, NextResponse, after } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import type { InvoiceStatus, EasyshipHandover } from '@/lib/types/ecommerce';
import { logAuditServer } from '@/lib/admin/audit';
import { getInvoiceCaller, callerCanWrite } from '@/lib/admin/invoice-access';
import { effectiveStatus } from '@/lib/admin/invoice-status';
import { computeStockSplit, type SplitLine, type ComputedLine } from '@/lib/admin/invoice-split';
import { checkLowStockForProducts } from '@/lib/admin/low-stock';
import { adjustInvoiceStock } from '@/lib/admin/stock-ledger';
import { sendConfirmationForPaidInvoice } from '@/lib/order-confirmation';
import {
  autoCreateShipmentForOrder,
  autoCreateShipmentForInvoice,
  normalizeCourierPreference,
} from '@/lib/shipping/auto-shipment';
import {
  fetchPuramassContexts,
  PURAMASS_INVOICE_SOURCE,
  type PuramassInvoiceContext,
} from '@/lib/admin/puramass-invoice';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function lineTotalOf(li: any): number {
  const qty = Number(li.qty) || 0;
  const unit = Number(li.unit_price) || 0;
  const disc = Number(li.discount_pct) || 0;
  return round2(qty * unit * (1 - disc / 100));
}

// GET /api/admin/invoices  → { invoices, total, stats }
export async function GET(req: NextRequest) {
  const caller = await getInvoiceCaller(db, req);
  if (!caller.ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const status = sp.get('status') as InvoiceStatus | null;
  const customerId = sp.get('customer_id');
  // Origin filter: Stealth Health hand-offs vs invoices raised in this admin.
  const source = sp.get('source');
  const q = (sp.get('q') ?? '').trim().toLowerCase();
  const limit = Math.min(Math.max(Number(sp.get('limit')) || 20, 1), 100);
  const offset = Math.max(Number(sp.get('offset')) || 0, 0);

  // Belt-and-suspenders: sweep overdue before reading.
  await db.rpc('mark_overdue_invoices');

  // Scope set = status + customer filter (NOT search/pagination), so the
  // summary cards stay accurate while paging/searching.
  let query = db
    .from('invoices')
    .select(`
      *,
      customers!invoices_customer_id_fkey (first_name, last_name, email),
      sales_persons (first_name, last_name, email)
    `)
    .order('created_at', { ascending: false });

  if (status) query = query.eq('status', status);
  if (customerId) query = query.eq('customer_id', customerId);
  // Part of the scope set (like status), so the summary cards follow the filter.
  // `manual` has to spell out the NULL case: in SQL `source <> 'x'` drops NULLs,
  // and every hand-written invoice has a NULL source.
  if (source === 'puramass') query = query.eq('source', PURAMASS_INVOICE_SOURCE);
  else if (source === 'manual') {
    query = query.or(`source.is.null,source.neq.${PURAMASS_INVOICE_SOURCE}`);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = data ?? [];

  // Derive amount_paid per invoice from payments.
  const ids = rows.map((r: any) => r.id);
  const paidMap = new Map<string, number>();
  if (ids.length) {
    const { data: pmts } = await db
      .from('payments')
      .select('invoice_id, amount')
      .in('invoice_id', ids);
    for (const p of pmts ?? []) {
      paidMap.set(p.invoice_id, (paidMap.get(p.invoice_id) ?? 0) + Number(p.amount));
    }
  }

  // Stealth Health hand-offs keep the buyer's contact + shipping address on the
  // hand-off ledger, not on the invoice. Pull it for the Stealth Health rows in scope
  // so the table can show where the parcel is going, and so a search can match
  // a transaction id or a phone number the invoice row doesn't carry.
  const puramassCtx = await fetchPuramassContexts(
    db,
    rows.filter((r: any) => r.source === PURAMASS_INVOICE_SOURCE).map((r: any) => r.id),
  );

  const enriched = rows.map((inv: any) => {
    const amount_paid = round2(paidMap.get(inv.id) ?? 0);
    const amount_due = round2(Math.max(0, Number(inv.total) - amount_paid));
    const puramass: PuramassInvoiceContext | null = puramassCtx.get(inv.id) ?? null;
    // A Stealth Health buyer is usually a guest here — fall back to the name/email
    // Stealth Health captured on its hosted page before showing an empty cell.
    const customer_name_display = inv.customers
      ? `${inv.customers.first_name} ${inv.customers.last_name}`
      : (inv.customer_name ?? puramass?.customer_name ?? null);
    const customer_email_display =
      inv.customers?.email ?? inv.customer_email ?? puramass?.customer_email ?? null;
    return {
      ...inv,
      amount_paid,
      amount_due,
      status_effective: effectiveStatus(inv.status, inv.due_date),
      customer_name_display,
      customer_email_display,
      sales_person_name: inv.sales_persons
        ? `${inv.sales_persons.first_name} ${inv.sales_persons.last_name}`
        : null,
      puramass,
    };
  });

  // Stats over the whole scope set (independent of search + pagination).
  const stats = {
    count: enriched.length,
    outstanding: round2(
      enriched
        // Unpaid Stealth Health hand-offs are not receivables: the buyer pays
        // on the Stealth Health checkout or not at all.
        .filter(
          (i) =>
            i.status_effective !== 'paid' &&
            i.status_effective !== 'draft' &&
            i.status_effective !== 'pending_payment' &&
            i.status_effective !== 'expired',
        )
        .reduce((s, i) => s + i.amount_due, 0),
    ),
    overdueCount: enriched.filter((i) => i.status_effective === 'overdue').length,
    paid: enriched.filter((i) => i.status_effective === 'paid').length,
  };

  // Apply search over invoice number + denormalized/linked customer fields.
  // Stealth Health rows also match on what only the hand-off ledger knows: the
  // transaction id / our partner reference, the buyer's phone, and the city the
  // parcel is going to.
  const matched = q
    ? enriched.filter((i) => {
        const pm = i.puramass;
        const addr = pm?.shipping_address;
        return [
          i.invoice_number,
          i.customer_name_display,
          i.customer_email_display,
          pm?.transaction_id,
          pm?.partner_reference,
          pm?.customer_phone,
          addr?.city,
          addr?.state,
          addr?.zip,
        ].some((f) => (f ?? '').toLowerCase().includes(q));
      })
    : enriched;

  const total = matched.length;
  const invoices = matched.slice(offset, offset + limit);

  return NextResponse.json({ invoices, total, stats });
}

const ALLOWED_INVOICE_STATUS: InvoiceStatus[] = ['draft', 'sent', 'partial', 'paid', 'overdue'];

interface InsertInvoiceArgs {
  base: Record<string, unknown>;       // order_id, customer_*, due_date, notes
  status: InvoiceStatus;
  is_backorder: boolean;
  parent_invoice_id: string | null;
  lines: ComputedLine[];
  subtotal: number;
  tax_total: number;
  shipping_cost: number;
  total: number;
  sales_person_id: string | null;
  commission_rate: number;
}

/**
 * Insert one invoice (header + lines) and its per-invoice side effects:
 * commission row, audit entry, and stock decrement when created as `paid`.
 * Returns the inserted invoice row, or an error message.
 */
async function insertInvoice(
  caller: { actor_id: string | null; actor_email: string | null },
  args: InsertInvoiceArgs,
): Promise<{ invoice?: any; error?: string }> {
  const commissionAmount = args.sales_person_id ? round2(args.total * (args.commission_rate / 100)) : 0;

  const { data: invoice, error: invErr } = await db
    .from('invoices')
    .insert({
      ...args.base,
      subtotal: args.subtotal,
      tax_total: args.tax_total,
      shipping_cost: args.shipping_cost,
      total: args.total,
      status: args.status,
      is_backorder: args.is_backorder,
      parent_invoice_id: args.parent_invoice_id,
      sales_person_id: args.sales_person_id ?? null,
      sales_person_commission_rate: args.sales_person_id ? args.commission_rate : 0,
      sales_person_commission_amount: commissionAmount,
    })
    .select()
    .single();

  if (invErr || !invoice) {
    return { error: invErr?.message ?? 'Failed to create invoice' };
  }

  if (args.sales_person_id && commissionAmount > 0) {
    const { error: commErr } = await db.from('sales_commissions').insert({
      sales_person_id: args.sales_person_id,
      invoice_id: invoice.id,
      amount: commissionAmount,
      invoice_total: args.total,
      commission_rate: args.commission_rate,
      status: 'pending',
    });
    if (commErr) console.error('sales commission insert error:', commErr);
  }

  const lineRows = args.lines.map((li) => ({
    invoice_id: invoice.id,
    product_id: li.product_id ?? null,
    product_variant_id: li.product_variant_id ?? null,
    description: li.description,
    qty: li.qty,
    unit_price: li.unit_price,
    discount_pct: li.discount_pct,
    price_type: li.price_type === 'vial' ? 'vial' : 'box',
    line_total: li.line_total,
  }));
  const { error: lineErr } = await db.from('invoice_line_items').insert(lineRows);
  if (lineErr) console.error('line item insert error:', lineErr);

  // Created-as-paid decrements stock once (idempotent in the DB).
  if (args.status === 'paid') {
    const stock = await adjustInvoiceStock(db, invoice.id, caller.actor_email);
    if (!stock.ok) console.error('adjust_stock_for_invoice failed:', stock.error);
    const productIds = args.lines.map((l) => l.product_id).filter(Boolean) as string[];
    if (productIds.length) await checkLowStockForProducts(db, productIds);

    // Created already paid against an order: confirm it to the customer
    // (once, after the response). A manual invoice has no order and is skipped.
    if (args.base.order_id) {
      after(() => sendConfirmationForPaidInvoice(db, invoice.id));
    }
  }

  await logAuditServer(db, { actor_id: caller.actor_id, actor_email: caller.actor_email }, {
    action: args.is_backorder ? 'invoice.create_backorder' : 'invoice.create',
    entity_type: 'invoice',
    entity_id: invoice.id,
  });

  return { invoice };
}

// POST /api/admin/invoices
export async function POST(req: NextRequest) {
  const caller = await getInvoiceCaller(db, req);
  if (!caller.ok || !callerCanWrite(caller.role)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const body = await req.json();
  const {
    order_id,
    customer_id,
    customer_name,
    customer_email,
    customer_phone,
    due_date,
    tax_total,
    shipping_cost,
    notes,
    currency,
    with_labels,
    processing_fee,
    show_processing_fee,
    fulfillment_type,
    ships_to_client,
    client_id,
    // Easyship shipment options — opt-in per invoice. When
    // create_easyship_shipment is true and the invoice is bound to an order,
    // an Easyship shipment is created post-response via `after()`. Never
    // blocks the invoice save; failures land in shipment_auto_logs.
    create_easyship_shipment,
    easyship_courier_id,
    easyship_courier_preference,
    easyship_buy_label,
    easyship_insured,
    easyship_handover,
    line_items,
    sales_person_id,
    sales_person_commission_rate,
    status: requestedStatus,
  } = body;

  if (!line_items?.length) {
    return NextResponse.json({ error: 'At least one line item is required' }, { status: 400 });
  }

  const status: InvoiceStatus = ALLOWED_INVOICE_STATUS.includes(requestedStatus) ? requestedStatus : 'draft';

  // Money is always recomputed server-side — never trusted from the client.
  const cleanLines: SplitLine[] = (line_items as any[]).map((li) => ({
    product_id: li.product_id ?? null,
    product_variant_id: li.product_variant_id ?? null,
    description: li.description,
    qty: Number(li.qty) || 1,
    unit_price: Number(li.unit_price) || 0,
    discount_pct: Number(li.discount_pct) || 0,
    // Carry the box/vial marker straight through to insertInvoice so the
    // detail view, print HTML and PDF can label the line correctly.
    price_type: li.price_type === 'vial' ? 'vial' : 'box',
  }));

  // Effective tax rate from the client's absolute tax_total, so it can be
  // re-derived for each half of a split.
  const subtotalFull = round2(cleanLines.reduce((s, li) => s + lineTotalOf(li), 0));
  const shipping = round2(shipping_cost);
  const taxFull = round2(tax_total);
  const effRate = subtotalFull > 0 ? taxFull / subtotalFull : 0;
  const rate = Number(sales_person_commission_rate) || 0;

  const baseFields = {
    order_id: order_id ?? null,
    customer_id: customer_id ?? null,
    customer_name: customer_name ?? null,
    customer_email: customer_email ?? null,
    customer_phone: customer_phone ?? null,
    due_date: due_date ?? undefined,
    notes: notes ?? null,
    currency: currency === 'USD' ? 'USD' : 'CAD',
    with_labels: with_labels === false ? false : true,
    processing_fee: Number(processing_fee) || 0,
    show_processing_fee: show_processing_fee !== false,
    fulfillment_type: fulfillment_type === 'pickup' ? 'pickup' : 'shipment',
    // Ships-to-Client (drop-ship). Only meaningful for shipment invoices —
    // pickup can't ship to anyone. client_id must reference customer_clients.
    ships_to_client: fulfillment_type !== 'pickup' && !!ships_to_client,
    client_id: fulfillment_type !== 'pickup' && ships_to_client ? (client_id ?? null) : null,
  };

  // Look up current stock for product-bearing lines, then split.
  const productIds = Array.from(new Set(cleanLines.map((l) => l.product_id).filter(Boolean) as string[]));
  const stockMap = new Map<string, number>();
  if (productIds.length) {
    const { data: products } = await db
      .from('products')
      .select('id, stock_quantity')
      .in('id', productIds);
    for (const p of products ?? []) stockMap.set(p.id, Number(p.stock_quantity) || 0);
  }

  const { inStock, backordered, backorderItems } = computeStockSplit(cleanLines, stockMap);

  // Auto-shipment helper. Schedules the Easyship shipment creation
  // post-response so the invoice save never waits on a network round-trip.
  //
  // Anchored on the order when the invoice has one; otherwise on the invoice
  // itself, which is what makes a Stealth Health hand-off (no order
  // row by design) shippable — its destination comes from the hand-off ledger.
  function scheduleAutoShipment(
    invoiceIdForShip: string | null | undefined,
    orderIdForShip: string | null | undefined,
  ) {
    if (!create_easyship_shipment) return;
    if ((baseFields.fulfillment_type as string) === 'pickup') return;
    const shipmentOpts = {
      courierIdOverride: easyship_courier_id ? String(easyship_courier_id) : undefined,
      courierPreference: normalizeCourierPreference(easyship_courier_preference),
      insured: !!easyship_insured,
      handover: (easyship_handover as EasyshipHandover | undefined) ?? undefined,
      buyLabel: !!easyship_buy_label,
    };
    if (orderIdForShip) {
      after(async () => {
        const { data: ord } = await db
          .from('orders')
          .select('id, easyship_shipment_id, easyship_courier_id, fulfillment_type, shipping_address, email, total')
          .eq('id', orderIdForShip)
          .maybeSingle();
        if (!ord) return;
        await autoCreateShipmentForOrder(db, ord as any, true, shipmentOpts);
      });
      return;
    }
    if (!invoiceIdForShip) return;
    after(async () => {
      await autoCreateShipmentForInvoice(db, invoiceIdForShip, true, shipmentOpts);
    });
  }

  const moneyFor = (lines: ComputedLine[], withShipping: boolean) => {
    const sub = round2(lines.reduce((s, l) => s + l.line_total, 0));
    const tax = round2(sub * effRate);
    const ship = withShipping ? shipping : 0;
    return { subtotal: sub, tax_total: tax, shipping_cost: ship, total: round2(sub + tax + ship) };
  };

  // No shortfall: a single invoice, exactly as before.
  if (backordered.length === 0) {
    const m = moneyFor(inStock, true);
    const { invoice, error } = await insertInvoice(caller, {
      base: baseFields,
      status,
      is_backorder: false,
      parent_invoice_id: null,
      lines: inStock,
      ...m,
      sales_person_id: sales_person_id ?? null,
      commission_rate: rate,
    });
    if (error) return NextResponse.json({ error }, { status: 500 });
    scheduleAutoShipment(invoice?.id ?? null, order_id ?? null);
    return NextResponse.json({ invoice }, { status: 201 });
  }

  // Shortfall → split into primary (in-stock) + backorder invoice.
  let primary: any = null;
  if (inStock.length > 0) {
    const m = moneyFor(inStock, true);
    const res = await insertInvoice(caller, {
      base: baseFields,
      status,
      is_backorder: false,
      parent_invoice_id: null,
      lines: inStock,
      ...m,
      sales_person_id: sales_person_id ?? null,
      commission_rate: rate,
    });
    if (res.error) return NextResponse.json({ error: res.error }, { status: 500 });
    primary = res.invoice;
  }

  // The backordered portion can't be fulfilled yet, so it is always a draft
  // and never decrements stock. Shipping rides on the primary when present.
  const backMoney = moneyFor(backordered, !primary);
  const backRes = await insertInvoice(caller, {
    base: baseFields,
    status: 'draft',
    is_backorder: true,
    parent_invoice_id: primary?.id ?? null,
    lines: backordered,
    ...backMoney,
    sales_person_id: sales_person_id ?? null,
    commission_rate: rate,
  });
  if (backRes.error || !backRes.invoice) {
    return NextResponse.json({ error: backRes.error ?? 'Failed to create backorder invoice' }, { status: 500 });
  }
  const backInvoice = backRes.invoice;

  // Record the open backorder against the backorder invoice.
  const { data: bo, error: boErr } = await db
    .from('backorders')
    .insert({ invoice_id: backInvoice.id, status: 'open' })
    .select('id')
    .single();
  if (boErr || !bo) {
    console.error('backorder create error:', boErr);
  } else {
    const { error: biErr } = await db.from('backorder_items').insert(
      backorderItems.map((it) => ({ ...it, backorder_id: bo.id })),
    );
    if (biErr) console.error('backorder items insert error:', biErr);
  }

  // Split path: only the primary invoice ships. Backorder halves never carry
  // a shipment (they're drafts until stock arrives).
  if (primary) scheduleAutoShipment(primary.id ?? null, order_id ?? null);

  return NextResponse.json(
    { invoice: primary ?? backInvoice, backorder_invoice: backInvoice, split: true },
    { status: 201 },
  );
}

// DELETE /api/admin/invoices  → bulk delete
//
// Body: { ids: string[] }. Unlike the single-invoice DELETE (which leaves
// the parent order alone), the bulk operation is treated as a full teardown:
// the linked orders are removed too, and any crypto wallet addresses bound
// to those orders are released back to the pool (order_id = null) instead
// of being permanently destroyed.
export async function DELETE(req: NextRequest) {
  const caller = await getInvoiceCaller(db, req);
  if (!caller.ok || !callerCanWrite(caller.role)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const ids = Array.isArray(body.ids)
    ? (body.ids as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: 'ids[] is required' }, { status: 400 });
  }

  // Pull the invoices' order_ids first — cascading FKs on invoice children
  // (line items, payments, backorders, email logs) fire when the invoice
  // rows go, but we need the order references *before* the invoices vanish.
  const { data: rows, error: readErr } = await db
    .from('invoices')
    .select('id, order_id')
    .in('id', ids);
  if (readErr) {
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  }
  const orderIds = Array.from(
    new Set((rows ?? []).map((r) => r.order_id).filter(Boolean) as string[]),
  );

  // Delete invoices (cascades take care of line_items / payments / backorders /
  // invoice_email_log via ON DELETE CASCADE).
  const { error: invDelErr } = await db.from('invoices').delete().in('id', ids);
  if (invDelErr) {
    return NextResponse.json({ error: invDelErr.message }, { status: 500 });
  }

  // Release any crypto wallet addresses bound to those orders back to the
  // pool. Nulling `order_id` (rather than deleting the row) preserves the
  // address for reuse — bulk invoice teardown shouldn't shrink the pool.
  let ordersDeleted = 0;
  if (orderIds.length > 0) {
    await db.from('sol_addresses').update({ order_id: null }).in('order_id', orderIds);
    const { error: ordDelErr, count } = await db
      .from('orders')
      .delete({ count: 'exact' })
      .in('id', orderIds);
    if (ordDelErr) {
      // Invoices are already gone at this point — surface the order-delete
      // failure so the caller can retry the order cleanup, but don't fake a
      // rollback the DB can't give us.
      return NextResponse.json(
        { error: `Invoices deleted, but order cleanup failed: ${ordDelErr.message}` },
        { status: 500 },
      );
    }
    ordersDeleted = count ?? 0;
  }

  for (const id of ids) {
    await logAuditServer(
      db,
      { actor_id: caller.actor_id, actor_email: caller.actor_email },
      { action: 'invoice.delete', entity_type: 'invoice', entity_id: id },
    );
  }

  return NextResponse.json({
    ok: true,
    deleted: ids.length,
    ordersDeleted,
  });
}
