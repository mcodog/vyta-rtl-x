/**
 * Choosing a courier for a shipment nobody picked a service for.
 *
 * Pure (no Easyship client, no Supabase) so the ranking can be unit-tested and
 * shared. The caller has already narrowed the quote to the allowed couriers
 * (UPS and Canada Post — `isAllowedCourier` in lib/easyship.ts).
 */

export type CourierPreference = 'best_value' | 'cheapest' | 'fastest' | 'ups' | 'canada_post';

export const COURIER_PREFERENCES: readonly CourierPreference[] = [
  'best_value',
  'cheapest',
  'fastest',
  'ups',
  'canada_post',
];

/** What every shipment books when nobody picked a service. */
export const DEFAULT_COURIER_PREFERENCE: CourierPreference = 'best_value';

/** The slowest a best-value service may be, in days (worst case). */
export const BEST_VALUE_MAX_DAYS = 2;

export interface PickableRate {
  courier_id: string;
  courier_name: string;
  total_charge: number;
  min_delivery_time?: number | null;
  max_delivery_time?: number | null;
}

/**
 * Transit time used to rank a rate. The worst case (max) leads so a "1–7 day"
 * service doesn't beat a flat "2 day" one; an unknown estimate sorts last
 * rather than first.
 */
export function deliveryDays(rate: PickableRate): number {
  const max = Number(rate.max_delivery_time) || 0;
  const min = Number(rate.min_delivery_time) || 0;
  return max > 0 ? max : min > 0 ? min : Number.POSITIVE_INFINITY;
}

const byPrice = (a: PickableRate, b: PickableRate) =>
  (Number(a.total_charge) || 0) - (Number(b.total_charge) || 0);

// Fastest first; the cheaper of two equally quick services wins.
const bySpeed = (a: PickableRate, b: PickableRate) =>
  deliveryDays(a) - deliveryDays(b) || byPrice(a, b);

const CARRIER_PATTERN: Record<'ups' | 'canada_post', RegExp> = {
  ups: /\bups\b/i,
  canada_post: /\bcanada\s*post\b/i,
};

/**
 * Pick one rate by preference. Never mutates `rates`.
 *
 *  - `best_value`: the cheapest service that arrives within
 *    BEST_VALUE_MAX_DAYS. When nothing on the lane is that quick, the fastest
 *    service on offer (cheapest among equals) — never a slow one just because
 *    it is cheap.
 *  - `cheapest` / `fastest`: as named.
 *  - `ups` / `canada_post`: that carrier's best-value service, falling back to
 *    the overall best value when the carrier isn't on offer.
 */
export function pickCourier<T extends PickableRate>(
  rates: readonly T[],
  pref: CourierPreference,
): T | null {
  if (rates.length === 0) return null;
  if (pref === 'fastest') return [...rates].sort(bySpeed)[0] ?? null;
  if (pref === 'cheapest') return [...rates].sort(byPrice)[0] ?? null;
  if (pref === 'best_value') return bestValue(rates);
  const re = CARRIER_PATTERN[pref];
  const carrier = re ? rates.filter((r) => re.test(r.courier_name || '')) : [];
  return bestValue(carrier) ?? bestValue(rates);
}

function bestValue<T extends PickableRate>(rates: readonly T[]): T | null {
  const quick = rates.filter((r) => deliveryDays(r) <= BEST_VALUE_MAX_DAYS);
  if (quick.length > 0) return [...quick].sort(byPrice)[0] ?? null;
  return [...rates].sort(bySpeed)[0] ?? null;
}
