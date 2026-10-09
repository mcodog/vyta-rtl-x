import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getInvoiceCaller } from '@/lib/admin/invoice-access';
import { getEasyshipTracking } from '@/lib/easyship';
import { isMissingColumnError } from '@/lib/payments/puramass-columns';
import { onShipmentLabelGenerated } from '@/lib/shipping/label-generated';

/**
 * The rest of the Easyship record, mirrored onto the invoice when the label
 * was generated (easyship-label-sync-migration.sql). Read on its own so a
 * database without those columns still answers.
 */
async function loadShipmentRecord(invoiceId: string) {
  const { data, error } = await db
    .from('invoices')
    .select(
      'shipping_service, shipping_label_cost, shipping_label_currency, est_delivery_min_days, est_delivery_max_days, label_generated_at, easyship_synced_at, shipped_emailed_at',
    )
    .eq('id', invoiceId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    service: data.shipping_service ?? null,
    label_cost: data.shipping_label_cost != null ? Number(data.shipping_label_cost) : null,
    label_currency: data.shipping_label_currency ?? null,
    est_delivery_min_days: data.est_delivery_min_days ?? null,
    est_delivery_max_days: data.est_delivery_max_days ?? null,
    label_generated_at: data.label_generated_at ?? null,
    synced_at: data.easyship_synced_at ?? null,
    shipped_emailed_at: data.shipped_emailed_at ?? null,
  };
}

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/admin/invoices/[id]/tracking
 *
 * Returns a snapshot of the invoice's shipping / tracking state — from the
 * linked order when there is one, and from the invoice itself when there
 * isn't. A Stealth Health hand-off has no order row by design
 * (see lib/payments/puramass-fulfillment.ts) but can still anchor its own
 * Easyship shipment, so `hasOrder: false` no longer means "not shipped".
 *
 * Admin / assistant / affiliate can read; only admins can `?refresh=1` and
 * persist a changed live status back.
 *
 * Response:
 *   { hasOrder, order_id, order_number, order_status, hasShipment,
 *     live: boolean, tracking: { status, number, url, carrier,
 *                                easyship_shipment_id, label_state,
 *                                label_url, checkpoints? } }
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const caller = await getInvoiceCaller(db, req);
  if (!caller.ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  // An admin's live refresh also re-syncs the full Easyship record onto the
  // invoice — and, when the label exists and the customer hasn't had the
  // shipped email yet, sends it (catches a label the webhook never reported).
  if (req.nextUrl.searchParams.get('refresh') === '1' && caller.role === 'admin') {
    const { data: head } = await db
      .from('invoices')
      .select('id, order_id')
      .eq('id', params.id)
      .maybeSingle();
    if (head) {
      await onShipmentLabelGenerated(
        db,
        head.order_id ? { kind: 'order', id: head.order_id } : { kind: 'invoice', id: head.id },
      );
    }
  }

  // The invoice's own shipment block (easyship-invoice-shipment-migration.sql).
  // Falls back to the bare columns so a database that hasn't run that
  // migration still answers for order-backed invoices exactly as before.
  const INVOICE_SHIPMENT_COLS =
    'id, order_id, easyship_shipment_id, easyship_courier_id, tracking_number, tracking_status, tracking_url, carrier, label_state, label_url, tracking_checkpoints, auto_shipment_status, auto_shipment_stage, auto_shipment_error, auto_shipment_attempted_at';
  let invoiceRes = await db
    .from('invoices')
    .select(INVOICE_SHIPMENT_COLS)
    .eq('id', params.id)
    .maybeSingle();
  if (invoiceRes.error && isMissingColumnError(invoiceRes.error)) {
    invoiceRes = (await db
      .from('invoices')
      .select('id, order_id')
      .eq('id', params.id)
      .maybeSingle()) as typeof invoiceRes;
  }
  const invoice = invoiceRes.data as Record<string, any> | null;
  if (invoiceRes.error || !invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  }

  if (!invoice.order_id) {
    return NextResponse.json(
      await invoiceAnchoredSnapshot(invoice, {
        wantsRefresh: req.nextUrl.searchParams.get('refresh') === '1',
        canPersist: caller.role === 'admin',
      }),
    );
  }

  const { data: order } = await db
    .from('orders')
    .select(
      'id, order_number, status, tracking_number, tracking_status, tracking_url, carrier, easyship_shipment_id, label_state, label_url, shipping_address, auto_shipment_status, auto_shipment_stage, auto_shipment_error, auto_shipment_attempted_at',
    )
    .eq('id', invoice.order_id)
    .single();

  if (!order) {
    // The invoice points at an order that no longer exists — report whatever
    // the invoice itself carries rather than a blank snapshot.
    return NextResponse.json(
      await invoiceAnchoredSnapshot(invoice, {
        wantsRefresh: req.nextUrl.searchParams.get('refresh') === '1',
        canPersist: caller.role === 'admin',
      }),
    );
  }

  // Destination label for the shipment map — the parcel's endpoint. Handles
  // both the JSONB address object and a bare string.
  const destLabel = (() => {
    const addr: any = order.shipping_address;
    if (!addr) return null;
    if (typeof addr === 'string') return addr;
    const parts = [addr.city, addr.state, addr.country].filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  })();

  const wantsRefresh = req.nextUrl.searchParams.get('refresh') === '1';
  const canPersist = caller.role === 'admin';

  // Stored checkpoint history (populated by the Easyship checkpoints webhook).
  // Fetched separately and guarded so a not-yet-migrated column can't break the
  // whole tracking response.
  let storedCheckpoints: any = undefined;
  {
    const { data: cpRow } = await db
      .from('orders')
      .select('tracking_checkpoints')
      .eq('id', order.id)
      .maybeSingle();
    if (cpRow?.tracking_checkpoints && Array.isArray(cpRow.tracking_checkpoints)) {
      storedCheckpoints = cpRow.tracking_checkpoints;
    }
  }

  let tracking: any = {
    status: order.tracking_status ?? null,
    number: order.tracking_number ?? null,
    url: order.tracking_url ?? null,
    carrier: order.carrier ?? null,
    easyship_shipment_id: order.easyship_shipment_id ?? null,
    label_state: order.label_state ?? null,
    label_url: order.label_url ?? null,
    // Render the stored journey by default (no live API call needed).
    checkpoints: storedCheckpoints,
    // Auto-shipment attempt snapshot — surfaced on the detail page so the
    // admin can tell whether the after() job succeeded, is still pending, or
    // failed (with the reason from shipment_auto_logs).
    auto_shipment: order.auto_shipment_status
      ? {
          status: order.auto_shipment_status,
          stage: order.auto_shipment_stage ?? null,
          error: order.auto_shipment_error ?? null,
          attempted_at: order.auto_shipment_attempted_at ?? null,
        }
      : null,
  };
  let live = false;

  if (wantsRefresh && order.easyship_shipment_id) {
    try {
      const fresh = await getEasyshipTracking(order.easyship_shipment_id);
      live = true;
      tracking = {
        ...tracking,
        status: fresh.status ?? tracking.status,
        number: fresh.tracking_number ?? tracking.number,
        url: fresh.tracking_url ?? tracking.url,
        carrier: fresh.carrier ?? tracking.carrier,
        // Prefer freshly-fetched checkpoints, but keep the stored webhook
        // history when the shipment endpoint returns none (the common case).
        checkpoints: fresh.checkpoints.length ? fresh.checkpoints : storedCheckpoints,
      };

      // Only admins persist, and only fields that actually changed, so reads
      // don't churn the order row.
      if (canPersist) {
        const patch: Record<string, unknown> = {};
        if (fresh.status && fresh.status !== order.tracking_status) patch.tracking_status = fresh.status;
        if (fresh.tracking_number && fresh.tracking_number !== order.tracking_number) patch.tracking_number = fresh.tracking_number;
        if (fresh.tracking_url && fresh.tracking_url !== order.tracking_url) patch.tracking_url = fresh.tracking_url;
        if (fresh.carrier && fresh.carrier !== order.carrier) patch.carrier = fresh.carrier;
        if (Object.keys(patch).length > 0) {
          await db.from('orders').update(patch).eq('id', order.id);
        }
      }
    } catch (e: any) {
      // Live fetch is best-effort — return the cached snapshot with an
      // `error` breadcrumb so the UI can show "couldn't refresh" without
      // discarding what we already had.
      tracking = { ...tracking, refresh_error: e?.message ?? 'Easyship error' };
    }
  }

  tracking.record = await loadShipmentRecord(params.id);

  return NextResponse.json({
    hasOrder: true,
    order_id: order.id,
    order_number: order.order_number,
    order_status: order.status,
    hasShipment: !!order.easyship_shipment_id,
    live,
    destination: destLabel,
    tracking,
  });
}

/**
 * The same snapshot, read off the invoice row for an invoice that anchors its
 * own shipment (no order). `?refresh=1` re-reads Easyship live and, for an
 * admin, persists the changed fields back onto the invoice.
 */
async function invoiceAnchoredSnapshot(
  invoice: Record<string, any>,
  opts: { wantsRefresh: boolean; canPersist: boolean },
) {
  const storedCheckpoints = Array.isArray(invoice.tracking_checkpoints)
    ? invoice.tracking_checkpoints
    : undefined;

  let tracking: any = {
    status: invoice.tracking_status ?? null,
    number: invoice.tracking_number ?? null,
    url: invoice.tracking_url ?? null,
    carrier: invoice.carrier ?? null,
    easyship_shipment_id: invoice.easyship_shipment_id ?? null,
    label_state: invoice.label_state ?? null,
    label_url: invoice.label_url ?? null,
    checkpoints: storedCheckpoints,
    auto_shipment: invoice.auto_shipment_status
      ? {
          status: invoice.auto_shipment_status,
          stage: invoice.auto_shipment_stage ?? null,
          error: invoice.auto_shipment_error ?? null,
          attempted_at: invoice.auto_shipment_attempted_at ?? null,
        }
      : null,
  };
  let live = false;

  if (opts.wantsRefresh && invoice.easyship_shipment_id) {
    try {
      const fresh = await getEasyshipTracking(invoice.easyship_shipment_id);
      live = true;
      tracking = {
        ...tracking,
        status: fresh.status ?? tracking.status,
        number: fresh.tracking_number ?? tracking.number,
        url: fresh.tracking_url ?? tracking.url,
        carrier: fresh.carrier ?? tracking.carrier,
        checkpoints: fresh.checkpoints.length ? fresh.checkpoints : storedCheckpoints,
      };
      if (opts.canPersist) {
        const patch: Record<string, unknown> = {};
        if (fresh.status && fresh.status !== invoice.tracking_status) patch.tracking_status = fresh.status;
        if (fresh.tracking_number && fresh.tracking_number !== invoice.tracking_number) patch.tracking_number = fresh.tracking_number;
        if (fresh.tracking_url && fresh.tracking_url !== invoice.tracking_url) patch.tracking_url = fresh.tracking_url;
        if (fresh.carrier && fresh.carrier !== invoice.carrier) patch.carrier = fresh.carrier;
        if (Object.keys(patch).length > 0) {
          await db.from('invoices').update(patch).eq('id', invoice.id);
        }
      }
    } catch (e: any) {
      tracking = { ...tracking, refresh_error: e?.message ?? 'Easyship error' };
    }
  }

  tracking.record = await loadShipmentRecord(invoice.id);

  const hasShipment = !!invoice.easyship_shipment_id;
  return {
    hasOrder: false,
    order_id: invoice.order_id ?? null,
    order_number: null,
    order_status: null,
    hasShipment,
    live,
    destination: null,
    // An invoice with no shipment and no attempt has nothing to report; one
    // that failed to create still carries the reason, which the detail page
    // shows so the admin knows it needs another go.
    tracking: hasShipment || invoice.auto_shipment_status ? tracking : null,
  };
}
