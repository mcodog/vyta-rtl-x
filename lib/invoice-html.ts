// Shared printer-ready invoice document — one template used by both the
// admin invoice PDF route and the customer "download invoice" route, so the
// two always render the identical document.
//
// To generate an actual PDF file, integrate @sparticuz/chromium +
// puppeteer-core and call page.pdf() with this HTML as the content.
import { formatAppDate } from '@/lib/datetime';
import {
  formatAddressLines,
} from '@/lib/payments/puramass-address';
import {
  centsToAmount,
  PURAMASS_STATUS_LABEL,
  type PuramassInvoiceContext,
} from '@/lib/admin/puramass-invoice';

export function formatInvoiceCurrency(n: number, currency: 'CAD' | 'USD' = 'CAD') {
  return new Intl.NumberFormat(currency === 'USD' ? 'en-US' : 'en-CA', {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
  }).format(n);
}

function formatDate(d: string) {
  return formatAppDate(d, { year: 'numeric', month: 'long', day: 'numeric' }, 'en-CA', '');
}

export interface RenderInvoiceHtmlOptions {
  /** Invoice row, optionally with joined `customers` + `sales_persons`. */
  invoice: any;
  lineItems: any[];
  payments: any[];
  /** Append the auto-print script (used by ?download=1). */
  autoPrint?: boolean;
  /** Customers see a `draft` invoice as "pending" — the order simply hasn't
   *  been paid yet; "draft" reads like an unfinished internal document. */
  viewer?: 'admin' | 'customer';
  /**
   * The Stealth Health hand-off behind this invoice, when it has one
   * (`invoices.source = 'stealth_health'`). Stealth Health collects the buyer's
   * contact and shipping address on its hosted checkout page, so for these
   * sales the invoice row itself has no ship-to — it lives on the hand-off
   * ledger, and this is how it reaches the printed document.
   */
  puramass?: PuramassInvoiceContext | null;
}

/** Escape untrusted text (buyer names, addresses, refund notes) for HTML. */
function esc(v: unknown): string {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderInvoiceHtml({
  invoice,
  lineItems,
  payments,
  autoPrint = false,
  viewer = 'admin',
  puramass = null,
}: RenderInvoiceHtmlOptions): string {
  const amountPaid = (payments ?? []).reduce((s: number, p: any) => s + Number(p.amount), 0);
  const amountDue = Number(invoice.total) - amountPaid;

  const cur: 'CAD' | 'USD' = invoice.currency === 'USD' ? 'USD' : 'CAD';
  const fmt = (n: number) => formatInvoiceCurrency(n, cur);

  const c = invoice.customers;
  const customerName = c
    ? `${c.first_name} ${c.last_name}`
    : (invoice.customer_name ?? 'Guest');
  const customerEmail = c?.email ?? invoice.customer_email ?? '';
  const customerPhone = c?.phone ?? invoice.customer_phone ?? '';
  const customerAddress = c
    ? [c.shipping_address, c.shipping_city, c.shipping_state, c.shipping_postal_code, c.shipping_country]
        .filter(Boolean).join(', ')
    : '';

  const sp = invoice.sales_persons;
  const salesPersonName = sp ? `${sp.first_name} ${sp.last_name}` : '';

  const statusColor: Record<string, string> = {
    draft: '#56707f',
    sent: '#438b9e',
    paid: '#10b981',
    partial: '#f59e0b',
    overdue: '#ef4444',
    pending_payment: '#d97706',
    expired: '#56707f',
  };
  const statusLabel =
    viewer === 'customer' && invoice.status === 'draft'
      ? 'pending'
      : invoice.status === 'pending_payment'
        ? 'pending payment'
        : invoice.status;

  // ---- Stealth Health hand-off ---------------------------------------------------
  // For a Stealth Health sale everything below comes off the hand-off ledger, not off
  // this invoice: Stealth Health took the payment on its own hosted page and captured
  // the buyer's contact + shipping address there. The document says so, so a
  // packer never mistakes a partner-reported address for one typed in here.
  const pmAddressLines = formatAddressLines(puramass?.shipping_address ?? null);
  const pmAddressNote = puramass?.shipping_address
    ? puramass.shipping_address_source === 'customer'
      ? 'Confirmed by the customer'
      : 'Reported by Stealth Health'
    : '';
  const pmRefunded = centsToAmount(puramass?.refunded_total_cents ?? 0) ?? 0;

  /** Stealth Health SKU per line, matched on the name the invoice line was built from. */
  const pmSkuByName = new Map<string, string>();
  for (const item of puramass?.items ?? []) {
    if (item.sku && item.name) pmSkuByName.set(item.name.toLowerCase(), item.sku);
  }

  const lineRows = (lineItems ?? []).map((li: any) => {
    const pt = li.price_type === 'vial' ? 'vial' : 'box';
    const chip = `<span class="pt-chip pt-${pt}">${pt === 'vial' ? 'Vial' : 'Pack'}</span>`;
    // Case lines are sold to shoppers as a "Pack of N" — normalize older
    // invoice rows that were written with the internal "Case of" wording.
    const description = String(li.description ?? '').replace(/— Case of (\d+)/, '— Pack of $1');
    const sku = pmSkuByName.get(String(li.description ?? '').toLowerCase());
    const skuLine = sku ? `<div class="sku">SKU ${esc(sku)}</div>` : '';
    return `
    <tr>
      <td>${description} ${chip}${skuLine}</td>
      <td style="text-align:center">${li.qty}</td>
      <td style="text-align:right">${fmt(li.unit_price)}</td>
      <td style="text-align:center">${li.discount_pct > 0 ? li.discount_pct + '%' : '—'}</td>
      <td style="text-align:right">${fmt(li.line_total)}</td>
    </tr>
  `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Invoice ${invoice.invoice_number}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px; color: #07203a; background: #fff; padding: 40px; }
  .page { max-width: 800px; margin: 0 auto; }
  header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 40px; }
  .logo { font-size: 22px; font-weight: 800; letter-spacing: -0.5px; }
  .logo span { color: #438b9e; }
  .invoice-meta { text-align: right; }
  .invoice-meta h2 { font-size: 24px; font-weight: 700; color: #07203a; }
  .invoice-meta .number { font-size: 14px; color: #56707F; margin-top: 4px; }
  .status-badge { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #fff; background: ${statusColor[invoice.status] ?? '#56707f'}; }
  .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-bottom: 32px; }
  .party h3 { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: #6E8898; margin-bottom: 8px; }
  .party p { line-height: 1.6; }
  .dates { display: grid; grid-template-columns: repeat(3,1fr); gap: 16px; background: #f7fafb; border-radius: 8px; padding: 16px; margin-bottom: 32px; }
  .date-item h4 { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #6E8898; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
  thead th { border-bottom: 2px solid #dce7eb; padding: 10px 8px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #6E8898; }
  tbody td { padding: 10px 8px; border-bottom: 1px solid #edf3f5; vertical-align: top; }
  tbody tr:last-child td { border-bottom: none; }
  .totals { display: flex; justify-content: flex-end; }
  .totals-inner { width: 260px; }
  .totals-row { display: flex; justify-content: space-between; padding: 5px 0; font-size: 13px; }
  .totals-row.total { border-top: 2px solid #07203a; padding-top: 10px; margin-top: 5px; font-weight: 700; font-size: 15px; }
  .totals-row.due { color: #438b9e; font-weight: 700; }
  .payments-section { margin-top: 32px; }
  .payments-section h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #6E8898; margin-bottom: 12px; }
  .pmt-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #edf3f5; font-size: 12px; }
  footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid #dce7eb; font-size: 11px; color: #6E8898; text-align: center; }
  .pt-chip { display:inline-block; margin-left:6px; padding:1px 6px; border-radius:999px; font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; vertical-align:1px; }
  .pt-box { background:#edf3f5; color:#0E3F5F; }
  .pt-vial { background:#e1eff1; color:#438b9e; }
  .sku { margin-top:3px; font-size:10px; color:#6E8898; letter-spacing:0.04em; }
  .origin { margin-top:8px; font-size:10px; color:#6E8898; text-transform:uppercase; letter-spacing:0.08em; }
  .source-strip { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; border:1px solid #e1eff1; background:#f7fafb; border-radius:8px; padding:14px 16px; margin-bottom:32px; }
  .source-strip h4 { font-size:10px; text-transform:uppercase; letter-spacing:0.08em; color:#438b9e; margin-bottom:4px; }
  .source-strip p { font-size:12px; word-break:break-all; }
  .source-title { grid-column:1 / -1; font-size:11px; font-weight:700; color:#438b9e; text-transform:uppercase; letter-spacing:0.08em; }
  .party .note { margin-top:4px; font-size:10px; color:#6E8898; }
  .totals-row.refund { color:#b45309; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
<div class="page">
  <header>
    <div>
      <div class="logo">VYTA<span> Biosciences</span></div>
      <p style="margin-top:6px;font-size:12px;color:#56707F">vytabio.com<br>support@vytabio.com</p>
    </div>
    <div class="invoice-meta">
      <h2>Invoice</h2>
      <div class="number">${invoice.invoice_number}</div>
      <div style="margin-top:8px"><span class="status-badge">${statusLabel}</span></div>
      ${puramass ? '<div class="origin">Placed via Stealth Health</div>' : ''}
    </div>
  </header>

  <div class="parties">
    <div class="party">
      <h3>Bill To</h3>
      <p><strong>${customerName}</strong><br>
      ${customerEmail}<br>${customerPhone}<br>${customerAddress}</p>
    </div>
    ${puramass ? `
    <div class="party">
      <h3>Ship To</h3>
      <p><strong>${esc(puramass.customer_name ?? customerName)}</strong><br>
      ${pmAddressLines.length > 0
        ? pmAddressLines.map((l) => esc(l)).join('<br>')
        : 'No shipping address on file yet — Stealth Health has not reported one.'}
      ${puramass.customer_phone ? `<br>${esc(puramass.customer_phone)}` : ''}</p>
      ${pmAddressNote ? `<p class="note">${pmAddressNote}</p>` : ''}
    </div>` : ''}
    ${salesPersonName ? `
    <div class="party">
      <h3>Sales Person</h3>
      <p><strong>${salesPersonName}</strong><br>
      ${sp?.email ?? ''}</p>
    </div>` : ''}
  </div>

  <div class="dates">
    <div class="date-item"><h4>Issue Date</h4><p>${formatDate(invoice.issue_date)}</p></div>
    <div class="date-item"><h4>Due Date</h4><p>${formatDate(invoice.due_date)}</p></div>
    <div class="date-item"><h4>Invoice #</h4><p>${invoice.invoice_number}</p></div>
  </div>

  ${puramass ? `
  <div class="source-strip">
    <div class="source-title">Stealth Health hosted checkout — payment, taxes &amp; shipping collected by Stealth Health</div>
    <div><h4>Transaction</h4><p>${esc(puramass.transaction_id ?? '—')}</p></div>
    <div><h4>Our reference</h4><p>${esc(puramass.partner_reference || '—')}</p></div>
    <div><h4>Payment status</h4><p>${esc(PURAMASS_STATUS_LABEL[puramass.status] ?? puramass.status ?? '—')}${
      puramass.paid_at ? ` · ${formatDate(puramass.paid_at)}` : ''
    }</p></div>
    <div><h4>Goods charged</h4><p>${
      centsToAmount(puramass.subtotal_cents) != null
        ? `${fmt(centsToAmount(puramass.subtotal_cents) as number)} ${esc(puramass.currency)}`
        : '—'
    }</p></div>
  </div>` : ''}

  <table>
    <thead>
      <tr>
        <th>Description</th>
        <th style="text-align:center">Qty</th>
        <th style="text-align:right">Unit Price</th>
        <th style="text-align:center">Disc.</th>
        <th style="text-align:right">Total</th>
      </tr>
    </thead>
    <tbody>${lineRows}</tbody>
  </table>

  <div class="totals">
    <div class="totals-inner">
      <div class="totals-row"><span>Subtotal</span><span>${fmt(invoice.subtotal)}</span></div>
      <div class="totals-row"><span>Tax</span><span>${fmt(invoice.tax_total)}</span></div>
      <div class="totals-row"><span>Shipping</span><span>${fmt(invoice.shipping_cost)}</span></div>
      <div class="totals-row total"><span>Total</span><span>${fmt(invoice.total)} ${cur}</span></div>
      ${amountPaid > 0 ? `<div class="totals-row"><span>Paid</span><span>– ${fmt(amountPaid)}</span></div>` : ''}
      ${pmRefunded > 0 ? `
      <div class="totals-row refund"><span>Refunded by Stealth Health</span><span>– ${fmt(pmRefunded)}</span></div>
      <div class="totals-row"><span>Net of refunds</span><span>${fmt(Number(invoice.total) - pmRefunded)}</span></div>` : ''}
      ${amountDue !== Number(invoice.total) ? `<div class="totals-row due"><span>Amount Due</span><span>${fmt(amountDue)}</span></div>` : ''}
    </div>
  </div>

  ${(payments ?? []).length > 0 ? `
  <div class="payments-section">
    <h3>Payment History</h3>
    ${(payments ?? []).map((p: any) => `
    <div class="pmt-row">
      <span>${formatDate(p.paid_at)} · ${p.method}</span>
      <span>${p.reference_note ? '(' + p.reference_note + ')' : ''}</span>
      <span>${fmt(p.amount)}</span>
    </div>`).join('')}
  </div>` : ''}

  ${(puramass?.refunds ?? []).length > 0 ? `
  <div class="payments-section">
    <h3>Stealth Health Refunds</h3>
    ${(puramass?.refunds ?? []).map((r) => `
    <div class="pmt-row">
      <span>${r.created_at ? formatDate(r.created_at) : '—'}</span>
      <span>${esc(r.reason ?? '')}</span>
      <span>${r.amount_cents != null ? `– ${fmt(centsToAmount(r.amount_cents) as number)}` : '—'}</span>
    </div>`).join('')}
  </div>` : ''}

  ${invoice.notes ? `<div style="margin-top:24px;padding:16px;background:#f7fafb;border-radius:8px;font-size:12px"><strong>Notes:</strong> ${invoice.notes}</div>` : ''}

  <footer>Thank you for your business.</footer>
</div>
${autoPrint ? '<script>window.addEventListener("load", () => { setTimeout(() => window.print(), 300); });</script>' : ''}
</body>
</html>`;
}
