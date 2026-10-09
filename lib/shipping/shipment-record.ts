/**
 * The Easyship shipment record as it is stored on an invoice / order row.
 *
 * Pure (no Easyship client, no Supabase) so the mapping can be unit-tested.
 * lib/shipping/label-generated.ts does the reading and writing.
 */

/** The flattened shipment, as lib/easyship.ts `normalizeEasyshipShipment` returns it. */
export interface ShipmentRecordSource {
  easyship_shipment_id: string;
  label_state: string | null;
  label_url: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  tracking_status: string | null;
  carrier: string | null;
  service_name: string | null;
  courier_service_id: string | null;
  total_charge: number | null;
  currency: string | null;
  min_delivery_days: number | null;
  max_delivery_days: number | null;
  label_generated_at: string | null;
}

/**
 * Columns every shipment-carrying row has had since
 * easyship-invoice-shipment-migration.sql. Only values Easyship actually
 * returned are written, so a sparse read never blanks what is stored.
 */
export function coreShipmentPatch(d: ShipmentRecordSource): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (d.easyship_shipment_id) patch.easyship_shipment_id = d.easyship_shipment_id;
  if (d.courier_service_id) patch.easyship_courier_id = d.courier_service_id;
  if (d.tracking_number) patch.tracking_number = d.tracking_number;
  if (d.tracking_url) patch.tracking_url = d.tracking_url;
  if (d.tracking_status) patch.tracking_status = d.tracking_status;
  if (d.carrier) patch.carrier = d.carrier;
  if (d.label_url) patch.label_url = d.label_url;
  if (d.label_state && d.label_state !== 'not_created') patch.label_state = d.label_state;
  return patch;
}

/**
 * The rest of the record (easyship-label-sync-migration.sql): service, what
 * the label cost, the delivery estimate and when it was synced. Written
 * separately so a database without those columns still gets the core patch.
 */
export function extendedShipmentPatch(
  d: ShipmentRecordSource,
  now: Date = new Date(),
): Record<string, unknown> {
  const patch: Record<string, unknown> = { easyship_synced_at: now.toISOString() };
  if (d.service_name) patch.shipping_service = d.service_name;
  if (d.total_charge != null) patch.shipping_label_cost = d.total_charge;
  if (d.currency) patch.shipping_label_currency = d.currency;
  if (d.min_delivery_days != null && d.min_delivery_days > 0) {
    patch.est_delivery_min_days = Math.round(d.min_delivery_days);
  }
  if (d.max_delivery_days != null && d.max_delivery_days > 0) {
    patch.est_delivery_max_days = Math.round(d.max_delivery_days);
  }
  // Only Easyship's own timestamp here; without one the caller stamps "now"
  // once, on a row that has none yet, so a later re-sync can't move it.
  if (d.label_state === 'generated' && d.label_generated_at) {
    patch.label_generated_at = d.label_generated_at;
  }
  return patch;
}

/** Shift a "YYYY-MM-DD" day forward by `days` working days (Mon–Fri). */
export function addBusinessDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  let left = Math.max(0, Math.round(days));
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return d.toISOString().slice(0, 10);
}

/**
 * The delivery window for the shipped email, from the courier's transit
 * estimate (working days) counted from the day the label was made. Null when
 * Easyship gave no estimate.
 */
export function estimatedDeliveryWindow(
  shippedDay: string,
  minDays: number | null | undefined,
  maxDays: number | null | undefined,
): { deliveryFrom: string | null; deliveryTo: string | null } | null {
  const min = Number(minDays) > 0 ? Number(minDays) : null;
  const max = Number(maxDays) > 0 ? Number(maxDays) : null;
  if (min == null && max == null) return null;
  return {
    deliveryFrom: addBusinessDays(shippedDay, min ?? max!),
    deliveryTo: addBusinessDays(shippedDay, max ?? min!),
  };
}
