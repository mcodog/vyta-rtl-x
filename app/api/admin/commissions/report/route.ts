import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { resolveStaffCaller } from '@/lib/affiliate/route-auth';
import {
  commissionReference,
  loadCommissionLedger,
  type CommissionSource,
  type LedgerCommission,
  type LedgerRecipient,
} from '@/lib/admin/commission-ledger';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

function money(n: number) {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(n || 0);
}
function fmtDate(s: string | null) {
  return s ? new Date(s).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
}
function esc(s: string | null | undefined) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}
/** Buyer name, else email, else "Guest" — guest checkouts have no account. */
function customerCell(r: LedgerCommission): string {
  const primary = r.customer_name || r.customer_email;
  if (!primary) return '<span class="muted">Guest</span>';
  const guest = r.customer_is_guest ? ' <span class="muted">(guest)</span>' : '';
  const sub = r.customer_name && r.customer_email ? `<div class="muted">${esc(r.customer_email)}</div>` : '';
  return `${esc(primary)}${guest}${sub}`;
}
const sum = (rows: LedgerCommission[], status: string) =>
  rows.filter((r) => r.status === status).reduce((s, r) => s + r.amount, 0);

/**
 * GET /api/admin/commissions/report — printable commission report. Staff.
 *
 * Query:
 *   recipient  `affiliate:<id>` or `sales:<id>` — one recipient's statement
 *   status     pending | paid | cancelled | all (default all)
 *   source     affiliate | sales (whole-ledger report only)
 *   q          free-text filter on recipient, customer and invoice/order no.
 */
export async function GET(req: NextRequest) {
  const caller = await resolveStaffCaller(db, req, { allowAssistant: true });
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });

  const sp = new URL(req.url).searchParams;
  const statusFilter = sp.get('status') || 'all';
  const q = (sp.get('q') || '').trim().toLowerCase();

  let source: CommissionSource | undefined =
    sp.get('source') === 'affiliate' ? 'affiliate' : sp.get('source') === 'sales' ? 'sales' : undefined;
  let recipientId: string | undefined;
  const recipientParam = sp.get('recipient');
  if (recipientParam) {
    const [src, id] = recipientParam.split(':');
    if ((src === 'affiliate' || src === 'sales') && id) {
      source = src;
      recipientId = id;
    }
  }

  const { recipients, commissions } = await loadCommissionLedger(db, { source, recipientId });
  const byKey = new Map(recipients.map((r) => [r.key, r]));
  const single: LedgerRecipient | null = recipientId ? byKey.get(`${source}:${recipientId}`) ?? null : null;

  let rows = commissions;
  if (statusFilter !== 'all') rows = rows.filter((r) => r.status === statusFilter);
  if (q) {
    rows = rows.filter((r) => {
      const rec = byKey.get(r.recipient_key);
      return [rec?.name, rec?.email, rec?.referral_code, r.customer_name, r.customer_email, commissionReference(r), r.order_number]
        .some((v) => (v ?? '').toLowerCase().includes(q));
    });
  }

  const pendingTotal = sum(rows, 'pending');
  const paidTotal = sum(rows, 'paid');
  const statusLabel = statusFilter === 'all' ? 'All commissions' : `${statusFilter[0].toUpperCase()}${statusFilter.slice(1)} commissions`;

  const tableRows = rows
    .map((r) => {
      const rec = byKey.get(r.recipient_key);
      const ref = commissionReference(r);
      return `
      <tr>
        <td>${fmtDate(r.created_at)}</td>
        ${single ? '' : `<td>${esc(rec?.name)}<div class="muted">${esc(rec?.email)}</div></td>`}
        <td class="mono">${esc(ref)}${r.order_number && r.invoice_number ? `<div class="muted">Order ${esc(r.order_number)}</div>` : ''}</td>
        <td>${customerCell(r)}</td>
        <td class="num">${money(r.base)}</td>
        <td class="num">${r.rate ? `${r.rate}%` : '—'}</td>
        <td class="num"><b>${money(r.amount)}</b></td>
        <td><span class="status ${esc(r.status)}">${esc(r.status)}</span>${r.paid_at ? `<div class="muted">${fmtDate(r.paid_at)}</div>` : ''}</td>
      </tr>`;
    })
    .join('');
  const colCount = single ? 7 : 8;

  const title = single ? `Commission Statement — ${single.name}` : 'Commission Report';
  const header = single
    ? `<div class="recipient">
        <div class="label">${single.source === 'affiliate' ? 'Affiliate' : 'Sales person'}</div>
        <div class="name">${esc(single.name)}</div>
        <div class="muted">${esc(single.email)}${single.referral_code ? ` &bull; Code <span class="mono">${esc(single.referral_code)}</span>` : ''}</div>
      </div>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<style>
  body { font-family: 'Segoe UI', -apple-system, sans-serif; color: #07203A; margin: 0; padding: 32px; background: #fff; }
  .page { max-width: 960px; margin: 0 auto; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
  h1 { font-size: 22px; margin: 0; }
  .logo span { color: #438b9e; }
  .meta { color: #56707F; font-size: 13px; margin: 4px 0 24px; }
  .recipient { border: 1px solid #DCE7EB; border-radius: 8px; padding: 12px 16px; margin-bottom: 20px; }
  .recipient .label { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #56707F; }
  .recipient .name { font-size: 18px; font-weight: 700; margin: 2px 0; }
  .totals { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
  .card { border: 1px solid #DCE7EB; border-radius: 8px; padding: 12px 16px; font-size: 13px; min-width: 140px; }
  .card b { display: block; font-size: 18px; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; text-transform: uppercase; font-size: 11px; color: #56707F; border-bottom: 2px solid #DCE7EB; padding: 8px; }
  th.num { text-align: right; }
  td { padding: 10px 8px; border-bottom: 1px solid #EDF3F5; vertical-align: top; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .mono { font-family: monospace; }
  .muted { color: #6E8898; font-size: 11px; }
  .status { padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; text-transform: capitalize; }
  .status.paid { background: #ECFDF5; color: #059669; }
  .status.pending { background: #FFFBEB; color: #B45309; }
  .status.cancelled { background: #FEF2F2; color: #DC2626; }
  .print-btn { font: inherit; font-size: 13px; padding: 8px 14px; border-radius: 8px; border: 1px solid #07203A; background: #07203A; color: #fff; cursor: pointer; }
  @media print { body { padding: 0; } .print-btn { display: none; } }
</style></head>
<body><div class="page">
  <div class="top">
    <div>
      <h1 class="logo">AMINO<span>CAN</span></h1>
      <div class="meta">${esc(title)} &bull; ${esc(statusLabel)} &bull; ${rows.length} ${rows.length === 1 ? 'entry' : 'entries'} &bull; ${fmtDate(new Date().toISOString())}</div>
    </div>
    <button class="print-btn" onclick="window.print()">Print</button>
  </div>
  ${header}
  <div class="totals">
    <div class="card">Pending<b>${money(pendingTotal)}</b></div>
    <div class="card">Paid<b>${money(paidTotal)}</b></div>
    <div class="card">Total<b>${money(pendingTotal + paidTotal)}</b></div>
  </div>
  <table>
    <thead><tr>
      <th>Date</th>
      ${single ? '' : '<th>Recipient</th>'}
      <th>Invoice</th>
      <th>Customer</th>
      <th class="num">Base</th>
      <th class="num">Rate</th>
      <th class="num">Commission</th>
      <th>Status</th>
    </tr></thead>
    <tbody>${tableRows || `<tr><td colspan="${colCount}" style="text-align:center;color:#6E8898;padding:32px;">No commissions match the filters</td></tr>`}</tbody>
  </table>
</div></body></html>`;

  return new NextResponse(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
