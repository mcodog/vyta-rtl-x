/**
 * "New Stealth Health order paid" email to the admin notification list
 * (Admin → Settings → Admin Email Notifications). The admin-side counterpart of
 * the buyer's order confirmation (lib/order-confirmation.ts), sent from the
 * same paid signals:
 *   • every webhook / poll / admin-refresh pass of
 *     `materializeStealthHealthFulfillment`, and
 *   • an admin marking the hand-off's invoice paid (status change or a payment
 *     that settles it in full).
 *
 * Exactly once: the send first claims the hand-off row
 * (`admin_paid_alert_sent_at` NULL → now()); only the caller whose conditional
 * update hit a row sends, and a failed send releases the claim so the next
 * signal retries. Every attempt is logged to `fulfillment_email_log`
 * (kind 'admin_paid_alert').
 *
 * Until stealth-health-admin-paid-alert-migration.sql has run there is no claim
 * column; the alert then goes out only on the call that saw the invoice turn
 * paid (`transition`), unclaimed — the behaviour before this module existed.
 *
 * Admins can also send it by hand from the invoice page
 * (`sendAdminPaidAlertManually`): for a Stealth Health invoice (a resend) and
 * for a manual invoice — no order, no hand-off — which is never sent
 * automatically. Manual sends are logged with the admin who sent them.
 *
 * Nothing here throws: a payment webhook or an admin's status change must never
 * fail because an email couldn't be sent. Callers pass the service-role client.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingColumnError } from '@/lib/payments/puramass-columns';
import { SITE_URL } from '@/lib/config';
import {
  manualInvoiceOrderSummary,
  stealthHealthOrderSummary,
  summarizeConfirmationLog,
  type ConfirmationLogRow,
  type ConfirmationSummary,
} from '@/lib/order-confirmation-data';
import type { AdminOrderPaidEmailData } from '@/lib/order-confirmation-email';

const SENT_COLUMN = 'admin_paid_alert_sent_at';
const LOG_KIND = 'admin_paid_alert';

const MIGRATION_WARNING =
  '[stealth-health-alert] puramass_orders.admin_paid_alert_sent_at is missing — run ' +
  'stealth-health-admin-paid-alert-migration.sql; the admin paid-order email is only sent ' +
  'on the first paid signal (no retry) until then.';

export type PaidAlertOutcome =
  | { sent: true }
  | {
      sent: false;
      reason:
        | 'not_found'
        | 'not_paid'
        | 'already_sent'
        | 'no_recipients'
        | 'not_migrated'
        | 'send_failed'
        | 'error';
    };

export interface PaidAlertOptions {
  /** This call saw the invoice turn paid (used only before the migration). */
  transition: boolean;
  /** Who marked it paid — changes one line of the email. */
  paidVia: 'checkout' | 'admin';
}

function trimOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

async function claim(db: SupabaseClient, id: string): Promise<'won' | 'lost' | 'not_migrated'> {
  const { data, error } = await db
    .from('puramass_orders')
    .update({ [SENT_COLUMN]: new Date().toISOString() })
    .eq('id', id)
    .is(SENT_COLUMN, null)
    .select('id');
  if (error) {
    if (isMissingColumnError(error)) {
      console.warn(MIGRATION_WARNING);
      return 'not_migrated';
    }
    console.error(`[stealth-health-alert] claim on ${id} failed:`, error);
    return 'lost';
  }
  return (data ?? []).length > 0 ? 'won' : 'lost';
}

async function release(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from('puramass_orders').update({ [SENT_COLUMN]: null }).eq('id', id);
  if (error) console.error(`[stealth-health-alert] releasing ${id} failed:`, error);
}

async function logAttempt(
  db: SupabaseClient,
  row: {
    invoice_id: string;
    to_email: string;
    subject: string;
    success: boolean;
    error: string | null;
    sent_by?: string | null;
    sent_by_email?: string | null;
  },
): Promise<void> {
  try {
    const { error } = await db.from('fulfillment_email_log').insert({
      sent_by: null,
      sent_by_email: null,
      ...row,
      order_id: null,
      message_id: null,
      kind: LOG_KIND,
    });
    if (error) console.error('[stealth-health-alert] logging the send failed:', error);
  } catch (err) {
    console.error('[stealth-health-alert] logging the send threw:', err);
  }
}

/**
 * Email the admins that a Stealth Health hand-off is paid, if it is and the
 * alert hasn't gone out yet. Safe to call on every paid signal.
 */
export async function sendStealthHealthPaidAlertOnce(
  db: SupabaseClient,
  puramassOrderId: string,
  opts: PaidAlertOptions,
): Promise<PaidAlertOutcome> {
  try {
    // `*` so a not-yet-migrated optional column can't fail the read.
    const { data: ledger, error } = await db
      .from('puramass_orders')
      .select('*')
      .eq('id', puramassOrderId)
      .maybeSingle();
    if (error) throw error;
    if (!ledger || !ledger.invoice_id) return { sent: false, reason: 'not_found' };

    const [{ data: invoice }, { data: lines }] = await Promise.all([
      db.from('invoices').select('*').eq('id', ledger.invoice_id).maybeSingle(),
      db
        .from('invoice_line_items')
        .select('*')
        .eq('invoice_id', ledger.invoice_id),
    ]);
    if (!invoice) return { sent: false, reason: 'not_found' };
    // The invoice is written at checkout (pending_payment); only the invoice
    // or the ledger saying "paid" counts.
    if (invoice.status !== 'paid' && ledger.status !== 'paid') {
      return { sent: false, reason: 'not_paid' };
    }

    const migrated = SENT_COLUMN in ledger;
    if (!migrated) {
      console.warn(MIGRATION_WARNING);
      if (!opts.transition) return { sent: false, reason: 'not_migrated' };
    } else if (ledger[SENT_COLUMN]) {
      return { sent: false, reason: 'already_sent' };
    }

    const { getAdminAlertEmails } = await import('@/lib/admin/alert-recipients');
    const to = await getAdminAlertEmails(db);
    if (to.length === 0) {
      console.warn(
        `[stealth-health-alert] no admin recipients configured — paid alert for ${puramassOrderId} not sent`,
      );
      return { sent: false, reason: 'no_recipients' };
    }

    if (migrated) {
      const claimed = await claim(db, puramassOrderId);
      if (claimed === 'lost') return { sent: false, reason: 'already_sent' };
      if (claimed === 'not_migrated' && !opts.transition) return { sent: false, reason: 'not_migrated' };
    }

    const email = await buildAdminEmail(db, {
      kind: 'stealth_health',
      invoice,
      ledger,
      lines: lines ?? [],
      paidVia: opts.paidVia,
    });
    const { sendAdminOrderPaidAlert } = await import('@/lib/email');
    const res = await sendAdminOrderPaidAlert(to, email);

    await logAttempt(db, {
      invoice_id: invoice.id,
      to_email: to.join(', '),
      subject: res.subject,
      success: res.success,
      error: res.success ? null : res.error ?? 'Failed to send email',
    });

    if (!res.success) {
      if (migrated) await release(db, puramassOrderId);
      return { sent: false, reason: 'send_failed' };
    }
    return { sent: true };
  } catch (err) {
    console.error(`[stealth-health-alert] hand-off ${puramassOrderId} failed:`, err);
    return { sent: false, reason: 'error' };
  }
}

/**
 * An admin just marked an invoice paid: if it is a Stealth Health hand-off's
 * invoice, email the admins. Any other invoice is ignored.
 */
export async function sendStealthHealthPaidAlertForInvoice(
  db: SupabaseClient,
  invoiceId: string,
): Promise<PaidAlertOutcome> {
  try {
    const { data } = await db
      .from('puramass_orders')
      .select('id')
      .eq('invoice_id', invoiceId)
      .limit(1);
    const ledgerId = data?.[0]?.id as string | undefined;
    if (!ledgerId) return { sent: false, reason: 'not_found' };
    return await sendStealthHealthPaidAlertOnce(db, ledgerId, { transition: true, paidVia: 'admin' });
  } catch (err) {
    console.error(`[stealth-health-alert] paid invoice ${invoiceId} failed:`, err);
    return { sent: false, reason: 'error' };
  }
}

// ---------------------------------------------------------------------------
//  Shared payload, manual send and status
// ---------------------------------------------------------------------------

/** Lines with no product took no stock and need linking by hand. */
function stockWarnings(lines: Array<Record<string, any>>): string[] {
  return lines
    .filter((l) => !l.product_id)
    .map((l) => `${String(l.description ?? 'Item')} × ${Number(l.qty) || 0}`);
}

async function loadRow(db: SupabaseClient, table: string, id: unknown): Promise<Record<string, any> | null> {
  if (typeof id !== 'string' || !id) return null;
  const { data, error } = await db.from(table).select('*').eq('id', id).maybeSingle();
  if (error) console.error(`[stealth-health-alert] reading ${table} ${id} failed:`, error);
  return (data as Record<string, any> | null) ?? null;
}

/**
 * The admin email's data: the order exactly as the customer confirmation
 * shows it (line items with images, totals with the discount row, ship-to),
 * plus the customer's contact details, courier, discount code and any lines
 * that took no stock.
 */
async function buildAdminEmail(
  db: SupabaseClient,
  src:
    | { kind: 'stealth_health'; invoice: Record<string, any>; ledger: Record<string, any>; lines: Array<Record<string, any>>; paidVia: 'checkout' | 'admin' }
    | { kind: 'manual'; invoice: Record<string, any>; lines: Array<Record<string, any>>; paidVia: 'checkout' | 'admin' },
): Promise<AdminOrderPaidEmailData> {
  const { invoice, lines } = src;
  const ledger = src.kind === 'stealth_health' ? src.ledger : null;
  const customer = await loadRow(db, 'customers', invoice.customer_id ?? ledger?.customer_id);
  const client =
    src.kind === 'manual' && invoice.ships_to_client ? await loadRow(db, 'customer_clients', invoice.client_id) : null;

  const summary =
    src.kind === 'stealth_health'
      ? stealthHealthOrderSummary(src.ledger, invoice, lines, customer)
      : manualInvoiceOrderSummary(invoice, lines, customer, client);
  const { withProductImages } = await import('@/lib/order-confirmation');
  const order = await withProductImages(db, summary);

  const accountName =
    [trimOrNull(customer?.first_name), trimOrNull(customer?.last_name)].filter(Boolean).join(' ') || null;
  return {
    order,
    source: src.kind,
    paidVia: src.paidVia,
    customer: {
      name: accountName ?? trimOrNull(invoice.customer_name) ?? trimOrNull(ledger?.customer_name),
      email: trimOrNull(customer?.email) ?? trimOrNull(invoice.customer_email) ?? trimOrNull(ledger?.customer_email),
      phone: trimOrNull(customer?.phone) ?? trimOrNull(invoice.customer_phone) ?? trimOrNull(ledger?.customer_phone),
    },
    courier: trimOrNull(ledger ? ledger.shipping_courier : invoice.carrier),
    discountCode: trimOrNull(ledger?.discount_code),
    stockWarnings: stockWarnings(lines),
    invoiceUrl: `${SITE_URL}/admin/invoices/${invoice.id}`,
  };
}

type LoadedForAlert =
  | { kind: 'stealth_health'; invoice: Record<string, any>; ledger: Record<string, any>; lines: Array<Record<string, any>>; paid: boolean }
  | { kind: 'manual'; invoice: Record<string, any>; lines: Array<Record<string, any>>; paid: boolean };

/** The invoice behind a manual admin send — null for an order's invoice. */
async function loadForAlert(db: SupabaseClient, invoiceId: string): Promise<LoadedForAlert | null> {
  const [{ data: invoice, error }, { data: lines }, { data: ledgers }] = await Promise.all([
    db.from('invoices').select('*').eq('id', invoiceId).maybeSingle(),
    db.from('invoice_line_items').select('*').eq('invoice_id', invoiceId),
    db.from('puramass_orders').select('*').eq('invoice_id', invoiceId).limit(1),
  ]);
  if (error) throw error;
  // Storefront orders' invoices aren't covered by this email.
  if (!invoice || invoice.order_id) return null;
  const ledger = (ledgers ?? [])[0] as Record<string, any> | undefined;
  if (ledger) {
    return {
      kind: 'stealth_health',
      invoice,
      ledger,
      lines: lines ?? [],
      paid: invoice.status === 'paid' || ledger.status === 'paid',
    };
  }
  return { kind: 'manual', invoice, lines: lines ?? [], paid: invoice.status === 'paid' };
}

const NOT_PAID_REASON = 'Mark the invoice paid first — this email tells the team an order was paid.';
const NO_RECIPIENTS_REASON = 'No admin recipients — add them under Settings → Admin Email Notifications.';

export interface AdminPaidAlertStatus {
  kind: 'stealth_health' | 'manual';
  summary: ConfirmationSummary;
  history: ConfirmationLogRow[];
  recipients: string[];
  /** Why a send isn't possible right now; null when it is. */
  blockedReason: string | null;
}

/** Sent / not sent, history and recipients for the invoice-page card. */
export async function getAdminPaidAlertStatus(
  db: SupabaseClient,
  invoiceId: string,
): Promise<AdminPaidAlertStatus | null> {
  const loaded = await loadForAlert(db, invoiceId);
  if (!loaded) return null;
  const { getAdminAlertEmails } = await import('@/lib/admin/alert-recipients');
  const [recipients, logRes] = await Promise.all([
    getAdminAlertEmails(db),
    db
      .from('fulfillment_email_log')
      .select('created_at, to_email, success, error, sent_by_email')
      .eq('kind', LOG_KIND)
      .eq('invoice_id', invoiceId)
      .order('created_at', { ascending: false })
      .limit(50),
  ]);
  if (logRes.error) console.error('[stealth-health-alert] reading the send history failed:', logRes.error);
  const history = (logRes.data ?? []) as ConfirmationLogRow[];
  return {
    kind: loaded.kind,
    summary: summarizeConfirmationLog(history),
    history,
    recipients,
    blockedReason: !loaded.paid ? NOT_PAID_REASON : recipients.length === 0 ? NO_RECIPIENTS_REASON : null,
  };
}

/**
 * Send (or resend) the admin paid-order email on an admin's request — Stealth
 * Health or manual invoice, once it is paid. Not once-only. For a Stealth
 * Health hand-off it also stamps the claim so the automatic send won't repeat.
 */
export async function sendAdminPaidAlertManually(
  db: SupabaseClient,
  invoiceId: string,
  actor: { id: string | null; email: string | null },
): Promise<{ ok: true; to: string[]; sentAt: string } | { ok: false; status: number; error: string }> {
  const loaded = await loadForAlert(db, invoiceId);
  if (!loaded) return { ok: false, status: 404, error: 'Invoice not found, or it belongs to a storefront order.' };
  if (!loaded.paid) return { ok: false, status: 422, error: NOT_PAID_REASON };

  const { getAdminAlertEmails } = await import('@/lib/admin/alert-recipients');
  const to = await getAdminAlertEmails(db);
  if (to.length === 0) return { ok: false, status: 422, error: NO_RECIPIENTS_REASON };

  const email = await buildAdminEmail(db, { ...loaded, paidVia: 'admin' });
  const { sendAdminOrderPaidAlert } = await import('@/lib/email');
  const res = await sendAdminOrderPaidAlert(to, email);
  await logAttempt(db, {
    invoice_id: invoiceId,
    to_email: to.join(', '),
    subject: res.subject,
    success: res.success,
    error: res.success ? null : res.error ?? 'Failed to send email',
    sent_by: actor.id,
    sent_by_email: actor.email,
  });
  if (!res.success) return { ok: false, status: 502, error: res.error || 'The email could not be sent.' };

  const sentAt = new Date().toISOString();
  if (loaded.kind === 'stealth_health') {
    const { error } = await db
      .from('puramass_orders')
      .update({ [SENT_COLUMN]: sentAt })
      .eq('id', loaded.ledger.id)
      .is(SENT_COLUMN, null);
    if (error && !isMissingColumnError(error)) {
      console.error('[stealth-health-alert] stamping after a manual send failed:', error);
    }
  }
  return { ok: true, to, sentAt };
}
