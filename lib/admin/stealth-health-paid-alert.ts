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
 * Nothing here throws: a payment webhook or an admin's status change must never
 * fail because an email couldn't be sent. Callers pass the service-role client.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingColumnError } from '@/lib/payments/puramass-columns';

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

function formatShipTo(addr: unknown): string | null {
  if (!addr || typeof addr !== 'object') return null;
  const a = addr as Record<string, unknown>;
  const parts = [a.address, a.address2, a.city, a.state, a.zip, a.country]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
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
  row: { invoice_id: string; to_email: string; subject: string; success: boolean; error: string | null },
): Promise<void> {
  try {
    const { error } = await db.from('fulfillment_email_log').insert({
      ...row,
      order_id: null,
      message_id: null,
      sent_by: null,
      sent_by_email: null,
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
        .select('product_id, description, qty, line_total')
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

    const allLines = (lines ?? []) as Array<Record<string, any>>;
    const { sendStealthHealthOrderAlert } = await import('@/lib/email');
    const res = await sendStealthHealthOrderAlert({
      to,
      invoiceId: invoice.id,
      invoiceNumber: trimOrNull(invoice.invoice_number),
      customerName: trimOrNull(invoice.customer_name) ?? trimOrNull(ledger.customer_name),
      customerEmail: trimOrNull(invoice.customer_email) ?? trimOrNull(ledger.customer_email),
      items: allLines.map((l) => ({
        description: String(l.description ?? ''),
        qty: Number(l.qty) || 0,
        lineTotal: Number(l.line_total) || 0,
      })),
      subtotal: Number(invoice.subtotal) || 0,
      shipping: Number(invoice.shipping_cost) || 0,
      shippingCourier: trimOrNull(ledger.shipping_courier),
      total: Number(invoice.total) || 0,
      currency: trimOrNull(invoice.currency) ?? 'CAD',
      discountCode: trimOrNull(ledger.discount_code),
      shipTo: formatShipTo(ledger.shipping_address),
      paidVia: opts.paidVia,
      // Lines with no product took no stock and need linking by hand.
      stockWarnings: allLines
        .filter((l) => !l.product_id)
        .map((l) => `${String(l.description ?? 'Item')} × ${Number(l.qty) || 0}`),
    });

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
