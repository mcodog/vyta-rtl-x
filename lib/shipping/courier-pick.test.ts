/**
 * Unit tests for picking a courier when nobody chose one.
 *
 * Run with a TS-aware loader, e.g.
 * `node --test --import tsx lib/shipping/courier-pick.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickCourier, deliveryDays, type PickableRate } from '@/lib/shipping/courier-pick';

const rate = (
  courier_id: string,
  courier_name: string,
  total_charge: number,
  min: number,
  max: number,
): PickableRate => ({
  courier_id,
  courier_name,
  total_charge,
  min_delivery_time: min,
  max_delivery_time: max,
});

const quote = [
  rate('ups-ground', 'UPS', 12, 3, 5),
  rate('cp-priority', 'Canada Post', 40, 1, 1),
  rate('ups-express', 'UPS', 35, 1, 1),
  rate('cp-xpresspost', 'Canada Post', 18, 1, 2),
  rate('cp-regular', 'Canada Post', 9, 4, 8),
];

test('best value: cheapest service that arrives within 2 days', () => {
  assert.equal(pickCourier(quote, 'best_value')?.courier_id, 'cp-xpresspost');
});

test('best value: a "1–3 day" service is over 2 days and is not picked', () => {
  const r = [rate('slow-cheap', 'UPS', 5, 1, 3), rate('quick', 'Canada Post', 20, 1, 2)];
  assert.equal(pickCourier(r, 'best_value')?.courier_id, 'quick');
});

test('best value: nothing within 2 days falls back to the fastest, not the cheapest', () => {
  const r = [rate('a', 'UPS', 10, 4, 7), rate('b', 'Canada Post', 30, 3, 3)];
  assert.equal(pickCourier(r, 'best_value')?.courier_id, 'b');
});

test('best value: unknown transit time never counts as within 2 days', () => {
  const r = [rate('unknown', 'UPS', 1, 0, 0), rate('known', 'Canada Post', 50, 2, 2)];
  assert.equal(pickCourier(r, 'best_value')?.courier_id, 'known');
});

test('fastest picks the quickest worst case, cheaper of equals', () => {
  assert.equal(pickCourier(quote, 'fastest')?.courier_id, 'ups-express');
});

test('fastest ranks by worst case, not best case', () => {
  const r = [rate('a', 'UPS', 10, 1, 7), rate('b', 'Canada Post', 20, 2, 2)];
  assert.equal(pickCourier(r, 'fastest')?.courier_id, 'b');
});

test('an unknown transit time sorts last, not first', () => {
  const r = [rate('unknown', 'UPS', 5, 0, 0), rate('known', 'Canada Post', 50, 4, 4)];
  assert.equal(pickCourier(r, 'fastest')?.courier_id, 'known');
});

test('cheapest and carrier preferences', () => {
  assert.equal(pickCourier(quote, 'cheapest')?.courier_id, 'cp-regular');
  assert.equal(pickCourier(quote, 'ups')?.courier_id, 'ups-express');
  assert.equal(pickCourier(quote, 'canada_post')?.courier_id, 'cp-xpresspost');
});

test('a carrier that is not on offer falls back to the overall best value', () => {
  const r = quote.filter((q) => q.courier_name !== 'UPS');
  assert.equal(pickCourier(r, 'ups')?.courier_id, 'cp-xpresspost');
});

test('does not mutate the quote, and an empty quote picks nothing', () => {
  const before = quote.map((r) => r.courier_id);
  pickCourier(quote, 'fastest');
  pickCourier(quote, 'best_value');
  assert.deepEqual(quote.map((r) => r.courier_id), before);
  assert.equal(pickCourier([], 'best_value'), null);
  assert.equal(deliveryDays(rate('x', 'UPS', 1, 0, 0)), Number.POSITIVE_INFINITY);
});
