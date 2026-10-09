import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getInvoiceCaller } from '@/lib/admin/invoice-access';
import { resolveDestinationForInvoiceId } from '@/lib/shipping/invoice-destination';
import {
  getShippingConfig,
  fetchEasyshipRates,
  isAllowedCourier,
  applyHandlingFee,
  parcelDimensions,
} from '@/lib/easyship';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

interface ReadinessItem {
  qty: number;
  weight_kg?: number | null;
}

interface ReadinessDestination {
  country?: string | null;
  postal_code?: string | null;
  city?: string | null;
  state?: string | null;
}

/** How the resolved address is described on the readiness checklist, so an
 *  address the partner reported never reads like one typed here. */
const DESTINATION_LABEL: Record<string, string> = {
  order: 'from the linked order',
  puramass: 'from the Stealth Health hand-off',
  client: 'from the drop-ship client',
  customer: 'from the customer profile',
};

interface Check {
  key: string;
  label: string;
  ok: boolean;
  detail?: string;
}

/**
 * POST /api/admin/invoices/shipping-readiness
 *
 * Read-only pre-flight for the invoice form: given a proposed destination +
 * line items, tell the admin whether an Easyship shipment could be created,
 * and (when everything checks out) return live UPS / Canada Post rates so the shipping
 * fee can be auto-filled. Creates nothing.
 *
 * `invoice_id` lets the check run on an invoice whose address this admin never
 * typed — above all a Stealth Health hand-off, whose ship-to lives
 * on the hand-off ledger rather than on a customer record. When the body
 * carries no usable destination, the invoice's own destination is resolved
 * server-side (order → Stealth Health ledger → drop-ship client → customer profile)
 * and reported back as `destination`.
 *
 * Body: { destination?: { country, postal_code, city, state },
 *         invoice_id?: string, items: [{ qty, weight_kg? }] }
 * Response: { ready, checks[], rates[], ratesNote, destination? }
 */
export async function POST(req: NextRequest) {
  const caller = await getInvoiceCaller(db, req);
  if (!caller.ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  let destination = (body.destination ?? {}) as ReadinessDestination;
  const items = Array.isArray(body.items) ? (body.items as ReadinessItem[]) : [];
  const invoiceId = typeof body.invoice_id === 'string' ? body.invoice_id : null;

  // Nothing usable typed into the form — fall back to the address the invoice
  // itself resolves to. This is the normal case for a Stealth Health hand-off:
  // the admin picked no customer because there is none to pick.
  let resolvedDestination: ReadinessDestination | null = null;
  let destinationSource: string | null = null;
  let destinationNote: string | null = null;
  const typedDestOk = !!(destination.country && destination.postal_code && destination.city);
  if (!typedDestOk && invoiceId) {
    const resolved = await resolveDestinationForInvoiceId(db, invoiceId);
    if (resolved.destination) {
      resolvedDestination = {
        country: resolved.destination.country,
        postal_code: resolved.destination.postalCode,
        city: resolved.destination.city,
        state: resolved.destination.state,
      };
      destination = resolvedDestination;
      destinationSource = resolved.destination.source;
    } else {
      destinationNote = resolved.reason;
    }
  }

  const cfg = await getShippingConfig(db);
  const checks: Check[] = [];

  checks.push({
    key: 'easyship_enabled',
    label: 'Easyship live rates enabled',
    ok: !!cfg.enabled,
    detail: cfg.enabled ? undefined : 'Toggle on in Site Settings',
  });
  checks.push({
    key: 'easyship_api_key',
    label: 'Easyship API key present',
    ok: !!cfg.apiKey,
    detail: cfg.apiKey ? undefined : 'Missing EASYSHIP_API_KEY',
  });

  const originOk = !!(
    cfg.origin.country_alpha2 &&
    cfg.origin.postal_code &&
    cfg.origin.city
  );
  checks.push({
    key: 'origin',
    label: 'Origin address complete',
    ok: originOk,
    detail: originOk
      ? undefined
      : 'Set shipping origin (country / postal / city) in Site Settings',
  });

  const destOk = !!(
    destination.country &&
    destination.postal_code &&
    destination.city
  );
  checks.push({
    key: 'destination',
    label: destinationSource
      ? `Destination address complete (${DESTINATION_LABEL[destinationSource] ?? destinationSource})`
      : 'Destination address complete',
    ok: destOk,
    detail: destOk
      ? undefined
      : (destinationNote ??
        'Country, postal code and city are required for a rate quote'),
  });

  const itemCount = items.reduce((s, i) => s + (Number(i.qty) || 0), 0);
  const itemsOk = itemCount > 0;
  checks.push({
    key: 'items',
    label: 'At least one line item',
    ok: itemsOk,
  });

  // Never blocks: a side left blank in Settings goes out as 1 cm
  // (lib/easyship.ts parcelDimensions).
  const box = cfg.box ?? {};
  const dims = parcelDimensions(box);
  const parcelSet = !!(box.length && box.width && box.height);
  checks.push({
    key: 'parcel',
    label: parcelSet
      ? `Parcel ${dims.length} × ${dims.width} × ${dims.height} cm`
      : `Parcel ${dims.length} × ${dims.width} × ${dims.height} cm (blank sides default to 1 cm)`,
    ok: true,
  });

  const ready = checks.every((c) => c.ok);
  if (!ready) {
    return NextResponse.json({
      ready: false,
      checks,
      rates: [],
      ratesNote: null,
      destination: resolvedDestination,
      destination_source: destinationSource,
    });
  }

  // Total weight = per-line weight override × qty, falling back to the
  // configured per-item weight. Never let the parcel go to zero — Easyship
  // rejects a weightless shipment.
  const totalWeight = Math.max(
    0.05,
    items.reduce(
      (s, i) => s + (Number(i.qty) || 0) * (Number(i.weight_kg) || cfg.itemWeightKg),
      0,
    ),
  );

  let rates: any[] = [];
  let ratesNote: string | null = null;
  try {
    const raw = await fetchEasyshipRates(
      {
        origin_country_alpha2: cfg.origin.country_alpha2 ?? 'CA',
        origin_postal_code: cfg.origin.postal_code ?? '',
        origin_state: cfg.origin.state,
        origin_city: cfg.origin.city,
        destination_country_alpha2: (destination.country ?? '').toUpperCase(),
        destination_postal_code: destination.postal_code ?? '',
        destination_city: destination.city ?? '',
        destination_state: destination.state ?? undefined,
        total_actual_weight: totalWeight,
        quantity: Math.max(1, Math.round(itemCount)),
        boxes: [{ ...dims, weight: totalWeight }],
      },
      cfg.apiKey,
    );
    rates = raw
      .filter(isAllowedCourier)
      .map((r) => ({ ...r, total_charge: applyHandlingFee(r.total_charge, cfg) }))
      .sort((a, b) => a.total_charge - b.total_charge);
    if (rates.length === 0) {
      ratesNote =
        'Easyship returned no UPS / Canada Post rates for this destination. Manual shipping cost will be used.';
    }
  } catch (e: any) {
    ratesNote = `Live rate quote failed: ${e?.message ?? 'unknown error'}`;
  }

  return NextResponse.json({
    ready: true,
    checks,
    rates,
    ratesNote,
    destination: resolvedDestination,
    destination_source: destinationSource,
  });
}
