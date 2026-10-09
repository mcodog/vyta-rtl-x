import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createEasyshipShipment, getShippingConfig, parcelQuantity } from '@/lib/easyship';
import { unitWeightKg } from '@/lib/shipping/auto-shipment';
import type { EasyshipShipmentRequest } from '@/lib/types/ecommerce';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function verifyAdmin(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return { ok: false, userId: null as string | null };
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return { ok: false, userId: null };
  const { data } = await db.from('customers').select('role').eq('id', user.id).single();
  return { ok: data?.role === 'admin', userId: user.id };
}

const ORIGIN = {
  name: process.env.EASYSHIP_ORIGIN_NAME ?? 'VYTA Fulfillment',
  address: process.env.EASYSHIP_ORIGIN_ADDRESS ?? '',
  city: process.env.EASYSHIP_ORIGIN_CITY ?? '',
  postal_code: process.env.EASYSHIP_ORIGIN_POSTAL ?? '',
  country_alpha2: process.env.EASYSHIP_ORIGIN_COUNTRY ?? 'CA',
};

// POST /api/admin/easyship/shipments
export async function POST(req: NextRequest) {
  const { ok, userId } = await verifyAdmin(req);
  if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const { order_id, courier_id } = await req.json();

  if (!order_id || !courier_id) {
    return NextResponse.json({ error: 'order_id and courier_id are required' }, { status: 400 });
  }

  // Fetch order + items
  const { data: order, error: orderErr } = await db
    .from('orders')
    .select('*, order_items(*)')
    .eq('id', order_id)
    .single();

  if (orderErr || !order) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  }

  const dest = order.shipping_address ?? {};

  // One supplements parcel: the unit count at the per-unit weight, declared
  // at 1 per unit, in the configured box (blank sides → 1 cm). Category and
  // declared value are fixed by createEasyshipShipment.
  const cfg = await getShippingConfig(db);
  const parcels = [
    {
      quantity: parcelQuantity(order.order_items ?? []),
      actual_weight: unitWeightKg(cfg),
      length: cfg.box.length,
      width: cfg.box.width,
      height: cfg.box.height,
      declared_currency: 'CAD',
    },
  ];

  const shipmentPayload: EasyshipShipmentRequest = {
    order_id,
    selected_courier_id: courier_id,
    origin: ORIGIN,
    destination: {
      firstName: dest.firstName ?? '',
      lastName: dest.lastName ?? '',
      address: dest.address ?? '',
      city: dest.city ?? '',
      state: dest.state ?? '',
      postalCode: dest.postalCode ?? '',
      country: dest.country ?? '',
      country_alpha2: dest.country ?? 'CA',
      phone: dest.phone,
    },
    parcels,
  };

  try {
    const result = await createEasyshipShipment(shipmentPayload);

    // Update order with shipment data
    await db
      .from('orders')
      .update({
        easyship_shipment_id: result.easyship_shipment_id,
        tracking_number: result.tracking_number,
        shipping_carrier: result.courier_name,
        status: 'shipped',
        shipped_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', order_id);

    return NextResponse.json(result);
  } catch (err: any) {
    console.error('Easyship shipment error:', err);
    return NextResponse.json({ error: err.message ?? 'Failed to create shipment' }, { status: 502 });
  }
}
