/**
 * Invoice email templates: application-level defaults, merge-variable
 * resolution, and a tiny `{{var}}` renderer. Used by the email route so
 * the system works even when site_settings template columns are NULL.
 */

import { formatAppDate } from '@/lib/datetime';

export interface InvoiceEmailInvoice {
  invoice_number: string;
  customer_name?: string | null;
  customer_first_name?: string | null;
  customer_last_name?: string | null;
  customer_email?: string | null;
  total: number | string;
  amount_due?: number | string;
  amount_paid?: number | string;
  due_date?: string | null;
  issue_date?: string | null;
  currency?: string | null;
  sent_by_email?: string | null;
}

export interface MergeVar {
  token: string;
  description: string;
  sample: string;
}

/**
 * Available `{{merge}}` variables, for the template editor UI (insertable chips,
 * descriptions, and the `sample` values used to render the live preview).
 */
export const MERGE_VARS: MergeVar[] = [
  { token: 'customer_name', description: "Customer's full name", sample: 'Jane Doe' },
  { token: 'customer_first_name', description: "Customer's first name", sample: 'Jane' },
  { token: 'customer_last_name', description: "Customer's last name", sample: 'Doe' },
  { token: 'customer_email', description: "Customer's email address", sample: 'jane@example.com' },
  { token: 'invoice_number', description: 'Invoice number', sample: 'INV-2026-0042' },
  { token: 'invoice_total', description: 'Invoice grand total', sample: '$320.00' },
  { token: 'amount_due', description: 'Outstanding balance', sample: '$120.00' },
  { token: 'amount_paid', description: 'Amount already paid', sample: '$200.00' },
  { token: 'due_date', description: 'Payment due date', sample: 'Jun 30, 2026' },
  { token: 'issue_date', description: 'Invoice issue date', sample: 'Jun 12, 2026' },
  { token: 'currency', description: 'Invoice currency code', sample: 'CAD' },
  { token: 'sent_by_email', description: 'Email of the admin who sent it', sample: 'admin@aminocan.com' },
  { token: 'company_name', description: 'Your company name', sample: 'VYTA Biosciences' },
];

export const COMPANY_NAME = 'VYTA Biosciences';

export const DEFAULT_CUSTOMER_SUBJECT = 'Invoice {{invoice_number}} from {{company_name}}';
export const DEFAULT_CUSTOMER_BODY = [
  'Hi {{customer_name}},',
  '',
  'Please find attached invoice {{invoice_number}} for {{total}}.',
  'Amount due: {{amount_due}} (due {{due_date}}).',
  '',
  'Thank you for your business.',
  '{{company_name}}',
].join('\n');

export const DEFAULT_ADMIN_SUBJECT = 'Invoice {{invoice_number}} sent to {{customer_name}}';
export const DEFAULT_ADMIN_BODY = [
  'Invoice {{invoice_number}} was emailed to {{customer_name}}.',
  'Total: {{total}} — Amount due: {{amount_due}}.',
].join('\n');

function money(v: number | string | null | undefined, currency?: string | null): string {
  const n = Number(v ?? 0);
  const prefix = currency === 'USD' ? 'US$' : '$';
  return `${prefix}${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
}

function date(v: string | null | undefined): string {
  return formatAppDate(v, {});
}

export function buildInvoiceMergeVars(inv: InvoiceEmailInvoice): Record<string, string> {
  const fullName = inv.customer_name ?? 'there';
  return {
    invoice_number: inv.invoice_number ?? '',
    customer_name: fullName,
    customer_first_name: inv.customer_first_name ?? fullName.split(' ')[0] ?? '',
    customer_last_name: inv.customer_last_name ?? fullName.split(' ').slice(1).join(' '),
    customer_email: inv.customer_email ?? '',
    total: money(inv.total, inv.currency),
    invoice_total: money(inv.total, inv.currency),
    amount_due: money(inv.amount_due ?? inv.total, inv.currency),
    amount_paid: money(inv.amount_paid ?? 0, inv.currency),
    due_date: date(inv.due_date),
    issue_date: date(inv.issue_date),
    currency: inv.currency ?? 'CAD',
    sent_by_email: inv.sent_by_email ?? '',
    company_name: COMPANY_NAME,
  };
}

/** Replace `{{key}}` tokens. Unknown tokens are left blank. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => vars[key] ?? '');
}

/** Convert a plain-text body into simple HTML (escaped, line breaks preserved). */
export function plainTextToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;color:#07203A;line-height:1.6;white-space:pre-wrap;">${escaped}</div>`;
}
