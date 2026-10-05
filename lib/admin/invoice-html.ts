/**
 * Standalone A4 print-HTML for an invoice.
 *
 * Rendered server-side and served straight to the browser: `?download=1`
 * appends a `window.print()` bootstrap so the "Download PDF" button
 * lands in the OS print dialog.
 *
 * Status pill / totals rules mirror `lib/admin/invoice-status.ts` and
 * `lib/invoice-pdf.ts` so the browser view, the pdfkit attachment, and
 * the list badges never disagree.
 */
import { formatAppDate } from '@/lib/datetime';
import type { InvoiceStatus } from '@/lib/types/ecommerce';
import { INVOICE_STATUS_META, effectiveStatus } from './invoice-status';

export interface InvoiceHtmlLineItem {
  description: string;
  qty: number;
  unit_price: number;
  discount_pct: number;
  line_total: number;
  price_type?: 'box' | 'vial' | null;
  product?: { sku?: string | null } | null;
}

export interface InvoiceHtmlPayment {
  amount: number;
  method: string;
  reference_note?: string | null;
  paid_at: string;
}

export interface InvoiceHtmlInvoice {
  invoice_number: string;
  status: InvoiceStatus;
  issue_date: string;
  due_date: string;
  currency?: 'CAD' | 'USD' | string | null;
  with_labels?: boolean | null;
  fulfillment_type?: 'shipment' | 'pickup' | string | null;
  subtotal: number;
  tax_total: number;
  tax_rate?: number | null;
  shipping_cost: number;
  processing_fee?: number | null;
  show_processing_fee?: boolean | null;
  total: number;
  notes?: string | null;
  customer_name?: string | null;
  customer_email?: string | null;
  customer_phone?: string | null;
  customer?: {
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
    shipping_address?: string;
    shipping_city?: string;
    shipping_state?: string;
    shipping_postal_code?: string;
    shipping_country?: string;
  } | null;
  sales_person?: {
    first_name?: string;
    last_name?: string;
    email?: string;
  } | null;
  line_items?: InvoiceHtmlLineItem[];
  payments?: InvoiceHtmlPayment[];
  amount_paid?: number;
}

export interface BuildInvoiceHtmlOptions {
  /** Inject `window.print()` on load — used by "Download PDF" button. */
  autoPrint?: boolean;
}

const ACCENT = '#438B9E';
const INK = '#07203A';
const MUTED = '#56707F';
const RULE = '#DCE7EB';
const SURFACE = '#F7FAFB';

function escape(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatMoney(n: number, currency: string): string {
  const code = currency === 'USD' ? 'USD' : 'CAD';
  return new Intl.NumberFormat(code === 'USD' ? 'en-US' : 'en-CA', {
    style: 'currency',
    currency: code,
    currencyDisplay: 'narrowSymbol',
  }).format(Number.isFinite(n) ? n : 0);
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return formatAppDate(iso, { year: 'numeric', month: 'long', day: 'numeric' }, 'en-CA', escape(iso));
}

function customerBlock(inv: InvoiceHtmlInvoice): {
  name: string;
  email: string;
  phone: string;
  address: string;
} {
  const c = inv.customer ?? null;
  const name = c
    ? `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim()
    : (inv.customer_name ?? 'Guest');
  const email = c?.email ?? inv.customer_email ?? '';
  const phone = c?.phone ?? inv.customer_phone ?? '';
  const address = c
    ? [
        c.shipping_address,
        c.shipping_city,
        c.shipping_state,
        c.shipping_postal_code,
        c.shipping_country,
      ]
        .filter(Boolean)
        .join(', ')
    : '';
  return { name: name || 'Guest', email, phone, address };
}

/**
 * Build a standalone A4 HTML invoice document.
 *
 * The returned string is a full `<!DOCTYPE html>` page — safe to serve
 * with `Content-Type: text/html` or pipe into a headless-Chromium PDF
 * generator. `autoPrint` triggers the browser print dialog on load,
 * which powers the "Download / Print" button in the admin.
 */
export function buildInvoiceHtml(
  invoice: InvoiceHtmlInvoice,
  opts: BuildInvoiceHtmlOptions = {},
): string {
  const currency =
    invoice.currency === 'USD' || invoice.currency === 'CAD'
      ? invoice.currency
      : 'CAD';
  const fmt = (n: number) => formatMoney(n, currency);

  const status = effectiveStatus(
    invoice.status,
    invoice.due_date,
  ) as InvoiceStatus;
  const meta = INVOICE_STATUS_META[status] ?? INVOICE_STATUS_META.draft;

  const cust = customerBlock(invoice);
  const sp = invoice.sales_person;
  const salesName = sp
    ? `${sp.first_name ?? ''} ${sp.last_name ?? ''}`.trim()
    : '';

  const lines = invoice.line_items ?? [];
  const payments = invoice.payments ?? [];
  const amountPaid = Number(
    invoice.amount_paid ?? payments.reduce((s, p) => s + Number(p.amount), 0),
  );
  const total = Number(invoice.total ?? 0);
  const amountDue = Math.max(0, total - amountPaid);

  const showFee =
    invoice.fulfillment_type === 'pickup' &&
    !!invoice.show_processing_fee &&
    Number(invoice.processing_fee ?? 0) > 0;
  const fee = showFee ? Number(invoice.processing_fee ?? 0) : 0;

  const lineRows = lines
    .map((li) => {
      const pt = li.price_type === 'vial' ? 'vial' : 'box';
      const chip = `<span class="pt-chip pt-${pt}">${pt === 'vial' ? 'Vial' : 'Box'}</span>`;
      return `
        <tr>
          <td class="sku">${escape(li.product?.sku ?? '—')}</td>
          <td>${escape(li.description)} ${chip}</td>
          <td class="num">${escape(li.qty)}</td>
          <td class="num">${fmt(Number(li.unit_price))}</td>
          <td class="num">${
            Number(li.discount_pct) > 0
              ? escape(li.discount_pct) + '%'
              : '—'
          }</td>
          <td class="num">${fmt(Number(li.line_total))}</td>
        </tr>`;
    })
    .join('');

  const taxLabel =
    invoice.tax_rate && Number(invoice.tax_rate) > 0
      ? `Tax (${Number(invoice.tax_rate)}%)`
      : 'Tax';

  const paymentRows = payments
    .map(
      (p) => `
        <div class="pmt-row">
          <span>${escape(formatDate(p.paid_at))} · ${escape(p.method)}${
            p.reference_note
              ? ` · <span class="muted">${escape(p.reference_note)}</span>`
              : ''
          }</span>
          <span class="num">${fmt(Number(p.amount))}</span>
        </div>`,
    )
    .join('');

  const autoPrintScript = opts.autoPrint
    ? '<script>window.addEventListener("load", () => { setTimeout(() => window.print(), 300); });</script>'
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Invoice ${escape(invoice.invoice_number)}</title>
<style>
  @page { size: A4; margin: 18mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 12px;
    color: ${INK};
    background: #fff;
  }
  .page { max-width: 800px; margin: 0 auto; padding: 32px 40px; }
  header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding-bottom: 18px;
    border-bottom: 2px solid ${INK};
    margin-bottom: 28px;
  }
  .brand-name {
    font-size: 22px;
    font-weight: 800;
    letter-spacing: 2px;
    color: ${INK};
  }
  .brand-kicker {
    margin-top: 3px;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: ${ACCENT};
  }
  .brand-contact {
    margin-top: 6px;
    font-size: 11px;
    color: ${MUTED};
    letter-spacing: 0.02em;
  }
  .doc-meta { text-align: right; }
  .doc-meta h2 {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: ${INK};
  }
  .doc-meta .number {
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
    font-size: 13px;
    color: ${MUTED};
    margin-top: 4px;
  }
  .status-badge {
    display: inline-block;
    margin-top: 10px;
    padding: 3px 10px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: ${meta.pdf.fg};
    background: ${meta.pdf.bg};
  }
  .parties {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
    margin-bottom: 24px;
  }
  .party h3 {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: ${MUTED};
    margin-bottom: 6px;
  }
  .party p { line-height: 1.55; font-size: 12px; }
  .party .name { font-weight: 700; }
  .dates {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 12px;
    background: ${SURFACE};
    border: 1px solid ${RULE};
    border-radius: 6px;
    padding: 14px 16px;
    margin-bottom: 24px;
  }
  .date-item h4 {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: ${MUTED};
    margin-bottom: 4px;
  }
  .date-item p {
    font-size: 12px;
    font-weight: 600;
    color: ${INK};
  }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  thead th {
    border-bottom: 2px solid ${RULE};
    padding: 8px 6px;
    text-align: left;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: ${MUTED};
  }
  thead th.num, tbody td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tbody td {
    padding: 8px 6px;
    border-bottom: 1px solid #EDF3F5;
    vertical-align: top;
  }
  tbody td.sku {
    font-family: 'SFMono-Regular', Consolas, monospace;
    font-size: 10px;
    color: ${MUTED};
  }
  .pt-chip {
    display: inline-block;
    margin-left: 6px;
    padding: 1px 6px;
    border-radius: 999px;
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    vertical-align: 1px;
  }
  .pt-box { background: #EDF3F5; color: #0E3F5F; }
  .pt-vial { background: #E1EFF1; color: ${ACCENT}; }
  tbody tr:last-child td { border-bottom: none; }
  .totals { display: flex; justify-content: flex-end; margin-bottom: 24px; }
  .totals-inner { width: 280px; }
  .totals-row {
    display: flex;
    justify-content: space-between;
    padding: 4px 0;
    font-size: 12px;
    color: ${INK};
    font-variant-numeric: tabular-nums;
  }
  .totals-row.muted { color: ${MUTED}; }
  .totals-row.total {
    border-top: 2px solid ${INK};
    padding-top: 8px;
    margin-top: 4px;
    font-weight: 700;
    font-size: 14px;
  }
  .totals-row.due {
    color: ${ACCENT};
    font-weight: 700;
    font-size: 14px;
    border-top: 1px solid ${RULE};
    padding-top: 8px;
    margin-top: 4px;
  }
  .payments {
    margin-top: 16px;
    border-top: 1px solid ${RULE};
    padding-top: 14px;
  }
  .payments h3 {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: ${MUTED};
    margin-bottom: 8px;
  }
  .pmt-row {
    display: flex;
    justify-content: space-between;
    padding: 5px 0;
    border-bottom: 1px solid #EDF3F5;
    font-size: 11px;
  }
  .muted { color: ${MUTED}; }
  .notes {
    margin-top: 24px;
    padding: 14px 16px;
    background: ${SURFACE};
    border-left: 3px solid ${ACCENT};
    border-radius: 4px;
    font-size: 11px;
    line-height: 1.55;
  }
  .notes strong { color: ${INK}; }
  footer {
    margin-top: 40px;
    padding-top: 18px;
    border-top: 1px solid ${RULE};
    font-size: 10px;
    color: ${MUTED};
    text-align: center;
    letter-spacing: 0.04em;
  }
  @media print { body { padding: 0; } .page { padding: 0; } }
</style>
</head>
<body>
<div class="page">
  <header>
    <div>
      <div class="brand-name">VYTA</div>
      <div class="brand-kicker">Biosciences</div>
      <div class="brand-contact">vytabio.com &middot; support@vytabio.com</div>
    </div>
    <div class="doc-meta">
      <h2>Invoice</h2>
      <div class="number">${escape(invoice.invoice_number)}</div>
      <div><span class="status-badge">${escape(meta.label)}</span></div>
    </div>
  </header>

  <div class="parties">
    <div class="party">
      <h3>Bill To</h3>
      <p>
        <span class="name">${escape(cust.name)}</span><br>
        ${cust.email ? `${escape(cust.email)}<br>` : ''}
        ${cust.phone ? `${escape(cust.phone)}<br>` : ''}
        ${cust.address ? escape(cust.address) : ''}
      </p>
    </div>
    ${
      salesName
        ? `
    <div class="party">
      <h3>Sales Person</h3>
      <p>
        <span class="name">${escape(salesName)}</span><br>
        ${sp?.email ? escape(sp.email) : ''}
      </p>
    </div>`
        : `<div></div>`
    }
  </div>

  <div class="dates">
    <div class="date-item"><h4>Issue Date</h4><p>${escape(formatDate(invoice.issue_date))}</p></div>
    <div class="date-item"><h4>Due Date</h4><p>${escape(formatDate(invoice.due_date))}</p></div>
    <div class="date-item"><h4>Invoice #</h4><p>${escape(invoice.invoice_number)}</p></div>
    <div class="date-item"><h4>Currency</h4><p>${escape(currency)}</p></div>
    <div class="date-item"><h4>Labels</h4><p>${invoice.with_labels === false ? 'No' : 'Yes'}</p></div>
  </div>

  <table>
    <thead>
      <tr>
        <th>SKU</th>
        <th>Description</th>
        <th class="num">Qty</th>
        <th class="num">Unit Price</th>
        <th class="num">Disc %</th>
        <th class="num">Total</th>
      </tr>
    </thead>
    <tbody>${lineRows || `<tr><td colspan="6" class="muted" style="padding:12px 6px">No line items.</td></tr>`}</tbody>
  </table>

  <div class="totals">
    <div class="totals-inner">
      <div class="totals-row muted"><span>Subtotal</span><span>${fmt(Number(invoice.subtotal))}</span></div>
      <div class="totals-row muted"><span>${escape(taxLabel)}</span><span>${fmt(Number(invoice.tax_total))}</span></div>
      <div class="totals-row muted"><span>Shipping</span><span>${fmt(Number(invoice.shipping_cost))}</span></div>
      ${showFee ? `<div class="totals-row muted"><span>Processing Fee</span><span>${fmt(fee)}</span></div>` : ''}
      <div class="totals-row total"><span>Total</span><span>${fmt(total)} ${escape(currency)}</span></div>
      ${amountPaid > 0 ? `<div class="totals-row muted"><span>Paid</span><span>&minus; ${fmt(amountPaid)}</span></div>` : ''}
      ${amountPaid > 0 ? `<div class="totals-row due"><span>Amount Due</span><span>${fmt(amountDue)}</span></div>` : ''}
    </div>
  </div>

  ${
    payments.length > 0
      ? `<div class="payments"><h3>Payment History</h3>${paymentRows}</div>`
      : ''
  }

  ${
    invoice.notes
      ? `<div class="notes"><strong>Notes:</strong> ${escape(invoice.notes)}</div>`
      : ''
  }

  <footer>Thank you for your business. &middot; VYTA Biosciences</footer>
</div>
${autoPrintScript}
</body>
</html>`;
}
