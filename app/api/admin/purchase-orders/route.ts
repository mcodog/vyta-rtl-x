import { todayInAppTz } from '@/lib/datetime';
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  allocateLandedCost,
  resolveDiscountAmount,
  resolveTaxAmount,
  round2,
} from '@/lib/admin/po-landed-cost';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// read  -> admin OR assistant ; mutation -> admin only
async function verifyAdminRole(req: NextRequest, requireMutation: boolean) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return { ok: false, userId: null as string | null, role: 'customer' };
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return { ok: false, userId: null, role: 'customer' };
  const { data } = await db.from('customers').select('role').eq('id', user.id).single();
  const role = data?.role ?? 'customer';
  const ok = requireMutation
    ? role === 'admin'
    : role === 'admin' || role === 'assistant';
  return { ok, userId: user.id, role };
}

const r2 = round2;

/**
 * Order-total math. Spec order of operations:
 *   subtotal    = Σ (qty × unit_price)
 *   shipping    = max(0, shipping_fee)
 *   discount    = pct ? subtotal × val/100 : min(val, subtotal + shipping)
 *   taxBase     = subtotal + shipping − discount
 *   taxTotal    = pct ? taxBase × val/100 : val
 *   total       = taxBase + taxTotal
 *
 * A percentage discount is applied against the subtotal only (not shipping);
 * a fixed discount is capped so it can't exceed subtotal + shipping.
 */
export function computeSummary(opts: {
  items: { qty: number; unit_price: number }[];
  shipping_fee: number;
  discount_type: 'percentage' | 'fixed';
  discount_value: number;
  tax_type: 'percentage' | 'fixed';
  tax_value: number;
}) {
  const subtotal = r2(opts.items.reduce((s, i) => s + Number(i.qty) * Number(i.unit_price), 0));
  const shipping = r2(Math.max(0, Number(opts.shipping_fee) || 0));
  const discountRaw = resolveDiscountAmount(opts.discount_type, opts.discount_value, subtotal);
  const discount = opts.discount_type === 'fixed'
    ? r2(Math.min(discountRaw, subtotal + shipping))
    : r2(discountRaw);
  const taxBase = r2(subtotal + shipping - discount);
  const tax_total = resolveTaxAmount(opts.tax_type, opts.tax_value, taxBase);
  const total = r2(taxBase + tax_total);
  return { subtotal, shipping_fee: shipping, discount, tax_total, total };
}

// GET /api/admin/purchase-orders
export async function GET(req: NextRequest) {
  const { ok } = await verifyAdminRole(req, false);
  if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const status = sp.get('status');
  const supplierId = sp.get('supplier_id');

  let query = db
    .from('purchase_orders')
    .select(`*, supplier:suppliers (id, name), purchase_order_items (id)`)
    .order('created_at', { ascending: false });

  if (status) query = query.eq('status', status);
  if (supplierId) query = query.eq('supplier_id', supplierId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const purchase_orders = (data ?? []).map((po: any) => {
    const { purchase_order_items, ...rest } = po;
    return { ...rest, item_count: purchase_order_items?.length ?? 0 };
  });

  return NextResponse.json({ purchase_orders });
}

// POST /api/admin/purchase-orders
export async function POST(req: NextRequest) {
  const { ok, userId } = await verifyAdminRole(req, true);
  if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const body = await req.json();
  const {
    supplier_id,
    status,
    shipping_fee = 0,
    discount_type = 'percentage',
    discount_value = 0,
    tax_type = 'percentage',
    tax_value = 0,
    notes,
    order_date,
    expected_date,
    backorder_id,
    items,
  } = body;

  if (!supplier_id) {
    return NextResponse.json({ error: 'supplier_id is required' }, { status: 400 });
  }
  if (!items?.length) {
    return NextResponse.json({ error: 'At least one line item is required' }, { status: 400 });
  }

  // Clean items + recompute line_total server-side.
  const cleanItems = (items as any[]).map((i) => {
    const qty = Math.max(1, parseInt(i.qty) || 1);
    const unit_price = Math.max(0, Number(i.unit_price) || 0);
    return {
      product_id: i.product_id ?? null,
      description: String(i.description ?? '').trim(),
      sku_snapshot: i.sku_snapshot ?? null,
      qty,
      unit_price,
      // Box vs Vial marker — drives box→vial conversion on receive.
      price_type: (i.price_type === 'vial' ? 'vial' : 'box') as 'box' | 'vial',
      line_total: r2(qty * unit_price),
    };
  });

  const summary = computeSummary({
    items: cleanItems,
    shipping_fee,
    discount_type,
    discount_value,
    tax_type,
    tax_value,
  });

  const ALLOWED_CREATE = ['pending', 'fulfilled', 'paid', 'cancelled'];
  const poStatus = ALLOWED_CREATE.includes(status) ? status : 'pending';

  const { data: po, error: poErr } = await db
    .from('purchase_orders')
    .insert({
      supplier_id,
      status: poStatus,
      subtotal: summary.subtotal,
      shipping_fee: summary.shipping_fee,
      discount_type,
      discount_value: Number(discount_value) || 0,
      discount: summary.discount,
      tax_type,
      tax_value: Number(tax_value) || 0,
      tax_total: summary.tax_total,
      total: summary.total,
      notes: notes ?? null,
      order_date: order_date ?? todayInAppTz(),
      expected_date: expected_date ?? null,
      created_by: userId,
    })
    .select()
    .single();

  if (poErr || !po) {
    return NextResponse.json({ error: poErr?.message ?? 'Failed to create purchase order' }, { status: 500 });
  }

  const fulfilled = poStatus === 'fulfilled';
  // Landed cost = each line's supplier price + its share of shipping/discount.
  // Same math as the form + PDF, so what the admin sees = what we persist.
  const landed = allocateLandedCost(cleanItems, {
    shipping: summary.shipping_fee,
    discount: summary.discount,
  });
  const itemRows = cleanItems.map((i, idx) => ({
    purchase_order_id: po.id,
    product_id: i.product_id,
    description: i.description,
    sku_snapshot: i.sku_snapshot,
    qty: i.qty,
    qty_received: fulfilled ? i.qty : 0,
    unit_price: i.unit_price,
    price_type: i.price_type,
    line_total: i.line_total,
    landed_unit_cost: landed[idx].landed_unit_cost,
    landed_line_total: landed[idx].landed_line_total,
  }));

  const { error: itemErr } = await db.from('purchase_order_items').insert(itemRows);
  if (itemErr) {
    // Roll back the PO so we never strand a header without lines.
    await db.from('purchase_orders').delete().eq('id', po.id);
    return NextResponse.json({ error: itemErr.message }, { status: 500 });
  }

  // Create-as-fulfilled: apply all stock at once (idempotent RPC).
  if (fulfilled) {
    const { error: rpcErr } = await db.rpc('apply_po_inventory', { p_po_id: po.id });
    if (rpcErr) console.error('apply_po_inventory error:', rpcErr);
  }

  // Fulfil an originating backorder, only while still open.
  if (backorder_id) {
    const { error: boErr } = await db
      .from('backorders')
      .update({
        status: 'fulfilled',
        purchase_order_id: po.id,
        fulfilled_at: new Date().toISOString(),
      })
      .eq('id', backorder_id)
      .eq('status', 'open');
    if (boErr) console.error('backorder flush error:', boErr);
  }

  return NextResponse.json({ purchase_order: po }, { status: 201 });
}
