import { NextRequest, NextResponse, after } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createInvoiceForOrder } from '@/lib/admin/order-invoice-server';
import { logAuditServer } from '@/lib/admin/audit';
import { adjustStockForConfirmedOrder, restoreStockForCancelledOrder } from '@/lib/order-stock';
import { trackOrderStatusById } from '@/lib/klaviyo/events';
import { sendStorefrontOrderConfirmationOnce } from '@/lib/order-confirmation';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function verifyAdmin(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return { ok: false, userId: null as string | null, role: 'customer', actor_email: null as string | null };
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return { ok: false, userId: null, role: 'customer', actor_email: null };
  const { data } = await db.from('customers').select('role, email').eq('id', user.id).single();
  const role = data?.role ?? 'customer';
  return { ok: role === 'admin' || role === 'assistant', userId: user.id, role, actor_email: data?.email ?? user.email ?? null };
}

// GET /api/admin/orders/[id]
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { ok } = await verifyAdmin(req);
  if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const { data: order, error } = await db
    .from('orders')
    .select(`
      *,
      customers (first_name, last_name, email, phone)
    `)
    .eq('id', params.id)
    .single();

  if (error || !order) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  }

  const { data: items } = await db
    .from('order_items')
    .select('*')
    .eq('order_id', params.id);

  return NextResponse.json({
    order: {
      ...order,
      customer_name: order.customers
        ? `${order.customers.first_name} ${order.customers.last_name}`
        : null,
      customer_email: order.customers?.email ?? order.email ?? null,
      customer_phone: order.customers?.phone ?? null,
    },
    items: items ?? [],
  });
}

// PATCH /api/admin/orders/[id] — status change + field updates
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { ok, userId, role, actor_email } = await verifyAdmin(req);
  if (!ok || role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const body = await req.json();
  const { status: newStatus, ...rest } = body;

  // Fetch current order
  const { data: order, error: fetchErr } = await db
    .from('orders')
    .select('status, id, customer_id, items, stock_adjusted')
    .eq('id', params.id)
    .single();

  if (fetchErr || !order) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  }

  const allowedFields = [
    'billing_address', 'shipping_address', 'notes', 'staff_notes',
    'shipping_method', 'shipping_carrier', 'tracking_number',
  ];
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const f of allowedFields) {
    if (f in rest) updates[f] = rest[f];
  }

  if (newStatus && newStatus !== order.status) {
    // Guard: only allow editing while pending/confirmed
    const editableStatuses = ['pending', 'confirmed'];
    if (Object.keys(rest).some(k => allowedFields.slice(0, 2).includes(k))) {
      if (!editableStatuses.includes(order.status)) {
        return NextResponse.json(
          { error: 'Order can only be edited while pending or confirmed' },
          { status: 422 }
        );
      }
    }

    updates.status = newStatus;

    // Timestamp fields
    if (newStatus === 'packed') updates.packed_at = new Date().toISOString();
    if (newStatus === 'shipped') updates.shipped_at = new Date().toISOString();
    if (newStatus === 'delivered') updates.delivered_at = new Date().toISOString();
    if (newStatus === 'refunded') updates.refunded_at = new Date().toISOString();

    // On confirmed: deduct inventory
    if (newStatus === 'confirmed') {
      // Oversell guard. Storefront orders carry their lines as JSONB on
      // orders.items; before decrementing, verify every product still has
      // enough on hand. Blocking here (rather than silently flooring stock to
      // 0 in the RPC) surfaces the oversell to the admin so they can backorder
      // or restock instead of confirming an order that can't ship. Skipped
      // when the order was already decremented (idempotent re-confirm).
      if (order.stock_adjusted !== true) {
        const jsonbItems = Array.isArray(order.items)
          ? (order.items as Array<{ id?: string; quantity?: number | string }>)
          : [];
        const wantByProduct = new Map<string, number>();
        for (const it of jsonbItems) {
          const pid = typeof it?.id === 'string' ? it.id : '';
          if (!/^[0-9a-f-]{36}$/i.test(pid)) continue;
          const qty = Math.max(0, Math.floor(Number(it?.quantity) || 0));
          if (qty > 0) wantByProduct.set(pid, (wantByProduct.get(pid) ?? 0) + qty);
        }
        if (wantByProduct.size) {
          const { data: stockRows } = await db
            .from('products')
            .select('id, name, stock_quantity')
            .in('id', [...wantByProduct.keys()]);
          const stockById = new Map((stockRows ?? []).map((p: any) => [p.id, p]));
          for (const [pid, want] of wantByProduct) {
            const row: any = stockById.get(pid);
            const available = Number(row?.stock_quantity ?? 0);
            if (available < want) {
              return NextResponse.json(
                {
                  error: `Insufficient stock to confirm: "${row?.name ?? pid}" has ${available} on hand but the order needs ${want}. Restock or create a backorder first.`,
                  code: 'insufficient_stock',
                },
                { status: 422 },
              );
            }
          }
        }
      }

      const { data: items } = await db
        .from('order_items')
        .select('product_variant_id, qty, quantity')
        .eq('order_id', params.id);

      for (const item of items ?? []) {
        if (!item.product_variant_id) continue;
        const qty = item.qty ?? item.quantity ?? 1;

        const { data: variant } = await db
          .from('product_variants')
          .select('qty_on_hand')
          .eq('id', item.product_variant_id)
          .single();

        if (variant) {
          await db
            .from('product_variants')
            .update({ qty_on_hand: Math.max(0, variant.qty_on_hand - qty) })
            .eq('id', item.product_variant_id);

          await db.from('inventory_log').insert({
            variant_id: item.product_variant_id,
            change_qty: -qty,
            reason: 'sale',
            reference_id: params.id,
            note: `Order confirmed: ${params.id}`,
            created_by: userId,
          });
        }
      }

      // Decrement product-level stock (products.stock_quantity) from the
      // order's JSONB line items and log it to product history. This is the
      // source of truth; the product_variants block above is the deprecated
      // variant ledger. Runs before invoice creation so the auto-created
      // invoice inherits the order's stock_adjusted flag and never
      // double-decrements when it is later marked paid.
      await adjustStockForConfirmedOrder(db, params.id, actor_email);

      // Ensure the order has an invoice (idempotent — normally already created
      // at placement; this backstops orders placed before that was wired up).
      await createInvoiceForOrder(db, params.id);

      // First order is now complete — flip the flag so the 20% first-order
      // discount can't be claimed again on the customer's next order. (The
      // discount is decided server-side at checkout from this flag.)
      if (order.customer_id) {
        await db
          .from('customers')
          .update({ has_completed_first_order: true })
          .eq('id', order.customer_id);
      }
    }

    // On cancelled/refunded: restock (handled via /refund endpoint for granular control)
    // Simple full restock on cancelled
    if (newStatus === 'cancelled' && order.status === 'confirmed') {
      const { data: items } = await db
        .from('order_items')
        .select('product_variant_id, qty, quantity, restocked')
        .eq('order_id', params.id);

      for (const item of items ?? []) {
        if (!item.product_variant_id || item.restocked) continue;
        const qty = item.qty ?? item.quantity ?? 1;

        const { data: variant } = await db
          .from('product_variants')
          .select('qty_on_hand')
          .eq('id', item.product_variant_id)
          .single();

        if (variant) {
          await db
            .from('product_variants')
            .update({ qty_on_hand: variant.qty_on_hand + qty })
            .eq('id', item.product_variant_id);

          await db.from('inventory_log').insert({
            variant_id: item.product_variant_id,
            change_qty: qty,
            reason: 'return',
            reference_id: params.id,
            note: `Order cancelled: ${params.id}`,
            created_by: userId,
          });

          await db
            .from('order_items')
            .update({ restocked: true })
            .eq('id', item.id);
        }
      }
    }

    // Storefront (JSONB) orders keep their lines on orders.items, not in the
    // relational order_items table, so the variant loop above is a no-op for
    // them. Give product-level stock back here on cancel/refund — this is the
    // missing inverse of the confirm-time decrement (guarded by stock_adjusted,
    // so it only restores what was actually taken).
    if (newStatus === 'cancelled' || newStatus === 'refunded') {
      await restoreStockForCancelledOrder(db, params.id, actor_email);
    }
  }

  const { error: updateErr } = await db
    .from('orders')
    .update(updates)
    .eq('id', params.id);

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  // Klaviyo lifecycle event for the new status (confirmed / shipped /
  // delivered / cancelled / refunded). Best-effort, never throws.
  if (newStatus && newStatus !== order.status) {
    await trackOrderStatusById(db, params.id, newStatus);
  }

  // Confirmed = paid: email the customer their order confirmation, once, after
  // the response. Only storefront-checkout orders qualify; never throws.
  if (newStatus === 'confirmed' && newStatus !== order.status) {
    after(() => sendStorefrontOrderConfirmationOnce(db, params.id));
  }

  return NextResponse.json({ success: true });
}

// DELETE /api/admin/orders/[id] — hard delete with FK-safe teardown.
//
// `invoices.order_id → orders(id)` is ON DELETE SET NULL, so simply dropping the
// order would orphan any invoice bound to it. We delete the linked invoice(s)
// first (their line items, payments, backorders and email logs cascade), then
// clear the dependent rows that would otherwise block the delete, then the order
// itself (order_items cascade off orders). Dependent cleanups are best-effort —
// they no-op harmlessly when the table has nothing for this order.
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { ok, userId, role } = await verifyAdmin(req);
  if (!ok || role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const id = params.id;

  // Remove linked invoices first — the order↔invoice foreign key would only
  // null them out, leaving orphaned invoices behind.
  const { data: linkedInvoices } = await db
    .from('invoices')
    .select('id')
    .eq('order_id', id);
  const invoiceIds = (linkedInvoices ?? []).map((i: { id: string }) => i.id);
  if (invoiceIds.length) {
    await db.from('invoices').delete().in('id', invoiceIds);
  }

  // Dependent rows that reference the order without a cascade (or that we want
  // gone with the order). Best-effort: ignore per-table errors / empty tables.
  await db.from('commissions').delete().eq('order_id', id);
  await db.from('crypto_transactions').delete().eq('order_id', id);
  await db.from('shipment_auto_logs').delete().eq('order_id', id);
  await db.from('sol_addresses').delete().eq('order_id', id);
  await db.from('order_items').delete().eq('order_id', id);

  const { error } = await db.from('orders').delete().eq('id', id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await logAuditServer(db, { actor_id: userId, actor_email: null }, {
    action: 'order.delete',
    entity_type: 'order',
    entity_id: id,
  });

  return NextResponse.json({ success: true });
}
