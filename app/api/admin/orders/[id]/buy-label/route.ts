import { NextRequest, NextResponse, after } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { buyEasyshipLabel, getShippingConfig } from '@/lib/easyship';
import { onShipmentLabelGenerated } from '@/lib/shipping/label-generated';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function verifyAdmin(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return false;
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return false;
  const { data } = await db.from('customers').select('role').eq('id', user.id).single();
  return data?.role === 'admin';
}

// POST /api/admin/orders/[id]/buy-label — admin-triggered label purchase.
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const { data: order } = await db
    .from('orders')
    .select('id, easyship_shipment_id, fulfillment_type, label_state')
    .eq('id', params.id)
    .maybeSingle();
  if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  if (!order.easyship_shipment_id) {
    return NextResponse.json({ error: 'Order has no shipment yet — create one first' }, { status: 400 });
  }
  if (order.fulfillment_type === 'pickup') {
    return NextResponse.json({ error: 'Pickup orders do not need a label' }, { status: 400 });
  }
  if (order.label_state === 'generated') {
    return NextResponse.json({ error: 'Label already purchased' }, { status: 400 });
  }

  // The courier was assigned to the shipment at creation; buying the label just
  // confirms/charges it.
  const cfg = await getShippingConfig(db);
  try {
    const label = await buyEasyshipLabel(order.easyship_shipment_id, cfg.apiKey);
    await db
      .from('orders')
      .update({
        label_state: label.state,
        label_url: label.url,
        tracking_number: label.tracking_number ?? undefined,
        carrier: label.carrier ?? undefined,
      })
      .eq('id', params.id);
    // Mirror the record onto the order's invoice and send the shipped email
    // (customer + admins) once the label exists — after the response.
    if (label.state === 'generated') {
      after(() =>
        onShipmentLabelGenerated(db, { kind: 'order', id: params.id }, { apiKey: cfg.apiKey }).then(
          () => {},
        ),
      );
    }
    return NextResponse.json({ label });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'buy-label failed' }, { status: 502 });
  }
}
