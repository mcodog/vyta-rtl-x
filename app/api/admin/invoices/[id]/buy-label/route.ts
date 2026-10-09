import { NextRequest, NextResponse, after } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getInvoiceCaller, callerCanWrite } from '@/lib/admin/invoice-access';
import { logAuditServer } from '@/lib/admin/audit';
import { buyEasyshipLabel, getShippingConfig } from '@/lib/easyship';
import { isMissingColumnError } from '@/lib/payments/puramass-columns';
import { onShipmentLabelGenerated } from '@/lib/shipping/label-generated';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * POST /api/admin/invoices/[id]/buy-label — buy the Easyship label for an
 * invoice's shipment, wherever that shipment is anchored.
 *
 * The order-side twin (`/api/admin/orders/[id]/buy-label`) can only reach a
 * shipment that hangs off an order, which leaves a Stealth Health
 * hand-off — no order row by design — with a draft shipment and no way to pay
 * for its label from the admin. This routes itself the same way shipment
 * creation does.
 *
 * Charges the Easyship wallet, so it is admin-only and never automatic here.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const caller = await getInvoiceCaller(db, req);
  if (!caller.ok || !callerCanWrite(caller.role)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const { data: invoice } = await db
    .from('invoices')
    .select('id, order_id, fulfillment_type')
    .eq('id', params.id)
    .maybeSingle();
  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  }
  if (invoice.fulfillment_type === 'pickup') {
    return NextResponse.json(
      { error: 'Pickup invoices do not need a label' },
      { status: 400 },
    );
  }

  // Where the shipment lives: the linked order, or the invoice itself.
  const table = invoice.order_id ? 'orders' : 'invoices';
  const rowId = invoice.order_id ?? params.id;
  const anchored = await db
    .from(table)
    .select('id, easyship_shipment_id, label_state')
    .eq('id', rowId)
    .maybeSingle();
  if (anchored.error && isMissingColumnError(anchored.error)) {
    return NextResponse.json(
      {
        error:
          'Invoice shipment columns are missing — run easyship-invoice-shipment-migration.sql.',
      },
      { status: 500 },
    );
  }
  const row = anchored.data as Record<string, any> | null;
  if (!row?.easyship_shipment_id) {
    return NextResponse.json(
      { error: 'No shipment yet — create one first' },
      { status: 400 },
    );
  }
  if (row.label_state === 'generated') {
    return NextResponse.json({ error: 'Label already purchased' }, { status: 400 });
  }

  const cfg = await getShippingConfig(db);
  if (!cfg.enabled || !cfg.apiKey) {
    return NextResponse.json(
      { error: 'Easyship is disabled or missing an API key' },
      { status: 400 },
    );
  }

  try {
    // The courier was baked into the shipment at creation; buying the label
    // just confirms and charges it.
    const label = await buyEasyshipLabel(row.easyship_shipment_id, cfg.apiKey);
    await db
      .from(table)
      .update({
        label_state: label.state,
        label_url: label.url,
        tracking_number: label.tracking_number ?? undefined,
        carrier: label.carrier ?? undefined,
      })
      .eq('id', rowId);

    // Label in hand: mirror the Easyship record onto the invoice and send the
    // shipped email (customer + admins), after the response. A label still
    // generating is finished by the Easyship webhook, which does the same.
    if (label.state === 'generated') {
      const anchor = invoice.order_id
        ? ({ kind: 'order', id: invoice.order_id } as const)
        : ({ kind: 'invoice', id: params.id } as const);
      after(() => onShipmentLabelGenerated(db, anchor, { apiKey: cfg.apiKey }).then(() => {}));
    }

    await logAuditServer(db, caller, {
      action: 'invoice.buy_label',
      entity_type: 'invoice',
      entity_id: params.id,
    });

    return NextResponse.json({ anchor: invoice.order_id ? 'order' : 'invoice', label });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? 'buy-label failed' },
      { status: 502 },
    );
  }
}
