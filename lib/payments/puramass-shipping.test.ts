/**
 * Unit tests for the hosted-checkout shipping rules.
 *
 * The repo has no test runner wired up, so these use Node's built-in
 * `node:test` + `node:assert` (zero dependencies). Run with a TS-aware loader,
 * e.g. `node --test --import tsx lib/payments/puramass-shipping.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { EasyshipRate } from '@/lib/types/ecommerce';
import {
  deliveryEstimate,
  flatHostedRate,
  freeHostedRate,
  freeShippingProgress,
  hostedParcelWeight,
  isHostedCourier,
  PURAMASS_FLAT_COURIER_ID,
  rankHostedRates,
  selectHostedRate,
} from './puramass-shipping';
import {
  DEFAULT_FLAT_SHIPPING,
  qualifiesForFreeShipping,
  shapeHostedShippingSettings,
} from './puramass-settings';

const NO_FEE = { handlingFeeType: 'flat' as const, handlingFeeValue: 0 };

function rate(over: Partial<EasyshipRate> & { courier_id: string }): EasyshipRate {
  return {
    courier_name: 'UPS',
    service_name: 'Express',
    min_delivery_time: 2,
    max_delivery_time: 3,
    total_charge: 20,
    currency: 'CAD',
    tracking_rating: 0,
    ...over,
  } as EasyshipRate;
}

// ---- Courier whitelist ----------------------------------------------------

test('only UPS and Canada Post are offered', () => {
  for (const courier_name of ['UPS', 'ups', 'Canada Post', 'canada post']) {
    assert.equal(isHostedCourier({ courier_name }), true, courier_name);
  }
  for (const courier_name of ['FedEx', 'DHL', 'Purolator', 'Canpar', 'Sendle', '']) {
    assert.equal(isHostedCourier({ courier_name }), false, courier_name);
  }
});

// ---- Ranking --------------------------------------------------------------

test('fastest services lead, capped at the top five', () => {
  const ranked = rankHostedRates(
    [
      rate({ courier_id: 'slow', max_delivery_time: 9 }),
      rate({ courier_id: 'quick', max_delivery_time: 1 }),
      rate({ courier_id: 'mid-a', max_delivery_time: 4 }),
      rate({ courier_id: 'mid-b', max_delivery_time: 5 }),
      rate({ courier_id: 'mid-c', max_delivery_time: 6 }),
      rate({ courier_id: 'mid-d', max_delivery_time: 7 }),
    ],
    NO_FEE,
  );
  assert.deepEqual(
    ranked.map((r) => r.courier_id),
    ['quick', 'mid-a', 'mid-b', 'mid-c', 'mid-d'],
  );
});

test('a tie on speed breaks on price', () => {
  const ranked = rankHostedRates(
    [
      rate({ courier_id: 'pricey', total_charge: 40 }),
      rate({ courier_id: 'cheap', total_charge: 18 }),
    ],
    NO_FEE,
  );
  assert.deepEqual(ranked.map((r) => r.courier_id), ['cheap', 'pricey']);
});

test('a service with no delivery estimate sorts last, not first', () => {
  const ranked = rankHostedRates(
    [
      rate({ courier_id: 'unknown', min_delivery_time: 0, max_delivery_time: 0 }),
      rate({ courier_id: 'known', max_delivery_time: 8 }),
    ],
    NO_FEE,
  );
  assert.deepEqual(ranked.map((r) => r.courier_id), ['known', 'unknown']);
});

test('non-whitelisted couriers and unusable rates are dropped', () => {
  const ranked = rankHostedRates(
    [
      rate({ courier_id: 'dhl', courier_name: 'DHL' }),
      rate({ courier_id: '', courier_name: 'UPS' }),
      rate({ courier_id: 'free', total_charge: 0 }),
      rate({ courier_id: 'keeper' }),
    ],
    NO_FEE,
  );
  assert.deepEqual(ranked.map((r) => r.courier_id), ['keeper']);
});

// ---- Processing fee -------------------------------------------------------

test('a flat processing fee is folded into the quoted price', () => {
  const [r] = rankHostedRates([rate({ courier_id: 'a', total_charge: 18.4 })], {
    handlingFeeType: 'flat',
    handlingFeeValue: 5,
  });
  assert.equal(r.total_charge, 23.4);
});

test('a percentage processing fee is folded in and rounded to cents', () => {
  const [r] = rankHostedRates([rate({ courier_id: 'a', total_charge: 18.4 })], {
    handlingFeeType: 'pct',
    handlingFeeValue: 10,
  });
  assert.equal(r.total_charge, 20.24);
});

test('no fee configured leaves the carrier rate untouched', () => {
  const [r] = rankHostedRates([rate({ courier_id: 'a', total_charge: 18.4 })], NO_FEE);
  assert.equal(r.total_charge, 18.4);
});

// ---- Selection ------------------------------------------------------------

test('the flat option resolves without a live quote', () => {
  const picked = selectHostedRate([], PURAMASS_FLAT_COURIER_ID);
  assert.equal(picked?.total_charge, DEFAULT_FLAT_SHIPPING);
  assert.deepEqual(picked, flatHostedRate());
});

test('the flat fee is whatever the admin configured', () => {
  assert.equal(flatHostedRate(18.5).total_charge, 18.5);
  assert.equal(flatHostedRate(0).total_charge, 0);
  // Nonsense falls back rather than charging NaN.
  assert.equal(flatHostedRate(Number.NaN).total_charge, DEFAULT_FLAT_SHIPPING);
  assert.equal(flatHostedRate(-5).total_charge, DEFAULT_FLAT_SHIPPING);
});

test('a courier no longer on offer resolves to null', () => {
  const rates = rankHostedRates([rate({ courier_id: 'a' })], NO_FEE);
  assert.equal(selectHostedRate(rates, 'a')?.courier_id, 'a');
  assert.equal(selectHostedRate(rates, 'gone'), null);
  assert.equal(selectHostedRate(rates, ''), null);
  assert.equal(selectHostedRate(rates, null), null);
});

// ---- Parcel weight --------------------------------------------------------

test('parcel weight scales with the cart and never reaches zero', () => {
  assert.equal(hostedParcelWeight(10, 0.05), 0.5);
  assert.equal(hostedParcelWeight(0, 0.05), 0.05);
  assert.equal(hostedParcelWeight(-3, 0.05), 0.05);
  assert.equal(hostedParcelWeight(3, 0), 0.15);
});

// ---- Delivery estimate ----------------------------------------------------

test('delivery estimates read naturally', () => {
  const base = flatHostedRate();
  assert.equal(deliveryEstimate(base), null);
  assert.equal(
    deliveryEstimate({ ...base, min_delivery_time: 2, max_delivery_time: 4 }),
    '2–4 business days',
  );
  assert.equal(
    deliveryEstimate({ ...base, min_delivery_time: 3, max_delivery_time: 3 }),
    '3 business days',
  );
  assert.equal(
    deliveryEstimate({ ...base, min_delivery_time: 0, max_delivery_time: 5 }),
    '5 business days',
  );
  assert.equal(
    deliveryEstimate({ ...base, min_delivery_time: 2, max_delivery_time: 0 }),
    '2+ business days',
  );
});

// ---- Free shipping --------------------------------------------------------

const PROMO = {
  puramass_shipping_rates_enabled: true,
  puramass_free_shipping_enabled: true,
  puramass_free_shipping_threshold: 300,
};

test('the promo needs live rates and a real threshold to count as on', () => {
  assert.equal(shapeHostedShippingSettings(PROMO).freeShippingEnabled, true);
  // Live rates off: the flat fee has no quote to waive, so the promo is off
  // however it is stored.
  assert.equal(
    shapeHostedShippingSettings({ ...PROMO, puramass_shipping_rates_enabled: false })
      .freeShippingEnabled,
    false,
  );
  assert.equal(
    shapeHostedShippingSettings({ ...PROMO, puramass_free_shipping_threshold: 0 })
      .freeShippingEnabled,
    false,
  );
  assert.equal(shapeHostedShippingSettings(null).freeShippingEnabled, false);
});

test('settings fall back to the pre-promo behaviour', () => {
  const s = shapeHostedShippingSettings(null);
  assert.equal(s.ratesEnabled, false);
  assert.equal(s.flatShipping, DEFAULT_FLAT_SHIPPING);
  assert.equal(s.freeShippingThreshold, 0);
  assert.equal(shapeHostedShippingSettings({ puramass_flat_shipping: 12 }).flatShipping, 12);
});

test('a cart qualifies at the threshold, not a cent below', () => {
  const s = shapeHostedShippingSettings(PROMO);
  assert.equal(qualifiesForFreeShipping(s, 299.99), false);
  assert.equal(qualifiesForFreeShipping(s, 300), true);
  assert.equal(qualifiesForFreeShipping(s, 1000), true);
  // Off means off, however big the cart.
  const off = shapeHostedShippingSettings({ ...PROMO, puramass_free_shipping_enabled: false });
  assert.equal(qualifiesForFreeShipping(off, 5000), false);
});

test('free shipping zeroes the price but keeps the courier', () => {
  const [rate] = rankHostedRates([rate2()], NO_FEE);
  const free = freeHostedRate(rate);
  assert.equal(free.total_charge, 0);
  assert.equal(free.courier_id, rate.courier_id);
  assert.equal(free.service_name, rate.service_name);
});

test('progress reports what is left to spend', () => {
  assert.equal(freeShippingProgress(0, 300)?.remaining, 300);
  assert.equal(freeShippingProgress(120, 300)?.remaining, 180);
  assert.equal(freeShippingProgress(120, 300)?.pct, 40);
  assert.equal(freeShippingProgress(300, 300)?.unlocked, true);
  assert.equal(freeShippingProgress(400, 300)?.pct, 100);
  assert.equal(freeShippingProgress(400, 300)?.remaining, 0);
  // A fraction short must not round down to "nothing to go".
  assert.equal(freeShippingProgress(299.994, 300)?.remaining, 0.01);
  assert.equal(freeShippingProgress(299.994, 300)?.unlocked, false);
  // No threshold, nothing to show.
  assert.equal(freeShippingProgress(50, 0), null);
});

/** A plain UPS rate, for the free-shipping cases above. */
function rate2() {
  return rate({ courier_id: 'ups-express', total_charge: 22.5 });
}
