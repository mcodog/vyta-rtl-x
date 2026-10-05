/**
 * Unit tests for affiliate discount codes.
 *
 * `evaluateDiscountCode` decides how much comes off a real order, so the
 * boundaries are what is pinned: the window, the usage limit, the minimum,
 * self-use, and a fixed amount converted to the percentage the hosted
 * checkout can actually apply.
 *
 * Node's built-in runner, like the sibling suites. Run with a TS-aware loader:
 *   node --test --import tsx lib/affiliate/discount-codes.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeDiscount,
  eligibleSubtotal,
  evaluateDiscountCode,
  hasRestrictions,
  normalizeDiscountCode,
  normalizeProductIds,
  shapeDiscountCodeInput,
  shapeDiscountCodeRow,
  withoutRestrictions,
} from './discount-codes';
import { MAX_DISCOUNT_PERCENT } from '../promos/cart-offer';

const NOW = Date.parse('2026-09-23T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const base = {
  discount_type: 'percent' as const,
  discount_value: 15,
  min_subtotal: null,
  max_uses: null,
  starts_at: null,
  expires_at: null,
  active: true,
  affiliate_id: 'aff-1',
};

const ctx = { subtotal: 200, usesCount: 0, now: NOW };

test('codes are normalised the way they are compared', () => {
  assert.equal(normalizeDiscountCode(' spring-20 '), 'SPRING20');
  assert.equal(normalizeDiscountCode(null), '');
});

test('a live percentage code applies its percentage', () => {
  assert.deepEqual(evaluateDiscountCode(base, ctx), { ok: true, percent: 15 });
});

test('inactive, not-yet-started and expired codes are refused', () => {
  assert.deepEqual(evaluateDiscountCode({ ...base, active: false }, ctx), { ok: false, reason: 'inactive' });
  assert.deepEqual(
    evaluateDiscountCode({ ...base, starts_at: new Date(NOW + HOUR).toISOString() }, ctx),
    { ok: false, reason: 'not-started' },
  );
  assert.deepEqual(
    evaluateDiscountCode({ ...base, expires_at: new Date(NOW).toISOString() }, ctx),
    { ok: false, reason: 'expired' },
  );
  assert.equal(
    evaluateDiscountCode({ ...base, expires_at: new Date(NOW + HOUR).toISOString() }, ctx).ok,
    true,
  );
});

test('the usage limit is a cap on paid uses', () => {
  assert.equal(evaluateDiscountCode({ ...base, max_uses: 3 }, { ...ctx, usesCount: 2 }).ok, true);
  assert.deepEqual(
    evaluateDiscountCode({ ...base, max_uses: 3 }, { ...ctx, usesCount: 3 }),
    { ok: false, reason: 'used-up' },
  );
});

test('the minimum is measured against the list subtotal', () => {
  const code = { ...base, min_subtotal: 150 };
  assert.equal(evaluateDiscountCode(code, { ...ctx, subtotal: 150 }).ok, true);
  assert.deepEqual(evaluateDiscountCode(code, { ...ctx, subtotal: 149.99 }), {
    ok: false,
    reason: 'below-minimum',
  });
});

test('an affiliate cannot use their own code', () => {
  assert.deepEqual(evaluateDiscountCode(base, { ...ctx, customerId: 'aff-1' }), {
    ok: false,
    reason: 'own-code',
  });
  assert.equal(evaluateDiscountCode(base, { ...ctx, customerId: 'someone-else' }).ok, true);
});

test('a fixed amount becomes a percentage of the subtotal', () => {
  const fixed = { ...base, discount_type: 'fixed' as const, discount_value: 20 };
  assert.deepEqual(evaluateDiscountCode(fixed, { ...ctx, subtotal: 200 }), { ok: true, percent: 10 });
  assert.deepEqual(evaluateDiscountCode(fixed, { ...ctx, subtotal: 300 }), { ok: true, percent: 6.67 });
});

test('a fixed amount larger than the cart is capped, never a free order', () => {
  const fixed = { ...base, discount_type: 'fixed' as const, discount_value: 500 };
  assert.deepEqual(evaluateDiscountCode(fixed, { ...ctx, subtotal: 100 }), {
    ok: true,
    percent: MAX_DISCOUNT_PERCENT,
  });
});

test('describeDiscount reads the way the admin typed it', () => {
  assert.equal(describeDiscount({ discount_type: 'percent', discount_value: 15 }), '15% off');
  assert.equal(describeDiscount({ discount_type: 'fixed', discount_value: 20 }), '$20.00 off');
});

test('admin input is validated and normalised', () => {
  const good = shapeDiscountCodeInput({
    code: 'podcast-15',
    discount_type: 'percent',
    discount_value: '15',
    commission_rate: '12.5',
    max_uses: '',
    affiliate_id: ' aff-1 ',
  });
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.value.code, 'PODCAST15');
    assert.equal(good.value.discount_value, 15);
    assert.equal(good.value.commission_rate, 12.5);
    assert.equal(good.value.max_uses, null);
    assert.equal(good.value.affiliate_id, 'aff-1');
    assert.equal(good.value.active, true);
  }

  assert.equal(shapeDiscountCodeInput({ code: 'AB', discount_value: 10 }).ok, false);
  assert.equal(shapeDiscountCodeInput({ code: 'SAVE', discount_value: 0 }).ok, false);
  assert.equal(shapeDiscountCodeInput({ code: 'SAVE', discount_value: 100 }).ok, false);
  assert.equal(
    shapeDiscountCodeInput({ code: 'SAVE', discount_type: 'fixed', discount_value: 100 }).ok,
    true,
  );
  assert.equal(shapeDiscountCodeInput({ code: 'SAVE', discount_value: 10, commission_rate: 101 }).ok, false);
  assert.equal(
    shapeDiscountCodeInput({
      code: 'SAVE',
      discount_value: 10,
      starts_at: '2026-10-01',
      expires_at: '2026-09-01',
    }).ok,
    false,
  );
});

// ---------------------------------------------------------------------------
// First-order-only codes and product exclusions (landing-pages-migration.sql)
// ---------------------------------------------------------------------------

const BAC = '22222222-2222-4222-8222-222222222222';
const PEPTIDE = '33333333-3333-4333-8333-333333333333';

test('a first-order-only code is refused to anyone who has ordered', () => {
  const code = { ...base, first_order_only: true };
  assert.deepEqual(evaluateDiscountCode(code, { ...ctx, firstOrder: 'first' }), { ok: true, percent: 15 });
  assert.deepEqual(evaluateDiscountCode(code, { ...ctx, firstOrder: 'ordered' }), {
    ok: false,
    reason: 'first-order-only',
  });
  // A read that failed is not a yes.
  assert.deepEqual(evaluateDiscountCode(code, { ...ctx, firstOrder: 'unknown' }), {
    ok: false,
    reason: 'first-order-unverified',
  });
});

test('a first-order check that has not happened yet is deferred, not failed', () => {
  // A guest previewing before typing an email. The hand-off always passes it.
  const code = { ...base, first_order_only: true };
  assert.deepEqual(evaluateDiscountCode(code, ctx), { ok: true, percent: 15 });
});

test('a code that is not first-order-only ignores order history', () => {
  assert.deepEqual(evaluateDiscountCode(base, { ...ctx, firstOrder: 'ordered' }), { ok: true, percent: 15 });
});

test('the eligible subtotal leaves excluded products out', () => {
  const lines = [
    { productId: PEPTIDE, amount: 150 },
    { productId: BAC.toUpperCase(), amount: 50 },
  ];
  assert.equal(eligibleSubtotal(lines, [BAC]), 150);
  assert.equal(eligibleSubtotal(lines, []), 200);
  assert.equal(eligibleSubtotal(lines, null), 200);
});

test('a cart of nothing but excluded products gets nothing, and is told so', () => {
  const code = { ...base, excluded_product_ids: [BAC] };
  assert.deepEqual(evaluateDiscountCode(code, { ...ctx, subtotal: 50, eligibleSubtotal: 0 }), {
    ok: false,
    reason: 'nothing-eligible',
  });
  assert.deepEqual(evaluateDiscountCode(code, { ...ctx, subtotal: 200, eligibleSubtotal: 150 }), {
    ok: true,
    percent: 15,
  });
});

test('a fixed amount is a percentage of what it applies to', () => {
  const fixed = { ...base, discount_type: 'fixed' as const, discount_value: 30, excluded_product_ids: [BAC] };
  // $30 off the $150 of eligible goods is 20% of THOSE lines.
  assert.deepEqual(evaluateDiscountCode(fixed, { ...ctx, subtotal: 200, eligibleSubtotal: 150 }), {
    ok: true,
    percent: 20,
  });
});

test('restrictions are only written when the form sent them', () => {
  // A full edit from a form that predates the fields must not reset them.
  const legacy = shapeDiscountCodeInput({ code: 'SAVE10', discount_value: 10 });
  assert.equal(legacy.ok, true);
  if (legacy.ok) {
    assert.equal('first_order_only' in legacy.value, false);
    assert.equal('excluded_product_ids' in legacy.value, false);
  }
  const full = shapeDiscountCodeInput({
    code: 'SAVE10',
    discount_value: 10,
    first_order_only: true,
    excluded_product_ids: [BAC, 'not-a-uuid', BAC],
  });
  assert.equal(full.ok, true);
  if (full.ok) {
    assert.equal(full.value.first_order_only, true);
    assert.deepEqual(full.value.excluded_product_ids, [BAC]);
    assert.equal(hasRestrictions(full.value), true);
    assert.equal('first_order_only' in withoutRestrictions(full.value as any), false);
  }
  assert.equal(hasRestrictions({ first_order_only: false, excluded_product_ids: [] }), false);
});

test('an unmigrated row reads as unrestricted', () => {
  const row = shapeDiscountCodeRow({ code: 'OLD' });
  assert.equal(row.first_order_only, false);
  assert.deepEqual(row.excluded_product_ids, []);
  assert.deepEqual(normalizeProductIds('nope'), []);
});
