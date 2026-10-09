import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getShippingConfig, getShippingQuoteOrFallback, parcelQuantity } from '@/lib/easyship';
import { computeScaledWeight, unitWeightKg } from '@/lib/shipping/auto-shipment';
import type { EasyshipRateRequest } from '@/lib/types/ecommerce';

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
  return data?.role === 'admin' || data?.role === 'assistant';
}

// GET /api/admin/orders/[id]/rates — per-order live rates (UPS / Canada Post, handling fee folded).
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  if (!(await verifyAdmin(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const { data: order, error } = await db
    .from('orders')
    .select('id, shipping_address, items')
    .eq('id', params.id)
    .maybeSingle();
  if (error || !order) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  }
  const dest = order.shipping_address as any;
  if (!dest?.postalCode) {
    return NextResponse.json({ rates: [], note: 'order has no postal code' });
  }

  const cfg = await getShippingConfig(db);
  const items = Array.isArray((order as any).items) ? (order as any).items : [];
  const weight = computeScaledWeight(items, unitWeightKg(cfg));
  const payload: EasyshipRateRequest = {
    origin_country_alpha2: cfg.origin.country_alpha2 || 'CA',
    origin_postal_code: cfg.origin.postal_code || '',
    // Easyship's 2024-09 rates endpoint requires origin city + state and
    // destination state for US/CA addresses (422 otherwise).
    origin_city: cfg.origin.city || undefined,
    origin_state: cfg.origin.state || undefined,
    destination_country_alpha2: dest.country?.length === 2 ? dest.country : 'CA',
    destination_postal_code: dest.postalCode,
    destination_city: dest.city ?? '',
    destination_state: dest.state || undefined,
    // Same parcel the shipment is created with (lib/shipping/auto-shipment.ts):
    // the unit count at the per-unit weight; blank box sides go out as 1 cm.
    total_actual_weight: weight,
    quantity: parcelQuantity(items),
    boxes: [
      {
        length: cfg.box.length ?? 0,
        width: cfg.box.width ?? 0,
        height: cfg.box.height ?? 0,
        weight,
      },
    ],
  };
  const rates = await getShippingQuoteOrFallback(payload);
  return NextResponse.json({ rates });
}
