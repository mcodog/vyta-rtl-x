import { NextRequest, NextResponse, after } from 'next/server';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { advanceOrderForward } from '@/lib/warehouse/types';
import { trackOrderStatus, trackOrderStatusById } from '@/lib/klaviyo/events';
import { onShipmentLabelGenerated } from '@/lib/shipping/label-generated';
import { parseEasyshipWebhook } from '@/lib/shipping/easyship-webhook';

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

/**
 * Easyship's own signature: `X-EASYSHIP-SIGNATURE` carries a JWT signed
 * HS256 with the webhook's secret key (Easyship → Connect → Webhooks). Valid
 * when the signature over `header.payload` matches and any `exp` is still in
 * the future.
 */
function verifyEasyshipJwt(token: string, secret: string): boolean {
  const parts = token.trim().split('.');
  if (parts.length !== 3) return false;
  const [h, p, sig] = parts;
  try {
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    if (header?.alg !== 'HS256') return false;
    const expected = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      return false;
    }
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (typeof claims?.exp === 'number' && claims.exp * 1000 < Date.now()) return false;
    return true;
  } catch {
    return false;
  }
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
  const jwtHeader = req.headers.get('x-easyship-signature');
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
  if (jwtHeader && verifyEasyshipJwt(jwtHeader, secret)) verified = true;
  else if (hmacHeader && verifyHmac(raw, hmacHeader, secret)) verified = true;
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

  // Registered at EASYSHIP_WEBHOOK_URL (lib/shipping/easyship-webhook.ts).
  // Each event nests its subject under its own key (label / tracking_status /
  // tracking_checkpoints / shipment); the parser reads all of them.
  const parsed = parseEasyshipWebhook(payload);
  if (!parsed.handled) {
    // Account-level events (batches, credit, couriers, OAuth, transactions):
    // nothing on an order or invoice to update. Ack so Easyship stops retrying.
    return NextResponse.json({ ignored: parsed.eventType }, { status: 200 });
  }
  const {
    shipmentId: easyshipId,
    orderNumber,
    trackingNumber,
    trackingUrl,
    carrier,
    labelUrl,
    labelState,
    trackingStatus,
    checkpoints: normalizedCheckpoints,
  } = parsed;

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
