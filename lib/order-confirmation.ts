/**
 * Paid-order confirmation email — send it once when an order is paid, let an
 * admin see whether it went out and (re)send it by hand.
 *
 * Two kinds of order can be confirmed:
 *   • Stealth Health hand-offs (`puramass_orders` + their invoice). Paid by the
 *     processor; `materializeStealthHealthFulfillment` sends on every webhook /
 *     poll pass, and so does an admin marking the hand-off's invoice paid.
 *   • Storefront `orders`. Only rows from a storefront checkout
 *     (`isStorefrontCheckoutSource`) are sent automatically — none on VYTA
 *     today — but every order gets the admin status card and manual send.
 *
 * Exactly once: every paid signal can fire more than once, so the automatic
 * send first claims the row (`confirmation_email_sent_at` NULL → now()); only
 * the caller whose conditional update hit a row sends, and a failed send
 * releases the claim so the next signal retries. Every attempt is logged to
 * `fulfillment_email_log` (kind 'order_confirmation') for the admin history.
 *
 * Nothing here throws to the caller: a payment webhook or an admin's status
 * change must never fail because an email couldn't be sent. Callers pass the
 * service-role client.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendOrderConfirmation } from '@/lib/email';
import { SITE_URL } from '@/lib/config';
import { buildViewOrderUrl } from '@/lib/customer/order-link';
import { isMissingColumnError } from '@/lib/payments/puramass-columns';
import {
  isStorefrontCheckoutSource,
  stealthHealthConfirmationData,
  storefrontConfirmationData,
  summarizeConfirmationLog,
  type ConfirmationEmailData,
  type ConfirmationLogRow,
  type ConfirmationSummary,
} from '@/lib/order-confirmation-data';

const SENT_COLUMN = 'confirmation_email_sent_at';
const LOG_KIND = 'order_confirmation';
const HISTORY_LIMIT = 50;

type ClaimTable = 'orders' | 'puramass_orders';

export type ConfirmationOutcome =
  | { sent: true }
  | {
      sent: false;
      reason:
        | 'not_found'
        | 'not_eligible'
        | 'already_sent'
        | 'no_email'
        | 'not_migrated'
        | 'send_failed'
        | 'error';
    };

export type ConfirmationTargetInput =
  | { orderId: string }
  | { invoiceId: string }
  | { puramassOrderId: string };

export type ConfirmationTarget =
  | { kind: 'storefront'; orderId: string; invoiceId: string | null }
  | { kind: 'stealth_health'; puramassOrderId: string; invoiceId: string | null };

export interface ConfirmationStatus {
  kind: ConfirmationTarget['kind'];
  summary: ConfirmationSummary;
  history: ConfirmationLogRow[];
  recipient: string | null;
  orderNumber: string | null;
  /** Why a send isn't possible right now; null when it is. */
  blockedReason: string | null;
}

const MIGRATION_WARNING =
  '[order-confirmation] orders/puramass_orders.confirmation_email_sent_at is missing — ' +
  'run order-confirmation-email-migration.sql; automatic confirmation emails are off until then.';

const NOT_PAID_REASON = 'Not paid yet — the confirmation goes out once the order is paid.';
const NO_EMAIL_REASON = 'No real email address on this order.';

// ---------------------------------------------------------------------------
//  Loading
// ---------------------------------------------------------------------------

interface LoadedStorefront {
  order: Record<string, any>;
  data: ConfirmationEmailData | null;
}

interface LoadedStealthHealth {
  ledger: Record<string, any>;
  invoice: Record<string, any> | null;
  paid: boolean;
  data: ConfirmationEmailData | null;
}

async function loadStorefront(db: SupabaseClient, orderId: string): Promise<LoadedStorefront | null> {
  // `*` so a not-yet-migrated optional column can't fail the read.
  const { data: order, error } = await db.from('orders').select('*').eq('id', orderId).maybeSingle();
  if (error) throw error;
  if (!order) return null;

  const filled: Record<string, any> = { ...order };

  // Admin-created orders keep their lines in order_items, not orders.items.
  if (!Array.isArray(order.items) || order.items.length === 0) {
    const { data: lines } = await db.from('order_items').select('*').eq('order_id', orderId);
    filled.items = (lines ?? []).map((l: any) => ({
      name: l.product_name ?? l.name_snapshot,
      strength: l.strength ?? l.product_strength,
      quantity: l.quantity ?? l.qty,
      price: l.price_at_time ?? l.unit_price,
    }));
  }

  // …and usually no email of their own: fall back to the customer account.
  if (!String(order.email ?? '').trim() && order.customer_id) {
    const { data: customer } = await db
      .from('customers')
      .select('email, first_name, last_name')
      .eq('id', order.customer_id)
      .maybeSingle();
    if (customer) {
      filled.email = customer.email;
      const addr = order.shipping_address && typeof order.shipping_address === 'object'
        ? order.shipping_address
        : {};
      if (!addr.firstName && !addr.first_name) {
        filled.shipping_address = {
          ...addr,
          firstName: customer.first_name ?? '',
          lastName: customer.last_name ?? '',
        };
      }
    }
  }

  return { order, data: storefrontConfirmationData(filled) };
}

async function loadStealthHealth(
  db: SupabaseClient,
  puramassOrderId: string,
): Promise<LoadedStealthHealth | null> {
  const { data: ledger, error } = await db
    .from('puramass_orders')
    .select('*')
    .eq('id', puramassOrderId)
    .maybeSingle();
  if (error) throw error;
  if (!ledger) return null;

  let invoice: Record<string, any> | null = null;
  let lines: Array<Record<string, any>> = [];
  if (ledger.invoice_id) {
    const [inv, li] = await Promise.all([
      db.from('invoices').select('*').eq('id', ledger.invoice_id).maybeSingle(),
      db
        .from('invoice_line_items')
        // `*`: product_id / price_type / vials_per_unit arrive with later
        // migrations, and naming them would fail the read before those ran.
        .select('*')
        .eq('invoice_id', ledger.invoice_id),
    ]);
    invoice = inv.data ?? null;
    lines = li.data ?? [];
  }

  // The hand-off's invoice is written at checkout (pending_payment), so its
  // existence alone doesn't mean paid — the ledger or the invoice must say so.
  const paid = !!invoice && (ledger.status === 'paid' || invoice.status === 'paid');
  return {
    ledger,
    invoice,
    paid,
    data: invoice ? stealthHealthConfirmationData(ledger, invoice, lines) : null,
  };
}

async function invoiceIdForOrder(db: SupabaseClient, orderId: string): Promise<string | null> {
  const { data } = await db.from('invoices').select('id').eq('order_id', orderId).limit(1);
  return (data?.[0]?.id as string | undefined) ?? null;
}

// ---------------------------------------------------------------------------
//  Claim / send / log / release
// ---------------------------------------------------------------------------

async function claim(
  db: SupabaseClient,
  table: ClaimTable,
  id: string,
): Promise<'won' | 'lost' | 'not_migrated'> {
  const { data, error } = await db
    .from(table)
    .update({ [SENT_COLUMN]: new Date().toISOString() })
    .eq('id', id)
    .is(SENT_COLUMN, null)
    .select('id');
  if (error) {
    if (isMissingColumnError(error)) {
      console.warn(MIGRATION_WARNING);
      return 'not_migrated';
    }
    console.error(`[order-confirmation] claim on ${table} ${id} failed:`, error);
    return 'lost';
  }
  return (data ?? []).length > 0 ? 'won' : 'lost';
}

async function release(db: SupabaseClient, table: ClaimTable, id: string): Promise<void> {
  const { error } = await db.from(table).update({ [SENT_COLUMN]: null }).eq('id', id);
  if (error) console.error(`[order-confirmation] releasing ${table} ${id} failed:`, error);
}

/** Public URL for a catalog image path (spaces and all), or null. */
function absoluteImageUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const url = raw.trim();
  if (/^https?:\/\//i.test(url)) return url;
  return `${SITE_URL}${encodeURI(url.startsWith('/') ? url : `/${url}`)}`;
}

/**
 * Fill in what the pure payload can't know: each line's product image and
 * the "View Order Details" link (sign in / sign up, then the order page).
 * Best-effort — the email still goes out without either.
 */
async function enrichForEmail(
  db: SupabaseClient,
  data: ConfirmationEmailData,
): Promise<ConfirmationEmailData> {
  const out: ConfirmationEmailData = { ...data, items: data.items.map((i) => ({ ...i })) };

  const ids = [...new Set(out.items.map((i) => i.productId).filter((id): id is string => !!id))];
  if (ids.length > 0) {
    try {
      const { data: products } = await db.from('products').select('id, image_url').in('id', ids);
      const byId = new Map<string, string | null>(
        (products ?? []).map((p: any) => [String(p.id), absoluteImageUrl(p.image_url)]),
      );
      for (const item of out.items) {
        const url = item.productId ? byId.get(item.productId) : null;
        if (url) item.imageUrl = url;
      }
    } catch (err) {
      console.error('[order-confirmation] product image lookup failed:', err);
    }
  }

  if (out.accountOrderId) {
    try {
      out.viewOrderUrl = await buildViewOrderUrl(db, SITE_URL, out.accountOrderId, out.to);
    } catch (err) {
      console.error('[order-confirmation] building the order link failed:', err);
    }
  }
  return out;
}

async function deliver(
  db: SupabaseClient,
  data: ConfirmationEmailData,
): Promise<{ success: boolean; id?: string; error?: string; subject: string }> {
  try {
    return await sendOrderConfirmation(await enrichForEmail(db, data));
  } catch (err: any) {
    return {
      success: false,
      error: err?.message ?? 'Failed to send email',
      subject: `Order Confirmed - ${data.orderNumber}`,
    };
  }
}

async function logAttempt(
  db: SupabaseClient,
  row: {
    order_id: string | null;
    invoice_id: string | null;
    to_email: string;
    subject: string;
    message_id: string | null;
    success: boolean;
    error: string | null;
    sent_by: string | null;
    sent_by_email: string | null;
  },
): Promise<void> {
  try {
    const { error } = await db.from('fulfillment_email_log').insert({ ...row, kind: LOG_KIND });
    // Supabase returns (doesn't throw) a rejected insert — e.g. a CHECK on
    // `kind` that predates this email. Say so, or the admin's history goes
    // blank while the emails still go out.
    if (error) {
      console.error(
        `[order-confirmation] logging the send to ${row.to_email} failed ` +
          '(run order-confirmation-email-migration.sql if this is a CHECK on kind):',
        error,
      );
    }
  } catch (err) {
    console.error('[order-confirmation] logging the send threw:', err);
  }
}

async function claimAndSend(
  db: SupabaseClient,
  table: ClaimTable,
  id: string,
  data: ConfirmationEmailData,
  link: { order_id: string | null; invoice_id: string | null },
): Promise<ConfirmationOutcome> {
  const claimed = await claim(db, table, id);
  if (claimed === 'not_migrated') return { sent: false, reason: 'not_migrated' };
  if (claimed === 'lost') return { sent: false, reason: 'already_sent' };

  const res = await deliver(db, data);
  await logAttempt(db, {
    ...link,
    to_email: data.to,
    subject: res.subject,
    message_id: res.id ?? null,
    success: res.success,
    error: res.success ? null : res.error ?? 'Failed to send email',
    sent_by: null,
    sent_by_email: null,
  });

  if (!res.success) {
    await release(db, table, id);
    return { sent: false, reason: 'send_failed' };
  }
  return { sent: true };
}

// ---------------------------------------------------------------------------
//  Automatic sends
// ---------------------------------------------------------------------------

/** Send a storefront order's confirmation if it hasn't gone out yet. */
export async function sendStorefrontOrderConfirmationOnce(
  db: SupabaseClient,
  orderId: string,
): Promise<ConfirmationOutcome> {
  try {
    const loaded = await loadStorefront(db, orderId);
    if (!loaded) return { sent: false, reason: 'not_found' };
    const { order, data } = loaded;

    if (!isStorefrontCheckoutSource(order.source)) return { sent: false, reason: 'not_eligible' };
    if (!(SENT_COLUMN in order)) {
      console.warn(MIGRATION_WARNING);
      return { sent: false, reason: 'not_migrated' };
    }
    if (order[SENT_COLUMN]) return { sent: false, reason: 'already_sent' };
    if (!data) return { sent: false, reason: 'no_email' };

    const invoiceId = await invoiceIdForOrder(db, orderId);
    return await claimAndSend(db, 'orders', orderId, data, { order_id: orderId, invoice_id: invoiceId });
  } catch (err) {
    console.error(`[order-confirmation] storefront order ${orderId} failed:`, err);
    return { sent: false, reason: 'error' };
  }
}

/**
 * Send a Stealth Health hand-off's confirmation if it is paid and it hasn't
 * gone out yet. Safe to call on every webhook / poll pass.
 */
export async function sendStealthHealthOrderConfirmationOnce(
  db: SupabaseClient,
  puramassOrderId: string,
): Promise<ConfirmationOutcome> {
  try {
    const loaded = await loadStealthHealth(db, puramassOrderId);
    if (!loaded) return { sent: false, reason: 'not_found' };
    const { ledger, invoice, paid, data } = loaded;

    if (!paid || !invoice) return { sent: false, reason: 'not_eligible' };
    if (!(SENT_COLUMN in ledger)) {
      console.warn(MIGRATION_WARNING);
      return { sent: false, reason: 'not_migrated' };
    }
    if (ledger[SENT_COLUMN]) return { sent: false, reason: 'already_sent' };
    if (!data) return { sent: false, reason: 'no_email' };

    return await claimAndSend(db, 'puramass_orders', puramassOrderId, data, {
      order_id: null,
      invoice_id: invoice.id,
    });
  } catch (err) {
    console.error(`[order-confirmation] Stealth Health order ${puramassOrderId} failed:`, err);
    return { sent: false, reason: 'error' };
  }
}

/** An invoice just became paid: confirm whichever order it belongs to. */
export async function sendConfirmationForPaidInvoice(
  db: SupabaseClient,
  invoiceId: string,
): Promise<ConfirmationOutcome> {
  try {
    const target = await resolveConfirmationTarget(db, { invoiceId });
    if (!target) return { sent: false, reason: 'not_eligible' };
    return target.kind === 'storefront'
      ? await sendStorefrontOrderConfirmationOnce(db, target.orderId)
      : await sendStealthHealthOrderConfirmationOnce(db, target.puramassOrderId);
  } catch (err) {
    console.error(`[order-confirmation] paid invoice ${invoiceId} failed:`, err);
    return { sent: false, reason: 'error' };
  }
}

// ---------------------------------------------------------------------------
//  Admin: status, history, manual send
// ---------------------------------------------------------------------------

/**
 * Which order an id points at. A manual invoice (no order, no hand-off) has
 * nothing to confirm and resolves to null.
 */
export async function resolveConfirmationTarget(
  db: SupabaseClient,
  input: ConfirmationTargetInput,
): Promise<ConfirmationTarget | null> {
  if ('orderId' in input) {
    const { data } = await db.from('orders').select('id').eq('id', input.orderId).maybeSingle();
    if (!data) return null;
    return { kind: 'storefront', orderId: data.id, invoiceId: await invoiceIdForOrder(db, data.id) };
  }

  if ('puramassOrderId' in input) {
    const { data } = await db
      .from('puramass_orders')
      .select('id, invoice_id')
      .eq('id', input.puramassOrderId)
      .maybeSingle();
    if (!data) return null;
    return { kind: 'stealth_health', puramassOrderId: data.id, invoiceId: data.invoice_id ?? null };
  }

  const { data: invoice } = await db
    .from('invoices')
    .select('id, order_id')
    .eq('id', input.invoiceId)
    .maybeSingle();
  if (!invoice) return null;
  if (invoice.order_id) {
    return { kind: 'storefront', orderId: invoice.order_id, invoiceId: invoice.id };
  }
  const { data: ledger } = await db
    .from('puramass_orders')
    .select('id')
    .eq('invoice_id', invoice.id)
    .limit(1);
  const puramassOrderId = ledger?.[0]?.id as string | undefined;
  return puramassOrderId
    ? { kind: 'stealth_health', puramassOrderId, invoiceId: invoice.id }
    : null;
}

async function readLog(db: SupabaseClient, target: ConfirmationTarget): Promise<ConfirmationLogRow[]> {
  let query = db
    .from('fulfillment_email_log')
    .select('created_at, to_email, success, error, sent_by_email')
    .eq('kind', LOG_KIND)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT);

  if (target.kind === 'storefront') {
    query = target.invoiceId
      ? query.or(`order_id.eq.${target.orderId},invoice_id.eq.${target.invoiceId}`)
      : query.eq('order_id', target.orderId);
  } else {
    if (!target.invoiceId) return [];
    query = query.eq('invoice_id', target.invoiceId);
  }

  const { data, error } = await query;
  if (error) {
    console.error('[order-confirmation] reading the send history failed:', error);
    return [];
  }
  return (data ?? []) as ConfirmationLogRow[];
}

/** Sent / not sent, the history and whether a send is possible right now. */
export async function getConfirmationStatus(
  db: SupabaseClient,
  input: ConfirmationTargetInput,
): Promise<ConfirmationStatus | null> {
  const target = await resolveConfirmationTarget(db, input);
  if (!target) return null;

  let data: ConfirmationEmailData | null = null;
  let blockedReason: string | null = null;
  if (target.kind === 'storefront') {
    data = (await loadStorefront(db, target.orderId))?.data ?? null;
  } else {
    const loaded = await loadStealthHealth(db, target.puramassOrderId);
    data = loaded?.data ?? null;
    if (!loaded?.paid) blockedReason = NOT_PAID_REASON;
  }
  if (!blockedReason && !data) blockedReason = NO_EMAIL_REASON;

  const history = await readLog(db, target);
  return {
    kind: target.kind,
    summary: summarizeConfirmationLog(history),
    history,
    recipient: data?.to ?? null,
    orderNumber: data?.orderNumber ?? null,
    blockedReason,
  };
}

/**
 * Send (or resend) the confirmation on an admin's request. Not once-only, and
 * a storefront order needn't be paid or from a checkout — the admin decides.
 * Stamps the order afterwards so the automatic send won't repeat it.
 */
export async function sendConfirmationManually(
  db: SupabaseClient,
  input: ConfirmationTargetInput,
  actor: { id: string | null; email: string | null },
): Promise<{ ok: true; to: string; sentAt: string } | { ok: false; status: number; error: string }> {
  const target = await resolveConfirmationTarget(db, input);
  if (!target) {
    return { ok: false, status: 404, error: 'No storefront or Stealth Health order found for this.' };
  }

  let data: ConfirmationEmailData | null;
  let table: ClaimTable;
  let rowId: string;
  let link: { order_id: string | null; invoice_id: string | null };

  if (target.kind === 'storefront') {
    const loaded = await loadStorefront(db, target.orderId);
    if (!loaded) return { ok: false, status: 404, error: 'Order not found.' };
    data = loaded.data;
    table = 'orders';
    rowId = target.orderId;
    link = { order_id: target.orderId, invoice_id: target.invoiceId };
  } else {
    const loaded = await loadStealthHealth(db, target.puramassOrderId);
    if (!loaded) return { ok: false, status: 404, error: 'Order not found.' };
    if (!loaded.paid || !loaded.invoice) {
      return {
        ok: false,
        status: 422,
        error: 'This order isn’t paid yet — the confirmation goes out once it’s paid.',
      };
    }
    data = loaded.data;
    table = 'puramass_orders';
    rowId = target.puramassOrderId;
    link = { order_id: null, invoice_id: loaded.invoice.id };
  }

  if (!data) {
    return { ok: false, status: 422, error: 'This order has no real email address to send to.' };
  }

  const res = await deliver(db, data);
  await logAttempt(db, {
    ...link,
    to_email: data.to,
    subject: res.subject,
    message_id: res.id ?? null,
    success: res.success,
    error: res.success ? null : res.error ?? 'Failed to send email',
    sent_by: actor.id,
    sent_by_email: actor.email,
  });
  if (!res.success) {
    return { ok: false, status: 502, error: res.error || 'The email could not be sent.' };
  }

  const sentAt = new Date().toISOString();
  const { error } = await db.from(table).update({ [SENT_COLUMN]: sentAt }).eq('id', rowId);
  if (error && !isMissingColumnError(error)) {
    console.error(`[order-confirmation] stamping ${table} ${rowId} failed:`, error);
  }
  return { ok: true, to: data.to, sentAt };
}

// ---------------------------------------------------------------------------
//  Bulk summaries for list screens
// ---------------------------------------------------------------------------

async function summariesBy(
  db: SupabaseClient,
  column: 'order_id' | 'invoice_id',
  ids: Array<string | null | undefined>,
): Promise<Record<string, ConfirmationSummary>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (unique.length === 0) return {};

  const { data, error } = await db
    .from('fulfillment_email_log')
    .select(`${column}, created_at, to_email, success, error, sent_by_email`)
    .eq('kind', LOG_KIND)
    .in(column, unique);
  if (error) {
    console.error('[order-confirmation] reading send summaries failed:', error);
    return {};
  }

  const byId = new Map<string, ConfirmationLogRow[]>();
  for (const row of (data ?? []) as Array<ConfirmationLogRow & Record<string, any>>) {
    const key = row[column] as string | null;
    if (!key) continue;
    const list = byId.get(key) ?? [];
    list.push(row);
    byId.set(key, list);
  }

  const out: Record<string, ConfirmationSummary> = {};
  for (const [key, rows] of byId) out[key] = summarizeConfirmationLog(rows);
  return out;
}

/** Summary per storefront order id. Ids with no sends are absent ("Not sent"). */
export function confirmationSummariesByOrder(
  db: SupabaseClient,
  orderIds: Array<string | null | undefined>,
): Promise<Record<string, ConfirmationSummary>> {
  return summariesBy(db, 'order_id', orderIds);
}

/** Summary per invoice id (Stealth Health hand-offs are keyed by their invoice). */
export function confirmationSummariesByInvoice(
  db: SupabaseClient,
  invoiceIds: Array<string | null | undefined>,
): Promise<Record<string, ConfirmationSummary>> {
  return summariesBy(db, 'invoice_id', invoiceIds);
}
