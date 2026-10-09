import type {
  EasyshipRateRequest,
  EasyshipRate,
  EasyshipShipmentRequest,
  EasyshipShipmentResponse,
} from '@/lib/types/ecommerce';
import { getSupabase } from '@/lib/supabase';
import { applyProcessingFee } from '@/lib/shipping/processing-fee';
import type { SupabaseClient } from '@supabase/supabase-js';

// Base URL includes the dated API version. 2024-09 is the current stable
// version; 2023-01 is legacy and its rates payload/response differ. Override
// the whole thing with EASYSHIP_API_URL if EasyShip moves the version again.
const EASYSHIP_BASE =
  process.env.EASYSHIP_API_URL || 'https://public-api.easyship.com/2024-09';

function headers(apiKey?: string) {
  const token = apiKey || process.env.EASYSHIP_API_KEY;
  if (!token) throw new Error('EASYSHIP_API_KEY is not set');
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

// ---------- Parcel contents ----------
//
// Every Easyship parcel goes out the same way, whatever the order holds:
//   • one item line under the supplements category (SUPPLEMENTS_HS_CODE),
//   • the real unit count as its quantity,
//   • a declared value of 1 per unit — never the order's real prices,
//   • the box from Settings → Default parcel, each blank side falling back
//     to 1 cm.
// Rate quotes and shipment creation both build from these, so the rate the
// courier was picked on is the rate the label is bought at.

/** Easyship item category "Dry Food & Supplements". */
export const SUPPLEMENTS_HS_CODE = '17049000';
/** Description on every parcel item. */
export const PARCEL_ITEM_DESCRIPTION = 'Supplements';
/** Declared customs value per unit (CAD). */
export const DECLARED_UNIT_VALUE = 1;
/** Per-unit weight floor (kg) — Easyship rejects a weight <= 0. */
export const MIN_UNIT_WEIGHT_KG = 0.01;
/** Box side (cm) used when Settings → Default parcel leaves it blank or 0. */
export const FALLBACK_DIMENSION_CM = 1;

/** A box side, or the 1 cm fallback for a blank / zero / junk value. */
export function parcelDimension(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : FALLBACK_DIMENSION_CM;
}

/** The configured box with the 1 cm fallback applied to each side. */
export function parcelDimensions(box: {
  length?: number | null;
  width?: number | null;
  height?: number | null;
} | null | undefined): { length: number; width: number; height: number } {
  return {
    length: parcelDimension(box?.length),
    width: parcelDimension(box?.width),
    height: parcelDimension(box?.height),
  };
}

/** Units in a parcel: the summed line quantities, at least 1. */
export function parcelQuantity(
  items: Array<{ quantity?: number | string | null; qty?: number | string | null }> | null | undefined,
): number {
  const total = (items ?? []).reduce(
    (s, i) => s + (Number(i.quantity) || Number(i.qty) || 0),
    0,
  );
  return Math.max(1, Math.round(total));
}

// ---------- Config from site_settings (with env fallback) ----------

export interface ShippingConfig {
  enabled: boolean;
  apiKey: string;
  origin: {
    name?: string;
    company?: string;
    phone?: string;
    email?: string;
    address?: string;
    city?: string;
    state?: string;
    postal_code?: string;
    country_alpha2?: string;
  };
  box: { length?: number; width?: number; height?: number; weight?: number };
  itemWeightKg: number;
  flatRate: number;
  handlingFeeType: 'flat' | 'pct';
  handlingFeeValue: number;
}

const DEFAULT_CONFIG: ShippingConfig = {
  enabled: false,
  apiKey: '',
  origin: {
    name: process.env.EASYSHIP_ORIGIN_NAME ?? 'VYTA Fulfillment',
    company: process.env.EASYSHIP_ORIGIN_COMPANY ?? process.env.EASYSHIP_ORIGIN_NAME ?? 'VYTA',
    phone: process.env.EASYSHIP_ORIGIN_PHONE ?? '',
    email: process.env.EASYSHIP_ORIGIN_EMAIL ?? '',
    address: process.env.EASYSHIP_ORIGIN_ADDRESS ?? '',
    city: process.env.EASYSHIP_ORIGIN_CITY ?? '',
    postal_code: process.env.EASYSHIP_ORIGIN_POSTAL ?? '',
    country_alpha2: process.env.EASYSHIP_ORIGIN_COUNTRY ?? 'CA',
  },
  // Blank dimensions fall back to 1 cm each (FALLBACK_DIMENSION_CM) — see
  // parcelDimensions(). Weight is the per-unit floor.
  box: { length: FALLBACK_DIMENSION_CM, width: FALLBACK_DIMENSION_CM, height: FALLBACK_DIMENSION_CM, weight: 0.05 },
  itemWeightKg: 0.05,
  flatRate: 20,
  handlingFeeType: 'flat',
  handlingFeeValue: 0,
};

export async function getShippingConfig(
  db?: SupabaseClient,
): Promise<ShippingConfig> {
  const client = db ?? getSupabase();
  try {
    // Select '*' rather than an explicit column list: the handling-fee
    // columns (shipping_handling_fee_type/value) ship in a separate, optional
    // migration, and naming a column that doesn't exist makes PostgREST fail
    // the WHOLE query — which previously collapsed the config to DEFAULT_CONFIG
    // and silently disabled EasyShip even when it was enabled with a valid key.
    // '*' returns whatever columns exist; absent fields just fall back below.
    const { data, error } = await client
      .from('site_settings')
      .select('*')
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error('[easyship] getShippingConfig read failed:', error.message);
      return DEFAULT_CONFIG;
    }
    if (!data) return DEFAULT_CONFIG;
    const origin = (data.shipping_origin ?? {}) as Record<string, any>;
    return {
      enabled: !!data.easyship_enabled,
      apiKey: data.easyship_api_key || process.env.EASYSHIP_API_KEY || '',
      origin: {
        ...DEFAULT_CONFIG.origin,
        ...origin,
        // Settings store the street as `line_1`; the rest of the code (and
        // EasyShip shipment creation) expects `address`. Bridge both.
        address: origin.address ?? origin.line_1 ?? DEFAULT_CONFIG.origin.address,
      },
      box: { ...DEFAULT_CONFIG.box, ...(data.shipping_box ?? {}) },
      itemWeightKg:
        Number(data.shipping_item_weight_kg) || DEFAULT_CONFIG.itemWeightKg,
      flatRate: Number(data.shipping_flat_rate) || DEFAULT_CONFIG.flatRate,
      handlingFeeType:
        (data.shipping_handling_fee_type as 'flat' | 'pct') ||
        DEFAULT_CONFIG.handlingFeeType,
      handlingFeeValue: Number(data.shipping_handling_fee_value) || 0,
    };
  } catch (e: any) {
    console.error('[easyship] getShippingConfig threw:', e?.message ?? e);
    return DEFAULT_CONFIG;
  }
}

// ---------- Courier whitelist & handling fee ----------

/**
 * The only couriers a shipment is ever booked with. Matched against Easyship's
 * `umbrella_name` ("UPS", "Canada Post"), lower-cased; `\s*` so "CanadaPost"
 * matches too.
 */
export const ALLOWED_COURIERS = ['ups', 'canada post'] as const;

const ALLOWED_COURIER_PATTERNS = [/\bups\b/, /\bcanada\s*post\b/];

export function isAllowedCourier(rate: { courier_name?: string | null }): boolean {
  const name = (rate.courier_name || '').toLowerCase();
  return ALLOWED_COURIER_PATTERNS.some((re) => re.test(name));
}

/** Carrier rate plus the configured processing fee. See lib/shipping/processing-fee.ts. */
export function applyHandlingFee(cost: number, config: ShippingConfig): number {
  return applyProcessingFee(cost, config);
}

// ---------- Rates ----------

// Build the nested request body the EasyShip 2024-09 /rates endpoint expects.
// The previous flat shape (origin_postal_code / boxes[] at the top level) is
// not a valid rates request on any current API version, so every quote threw
// and checkout silently fell back to the flat rate.
function buildRatesBody(payload: EasyshipRateRequest) {
  const quantity = Math.max(1, Math.round(Number(payload.quantity) || 1));
  const dimensions = parcelDimensions(payload.boxes?.[0]);
  // total_actual_weight is the whole parcel; Easyship's item weight is per unit.
  const unitWeight = Math.max(
    (Number(payload.total_actual_weight) || 0) / quantity,
    MIN_UNIT_WEIGHT_KG,
  );
  return {
    origin_address: {
      country_alpha2: payload.origin_country_alpha2,
      postal_code: payload.origin_postal_code,
      ...(payload.origin_state ? { state: payload.origin_state } : {}),
      ...(payload.origin_city ? { city: payload.origin_city } : {}),
    },
    destination_address: {
      country_alpha2: payload.destination_country_alpha2,
      postal_code: payload.destination_postal_code,
      ...(payload.destination_city ? { city: payload.destination_city } : {}),
      ...(payload.destination_state ? { state: payload.destination_state } : {}),
    },
    incoterms: 'DDU',
    insurance: { is_insured: false },
    courier_settings: { show_courier_logo_url: false, apply_shipping_rules: true },
    shipping_settings: { units: { weight: 'kg', dimensions: 'cm' } },
    // 2024-09 requires parcels[].items[]. The quote describes the same single
    // supplements line the shipment is created with (see "Parcel contents"):
    // the real unit count, a declared value of 1 per unit, and the configured
    // box with each blank side at 1 cm.
    parcels: [
      {
        items: [
          {
            hs_code: SUPPLEMENTS_HS_CODE,
            quantity,
            actual_weight: unitWeight,
            declared_currency: payload.declared_currency ?? 'CAD',
            declared_customs_value: DECLARED_UNIT_VALUE,
            dimensions,
          },
        ],
      },
    ],
  };
}

export async function fetchEasyshipRates(
  payload: EasyshipRateRequest,
  apiKey?: string,
): Promise<EasyshipRate[]> {
  const res = await fetch(`${EASYSHIP_BASE}/rates`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify(buildRatesBody(payload)),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Easyship rates error ${res.status}: ${text}`);
  }

  const json = await res.json();
  return (json.rates ?? []).map((r: any): EasyshipRate => {
    // 2024-09 nests the courier under `courier_service` (no top-level
    // courier_name/courier_id). Use the per-service `id` as our courier_id so
    // distinct UPS/FedEx services don't collide (they share one courier_id),
    // and `umbrella_name` for the whitelist/brand display.
    const cs = r.courier_service ?? {};
    // Total may live at top level or under shipment_charge_total; take the
    // first real number. total_charge includes taxes/surcharges.
    const total = [
      r.total_charge,
      r.shipment_charge_total,
      r.shipment_charge,
    ].find((v) => typeof v === 'number');
    return {
      courier_id: cs.id ?? cs.courier_id ?? r.courier_id ?? '',
      courier_name: cs.umbrella_name ?? cs.name ?? r.courier_name ?? '',
      service_name: cs.name ?? r.full_description ?? r.service_name ?? '',
      min_delivery_time: r.min_delivery_time ?? 0,
      max_delivery_time: r.max_delivery_time ?? 0,
      total_charge: Number(total ?? 0),
      currency: r.currency ?? 'CAD',
      tracking_rating: r.tracking_rating ?? 0,
    };
  });
}

export async function getCheapestEasyshipRate(
  payload: EasyshipRateRequest,
  apiKey?: string,
): Promise<EasyshipRate | null> {
  const rates = (await fetchEasyshipRates(payload, apiKey)).filter(isAllowedCourier);
  if (rates.length === 0) return null;
  return rates.sort((a, b) => a.total_charge - b.total_charge)[0];
}

export async function resolveShippingCost(
  payload: EasyshipRateRequest,
  config?: ShippingConfig,
): Promise<{ cost: number; rate: EasyshipRate | null; usedFallback: boolean }> {
  const cfg = config ?? (await getShippingConfig());
  if (!cfg.enabled || !cfg.apiKey) {
    return { cost: cfg.flatRate, rate: null, usedFallback: true };
  }
  try {
    const rate = await getCheapestEasyshipRate(payload, cfg.apiKey);
    if (!rate) return { cost: cfg.flatRate, rate: null, usedFallback: true };
    return {
      cost: applyHandlingFee(rate.total_charge, cfg),
      rate,
      usedFallback: false,
    };
  } catch {
    return { cost: cfg.flatRate, rate: null, usedFallback: true };
  }
}

export async function getShippingQuoteOrFallback(
  payload: EasyshipRateRequest,
): Promise<EasyshipRate[]> {
  const cfg = await getShippingConfig();
  if (!cfg.enabled || !cfg.apiKey) return [];
  try {
    return (await fetchEasyshipRates(payload, cfg.apiKey))
      .filter(isAllowedCourier)
      .map((r) => ({ ...r, total_charge: applyHandlingFee(r.total_charge, cfg) }))
      .sort((a, b) => a.total_charge - b.total_charge);
  } catch (e: any) {
    // Don't break checkout — fall back to flat rate — but log the real reason
    // so a misconfigured payload/version/token is visible in server logs.
    console.error('[easyship] rate quote failed:', e?.message ?? e);
    return [];
  }
}

// ---------- Shipments ----------

export async function createEasyshipShipment(
  payload: EasyshipShipmentRequest,
  apiKey?: string,
): Promise<EasyshipShipmentResponse> {
  const res = await fetch(`${EASYSHIP_BASE}/shipments`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({
      // 2024-09 address schema: line_1 + contact_name/phone/email (origin also
      // requires company_name). contact_email/contact_phone are omitted when
      // empty — Easyship rejects an empty string as an invalid email format.
      origin_address: {
        line_1: payload.origin.address,
        city: payload.origin.city,
        ...(payload.origin.state ? { state: payload.origin.state } : {}),
        postal_code: payload.origin.postal_code,
        country_alpha2: payload.origin.country_alpha2,
        contact_name: payload.origin.name,
        company_name: payload.origin.company || payload.origin.name,
        ...(payload.origin.phone ? { contact_phone: payload.origin.phone } : {}),
        ...(payload.origin.email ? { contact_email: payload.origin.email } : {}),
      },
      destination_address: {
        line_1: payload.destination.address,
        city: payload.destination.city,
        state: payload.destination.state,
        postal_code: payload.destination.postalCode,
        country_alpha2: payload.destination.country_alpha2,
        contact_name:
          [payload.destination.firstName, payload.destination.lastName]
            .filter(Boolean)
            .join(' ')
            .trim() || payload.destination.firstName,
        // Easyship rejects a shipment whose destination has no contact phone
        // ("destination_address.contact_phone can't be blank", 422). Plenty of
        // addresses reach us without one — a Stealth Health hand-off reports whatever
        // the buyer typed — so fall back to the house number we already send as
        // the sender's, which is a real number a courier can call.
        ...(payload.destination.phone?.trim() || payload.origin.phone?.trim()
          ? {
              contact_phone:
                payload.destination.phone?.trim() || payload.origin.phone!.trim(),
            }
          : {}),
        ...(payload.destination.email ? { contact_email: payload.destination.email } : {}),
      },
      incoterms: 'DDU',
      insurance: { is_insured: !!payload.insured },
      // 2024-09 selects the courier via courier_settings.courier_service_id
      // (the renamed selected_courier_id/courier_selection). Sent only when a
      // courier was chosen; otherwise Easyship assigns the best-value courier.
      // handover_method is a top-level courier_settings knob when supplied —
      // most accounts default to 'dropoff' so we only include it when the
      // admin chose something explicit.
      ...(payload.selected_courier_id || payload.handover
        ? {
            courier_settings: {
              ...(payload.selected_courier_id
                ? {
                    courier_service_id: payload.selected_courier_id,
                    allow_fallback: false,
                    apply_shipping_rules: false,
                  }
                : {}),
              ...(payload.handover ? { handover_method: payload.handover } : {}),
            },
          }
        : {}),
      shipping_settings: {
        units: { weight: 'kg', dimensions: 'cm' },
        output_currency: 'CAD',
        // Draft only — never buy/charge a label at creation.
        buy_label: false,
        buy_label_synchronous: false,
      },
      // 2024-09 ParcelCreate does NOT accept item fields directly on the
      // parcel — they live on parcels[].items[], with the parcel carrying box
      // dims + total_actual_weight. One supplements line per parcel: the real
      // unit count, a declared value of 1 per unit, and each blank box side at
      // 1 cm (see "Parcel contents" above).
      parcels: payload.parcels.map((p) => {
        const quantity = Math.max(1, Math.round(Number(p.quantity) || 1));
        const unitWeight = Math.max(Number(p.actual_weight) || 0, MIN_UNIT_WEIGHT_KG);
        const dimensions = parcelDimensions(p);
        return {
          box: dimensions,
          total_actual_weight: Number((unitWeight * quantity).toFixed(3)),
          items: [
            {
              description: PARCEL_ITEM_DESCRIPTION,
              hs_code: SUPPLEMENTS_HS_CODE,
              quantity,
              actual_weight: unitWeight,
              declared_currency: p.declared_currency || 'CAD',
              declared_customs_value: DECLARED_UNIT_VALUE,
              dimensions,
            },
          ],
        };
      }),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Easyship shipment error ${res.status}: ${text}`);
  }

  const json = await res.json();
  const d = normalizeEasyshipShipment(json.shipment);
  return {
    easyship_shipment_id: d.easyship_shipment_id,
    tracking_number: d.tracking_number,
    label_url: d.label_url,
    courier_name: d.carrier,
    total_charge: d.total_charge,
    currency: d.currency,
  };
}

// ---------- Shipment details (the record mirrored onto the invoice) ----------

/** Everything worth keeping from an Easyship shipment, flattened. */
export interface EasyshipShipmentDetails {
  easyship_shipment_id: string;
  label_state: 'not_created' | 'pending' | 'generated' | 'failed';
  label_url: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  tracking_status: string | null;
  /** Courier brand, e.g. "UPS" / "Canada Post". */
  carrier: string | null;
  /** Service, e.g. "UPS Express Saver" / "Canada Post Xpresspost". */
  service_name: string | null;
  courier_service_id: string | null;
  /** What the label cost on the Easyship account. */
  total_charge: number | null;
  currency: string | null;
  min_delivery_days: number | null;
  max_delivery_days: number | null;
  /** When Easyship says the label was generated, if it says. */
  label_generated_at: string | null;
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/**
 * Flatten an Easyship shipment object. Field placement differs between API
 * versions and between "just created" and "label bought" shipments, so each
 * value is probed in the places it has been seen and the first real one wins.
 */
export function normalizeEasyshipShipment(shipment: any): EasyshipShipmentDetails {
  const s = shipment ?? {};
  const cs = s.courier_service ?? s.courier ?? s.selected_courier ?? {};
  const rate = (Array.isArray(s.rates) ? s.rates[0] : null) ?? s.selected_rate ?? {};
  const trackings = Array.isArray(s.trackings) ? s.trackings : [];
  // shipping_documents is an array of { category, url, ... } on current
  // versions; older payloads used an object with label_url.
  const docs = s.shipping_documents;
  const labelDoc = Array.isArray(docs)
    ? docs.find((d: any) => String(d?.category ?? '').toLowerCase() === 'label')
    : null;
  const labelUrl =
    str(s.label_url) ??
    str(labelDoc?.url) ??
    str(docs?.label_url) ??
    str(s.label?.url);

  const rawState = String(s.label_state ?? s.label_status ?? '').toLowerCase();
  let labelState: EasyshipShipmentDetails['label_state'] = labelUrl ? 'generated' : 'not_created';
  if (rawState === 'generated' || rawState === 'printed') labelState = 'generated';
  if (rawState === 'pending' || rawState === 'processing') labelState = labelUrl ? 'generated' : 'pending';
  if (rawState === 'failed' || rawState === 'error') labelState = 'failed';

  return {
    easyship_shipment_id: str(s.easyship_shipment_id) ?? str(s.id) ?? '',
    label_state: labelState,
    label_url: labelUrl,
    tracking_number:
      str(s.tracking_number) ??
      str(trackings[0]?.tracking_number) ??
      str(s.last_mile_tracking_number),
    tracking_url: str(s.tracking_page_url) ?? str(s.tracking_url),
    tracking_status:
      str(s.tracking_status) ??
      str(trackings[0]?.tracking_state) ??
      str(s.delivery_state) ??
      null,
    carrier:
      str(cs.umbrella_name) ?? str(s.courier_name) ?? str(rate.courier_service?.umbrella_name) ?? str(cs.name),
    service_name: str(cs.name) ?? str(rate.courier_service?.name) ?? str(rate.full_description),
    courier_service_id: str(cs.id) ?? str(rate.courier_service?.id),
    total_charge:
      num(rate.total_charge) ?? num(s.total_charge) ?? num(rate.shipment_charge_total),
    currency: str(rate.currency) ?? str(s.currency),
    min_delivery_days: num(rate.min_delivery_time) ?? num(s.min_delivery_time),
    max_delivery_days: num(rate.max_delivery_time) ?? num(s.max_delivery_time),
    label_generated_at:
      str(s.label_generated_at) ?? str(s.label_paid_at) ?? str(labelDoc?.created_at),
  };
}

/** Read one shipment off Easyship, flattened. Throws on an API error. */
export async function getEasyshipShipmentDetails(
  easyshipShipmentId: string,
  apiKey?: string,
): Promise<EasyshipShipmentDetails> {
  const res = await fetch(`${EASYSHIP_BASE}/shipments/${easyshipShipmentId}`, {
    headers: headers(apiKey),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Easyship shipment read error ${res.status}: ${text}`);
  }
  const json = await res.json();
  return normalizeEasyshipShipment(json.shipment);
}

// ---------- List shipments (for the sync dialog) ----------

export interface EasyshipShipmentSummary {
  easyship_shipment_id: string;
  tracking_number: string | null;
  label_url: string | null;
  courier_name: string | null;
  destination_name: string | null;
  created_at: string | null;
  status: string | null;
}

/**
 * List shipments created on or after `sinceIso` (a date or full ISO string).
 * Powers the admin Easyship-sync dialog: fetch a day's shipments and match
 * them to invoices by normalized customer name.
 *
 * Uses the 2024-09 GET /shipments endpoint. Easyship paginates via
 * `next_page`; we walk it (bounded) so a busy day still returns every match.
 */
export async function listEasyshipShipments(
  sinceIso: string,
  apiKey?: string,
): Promise<EasyshipShipmentSummary[]> {
  const out: EasyshipShipmentSummary[] = [];
  let page: string | null = String(
    new URLSearchParams({ created_after: sinceIso, per_page: '100' }),
  );
  // Cap at ~10 pages (1,000 shipments) to keep a runaway response from
  // blocking the admin UI — the sync dialog only shows one day at a time.
  for (let i = 0; page && i < 10; i++) {
    const res: Response = await fetch(`${EASYSHIP_BASE}/shipments?${page}`, {
      headers: headers(apiKey),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Easyship list shipments error ${res.status}: ${text}`);
    }
    const json: any = await res.json();
    for (const s of json.shipments ?? []) {
      const dest = s.destination_address ?? {};
      out.push({
        easyship_shipment_id: s.easyship_shipment_id ?? s.id ?? '',
        tracking_number: s.tracking_number ?? null,
        label_url:
          s.label_url ??
          s.shipping_documents?.label_url ??
          s.label?.url ??
          null,
        courier_name: s.courier_name ?? s.selected_courier?.name ?? null,
        destination_name:
          dest.contact_name ??
          ([dest.first_name, dest.last_name].filter(Boolean).join(' ').trim() ||
            null),
        created_at: s.created_at ?? null,
        status: s.status ?? s.label_state ?? null,
      });
    }
    // Pagination shapes vary between EasyShip API versions — accept the two
    // common ones and stop the moment we don't see a next page.
    const meta = json.meta ?? {};
    const nextUrl: string | null = json.next_page ?? meta.next_page ?? null;
    if (nextUrl) {
      // `next_page` may be a full URL; extract just the query for our fetch.
      const idx = nextUrl.indexOf('?');
      page = idx >= 0 ? nextUrl.slice(idx + 1) : null;
    } else {
      page = null;
    }
  }
  return out;
}

// ---------- Tracking ----------

export async function getEasyshipTracking(
  easyshipShipmentId: string,
  apiKey?: string,
): Promise<{
  status: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  carrier: string | null;
  checkpoints: Array<{
    message: string;
    occurred_at: string;
    location: string | null;
    primary_status: string | null;
  }>;
}> {
  // The 2024-09 API has NO `/shipments/{id}/tracking` sub-resource — it 404s
  // ("that request method and path combination isn't defined"). Detailed 3rd-
  // party checkpoints live behind Easyship's paid Trackings product. So read the
  // shipment object itself (the same endpoint the label lookup uses) and surface
  // whatever tracking state Easyship exposes on it. Live delivery status is also
  // pushed continuously by the Easyship webhook, which persists it to the order —
  // this on-demand read just pulls the latest immediately.
  const res = await fetch(
    `${EASYSHIP_BASE}/shipments/${easyshipShipmentId}`,
    { headers: headers(apiKey) },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Easyship tracking error ${res.status}: ${text}`);
  }

  const json = await res.json();
  const s = json.shipment ?? {};

  // Checkpoints are only present when the account has the tracking add-on;
  // probe the likely shapes and default to none.
  const rawCheckpoints =
    s.tracking?.checkpoints ?? s.trackings ?? s.checkpoints ?? [];

  return {
    status: s.tracking_status ?? s.tracking?.status ?? s.status ?? null,
    tracking_number: s.tracking_number ?? s.last_mile_tracking_number ?? null,
    tracking_url: s.tracking_page_url ?? s.tracking_url ?? null,
    carrier: s.courier_name ?? s.courier?.name ?? null,
    checkpoints: (Array.isArray(rawCheckpoints) ? rawCheckpoints : []).map((c: any) => {
      // Checkpoints carry either a pre-joined `location` string or discrete
      // city/state/country parts — normalize to one label for the journey
      // timeline. `primary_status` drives the stage progress bar.
      const location =
        c.location ||
        [c.city, c.state, c.country_alpha2 ?? c.country]
          .filter(Boolean)
          .join(', ');
      return {
        message: c.message ?? '',
        occurred_at: c.occurred_at ?? c.checkpoint_time ?? '',
        location: location || null,
        primary_status: c.primary_status ?? null,
      };
    }),
  };
}

// ---------- Labels (buy / poll / download) ----------

export interface EasyshipLabelInfo {
  state: 'not_created' | 'pending' | 'generated' | 'failed';
  url: string | null;
  tracking_number: string | null;
  carrier: string | null;
}

export async function getEasyshipShipmentLabel(
  easyshipShipmentId: string,
  apiKey?: string,
): Promise<EasyshipLabelInfo> {
  const res = await fetch(
    `${EASYSHIP_BASE}/shipments/${easyshipShipmentId}`,
    { headers: headers(apiKey) },
  );
  if (!res.ok) {
    return { state: 'failed', url: null, tracking_number: null, carrier: null };
  }
  const json = await res.json();
  return extractLabelInfo(json.shipment);
}

export function extractLabelInfo(shipment: any): EasyshipLabelInfo {
  if (!shipment) {
    return { state: 'not_created', url: null, tracking_number: null, carrier: null };
  }
  const d = normalizeEasyshipShipment(shipment);
  return {
    state: d.label_state,
    url: d.label_url,
    tracking_number: d.tracking_number,
    carrier: d.carrier,
  };
}

// Buy/confirm the shipping label for a shipment. In 2024-09 the label is bought
// via POST /shipments/{id}/label, which charges the account and confirms the
// courier already assigned to the shipment (set at creation via
// courier_settings). Generation is asynchronous, so we poll the shipment a few
// times for the label URL; the Easyship webhook also writes it back when ready.
export async function buyEasyshipLabel(
  easyshipShipmentId: string,
  apiKey?: string,
): Promise<EasyshipLabelInfo> {
  const res = await fetch(`${EASYSHIP_BASE}/shipments/${easyshipShipmentId}/label`, {
    method: 'POST',
    headers: headers(apiKey),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Easyship buy-label error ${res.status}: ${text}`);
  }

  // Poll for the generated label (best-effort; never throws on poll).
  let info = await getEasyshipShipmentLabel(easyshipShipmentId, apiKey).catch(
    () => ({ state: 'pending', url: null, tracking_number: null, carrier: null } as EasyshipLabelInfo),
  );
  for (let i = 0; i < 6 && !(info.state === 'generated' && info.url); i++) {
    await new Promise((r) => setTimeout(r, 1500));
    info = await getEasyshipShipmentLabel(easyshipShipmentId, apiKey).catch(() => info);
  }
  // If still not generated, report pending rather than failed — the webhook
  // will finalize it shortly and the admin can print once ready.
  if (info.state !== 'generated') info = { ...info, state: 'pending' };
  return info;
}

export async function fetchEasyshipDocument(
  url: string,
  apiKey?: string,
): Promise<{ blob: ArrayBuffer; contentType: string }> {
  // Some EasyShip label URLs are signed and public, others need auth.
  // Try with auth header first; fall back to plain GET on 401.
  let res = await fetch(url, { headers: headers(apiKey) });
  if (res.status === 401) res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Easyship label download error ${res.status}`);
  }
  return {
    blob: await res.arrayBuffer(),
    contentType: res.headers.get('content-type') || 'application/pdf',
  };
}

// ---------- Diagnose (config sanity check) ----------

export interface ShippingDiagnosis {
  ok: boolean;
  base_url: string;
  db_read_ok: boolean;
  settings_row_present: boolean;
  easyship_columns_present: boolean;
  enabled: boolean;
  has_api_key: boolean;
  origin_complete: boolean;
  reachable: boolean | null;
  errors: string[];
}

export async function diagnoseShipping(): Promise<ShippingDiagnosis> {
  const errors: string[] = [];

  // Step 1 — read the raw settings row directly so we can tell the difference
  // between "EasyShip is off" and "we couldn't read the config / the schema is
  // missing columns". This is the gap that made checkout silently fall back to
  // the flat rate even when the admin had enabled live rates.
  let db_read_ok = false;
  let settings_row_present = false;
  let easyship_columns_present = false;
  try {
    const { data, error } = await getSupabase()
      .from('site_settings')
      .select('*')
      .limit(1)
      .maybeSingle();
    if (error) {
      errors.push(`site_settings read error: ${error.message}`);
    } else {
      db_read_ok = true;
      settings_row_present = !!data;
      if (!data) {
        errors.push('site_settings has no row (run migration-site-settings.sql)');
      } else if (!('easyship_enabled' in data)) {
        errors.push(
          'easyship columns missing (run easyship-settings-migration.sql)',
        );
      } else {
        easyship_columns_present = true;
      }
    }
  } catch (e: any) {
    errors.push(`site_settings unreachable: ${e?.message ?? 'network'}`);
  }

  // Step 2 — resolved config (env-fallback applied).
  const cfg = await getShippingConfig();
  if (!cfg.enabled) errors.push('easyship_enabled is false');
  const has_api_key = !!cfg.apiKey;
  if (!has_api_key) errors.push('easyship_api_key missing (DB and env both empty)');
  const origin_complete = !!(
    cfg.origin.address && cfg.origin.city && cfg.origin.postal_code
  );
  if (!origin_complete) {
    errors.push('shipping_origin incomplete (address/city/postal)');
  }

  // Step 3 — live reachability against the configured base URL.
  let reachable: boolean | null = null;
  if (has_api_key) {
    try {
      // Cheap authenticated read that validates both the token and the base
      // URL/version without incurring a billable rate quote.
      const ping = await fetch(`${EASYSHIP_BASE}/couriers`, {
        headers: headers(cfg.apiKey),
      });
      reachable = ping.ok;
      if (!ping.ok) {
        errors.push(`EasyShip ping ${ping.status} (check token / base URL)`);
      }
    } catch (e: any) {
      reachable = false;
      errors.push(`EasyShip unreachable: ${e?.message ?? 'network'}`);
    }
  }

  return {
    ok: errors.length === 0,
    base_url: EASYSHIP_BASE,
    db_read_ok,
    settings_row_present,
    easyship_columns_present,
    enabled: cfg.enabled,
    has_api_key,
    origin_complete,
    reachable,
    errors,
  };
}
