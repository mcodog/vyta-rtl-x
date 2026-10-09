// Server-only warehouse helpers. Imported by Phase-3 API routes only.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { NextRequest } from 'next/server';
import nodemailer from 'nodemailer';
import { logAuditServer } from '@/lib/admin/audit';
import { restoreStockForCancelledOrder } from '@/lib/order-stock';
import { toShippingAddress } from '@/lib/payments/puramass-address';
import { isMissingColumnError } from '@/lib/payments/puramass-columns';
import { SITE_URL } from '@/lib/config';
import { loadOrderEmailForInvoice } from '@/lib/order-confirmation';
import { pickDeliverableEmail } from '@/lib/order-confirmation-data';
import { getAdminAlertEmails } from '@/lib/admin/alert-recipients';
import {
  fulfillmentEmailSubject,
  parseRecipients,
  renderFulfillmentEmailHtml,
  renderFulfillmentEmailText,
  type FulfillmentEmailData,
  type FulfillmentTracking,
} from '@/lib/fulfillment-email';
import type {
  FulfillmentStatus,
  NotificationPreview,
  QueueItem,
} from './types';

// ---------- verifyWarehouse ----------

export interface WarehouseAuth {
  authorized: boolean;
  canSendEmails: boolean;
  role: 'warehouse' | 'admin' | 'assistant' | 'customer' | 'affiliate' | null;
  actorId: string | null;
  actorEmail: string | null;
}

export async function verifyWarehouse(
  db: SupabaseClient,
  req: NextRequest,
): Promise<WarehouseAuth> {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) {
    return {
      authorized: false,
      canSendEmails: false,
      role: null,
      actorId: null,
      actorEmail: null,
    };
  }
  const {
    data: { user },
  } = await db.auth.getUser(token);
  if (!user) {
    return {
      authorized: false,
      canSendEmails: false,
      role: null,
      actorId: null,
      actorEmail: null,
    };
  }
  const { data: customer } = await db
    .from('customers')
    .select('role, email, can_send_fulfillment_emails, active')
    .eq('id', user.id)
    .maybeSingle();

  const role = (customer?.role ?? null) as WarehouseAuth['role'];
  const active = customer?.active !== false;
  const authorized =
    active && (role === 'warehouse' || role === 'admin');
  const canSendEmails =
    active &&
    (role === 'admin' ||
      (role === 'warehouse' && !!customer?.can_send_fulfillment_emails));
  return {
    authorized,
    canSendEmails,
    role,
    actorId: user.id,
    actorEmail: customer?.email ?? user.email ?? null,
  };
}

// ---------- Invoice/order sync + audit ----------

const FULFILLMENT_TERMINAL: Record<FulfillmentStatus, string | null> = {
  pending: null,
  packed: null,
  shipped: 'shipped',
  picked_up: 'delivered',
  // Courier handoff — the parcel is out of our hands the moment the
  // driver takes it, so the order is marked shipped (not delivered).
  dropped_off: 'shipped',
};

export function methodAllowsStatus(
  type: 'shipment' | 'pickup',
  status: FulfillmentStatus,
): boolean {
  if (type === 'shipment' && status === 'picked_up') return false;
  if (type === 'pickup' && status === 'shipped') return false;
  if (type === 'pickup' && status === 'dropped_off') return false;
  return true;
}

export async function setFulfillmentStatus(
  db: SupabaseClient,
  actor: WarehouseAuth,
  invoiceId: string,
  next: FulfillmentStatus,
): Promise<{ ok: true } | { error: string; status: number }> {
  const { data: inv } = await db
    .from('invoices')
    .select(
      'id, status, is_backorder, fulfillment_type, fulfillment_status, packed_at, fulfilled_at, order_id',
    )
    .eq('id', invoiceId)
    .maybeSingle();
  if (!inv) return { error: 'invoice not found', status: 404 };
  // Drafts are fulfillable (a generated invoice reaches the warehouse before
  // it is formally sent), but backorder placeholder invoices are non-payable
  // and never fulfilled directly.
  if (inv.is_backorder) {
    return { error: 'cannot fulfill a backorder invoice', status: 400 };
  }
  if (!methodAllowsStatus(inv.fulfillment_type, next)) {
    return { error: `status ${next} not allowed for ${inv.fulfillment_type}`, status: 400 };
  }

  // Payment gate: goods must not leave before payment is received. An order
  // stays `pending` until its payment is confirmed. Block the hand-off states (shipped / picked up / dropped off)
  // until the linked order has moved past pending. Packing is allowed so staff
  // can prep ahead of payment.
  const HANDOFF: FulfillmentStatus[] = ['shipped', 'picked_up', 'dropped_off'];
  const UNPAID_ORDER_STATUSES = ['pending', 'expired', 'cancelled', 'refunded'];
  if (HANDOFF.includes(next) && inv.order_id) {
    const { data: linkedOrder } = await db
      .from('orders')
      .select('status')
      .eq('id', inv.order_id)
      .maybeSingle();
    if (linkedOrder && UNPAID_ORDER_STATUSES.includes(linkedOrder.status)) {
      return {
        error:
          'Payment not confirmed yet — confirm the order (mark payment received) before shipping.',
        status: 409,
      };
    }
  }

  const patch: Record<string, unknown> = { fulfillment_status: next };
  const nowIso = new Date().toISOString();
  if (next === 'packed' && !inv.packed_at) {
    patch.packed_at = nowIso;
    patch.packed_by = actor.actorId;
  }
  if ((next === 'shipped' || next === 'picked_up' || next === 'dropped_off') && !inv.fulfilled_at) {
    patch.fulfilled_at = nowIso;
    patch.fulfilled_by = actor.actorId;
  }

  const { error } = await db.from('invoices').update(patch).eq('id', invoiceId);
  if (error) return { error: error.message, status: 500 };

  // Sync linked order (best-effort).
  const terminal = FULFILLMENT_TERMINAL[next];
  if (terminal && inv.order_id) {
    try {
      await db
        .from('orders')
        .update({
          status: terminal,
          ...(terminal === 'shipped' ? { shipped_at: nowIso } : {}),
          ...(terminal === 'delivered' ? { delivered_at: nowIso } : {}),
        })
        .eq('id', inv.order_id);
    } catch {}
  }

  // Audit (state encoded in action — no payload column).
  await logAuditServer(
    db,
    { actor_id: actor.actorId, actor_email: actor.actorEmail },
    {
      action: `invoice.fulfillment_update.${next}`,
      entity_type: 'invoice',
      entity_id: invoiceId,
    },
  );

  return { ok: true };
}

// ---------- Cancel a record from the queue ----------

// The queue is built around invoices, and most invoices are created directly
// (no storefront order), so `order_id` is frequently null. Cancelling therefore
// operates on the invoice itself — flipping its status to `cancelled` moves it to
// the Cancelled tab and stops fulfillment — and, when an order is linked, mirrors
// the cancellation onto that order too. Stock restock is intentionally left to the
// admin refund flow (see restore_stock_for_invoice), matching the confirm-dialog copy.
export async function cancelOrderForInvoice(
  db: SupabaseClient,
  actor: WarehouseAuth,
  invoiceId: string,
): Promise<{ ok: true } | { error: string; status: number }> {
  const { data: inv } = await db
    .from('invoices')
    .select('id, order_id, status, fulfillment_status')
    .eq('id', invoiceId)
    .maybeSingle();
  if (!inv) return { error: 'invoice not found', status: 404 };
  if (inv.fulfillment_status === 'shipped' || inv.fulfillment_status === 'picked_up') {
    return { error: 'cannot cancel a record that has already been fulfilled', status: 400 };
  }
  if (inv.status === 'cancelled') return { ok: true };

  const nowIso = new Date().toISOString();

  // Cancel the invoice itself.
  const { error: invErr } = await db
    .from('invoices')
    .update({ status: 'cancelled', updated_at: nowIso })
    .eq('id', invoiceId);
  if (invErr) return { error: invErr.message, status: 500 };

  await logAuditServer(
    db,
    { actor_id: actor.actorId, actor_email: actor.actorEmail },
    {
      action: 'invoice.cancel',
      entity_type: 'invoice',
      entity_id: invoiceId,
    },
  );

  // Mirror onto the linked order when present (best-effort).
  if (inv.order_id) {
    // Give product-level stock back if this order had already been decremented
    // (confirmed). Guarded by stock_adjusted, so pending orders are a no-op.
    await restoreStockForCancelledOrder(db, inv.order_id, actor.actorEmail);

    const { data: order } = await db
      .from('orders')
      .select('status')
      .eq('id', inv.order_id)
      .maybeSingle();
    if (order && order.status !== 'cancelled') {
      const { error: ordErr } = await db
        .from('orders')
        .update({ status: 'cancelled', updated_at: nowIso })
        .eq('id', inv.order_id);
      if (!ordErr) {
        await logAuditServer(
          db,
          { actor_id: actor.actorId, actor_email: actor.actorEmail },
          {
            action: 'order.cancel',
            entity_type: 'order',
            entity_id: inv.order_id,
          },
        );
      }
    }
  }

  return { ok: true };
}

// ---------- Backorder child invoice ----------

export interface BackorderChildResult {
  childInvoiceId: string;
  created: boolean;
}

export async function getOrCreateBackorderInvoice(
  db: SupabaseClient,
  parentInvoiceId: string,
): Promise<BackorderChildResult> {
  // Existing child?
  const { data: existing } = await db
    .from('invoices')
    .select('id')
    .eq('parent_invoice_id', parentInvoiceId)
    .eq('is_backorder', true)
    .eq('status', 'draft')
    .maybeSingle();
  if (existing) {
    return { childInvoiceId: existing.id, created: false };
  }

  // Load parent for inheritance.
  const { data: parent } = await db
    .from('invoices')
    .select(
      'customer_id, customer_name, customer_email, customer_phone, sales_person_id, sales_person_commission_rate, fulfillment_type, tax_rate, notes',
    )
    .eq('id', parentInvoiceId)
    .single();

  const { data: child, error } = await db
    .from('invoices')
    .insert({
      parent_invoice_id: parentInvoiceId,
      is_backorder: true,
      non_payable: true,
      status: 'draft',
      customer_id: parent?.customer_id ?? null,
      customer_name: parent?.customer_name ?? null,
      customer_email: parent?.customer_email ?? null,
      customer_phone: parent?.customer_phone ?? null,
      sales_person_id: parent?.sales_person_id ?? null,
      sales_person_commission_rate: parent?.sales_person_commission_rate ?? 0,
      fulfillment_type: parent?.fulfillment_type ?? 'shipment',
      fulfillment_status: 'pending',
      tax_rate: parent?.tax_rate ?? 0,
      subtotal: 0,
      tax_total: 0,
      shipping_cost: 0,
      total: 0,
      notes: parent?.notes
        ? `Backorder of ${parent.notes}`
        : `Backorder of invoice ${parentInvoiceId}`,
    })
    .select('id')
    .single();

  if (error || !child) {
    throw new Error(`failed to create backorder invoice: ${error?.message}`);
  }

  // Record into backorders ledger (if the table is shaped as expected).
  try {
    await db.from('backorders').insert({
      parent_invoice_id: parentInvoiceId,
      child_invoice_id: child.id,
    });
  } catch {
    // backorders table shape may vary; ledger insert is best-effort.
  }

  return { childInvoiceId: child.id, created: true };
}

export async function recomputeInvoiceTotals(
  db: SupabaseClient,
  invoiceId: string,
): Promise<void> {
  const { data: lines } = await db
    .from('invoice_line_items')
    .select('qty, unit_price, discount_pct, line_total')
    .eq('invoice_id', invoiceId);
  const subtotal = (lines ?? []).reduce((s, l: any) => {
    const explicit = Number(l.line_total);
    if (Number.isFinite(explicit) && explicit !== 0) return s + explicit;
    const derived = Number(l.qty) * Number(l.unit_price);
    return s + (Number.isFinite(derived) ? derived : 0);
  }, 0);
  const { data: inv } = await db
    .from('invoices')
    .select('tax_rate, shipping_cost')
    .eq('id', invoiceId)
    .single();
  const taxRate = Number(inv?.tax_rate ?? 0);
  const shipping = Number(inv?.shipping_cost ?? 0);
  const taxTotal = (subtotal * taxRate) / 100;
  const total = subtotal + taxTotal + shipping;
  await db
    .from('invoices')
    .update({ subtotal, tax_total: taxTotal, total })
    .eq('id', invoiceId);
}

// ---------- Per-line fulfill / backorder ----------

export async function applyLineAction(
  db: SupabaseClient,
  actor: WarehouseAuth,
  invoiceId: string,
  lineId: string,
  action: 'fulfill' | 'backorder',
  reqQty: number,
): Promise<
  | { ok: true; line: any; backorder_invoice_id?: string }
  | { error: string; status: number }
> {
  const qty = Math.max(0, Math.floor(reqQty));
  if (qty === 0) return { error: 'qty must be > 0', status: 400 };

  const { data: line } = await db
    .from('invoice_line_items')
    .select('id, invoice_id, description, qty, unit_price, qty_fulfilled, qty_backordered')
    .eq('id', lineId)
    .eq('invoice_id', invoiceId)
    .maybeSingle();
  if (!line) return { error: 'line not found', status: 404 };

  const remaining = line.qty - (line.qty_fulfilled ?? 0) - (line.qty_backordered ?? 0);
  if (remaining <= 0) {
    return { error: 'nothing left to act on for this line', status: 400 };
  }
  const capped = Math.min(qty, remaining);

  if (action === 'fulfill') {
    const { error } = await db
      .from('invoice_line_items')
      .update({ qty_fulfilled: (line.qty_fulfilled ?? 0) + capped })
      .eq('id', lineId);
    if (error) return { error: error.message, status: 500 };

    await logAuditServer(
      db,
      { actor_id: actor.actorId, actor_email: actor.actorEmail },
      {
        action: 'invoice.line_fulfill',
        entity_type: 'invoice',
        entity_id: invoiceId,
      },
    );
    return {
      ok: true,
      line: { id: line.id, qty_fulfilled: (line.qty_fulfilled ?? 0) + capped },
    };
  }

  // backorder
  const { childInvoiceId } = await getOrCreateBackorderInvoice(db, invoiceId);

  // Merge into existing child line by description, else insert.
  const { data: existing } = await db
    .from('invoice_line_items')
    .select('id, qty, unit_price')
    .eq('invoice_id', childInvoiceId)
    .eq('description', line.description)
    .maybeSingle();
  if (existing) {
    await db
      .from('invoice_line_items')
      .update({
        qty: existing.qty + capped,
        line_total: (existing.qty + capped) * existing.unit_price,
      })
      .eq('id', existing.id);
  } else {
    await db.from('invoice_line_items').insert({
      invoice_id: childInvoiceId,
      description: line.description,
      qty: capped,
      unit_price: line.unit_price,
      discount_pct: 0,
      line_total: capped * line.unit_price,
    });
  }

  await db
    .from('invoice_line_items')
    .update({ qty_backordered: (line.qty_backordered ?? 0) + capped })
    .eq('id', lineId);

  await recomputeInvoiceTotals(db, childInvoiceId);

  await logAuditServer(
    db,
    { actor_id: actor.actorId, actor_email: actor.actorEmail },
    {
      action: 'invoice.line_backorder',
      entity_type: 'invoice',
      entity_id: invoiceId,
    },
  );

  return {
    ok: true,
    line: {
      id: line.id,
      qty_backordered: (line.qty_backordered ?? 0) + capped,
    },
    backorder_invoice_id: childInvoiceId,
  };
}

// ---------- Notification builder + sender ----------
//
// The customer's "packed" / "shipped" emails: the branded templates in
// lib/fulfillment-email.ts, filled from the order behind the invoice. Sent
// only when staff press Notify packed / Notify shipped — never on a status
// change. Staff can change the recipient and subject; the body is the template.

function trimmed(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Shipment details typed into the send modal — usually because the label was
 * bought outside Easyship and nothing is on file yet. Used for this email
 * only (not saved); a blank field falls back to what's stored.
 */
export interface ShipmentDetailsInput {
  trackingNumber?: string | null;
  carrier?: string | null;
  trackingUrl?: string | null;
  /** Estimated delivery window, YYYY-MM-DD. */
  deliveryFrom?: string | null;
  deliveryTo?: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Shipment details from query params / a JSON body, cleaned up. */
export function parseShipmentDetails(source: { get(key: string): unknown }): ShipmentDetailsInput {
  const text = (key: string, max = 200) => {
    const v = trimmed(source.get(key));
    return v ? v.slice(0, max) : null;
  };
  const date = (key: string) => {
    const v = trimmed(source.get(key));
    return v && DATE_RE.test(v) ? v : null;
  };
  const url = text('tracking_url', 1000);
  return {
    trackingNumber: text('tracking_number', 100),
    carrier: text('carrier', 100),
    trackingUrl: url && /^https?:\/\//i.test(url) ? url : null,
    deliveryFrom: date('delivery_from'),
    deliveryTo: date('delivery_to'),
  };
}

/** Everything needed to render (and address) one packed / shipped email. */
async function buildFulfillmentEmail(
  db: SupabaseClient,
  invoiceId: string,
  kind: 'packed' | 'shipped',
  details: ShipmentDetailsInput = {},
): Promise<{ data: FulfillmentEmailData; to: string | null; stored: FulfillmentTracking } | null> {
  // `*`: the invoice's own shipment columns arrive with a later migration.
  const { data: inv } = await db.from('invoices').select('*').eq('id', invoiceId).maybeSingle();
  if (!inv) return null;

  const order = inv.order_id
    ? (await db.from('orders').select('*').eq('id', inv.order_id).maybeSingle()).data
    : null;

  let content: Awaited<ReturnType<typeof loadOrderEmailForInvoice>> = null;
  try {
    content = await loadOrderEmailForInvoice(db, invoiceId);
  } catch (err) {
    console.error(`[warehouse] loading the order for invoice ${invoiceId} failed:`, err);
  }
  const shown = content?.data;

  // The parcel: the order's shipment first, else the invoice's own.
  const stored: FulfillmentTracking = {
    number: trimmed(order?.tracking_number) ?? trimmed(inv.tracking_number),
    carrier:
      trimmed(order?.carrier) ?? trimmed(order?.shipping_carrier) ?? trimmed(inv.carrier),
    url: trimmed(order?.tracking_url) ?? trimmed(inv.tracking_url),
  };
  // A typed tracking number makes the stored link stale, so it only keeps the
  // stored URL when the number is unchanged.
  const typedNumber = trimmed(details.trackingNumber);
  const numberChanged = !!typedNumber && typedNumber !== stored.number;
  const tracking: FulfillmentTracking = {
    number: typedNumber ?? stored.number,
    carrier: trimmed(details.carrier) ?? stored.carrier,
    url: trimmed(details.trackingUrl) ?? (numberChanged ? null : stored.url),
  };
  const estimatedDelivery =
    details.deliveryFrom || details.deliveryTo
      ? { from: details.deliveryFrom ?? null, to: details.deliveryTo ?? null }
      : null;

  const data: FulfillmentEmailData = {
    kind,
    fulfillmentType: inv.fulfillment_type === 'pickup' ? 'pickup' : 'shipment',
    customerName: shown?.customerName ?? trimmed(inv.customer_name) ?? 'there',
    orderNumber:
      shown?.orderNumber ?? trimmed(order?.order_number) ?? trimmed(inv.invoice_number) ?? '',
    orderDate: shown?.orderDate,
    items: shown?.items ?? [],
    shipTo: shown?.shipTo,
    tracking,
    estimatedDelivery,
    viewOrderUrl: shown?.viewOrderUrl,
  };
  const to =
    shown?.to ?? pickDeliverableEmail(...(content?.emails ?? []), inv.customer_email) ?? trimmed(inv.customer_email);
  return { data, to, stored };
}

export async function buildNotificationPreview(
  db: SupabaseClient,
  invoiceId: string,
  kind: 'packed' | 'shipped',
  details: ShipmentDetailsInput = {},
): Promise<NotificationPreview | null> {
  const built = await buildFulfillmentEmail(db, invoiceId, kind, details);
  if (!built) return null;
  const subject = fulfillmentEmailSubject(built.data);
  return {
    subject,
    body: renderFulfillmentEmailText(built.data),
    html: renderFulfillmentEmailHtml(built.data, SITE_URL),
    to: built.to,
    defaults: { subject },
    trackingNumber: built.data.tracking?.number ?? null,
    stored: built.stored,
    adminRecipients: await getAdminAlertEmails(db),
  };
}

function buildTransport() {
  // Aligns with lib/invoice-mailer.ts: SMTP_HOST/PORT/USER/PASSWORD/FROM.
  if (process.env.SMTP_HOST) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
        : undefined,
    });
  }
  return null;
}

const FROM_ADDRESS = () =>
  process.env.SMTP_FROM || process.env.EMAIL_FROM || 'VYTA <orders@aminocan.com>';

export interface AdminCopyResult {
  sent: boolean;
  to: string[];
  error?: string;
}

export async function sendFulfillmentEmail(
  db: SupabaseClient,
  actor: WarehouseAuth,
  invoiceId: string,
  kind: 'packed' | 'shipped',
  overrides: { subject?: string; to?: string; details?: ShipmentDetailsInput } = {},
): Promise<{
  ok: boolean;
  message_id: string | null;
  emailed_at: string | null;
  error?: string;
  /** The admin team's copy — only attempted once the customer's send worked. */
  admin_copy?: AdminCopyResult;
}> {
  const built = await buildFulfillmentEmail(db, invoiceId, kind, overrides.details);
  if (!built) {
    return { ok: false, message_id: null, emailed_at: null, error: 'invoice not found' };
  }
  // The sender may redirect this one email (e.g. a better address than the one
  // on file). Nothing is written back to the invoice or customer.
  const typed = trimmed(overrides.to);
  let recipients: string[];
  if (typed) {
    const parsed = parseRecipients(typed);
    if (parsed.invalid.length > 0) {
      return {
        ok: false,
        message_id: null,
        emailed_at: null,
        error: `invalid recipient: ${parsed.invalid.join(', ')}`,
      };
    }
    recipients = parsed.emails;
  } else {
    recipients = built.to ? [built.to] : [];
  }
  if (recipients.length === 0) {
    return { ok: false, message_id: null, emailed_at: null, error: 'no recipient' };
  }
  const to = recipients.join(', ');
  const subject = trimmed(overrides.subject) ?? fulfillmentEmailSubject(built.data);
  const html = renderFulfillmentEmailHtml(built.data, SITE_URL);
  const text = renderFulfillmentEmailText(built.data);

  let success = false;
  let messageId: string | null = null;
  let errorMsg: string | null = null;
  const sentAt = new Date().toISOString();

  const transport = buildTransport();
  if (!transport) {
    errorMsg = 'SMTP not configured';
  } else {
    try {
      const sent = await transport.sendMail({
        from: FROM_ADDRESS(),
        to: recipients,
        subject,
        text,
        html,
      });
      success = true;
      messageId = sent.messageId ?? null;
    } catch (e: any) {
      errorMsg = e?.message ?? 'send failed';
    }
  }

  // Always log to fulfillment_email_log.
  try {
    await db.from('fulfillment_email_log').insert({
      invoice_id: invoiceId,
      kind,
      to_email: to,
      subject,
      message_id: messageId,
      success,
      error: errorMsg,
      sent_by: actor.actorId,
      sent_by_email: actor.actorEmail,
    });
  } catch {}

  // The admin team gets the same email as its own message (so the customer
  // never sees their addresses), flagged as a copy. Not logged to
  // fulfillment_email_log, which is the customer's send history. A failed
  // copy never fails the customer's send.
  let adminCopy: AdminCopyResult | undefined;
  if (success && transport) {
    const adminTo = (await getAdminAlertEmails(db)).filter(
      (e) => !recipients.some((r) => r.toLowerCase() === e.toLowerCase()),
    );
    adminCopy = { sent: false, to: adminTo };
    if (adminTo.length > 0) {
      const who = actor.actorEmail ? ` by ${actor.actorEmail}` : '';
      const notice = `this ${kind === 'packed' ? 'packed' : 'shipped'} email was sent to ${to}${who}.`;
      try {
        await transport.sendMail({
          from: FROM_ADDRESS(),
          to: adminTo,
          subject: `[Copy] ${subject} → ${to}`,
          text: `ADMIN COPY — ${notice}\n\n${text}`,
          html: renderFulfillmentEmailHtml(built.data, SITE_URL, { notice }),
        });
        adminCopy.sent = true;
      } catch (e: any) {
        adminCopy.error = e?.message ?? 'send failed';
        console.error(`[warehouse] admin copy of the ${kind} email for invoice ${invoiceId} failed:`, e);
      }
    }
  }

  if (success) {
    const stamp = kind === 'packed' ? 'packed_emailed_at' : 'shipped_emailed_at';
    try {
      await db.from('invoices').update({ [stamp]: sentAt }).eq('id', invoiceId);
    } catch {}
    await logAuditServer(
      db,
      { actor_id: actor.actorId, actor_email: actor.actorEmail },
      {
        action: `fulfillment.email_sent.${kind}`,
        entity_type: 'invoice',
        entity_id: invoiceId,
      },
    );
  }

  return {
    ok: success,
    message_id: messageId,
    emailed_at: success ? sentAt : null,
    error: errorMsg ?? undefined,
    admin_copy: adminCopy,
  };
}

// ---------- Queue read (server-side build) ----------

export async function buildQueueRow(row: any): Promise<QueueItem> {
  return {
    id: row.id,
    invoice_number: row.invoice_number,
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    customer_email: row.customer_email,
    source: row.source ?? null,
    status: row.status,
    fulfillment_type: row.fulfillment_type,
    fulfillment_status: row.fulfillment_status,
    non_payable: !!row.non_payable,
    // Product labels ("Ship with labels" on the invoice). Defaults to true to
    // mirror the invoice form / print HTML, so legacy rows with a null column
    // are treated as labeled rather than incorrectly showing "no labels".
    with_labels: row.with_labels !== false,
    removed_from_queue: row.removed_from_queue === true,
    handling_checklist: Array.isArray(row.handling_checklist) ? row.handling_checklist : [],
    packed_photos: Array.isArray(row.packed_photos) ? row.packed_photos : [],
    packed_at: row.packed_at,
    packed_by: row.packed_by,
    packed_by_name:
      row.packed_by_customer?.first_name || row.packed_by_customer?.email || null,
    fulfilled_at: row.fulfilled_at,
    fulfilled_by: row.fulfilled_by,
    fulfilled_by_name:
      row.fulfilled_by_customer?.first_name || row.fulfilled_by_customer?.email || null,
    packed_emailed_at: row.packed_emailed_at,
    shipped_emailed_at: row.shipped_emailed_at,
    total: Number(row.total ?? 0),
    created_at: row.created_at,
    line_items: (row.invoice_line_items ?? []).map((l: any) => ({
      id: l.id,
      description: l.description,
      qty: l.qty,
      qty_fulfilled: l.qty_fulfilled ?? 0,
      qty_backordered: l.qty_backordered ?? 0,
      unit_price: Number(l.unit_price ?? 0),
      line_total: Number(l.line_total ?? 0),
    })),
    // Filled in by attachPuramassShipTo for Stealth Health invoices, which
    // carry no order row of their own.
    shipping_address: null,
    order: row.order
      ? {
          id: row.order.id,
          order_number: row.order.order_number,
          status: row.order.status,
          tracking_number: row.order.tracking_number,
          carrier: row.order.carrier,
          label_state: row.order.label_state,
          label_url: row.order.label_url,
          shipping_address: row.order.shipping_address,
        }
      : null,
    // The invoice's own Easyship shipment, for rows with no order behind them.
    // The queue selects `*`, so these columns are simply undefined until
    // easyship-invoice-shipment-migration.sql has run.
    shipment: row.easyship_shipment_id
      ? {
          easyship_shipment_id: row.easyship_shipment_id,
          label_state: row.label_state ?? null,
          label_url: row.label_url ?? null,
          tracking_number: row.tracking_number ?? null,
          carrier: row.carrier ?? null,
        }
      : null,
    item_count: (row.invoice_line_items ?? []).reduce(
      (s: number, l: any) => s + (l.qty ?? 0),
      0,
    ),
    has_label:
      row.order?.label_state === 'generated' || row.label_state === 'generated',
  };
}


/**
 * Copy the Stealth Health ship-to onto the Stealth Health rows of a queue page.
 *
 * A Stealth Health invoice is materialised from the hosted checkout and has no
 * `orders` row, so the address the warehouse needs lives on the hand-off ledger
 * (`puramass_orders.shipping_address`) — either as Stealth Health reported it or as
 * the customer typed it into the missing-address form. It is read here rather
 * than snapshotted onto the invoice because it can land (or be corrected) long
 * after the invoice exists.
 *
 * Best-effort: a ledger that can't be read (address columns not migrated yet)
 * simply leaves the rows without an address, exactly as before.
 */
export async function attachPuramassShipTo(
  db: SupabaseClient,
  items: QueueItem[],
): Promise<QueueItem[]> {
  const ids = items.filter((i) => i.source === 'stealth_health').map((i) => i.id);
  if (ids.length === 0) return items;

  const { data, error } = await db
    .from('puramass_orders')
    .select('invoice_id, shipping_address, customer_phone')
    .in('invoice_id', ids);

  if (error) {
    if (!isMissingColumnError(error)) {
      console.error('[warehouse] puramass ship-to lookup failed:', error);
    }
    return items;
  }

  const byInvoice = new Map<string, Record<string, unknown>>();
  for (const row of data ?? []) {
    if (!row.invoice_id || byInvoice.has(row.invoice_id)) continue;
    const addr = toShippingAddress(row.shipping_address);
    if (!addr) continue;
    // Re-key into the `orders.shipping_address` shape the queue renders.
    byInvoice.set(row.invoice_id, {
      address: addr.address,
      address2: addr.address2,
      city: addr.city,
      state: addr.state,
      postalCode: addr.zip,
      country: addr.country,
      phone: row.customer_phone ?? null,
    });
  }
  if (byInvoice.size === 0) return items;

  return items.map((i) => {
    const addr = byInvoice.get(i.id);
    return addr ? { ...i, shipping_address: addr } : i;
  });
}
