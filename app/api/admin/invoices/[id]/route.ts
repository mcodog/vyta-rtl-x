import { NextRequest, NextResponse, after } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import type { EasyshipHandover } from '@/lib/types/ecommerce';
import { logAuditServer } from '@/lib/admin/audit';
import { checkLowStockForProducts } from '@/lib/admin/low-stock';
import { adjustInvoiceStock } from '@/lib/admin/stock-ledger';
import { syncInvoiceBackorder } from '@/lib/admin/backorder-sync';
import {
  autoCreateShipmentForInvoice,
  normalizeCourierPreference,
} from '@/lib/shipping/auto-shipment';
import { fetchPuramassContext, isPuramassInvoice } from '@/lib/admin/puramass-invoice';
import { sendConfirmationForPaidInvoice } from '@/lib/order-confirmation';
import { sendStealthHealthPaidAlertForInvoice } from '@/lib/admin/stealth-health-paid-alert';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function verifyAdmin(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return { ok: false, role: 'customer', actor_id: null as string | null, actor_email: null as string | null };
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return { ok: false, role: 'customer', actor_id: null, actor_email: null };
  const { data } = await db.from('customers').select('id, email, role').eq('id', user.id).single();
  const role = data?.role ?? 'customer';
  return {
    ok: role === 'admin' || role === 'assistant',
    role,
    actor_id: data?.id ?? user.id,
    actor_email: data?.email ?? user.email ?? null,
  };
}

// GET /api/admin/invoices/[id]
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { ok } = await verifyAdmin(req);
  if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const { data: invoice, error } = await db
    .from('invoices')
    .select(`*, customers!invoices_customer_id_fkey (first_name, last_name, email, phone)`)
    .eq('id', params.id)
    .single();

  if (error || !invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  }

  const { data: lineItems } = await db
    .from('invoice_line_items')
    .select('*')
    .eq('invoice_id', params.id);

  const { data: payments } = await db
    .from('payments')
    .select('*')
    .eq('invoice_id', params.id)
    .order('paid_at', { ascending: false });

  const amountPaid = (payments ?? []).reduce((s, p) => s + Number(p.amount), 0);

  // A Stealth Health hand-off carries none of the buyer's shipping detail on the
  // invoice itself — Stealth Health collects it on its hosted page and reports it
  // onto the hand-off ledger. Attach that so the detail view (and its PDF) can
  // show where the parcel goes, and label it as Stealth Health-sourced.
  const puramass = isPuramassInvoice(invoice)
    ? await fetchPuramassContext(db, invoice.id)
    : null;

  return NextResponse.json({
    invoice: {
      ...invoice,
      // Prefer the linked account, then whatever was denormalised onto the
      // invoice, then what Stealth Health captured. The last two matter for guest
      // sales, which have no `customers` row to join.
      customer_name: invoice.customers
        ? `${invoice.customers.first_name} ${invoice.customers.last_name}`
        : (invoice.customer_name ?? puramass?.customer_name ?? null),
      customer_email:
        invoice.customers?.email ?? invoice.customer_email ?? puramass?.customer_email ?? null,
      customer_phone:
        invoice.customers?.phone ?? invoice.customer_phone ?? puramass?.customer_phone ?? null,
      puramass,
    },
    line_items: lineItems ?? [],
    payments: payments ?? [],
    amount_paid: amountPaid,
    amount_due: Number(invoice.total) - amountPaid,
  });
}

// PATCH /api/admin/invoices/[id]
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { ok, role, actor_id, actor_email } = await verifyAdmin(req);
  if (!ok || role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const body = await req.json();
  const scalarFields = [
    'status', 'due_date', 'notes', 'currency',
    'customer_id', 'customer_name', 'customer_email', 'customer_phone',
    'subtotal', 'tax_total', 'shipping_cost', 'total',
    'sales_person_id', 'sales_person_commission_rate', 'sales_person_commission_amount',
    'with_labels', 'processing_fee', 'show_processing_fee',
    'fulfillment_type', 'fulfillment_status',
    'ships_to_client', 'client_id',
  ];
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const key of scalarFields) {
    if (key in body) updates[key] = body[key];
  }

  // Derive commission amount when salesperson + total provided
  if ('sales_person_id' in body && body.sales_person_id) {
    const rate = Number(body.sales_person_commission_rate ?? 0);
    const total = Number(body.total ?? 0);
    updates.sales_person_commission_rate = rate;
    updates.sales_person_commission_amount = +(total * (rate / 100)).toFixed(2);
  } else if ('sales_person_id' in body && !body.sales_person_id) {
    updates.sales_person_commission_rate = 0;
    updates.sales_person_commission_amount = 0;
  }

  // Capture the prior status so we can detect the first transition to paid.
  const { data: priorInv } = await db
    .from('invoices')
    .select('status, is_backorder')
    .eq('id', params.id)
    .single();
  const wasPaid = priorInv?.status === 'paid';

  const { error } = await db.from('invoices').update(updates).eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Replace line items if provided
  if (Array.isArray(body.line_items)) {
    const { error: delErr } = await db
      .from('invoice_line_items')
      .delete()
      .eq('invoice_id', params.id);
    if (delErr) {
      return NextResponse.json({ error: delErr.message }, { status: 500 });
    }

    const rows = (body.line_items as any[]).map((li) => ({
      invoice_id: params.id,
      product_id: li.product_id ?? null,
      product_variant_id: li.product_variant_id ?? null,
      description: li.description,
      qty: li.qty ?? 1,
      unit_price: li.unit_price,
      discount_pct: li.discount_pct ?? 0,
      price_type: li.price_type === 'vial' ? 'vial' : 'box',
      line_total:
        li.line_total ??
        li.unit_price * (li.qty ?? 1) * (1 - (li.discount_pct ?? 0) / 100),
    }));

    if (rows.length > 0) {
      const { error: insErr } = await db.from('invoice_line_items').insert(rows);
      if (insErr) {
        return NextResponse.json({ error: insErr.message }, { status: 500 });
      }
    }

    // Recompute the open backorder from the new lines. Backorder invoices are
    // skipped (their backorder was created at split time). Best-effort.
    if (!priorInv?.is_backorder) {
      await syncInvoiceBackorder(
        db,
        params.id,
        (body.line_items as any[]).map((li) => ({
          product_id: li.product_id ?? null,
          description: li.description,
          qty: Number(li.qty) || 0,
          unit_price: Number(li.unit_price) || 0,
        })),
      ).catch((e) => console.error('syncInvoiceBackorder failed:', e));
    }
  }

  // Re-sync pending sales commission record (don't touch already-paid ones)
  if ('sales_person_id' in body) {
    const newRate = Number(updates.sales_person_commission_rate ?? 0);
    const newAmount = Number(updates.sales_person_commission_amount ?? 0);
    const newTotal = Number(body.total ?? 0);

    // Wipe any existing pending records for this invoice
    await db
      .from('sales_commissions')
      .delete()
      .eq('invoice_id', params.id)
      .eq('status', 'pending');

    if (body.sales_person_id && newAmount > 0) {
      await db.from('sales_commissions').insert({
        sales_person_id: body.sales_person_id,
        invoice_id: params.id,
        amount: newAmount,
        invoice_total: newTotal,
        commission_rate: newRate,
        status: 'pending',
      });
    }
  }

  // First transition into `paid` decrements stock once (idempotent in the DB).
  if (body.status === 'paid' && !wasPaid) {
    const stock = await adjustInvoiceStock(db, params.id, actor_email);
    if (!stock.ok) console.error('adjust_stock_for_invoice failed:', stock.error);
    const { data: lines } = await db
      .from('invoice_line_items')
      .select('product_id')
      .eq('invoice_id', params.id);
    const productIds = (lines ?? []).map((l: any) => l.product_id).filter(Boolean);
    if (productIds.length) await checkLowStockForProducts(db, productIds);

    // Email the customer their order confirmation, and the admins the
    // "new order paid" alert for a Stealth Health hand-off (each once, after
    // the response).
    after(() => sendConfirmationForPaidInvoice(db, params.id));
    after(() => sendStealthHealthPaidAlertForInvoice(db, params.id));
  }

  // Cancelling an invoice that had already decremented stock restores it.
  // The DB RPC is guarded on `stock_adjusted`, so double-cancels are safe.
  if (body.status === 'cancelled' && priorInv?.status !== 'cancelled') {
    await db.rpc('restore_stock_for_invoice', { p_invoice_id: params.id, p_actor_email: actor_email });
  }

  await logAuditServer(db, { actor_id, actor_email }, {
    action: 'status' in body && Object.keys(body).length === 1 ? 'invoice.status_change' : 'invoice.update',
    entity_type: 'invoice',
    entity_id: params.id,
  });

  // Opt-in Easyship shipment on edit save. Fires post-response via after() so
  // the PATCH doesn't wait on a network round-trip. Idempotent — the helper
  // skips when the invoice (or its order) already has a shipment, and routes
  // itself to the order when there is one, or to the invoice when there isn't
  // (Stealth Health hand-offs, which never get an order row).
  if (body.create_easyship_shipment) {
    after(async () => {
      await autoCreateShipmentForInvoice(db, params.id, true, {
        courierIdOverride: body.easyship_courier_id ? String(body.easyship_courier_id) : undefined,
        courierPreference: normalizeCourierPreference(body.easyship_courier_preference),
        insured: !!body.easyship_insured,
        handover: (body.easyship_handover as EasyshipHandover | undefined) ?? undefined,
        buyLabel: !!body.easyship_buy_label,
      });
    });
  }

  return NextResponse.json({ success: true });
}

// DELETE /api/admin/invoices/[id]
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { ok, role, actor_id, actor_email } = await verifyAdmin(req);
  if (!ok || role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const { error } = await db.from('invoices').delete().eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAuditServer(db, { actor_id, actor_email }, {
    action: 'invoice.delete',
    entity_type: 'invoice',
    entity_id: params.id,
  });

  return NextResponse.json({ success: true });
}
