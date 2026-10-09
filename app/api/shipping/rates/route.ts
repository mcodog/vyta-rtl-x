import { NextRequest, NextResponse } from 'next/server';
import {
  getShippingConfig,
  getShippingQuoteOrFallback,
  parcelQuantity,
} from '@/lib/easyship';
import { computeScaledWeight, unitWeightKg } from '@/lib/shipping/auto-shipment';
import type { EasyshipRateRequest } from '@/lib/types/ecommerce';

interface CheckoutShipping {
  firstName?: string;
  lastName?: string;
  address?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  phone?: string;
}

interface RatesBody {
  shipping?: CheckoutShipping;
  items?: Array<{ quantity?: number; qty?: number }>;
}

// POST /api/shipping/rates
// Public storefront route. Returns live UPS / Canada Post rates (handling fee
// folded in) for the supplied destination address. When EasyShip is not
// configured / down, returns an empty `rates` array and the configured
// `flat_rate` as `fallback_rate`. The checkout UI should hide the
// shipping line until either a rate is selected or the fallback is
// shown.
export async function POST(req: NextRequest) {
  let body: RatesBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const dest = body.shipping ?? {};
  if (!dest.postalCode || !dest.country) {
    return NextResponse.json(
      { rates: [], fallback_rate: null, note: 'address required' },
      { status: 200 },
    );
  }

  const cfg = await getShippingConfig();
  const fallback_rate = Number(cfg.flatRate ?? 0);

  if (!cfg.enabled || !cfg.apiKey) {
    return NextResponse.json({
      rates: [],
      fallback_rate,
      note: 'easyship disabled',
    });
  }

  // Quantity-scaled weight — the exact same calculation the auto-shipment
  // creation uses (shared helper), so the quoted rate and the purchased label
  // are computed from the same weight instead of diverging.
  const scaledWeight = computeScaledWeight(body.items, unitWeightKg(cfg));

  const payload: EasyshipRateRequest = {
    origin_country_alpha2: cfg.origin.country_alpha2 || 'CA',
    origin_postal_code: cfg.origin.postal_code || '',
    origin_state: cfg.origin.state || undefined,
    origin_city: cfg.origin.city || undefined,
    destination_country_alpha2: dest.country.length === 2 ? dest.country : 'CA',
    destination_postal_code: dest.postalCode,
    destination_city: dest.city ?? '',
    destination_state: dest.state || undefined,
    total_actual_weight: scaledWeight,
    quantity: parcelQuantity(body.items),
    // Blank box sides go out as 1 cm (lib/easyship.ts parcelDimensions).
    boxes: [
      {
        length: cfg.box.length ?? 0,
        width: cfg.box.width ?? 0,
        height: cfg.box.height ?? 0,
        weight: scaledWeight,
      },
    ],
  };

  try {
    const rates = await getShippingQuoteOrFallback(payload);
    return NextResponse.json({
      rates,
      fallback_rate,
      origin_postal: cfg.origin.postal_code ?? null,
      // Enabled + configured but no rates came back: likely no courier
      // solution for this lane, or a token/origin issue. Point admins at the
      // Test connection diagnostics rather than failing silently.
      note:
        rates.length === 0
          ? 'no live rates returned (run admin → settings → shipping → Test connection)'
          : undefined,
    });
  } catch (e: any) {
    return NextResponse.json({
      rates: [],
      fallback_rate,
      note: e?.message ?? 'rate lookup failed',
    });
  }
}
