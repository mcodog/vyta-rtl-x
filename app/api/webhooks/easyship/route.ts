import { NextRequest, NextResponse, after } from 'next/server';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { advanceOrderForward } from '@/lib/warehouse/types';
import { trackOrderStatus, trackOrderStatusById } from '@/lib/klaviyo/events';
import { onShipmentLabelGenerated } from '@/lib/shipping/label-generated';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// ---------- Verification ----------

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function verifyHmac(raw: string, header: string, secret: string): boolean {
  const hmac = crypto.createHmac('sha256', secret).update(raw).digest();
  const headerBuf = (() => {
    try {
      return Buffer.from(header, 'base64');
    } catch {
      return Buffer.alloc(0);
    }
  })();
  if (
    headerBuf.length === hmac.length &&
    crypto.timingSafeEqual(headerBuf, hmac)
  ) {
    return true;
  }
  // Try hex.
  try {
    const hexBuf = Buffer.from(header, 'hex');
    if (hexBuf.length === hmac.length && crypto.timingSafeEqual(hexBuf, hmac)) {
      return true;
    }
  } catch {}
  return false;
}

// ---------- Checkpoints ----------

interface NormalizedCheckpoint {
  message: string;
  occurred_at: string;
  location: string | null;
  primary_status: string | null;
}

// Normalize Easyship checkpoint objects to the compact shape the admin UI
// (timeline + map) consumes. Easyship supplies either a pre-joined `location`
// or discrete city/state/country parts, and timestamps under `checkpoint_time`.
function normalizeCheckpoints(arr: unknown): NormalizedCheckpoint[] | null {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.map((c: any) => {
    const location =
      c.location ||
      [c.city, c.state, c.country_alpha2 ?? c.country].filter(Boolean).join(', ');
    return {
      message: c.message ?? '',
      occurred_at: c.checkpoint_time ?? c.occurred_at ?? '',
      location: location || null,
      primary_status: c.primary_status ?? null,
    };
  });
}

// The most recent checkpoint by timestamp — used to derive a status when the
// event payload doesn't carry a top-level one.
function latestCheckpoint(cps: NormalizedCheckpoint[]): NormalizedCheckpoint | null {
  return [...cps].sort(
    (a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime(),
  )[0] ?? null;
}

// ---------- Status mapping ----------

function mapToOrderStatus(s: string | null | undefined): string | null {
  if (!s) return null;
  const x = s.toLowerCase();
  if (x.includes('delivered')) return 'delivered';
  if (
    x.includes('shipped') ||
    x.includes('in_transit') ||
    x.includes('in transit') ||
    x.includes('out_for_delivery')
  ) {
    return 'shipped';
  }
  return null;
}

// ---------- POST ----------

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const secret = process.env.EASYSHIP_WEBHOOK_SECRET;
  const hmacHeader = req.headers.get('x-easyship-hmac-sha256');
  const sharedHeader = req.headers.get('x-easyship-webhook-secret');

  // Fail CLOSED: with no configured secret the endpoint would be an open,
  // unauthenticated way to force order/tracking/label state, so reject rather
  // than process unverified payloads.
  if (!secret) {
    console.error('[easyship-webhook] EASYSHIP_WEBHOOK_SECRET not set — rejecting');
    return NextResponse.json({ error: 'webhook not configured' }, { status: 503 });
  }
  let verified = false;
  if (hmacHeader && verifyHmac(raw, hmacHeader, secret)) verified = true;
  else if (sharedHeader && timingSafeEqualStr(sharedHeader, secret)) verified = true;
  if (!verified) {
    return NextResponse.json({ error: 'bad signature' }, { status: 401 });
  }

  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const event = payload?.shipment ?? payload?.resource ?? payload?.data ?? payload ?? {};
  const easyshipId =
    event.easyship_shipment_id ||
    event.shipment_id ||
    payload?.easyship_shipment_id ||
    null;
  const orderNumber =
    event.platform_order_number || event.order_number || payload?.order_number || null;
  const trackingNumber = event.tracking_number || payload?.tracking_number || null;
  const trackingUrl = event.tracking_url || payload?.tracking_url || null;
  const carrier = event.courier_name || event.carrier || null;
  const labelUrl = event.label_url || event.shipping_documents?.label_url || null;
  const labelState =
    labelUrl || String(event.label_state ?? '').toLowerCase() === 'generated'
      ? 'generated'
      : null;

  // Full checkpoint history — the shipment.tracking.checkpoints.created event
  // carries the same journey shown on Easyship's trackmyshipment.co page.
  const normalizedCheckpoints = normalizeCheckpoints(
    event.tracking?.checkpoints ??
      event.checkpoints ??
      payload?.resource?.checkpoints ??
      payload?.checkpoints,
  );

  // Derive the delivery status from the payload, falling back to the newest
  // checkpoint (checkpoints events may not carry a top-level status).
  const trackingStatus =
    event.tracking_status ||
    event.status ||
    payload?.status ||
    (normalizedCheckpoints ? latestCheckpoint(normalizedCheckpoints)?.primary_status ?? null : null);

  // Match order: easyship_shipment_id → order_number → tracking_number.
  let order: any = null;
  if (easyshipId) {
    const { data } = await db
      .from('orders')
      .select('id, status, label_state')
      .eq('easyship_shipment_id', easyshipId)
      .maybeSingle();
    if (data) order = data;
  }
  if (!order && orderNumber) {
    const { data } = await db
      .from('orders')
      .select('id, status, label_state')
      .eq('order_number', orderNumber)
      .maybeSingle();
    if (data) order = data;
  }
  if (!order && trackingNumber) {
    const { data } = await db
      .from('orders')
      .select('id, status, label_state')
      .eq('tracking_number', trackingNumber)
      .maybeSingle();
    if (data) order = data;
  }

  // No order carries this shipment. It may still belong to an invoice that
  // anchors its own — a Stealth Health hand-off has no order row by
  // design (see lib/shipping/auto-shipment.ts), so the tracking update lands
  // on the invoice instead.
  if (!order && easyshipId) {
    const invoiceUpdate: Record<string, unknown> = {};
    if (trackingNumber) invoiceUpdate.tracking_number = trackingNumber;
    if (trackingStatus) invoiceUpdate.tracking_status = trackingStatus;
    if (trackingUrl) invoiceUpdate.tracking_url = trackingUrl;
    if (carrier) invoiceUpdate.carrier = carrier;
    if (labelUrl) invoiceUpdate.label_url = labelUrl;
    if (labelState) invoiceUpdate.label_state = labelState;

    const { data: invoice, error: invErr } = await db
      .from('invoices')
      .select('*')
      .eq('easyship_shipment_id', easyshipId)
      .maybeSingle();
    // A database that hasn't run easyship-invoice-shipment-migration.sql has
    // no such column; that's an unmatched event, not a failure to retry.
    if (invErr || !invoice) {
      return NextResponse.json({ matched: false }, { status: 200 });
    }

    if (Object.keys(invoiceUpdate).length > 0) {
      await db.from('invoices').update(invoiceUpdate).eq('id', invoice.id);
    }
    // First sight of the label (e.g. bought in the Easyship dashboard, or a
    // purchase that was still generating): pull the full record onto the
    // invoice and send the shipped email to the customer + admins.
    if (labelState === 'generated' && invoice.label_state !== 'generated') {
      after(() =>
        onShipmentLabelGenerated(db, { kind: 'invoice', id: invoice.id }).then(() => {}),
      );
    }
    if (normalizedCheckpoints && normalizedCheckpoints.length > 0) {
      const { error: cpErr } = await db
        .from('invoices')
        .update({ tracking_checkpoints: normalizedCheckpoints })
        .eq('id', invoice.id);
      if (cpErr) {
        console.warn(
          '[easyship-webhook] could not store invoice checkpoints (run easyship-invoice-shipment-migration.sql?):',
          cpErr.message,
        );
      }
    }
    // Klaviyo "Fulfilled Order" / "Delivered Order" — only on the update that
    // moves the shipment into that state, not on every later checkpoint.
    const invoiceStage = mapToOrderStatus(trackingStatus);
    if (invoiceStage && mapToOrderStatus(invoice.tracking_status) !== invoiceStage) {
      await trackOrderStatus(db, {
        id: invoice.id,
        status: invoiceStage,
        email: invoice.customer_email,
        name: invoice.customer_name,
        orderNumber: invoice.invoice_number ?? null,
        total: invoice.total != null ? Number(invoice.total) : null,
        currency: invoice.currency ?? 'CAD',
        trackingNumber: trackingNumber ?? invoice.tracking_number ?? null,
        trackingUrl: trackingUrl ?? invoice.tracking_url ?? null,
        carrier: carrier ?? invoice.carrier ?? null,
      });
    }

    return NextResponse.json({ matched: true, anchor: 'invoice' });
  }

  if (!order) {
    // Ack so EasyShip stops retrying.
    return NextResponse.json({ matched: false }, { status: 200 });
  }

  const update: Record<string, unknown> = {};
  if (trackingNumber) update.tracking_number = trackingNumber;
  if (trackingStatus) update.tracking_status = trackingStatus;
  if (trackingUrl) update.tracking_url = trackingUrl;
  if (carrier) update.carrier = carrier;
  if (labelUrl) update.label_url = labelUrl;
  if (labelState) update.label_state = labelState;
  if (easyshipId) update.easyship_shipment_id = easyshipId;

  const nextStatus = advanceOrderForward(order.status, mapToOrderStatus(trackingStatus));
  if (nextStatus) {
    update.status = nextStatus;
    if (nextStatus === 'shipped') update.shipped_at = new Date().toISOString();
    if (nextStatus === 'delivered') update.delivered_at = new Date().toISOString();
  }

  if (Object.keys(update).length > 0) {
    await db.from('orders').update(update).eq('id', order.id);
  }

  // Persist checkpoints in a separate, best-effort write so a missing column
  // (migration not yet run) degrades gracefully instead of failing the whole
  // status update above.
  if (normalizedCheckpoints && normalizedCheckpoints.length > 0) {
    const { error: cpErr } = await db
      .from('orders')
      .update({ tracking_checkpoints: normalizedCheckpoints })
      .eq('id', order.id);
    if (cpErr) {
      console.warn(
        '[easyship-webhook] could not store checkpoints (run tracking-checkpoints-migration.sql?):',
        cpErr.message,
      );
    }
  }

  // Klaviyo "Fulfilled Order" / "Delivered Order" (best-effort, never throws).
  if (nextStatus) await trackOrderStatusById(db, order.id, nextStatus);

  // First sight of the label: mirror the full record onto the order's invoice
  // and send the shipped email to the customer + admins.
  if (labelState === 'generated' && order.label_state !== 'generated') {
    after(() => onShipmentLabelGenerated(db, { kind: 'order', id: order.id }).then(() => {}));
  }

  return NextResponse.json({ matched: true, advanced: nextStatus });
}
