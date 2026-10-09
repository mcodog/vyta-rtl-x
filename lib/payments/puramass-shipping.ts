/**
 * Shipping for the Stealth Health hosted checkout.
 *
 * Stealth Health now accepts a `shipping_total_cents` on the order it creates, so the
 * shipping the buyer pays is ours to decide instead of a flat fee we could only
 * guess at. This module holds the rules for deciding it:
 *
 *   • which couriers a buyer may choose from (UPS / Canada Post),
 *   • which of the returned services are worth showing (the fastest handful),
 *   • what each one costs once the admin's processing fee is folded in,
 *   • the flat fallback used when live rates are switched off or the quote
 *     comes back empty,
 *   • and how far a cart is toward the free-shipping threshold.
 *
 * Everything here is pure so the ranking can be unit-tested — and so the
 * checkout screen can import the same constants and types without dragging the
 * server-only Easyship client into the browser bundle. The Easyship call itself
 * lives in lib/easyship.ts and the quote endpoint in
 * app/api/checkout/puramass/rates.
 *
 * The processing fee is the SAME site setting the storefront's own shipping
 * uses (`shipping_handling_fee_type` / `shipping_handling_fee_value`, surfaced
 * in Site Settings as "Processing fee"). It defaults to zero, is folded into
 * the quoted price, and is never itemised for the buyer.
 */
import type { EasyshipRate } from '@/lib/types/ecommerce';
import { applyProcessingFee, type ProcessingFee } from '@/lib/shipping/processing-fee';
import { DEFAULT_FLAT_SHIPPING } from '@/lib/payments/puramass-settings';

/**
 * The courier id the buyer sends back when they picked the flat option. Not an
 * Easyship id — the checkout recognises it and skips the rate lookup, so the
 * flow never dead-ends because a live quote couldn't be had.
 */
export const PURAMASS_FLAT_COURIER_ID = 'flat';

/** How many live options the buyer is offered. */
export const PURAMASS_RATE_LIMIT = 5;

/**
 * Couriers a hosted-checkout buyer may pick — the same two every shipment is
 * booked with (`ALLOWED_COURIERS` in lib/easyship.ts): UPS and Canada Post.
 *
 * Matched against Easyship's `umbrella_name` ("UPS", "Canada Post"),
 * lower-cased. `\b` on both ends so "Canada Post" doesn't also match some
 * other courier that merely mentions Canada.
 */
export const PURAMASS_COURIERS = ['ups', 'canada post'] as const;

export function isHostedCourier(rate: { courier_name?: string | null }): boolean {
  const name = (rate.courier_name || '').toLowerCase();
  return PURAMASS_COURIERS.some((c) => new RegExp(`\\b${c}\\b`).test(name));
}

/** One shipping option as the checkout screen sees it. */
export interface HostedShippingRate {
  /** Easyship courier_service id, or `PURAMASS_FLAT_COURIER_ID`. */
  courier_id: string;
  courier_name: string;
  service_name: string;
  min_delivery_time: number;
  max_delivery_time: number;
  /** CAD, processing fee already folded in. Never itemised for the buyer. */
  total_charge: number;
  currency: string;
}

/**
 * The flat option, shown whenever live rates aren't available. `amount` is the
 * configured fee in CAD (`site_settings.puramass_flat_shipping`) — passed in
 * rather than baked in so the price can be changed without a deploy.
 */
export function flatHostedRate(amount: number = DEFAULT_FLAT_SHIPPING): HostedShippingRate {
  const charge = Number(amount);
  return {
    courier_id: PURAMASS_FLAT_COURIER_ID,
    courier_name: 'Standard shipping',
    service_name: 'Tracked delivery',
    min_delivery_time: 0,
    max_delivery_time: 0,
    total_charge: Number.isFinite(charge) && charge >= 0 ? charge : DEFAULT_FLAT_SHIPPING,
    currency: 'CAD',
  };
}

/**
 * Zero out a rate the buyer has earned free shipping on.
 *
 * The courier they picked is kept intact — a parcel still has to travel by
 * something, and the shipment booked later needs to know which service — only
 * the price they pay for it goes to zero.
 */
export function freeHostedRate(rate: HostedShippingRate): HostedShippingRate {
  return { ...rate, total_charge: 0 };
}

/**
 * How far a cart is toward free shipping, for the progress bar. Returns null
 * when there is no promo to show.
 *
 * `remaining` is what still has to be added, rounded up to the cent so the bar
 * never says "$0.00 to go" while the threshold is a fraction away.
 */
export function freeShippingProgress(
  subtotal: number,
  threshold: number,
): { pct: number; remaining: number; unlocked: boolean } | null {
  const target = Number(threshold);
  if (!Number.isFinite(target) || target <= 0) return null;
  const spent = Math.max(0, Number(subtotal) || 0);
  const remaining = Math.max(0, Math.ceil((target - spent) * 100) / 100);
  return {
    pct: Math.max(0, Math.min(100, (spent / target) * 100)),
    remaining,
    unlocked: remaining <= 0,
  };
}

/** An unknown/zero delivery estimate sorts last rather than first. */
function speed(rate: EasyshipRate): number {
  const max = Number(rate.max_delivery_time) || 0;
  const min = Number(rate.min_delivery_time) || 0;
  return max > 0 ? max : min > 0 ? min : Number.POSITIVE_INFINITY;
}

/**
 * Turn a raw Easyship quote into the options the buyer picks from: only the
 * whitelisted couriers, fastest first, capped at `PURAMASS_RATE_LIMIT`, each
 * priced with the processing fee folded in.
 *
 * Ties on speed break on price, so the cheapest of two equally quick services
 * leads. Rounded to cents here rather than at render time — this number is
 * what gets charged, so the buyer must never see one figure and pay another.
 */
export function rankHostedRates(
  rates: EasyshipRate[],
  fee: ProcessingFee,
  limit: number = PURAMASS_RATE_LIMIT,
): HostedShippingRate[] {
  return rates
    .filter(isHostedCourier)
    .map((r) => ({
      courier_id: String(r.courier_id ?? ''),
      courier_name: r.courier_name ?? '',
      service_name: r.service_name ?? '',
      min_delivery_time: Number(r.min_delivery_time) || 0,
      max_delivery_time: Number(r.max_delivery_time) || 0,
      total_charge: Math.round(applyProcessingFee(Number(r.total_charge) || 0, fee) * 100) / 100,
      currency: r.currency || 'CAD',
      _speed: speed(r),
    }))
    .filter((r) => r.courier_id && r.total_charge > 0)
    .sort((a, b) => a._speed - b._speed || a.total_charge - b.total_charge)
    .slice(0, Math.max(1, limit))
    .map(({ _speed, ...rate }) => rate);
}

/**
 * Pick the rate the buyer chose out of a fresh quote.
 *
 * The checkout re-quotes at hand-off rather than trusting the amount the
 * browser sends back: shipping is money, and the only price we can safely
 * charge is one Easyship has just confirmed. A `courier_id` that is no longer
 * on offer returns null so the caller can ask the buyer to pick again.
 */
export function selectHostedRate(
  rates: HostedShippingRate[],
  courierId: string | null | undefined,
): HostedShippingRate | null {
  const id = String(courierId ?? '').trim();
  if (!id) return null;
  const match = rates.find((r) => r.courier_id === id);
  if (match) return match;
  // The quote's own flat rate carries the configured fee; the bare default is
  // only a last resort when the quote didn't include one.
  if (id === PURAMASS_FLAT_COURIER_ID) return flatHostedRate();
  return null;
}

/**
 * Total parcel weight for a cart, in kg. `vials` is the whole cart counted in
 * single vials (a pack of 10 is 10 vials); Easyship rejects a weightless
 * shipment, so the result never drops below one item's worth.
 */
export function hostedParcelWeight(vials: number, perVialKg: number): number {
  const per = Number(perVialKg) > 0 ? Number(perVialKg) : 0.05;
  const count = Number(vials) > 0 ? Number(vials) : 0;
  return Math.max(per, Math.round(count * per * 1000) / 1000);
}

/** Human delivery estimate for a rate, e.g. "2–4 business days". */
export function deliveryEstimate(rate: HostedShippingRate): string | null {
  const min = rate.min_delivery_time;
  const max = rate.max_delivery_time;
  if (!min && !max) return null;
  if (!min || min === max) return `${max || min} business days`;
  if (!max) return `${min}+ business days`;
  return `${min}–${max} business days`;
}
