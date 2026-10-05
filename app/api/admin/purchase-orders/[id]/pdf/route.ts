import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { PO_STATUS_META } from '@/lib/admin/po-status';
import { allocateLandedCost } from '@/lib/admin/po-landed-cost';
import type { PurchaseOrderStatus } from '@/lib/types/ecommerce';
import { formatAppDate } from '@/lib/datetime';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function verifyAdmin(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return false;
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return false;
  const { data } = await db.from('customers').select('role').eq('id', user.id).single();
  return data?.role === 'admin' || data?.role === 'assistant';
}

function fmt(n: number) {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(Number(n) || 0);
}
function fmtDate(d: string) {
  return formatAppDate(d, { year: 'numeric', month: 'long', day: 'numeric' }, 'en-CA');
}
function esc(s: unknown) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// GET /api/admin/purchase-orders/[id]/pdf — print-ready branded HTML
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const { data: po, error } = await db
    .from('purchase_orders')
    .select(`*, suppliers (*)`)
    .eq('id', params.id)
    .single();
  if (error || !po) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { data: items } = await db
    .from('purchase_order_items')
    .select('*')
    .eq('purchase_order_id', params.id)
    .order('description');

  const supplier = po.suppliers;
  const meta = PO_STATUS_META[po.status as PurchaseOrderStatus] ?? PO_STATUS_META.pending;

  // Recompute landed cost live from the current items + shipping/discount
  // so POs created before the landed-cost migration still render numbers
  // in the "Landed / unit" column. The persisted values will match this
  // when they exist, so this is a safe overlay either way.
  const lineItems = (items ?? []) as any[];
  const landed = allocateLandedCost(
    lineItems.map((i) => ({ qty: i.qty, unit_price: i.unit_price, line_total: i.line_total })),
    { shipping: Number(po.shipping_fee) || 0, discount: Number(po.discount) || 0 },
  );

  const itemRows = lineItems.map((item: any, idx: number) => {
    const lc = landed[idx];
    return `
    <tr>
      <td class="td">${esc(item.description)}${item.price_type === 'vial' ? ' <span class="chip">Vial</span>' : ''}</td>
      <td class="td center">${esc(item.sku_snapshot ?? '—')}</td>
      <td class="td center">${esc(item.qty)}</td>
      <td class="td right">${fmt(item.unit_price)}</td>
      <td class="td right muted">${fmt(lc.landed_unit_cost)}</td>
      <td class="td right">${fmt(item.line_total)}</td>
    </tr>
  `;
  }).join('');

  const taxLabel = po.tax_type === 'percentage' ? `Tax (${esc(po.tax_value)}%)` : 'Tax (fixed)';
  const discountLabel = po.discount_type === 'percentage'
    ? `Discount (${esc(po.discount_value)}%)`
    : 'Discount';
  const issueDate = po.order_date ?? po.created_at;

  const shippingRow = Number(po.shipping_fee) > 0 ? `
      <div class="totals-row">
        <span class="label">Shipping</span>
        <span class="val">${fmt(po.shipping_fee)}</span>
      </div>` : '';
  const discountRow = Number(po.discount) > 0 ? `
      <div class="totals-row">
        <span class="label">${discountLabel}</span>
        <span class="val">−${fmt(po.discount)}</span>
      </div>` : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Purchase Order ${esc(po.po_number)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', system-ui, -apple-system, Arial, sans-serif; font-size: 13px; color: #07203A; background: #fff; padding: 48px 56px; line-height: 1.5; }
  .page { max-width: 820px; margin: 0 auto; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 48px; }
  .brand-name { font-size: 26px; font-weight: 800; letter-spacing: -0.5px; color: #07203A; }
  .brand-name span { color: #438b9e; }
  .brand-kicker { font-size: 9px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; color: #438b9e; margin-top: 3px; }
  .brand-tagline { font-size: 11px; color: #56707f; margin-top: 4px; }
  .po-meta { text-align: right; }
  .po-title { font-size: 28px; font-weight: 700; color: #07203A; }
  .po-number { font-size: 13px; color: #56707f; margin-top: 4px; font-family: monospace; }
  .status-pill { display: inline-block; margin-top: 8px; padding: 4px 12px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: ${meta.pdfFg}; background: ${meta.pdfBg}; }
  .divider { border: none; border-top: 2px solid #edf3f5; margin: 32px 0; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 32px; margin-bottom: 40px; }
  .info-block h3 { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: #6e8898; margin-bottom: 8px; font-weight: 600; }
  .info-block p { color: #07203A; line-height: 1.6; }
  .info-block .strong { font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 32px; }
  thead tr { background: #f7fafb; }
  th { padding: 10px 12px; text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #56707f; font-weight: 600; border-bottom: 2px solid #dce7eb; }
  th.center { text-align: center; } th.right { text-align: right; }
  .td { padding: 11px 12px; border-bottom: 1px solid #edf3f5; color: #07203A; vertical-align: top; }
  .td.center { text-align: center; color: #56707f; }
  .td.right { text-align: right; font-variant-numeric: tabular-nums; }
  .td.muted { color: #56707f; }
  .chip { display: inline-block; margin-left: 4px; padding: 1px 6px; border-radius: 4px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; background: #eef2ff; color: #4338ca; vertical-align: 1px; }
  .footnote { margin: -20px 0 24px; font-size: 10px; color: #6e8898; font-style: italic; }
  tbody tr:last-child .td { border-bottom: none; }
  .totals-wrap { display: flex; justify-content: flex-end; }
  .totals { width: 280px; }
  .totals-row { display: flex; justify-content: space-between; padding: 5px 0; font-size: 13px; }
  .totals-row .label { color: #56707f; }
  .totals-row .val { font-variant-numeric: tabular-nums; }
  .totals-row.grand { border-top: 2px solid #07203A; margin-top: 6px; padding-top: 10px; font-weight: 700; font-size: 16px; }
  .notes { margin-top: 40px; background: #f7fafb; border-radius: 8px; padding: 16px 20px; }
  .notes h3 { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: #6e8898; margin-bottom: 8px; font-weight: 600; }
  .notes p { color: #0E3F5F; font-size: 12px; line-height: 1.7; white-space: pre-wrap; }
  footer { margin-top: 56px; padding-top: 20px; border-top: 1px solid #dce7eb; display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: #6e8898; }
  @media print { body { padding: 24px 32px; } @page { margin: 0; size: A4; } }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div class="brand">
      <div class="brand-name">VYTA</div>
      <div class="brand-kicker">Biosciences</div>
      <div class="brand-tagline">vytabio.com &nbsp;·&nbsp; support@vytabio.com</div>
    </div>
    <div class="po-meta">
      <div class="po-title">Purchase Order</div>
      <div class="po-number">${esc(po.po_number)}</div>
      <div><span class="status-pill">${esc(meta.label)}</span></div>
    </div>
  </div>

  <hr class="divider">

  <div class="info-grid">
    <div class="info-block">
      <h3>Supplier</h3>
      <p>
        <span class="strong">${esc(supplier?.name ?? '—')}</span><br>
        ${supplier?.contact_name ? esc(supplier.contact_name) + '<br>' : ''}
        ${esc(supplier?.email ?? '')}<br>
        ${esc(supplier?.phone ?? '')}
      </p>
    </div>
    <div class="info-block">
      <h3>Order Date</h3>
      <p>${fmtDate(issueDate)}</p>
      ${po.expected_date ? `<h3 style="margin-top:16px">Expected Delivery</h3><p>${fmtDate(po.expected_date)}</p>` : ''}
    </div>
    <div class="info-block">
      <h3>Issued By</h3>
      <p>VYTA Procurement</p>
      <h3 style="margin-top:16px">PO Number</h3>
      <p class="strong" style="font-family:monospace">${esc(po.po_number)}</p>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:42%">Description</th>
        <th class="center" style="width:14%">SKU</th>
        <th class="center" style="width:10%">Qty</th>
        <th class="right" style="width:13%">Unit Price</th>
        <th class="right" style="width:13%">Landed / unit</th>
        <th class="right" style="width:14%">Line Total</th>
      </tr>
    </thead>
    <tbody>${itemRows}</tbody>
  </table>
  <p class="footnote">Landed / unit = supplier price + this line's share of shipping − share of discount.</p>

  <div class="totals-wrap">
    <div class="totals">
      <div class="totals-row">
        <span class="label">Subtotal</span>
        <span class="val">${fmt(po.subtotal)}</span>
      </div>${shippingRow}${discountRow}
      <div class="totals-row">
        <span class="label">${taxLabel}</span>
        <span class="val">${fmt(po.tax_total)}</span>
      </div>
      <div class="totals-row grand">
        <span>Total</span>
        <span>${fmt(po.total)}</span>
      </div>
    </div>
  </div>

  ${po.notes ? `<div class="notes"><h3>Notes</h3><p>${esc(po.notes)}</p></div>` : ''}

  <footer>
    <span>VYTA BIOSCIENCES &nbsp;·&nbsp; vytabio.com</span>
    <span>Generated ${esc(new Date().toLocaleDateString('en-CA'))} &nbsp;·&nbsp; ${esc(po.po_number)}</span>
  </footer>
</div>
</body>
</html>`;

  return new NextResponse(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `inline; filename="${po.po_number}.html"`,
    },
  });
}
