/**
 * Unit tests for affiliate commission recording.
 *
 * This is money: a wrong base, a wrong rate, or a lost idempotency guard all
 * pay the wrong amount to a real person. The cases that matter:
 *   - the base is the goods SUBTOTAL, never the total with shipping;
 *   - a stored rate of 0.10 and one of 10 mean the same thing;
 *   - a bound customer beats a raw referral code, and self-referral pays nobody;
 *   - a referral link carrying an affiliate's discount code, or a code they
 *     have since renamed, still credits that affiliate;
 *   - a repeat webhook/poll for the same sale never pays twice, including when
 *     the duplicate is caught by the database rather than the pre-check.
 *
 * The repo has no test runner wired up, so these use Node's built-in
 * `node:test` + `node:assert` (zero dependencies), matching the sibling suites
 * in lib/. Run with a TS-aware loader, e.g.
 *   node --test --import tsx lib/affiliate/commission.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCommissionRate,
  resolveAffiliateAttribution,
  resolveReferralCodeOwner,
  recordAffiliateCommission,
  AFFILIATE_COMMISSION_RATE,
  round2,
} from './commission';

/* ------------------------------------------------------------------ */
/* A minimal stand-in for the supabase-js query builder.               */
/* ------------------------------------------------------------------ */

interface Call {
  table: string;
  mode: 'select' | 'insert';
  filters: [string, unknown][];
  payload?: Record<string, unknown>;
}

type Handler = (call: Call) => { data: unknown; error: unknown };

function makeDb(handler: Handler) {
  const calls: Call[] = [];

  const build = (call: Call): any => {
    const settle = async () => {
      calls.push(call);
      return handler(call);
    };
    return {
      select: () => build(call),
      eq: (column: string, value: unknown) =>
        build({ ...call, filters: [...call.filters, [column, value]] }),
      limit: () => build(call),
      order: () => build(call),
      maybeSingle: settle,
      single: settle,
    };
  };

  const db = {
    from: (table: string) => ({
      select: () => build({ table, mode: 'select', filters: [] }),
      insert: (payload: Record<string, unknown>) =>
        build({ table, mode: 'insert', filters: [], payload }),
    }),
  };

  return { db: db as any, calls };
}

const ok = (data: unknown) => ({ data, error: null });
const empty = { data: null, error: null };

/** Finds the value a query filtered a column on. */
function filterValue(call: Call, column: string): unknown {
  return call.filters.find(([c]) => c === column)?.[1];
}

/* ------------------------------------------------------------------ */
/* normalizeCommissionRate                                            */
/* ------------------------------------------------------------------ */

test('a fraction and its percentage equivalent mean the same rate', () => {
  assert.equal(normalizeCommissionRate(0.1), 0.1);
  assert.equal(normalizeCommissionRate(10), 0.1);
  assert.equal(normalizeCommissionRate(0.15), 0.15);
  assert.equal(normalizeCommissionRate(15), 0.15);
});

test('1 is read as 100%, not as 1%', () => {
  // The boundary the <= 1 rule sets. Documented so a future change is deliberate.
  assert.equal(normalizeCommissionRate(1), 1);
});

test('missing, zero, negative and absurd rates fall back to the standard rate', () => {
  for (const bad of [null, undefined, 0, -5, NaN, 'abc', 250]) {
    assert.equal(normalizeCommissionRate(bad), AFFILIATE_COMMISSION_RATE);
  }
});

/* ------------------------------------------------------------------ */
/* resolveAffiliateAttribution                                        */
/* ------------------------------------------------------------------ */

test('a bound customer beats the referral code on the order', async () => {
  const { db } = makeDb((call) => {
    if (call.table === 'customers') return ok({ affiliate_id: 'aff-bound' });
    if (call.table === 'referral_codes') return ok({ id: 'code-1', code: 'BOUND10' });
    return empty;
  });

  const got = await resolveAffiliateAttribution(db, {
    customerId: 'cust-1',
    referralCode: 'OTHER',
  });

  assert.equal(got?.affiliateId, 'aff-bound');
  assert.equal(got?.referralCode, 'BOUND10');
});

test('a customer referred by their own code credits nobody', async () => {
  const { db } = makeDb((call) => {
    // The customer is bound to themselves, and the code is their own.
    if (call.table === 'customers') return ok({ affiliate_id: 'aff-self' });
    if (call.table === 'referral_codes') {
      return ok({ id: 'c', code: 'SELF', affiliate_id: 'aff-self', active: true });
    }
    return empty;
  });

  const got = await resolveAffiliateAttribution(db, {
    customerId: 'aff-self',
    referralCode: 'SELF',
  });

  assert.equal(got, null);
});

test('an unbound buyer is attributed by referral code, normalized', async () => {
  const seen: unknown[] = [];
  const { db } = makeDb((call) => {
    if (call.table === 'customers') return ok({ affiliate_id: null });
    if (call.table === 'referral_codes') {
      seen.push(filterValue(call, 'code'));
      return ok({ id: 'code-9', code: 'PROMO5', affiliate_id: 'aff-9', active: true });
    }
    if (call.table === 'affiliates') return ok({ active: true });
    return empty;
  });

  const got = await resolveAffiliateAttribution(db, {
    customerId: 'cust-2',
    referralCode: 'promo-5',
  });

  assert.equal(got?.affiliateId, 'aff-9');
  assert.equal(got?.referralCodeId, 'code-9');
  // Normalized, not merely uppercased: punctuation is stripped, so a code
  // typed with a dash still matches the stored one.
  assert.deepEqual(seen, ['PROMO5']);
});

test('a deactivated affiliate credits nobody, code or no code', async () => {
  const { db } = makeDb((call) => {
    if (call.table === 'customers') return ok({ affiliate_id: null });
    if (call.table === 'referral_codes') {
      return ok({ id: 'code-x', code: 'GONE10', affiliate_id: 'aff-off', active: true });
    }
    if (call.table === 'affiliates') return ok({ active: false });
    return empty;
  });

  // A switched-off partner's code must not discount an order or book a
  // commission nobody intends to pay.
  assert.equal(
    await resolveAffiliateAttribution(db, { customerId: 'cust-3', referralCode: 'GONE10' }),
    null,
  );
});

test('a guest with no code at all credits nobody', async () => {
  const { db } = makeDb(() => empty);
  assert.equal(await resolveAffiliateAttribution(db, {}), null);
});

/* ------------------------------------------------------------------ */
/* recordAffiliateCommission                                          */
/* ------------------------------------------------------------------ */

/** Wires up the happy path; `over` tweaks individual table responses. */
function paidSale(over: Partial<Record<string, unknown>> = {}) {
  const inserted: Record<string, unknown>[] = [];
  const { db, calls } = makeDb((call) => {
    if (call.table === 'commissions' && call.mode === 'insert') {
      inserted.push(call.payload!);
      if ('insertError' in over) return { data: null, error: over.insertError };
      return ok({ id: 'comm-1' });
    }
    if (call.table === 'commissions') return ok(over.existing ?? null);
    if (call.table === 'customers') return ok(over.customer ?? { affiliate_id: null });
    if (call.table === 'referral_codes') {
      return ok(
        'code' in over
          ? over.code
          : { id: 'code-1', code: 'REF10', affiliate_id: 'aff-1', active: true },
      );
    }
    if (call.table === 'affiliates') {
      return ok('affiliate' in over ? over.affiliate : { commission_rate: 0.1 });
    }
    if (call.table === 'discount_codes') return ok(over.discountCode ?? null);
    return empty;
  });
  return { db, calls, inserted };
}

test('commission is 10% of the subtotal, and shipping is not in the base', async () => {
  const { db, inserted } = paidSale();

  // $420.00 of goods. Stealth Health adds a $35 flat shipping fee on the invoice;
  // the affiliate must not earn on it.
  const res = await recordAffiliateCommission(db, {
    invoiceId: 'inv-1',
    subtotalCents: 42000,
    customerId: 'cust-1',
    referralCode: 'REF10',
  });

  assert.equal(res.recorded, true);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].order_total, 420);
  assert.equal(inserted[0].amount, 42);
  assert.notEqual(inserted[0].order_total, 455); // 420 + 35 shipping
});

test('the affiliate row is credited, with the code and a pending status', async () => {
  const { db, inserted } = paidSale();

  await recordAffiliateCommission(db, {
    invoiceId: 'inv-2',
    subtotalCents: 10000,
    referralCode: 'REF10',
  });

  assert.equal(inserted[0].affiliate_id, 'aff-1');
  assert.equal(inserted[0].invoice_id, 'inv-2');
  assert.equal(inserted[0].order_id, null);
  assert.equal(inserted[0].referral_code_id, 'code-1');
  assert.equal(inserted[0].status, 'pending');
});

test('a percentage-stored rate pays the same as a fraction-stored one', async () => {
  const asFraction = paidSale({ affiliate: { commission_rate: 0.15 } });
  await recordAffiliateCommission(asFraction.db, {
    invoiceId: 'inv-3',
    subtotalCents: 20000,
    referralCode: 'REF10',
  });

  const asPercent = paidSale({ affiliate: { commission_rate: 15 } });
  await recordAffiliateCommission(asPercent.db, {
    invoiceId: 'inv-3',
    subtotalCents: 20000,
    referralCode: 'REF10',
  });

  assert.equal(asFraction.inserted[0].amount, 30);
  assert.equal(asPercent.inserted[0].amount, 30);
  // Readers render commission_rate as a percentage.
  assert.equal(asFraction.inserted[0].commission_rate, 15);
  assert.equal(asPercent.inserted[0].commission_rate, 15);
});

test('an affiliate with no rate set falls back to the standard 10%', async () => {
  const { db, inserted } = paidSale({ affiliate: { commission_rate: null } });

  await recordAffiliateCommission(db, {
    invoiceId: 'inv-4',
    subtotalCents: 5000,
    referralCode: 'REF10',
  });

  assert.equal(inserted[0].amount, 5);
});

test('a fractional cent is rounded, not carried', async () => {
  const { db, inserted } = paidSale({ affiliate: { commission_rate: 0.125 } });

  // 133.33 * 0.125 = 16.66625
  await recordAffiliateCommission(db, {
    invoiceId: 'inv-5',
    subtotalCents: 13333,
    referralCode: 'REF10',
  });

  assert.equal(inserted[0].amount, 16.67);
});

test('a second webhook for the same sale does not pay twice', async () => {
  const { db, inserted } = paidSale({ existing: { id: 'comm-existing' } });

  const res = await recordAffiliateCommission(db, {
    invoiceId: 'inv-6',
    subtotalCents: 42000,
    referralCode: 'REF10',
  });

  assert.equal(res.recorded, false);
  assert.equal(res.recorded === false && res.reason, 'already-recorded');
  assert.equal(inserted.length, 0);
});

test('a race the pre-check misses is settled by the unique index, not paid twice', async () => {
  // Pre-check finds nothing, but the insert loses the race to a concurrent poll.
  const { db } = paidSale({ insertError: { code: '23505', message: 'duplicate key' } });

  const res = await recordAffiliateCommission(db, {
    invoiceId: 'inv-7',
    subtotalCents: 42000,
    referralCode: 'REF10',
  });

  assert.equal(res.recorded, false);
  assert.equal(res.recorded === false && res.reason, 'already-recorded');
});

test('an unattributed sale records nothing at all', async () => {
  const { db, inserted } = paidSale({ code: null });

  const res = await recordAffiliateCommission(db, {
    invoiceId: 'inv-8',
    subtotalCents: 42000,
    referralCode: 'NOPE',
  });

  assert.equal(res.recorded, false);
  assert.equal(res.recorded === false && res.reason, 'no-attribution');
  assert.equal(inserted.length, 0);
});

test('a sale with no reported subtotal is left uncredited rather than credited zero', async () => {
  // A zero row would satisfy the unique index and permanently block the real
  // commission from being recorded on a later pass.
  for (const subtotalCents of [null, undefined, 0, NaN]) {
    const { db, inserted } = paidSale();
    const res = await recordAffiliateCommission(db, {
      invoiceId: 'inv-9',
      subtotalCents: subtotalCents as number | null,
      referralCode: 'REF10',
    });
    assert.equal(res.recorded, false);
    assert.equal(res.recorded === false && res.reason, 'no-base');
    assert.equal(inserted.length, 0);
  }
});

test('a database failure is reported, not thrown, so the webhook still ACKs', async () => {
  const { db } = paidSale({ insertError: { code: '42703', message: 'no such column' } });

  const res = await recordAffiliateCommission(db, {
    invoiceId: 'inv-10',
    subtotalCents: 42000,
    referralCode: 'REF10',
  });

  assert.equal(res.recorded, false);
  assert.equal(res.recorded === false && res.reason, 'error');
});

test('a thrown client error is swallowed rather than breaking the caller', async () => {
  const exploding = {
    from() {
      throw new Error('connection reset');
    },
  } as any;

  const res = await recordAffiliateCommission(exploding, {
    invoiceId: 'inv-11',
    subtotalCents: 42000,
    referralCode: 'REF10',
  });

  assert.equal(res.recorded, false);
  assert.equal(res.recorded === false && res.reason, 'error');
});

test('round2 keeps currency arithmetic off binary-float edges', () => {
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(42.004999), 42);
  assert.equal(round2(42.005), 42.01);
  assert.equal(round2(0.1 + 0.2), 0.3);
});

/* ------------------------------------------------------------------ */
/* Discount codes                                                     */
/* ------------------------------------------------------------------ */

test('a discount code credits its own affiliate over the referral cookie', async () => {
  const { db, inserted } = paidSale({
    discountCode: { id: 'dc-1', affiliate_id: 'aff-code', commission_rate: null },
  });

  await recordAffiliateCommission(db, {
    invoiceId: 'inv-dc-1',
    subtotalCents: 10000,
    referralCode: 'REF10', // belongs to aff-1
    discountCodeId: 'dc-1',
  });

  assert.equal(inserted[0].affiliate_id, 'aff-code');
  assert.equal(inserted[0].discount_code_id, 'dc-1');
  assert.equal(inserted[0].referral_code_id, null);
  assert.equal(inserted[0].amount, 10); // affiliate's own 10%
});

test("a code's commission rate is a percentage and overrides the affiliate's", async () => {
  const { db, inserted } = paidSale({
    discountCode: { id: 'dc-2', affiliate_id: 'aff-code', commission_rate: 1 },
    affiliate: { commission_rate: 0.2 },
  });

  await recordAffiliateCommission(db, {
    invoiceId: 'inv-dc-2',
    subtotalCents: 20000,
    discountCodeId: 'dc-2',
  });

  // 1% of $200 — not 100% (1 read as a fraction), not the affiliate's 20%.
  assert.equal(inserted[0].amount, 2);
  assert.equal(inserted[0].commission_rate, 1);
});

test('a 0% code books a zero commission but still records the sale', async () => {
  const { db, inserted } = paidSale({
    discountCode: { id: 'dc-3', affiliate_id: 'aff-code', commission_rate: 0 },
  });

  await recordAffiliateCommission(db, {
    invoiceId: 'inv-dc-3',
    subtotalCents: 20000,
    discountCodeId: 'dc-3',
  });

  assert.equal(inserted[0].amount, 0);
  assert.equal(inserted[0].order_total, 200);
});

test('a store code with no affiliate falls back to normal attribution', async () => {
  const { db, inserted } = paidSale({
    discountCode: { id: 'dc-4', affiliate_id: null, commission_rate: null },
  });

  await recordAffiliateCommission(db, {
    invoiceId: 'inv-dc-4',
    subtotalCents: 10000,
    referralCode: 'REF10',
    discountCodeId: 'dc-4',
  });

  assert.equal(inserted[0].affiliate_id, 'aff-1');
  assert.equal(inserted[0].discount_code_id, undefined);
});

test('an affiliate using their own discount code earns nothing from it', async () => {
  const { db, inserted } = paidSale({
    discountCode: { id: 'dc-5', affiliate_id: 'cust-self', commission_rate: 50 },
    code: null,
  });

  const res = await recordAffiliateCommission(db, {
    invoiceId: 'inv-dc-5',
    subtotalCents: 10000,
    customerId: 'cust-self',
    discountCodeId: 'dc-5',
  });

  assert.equal(res.recorded, false);
  assert.equal(inserted.length, 0);
});

/* ------------------------------------------------------------------ */
/* Referral links that are not a live referral code                   */
/* ------------------------------------------------------------------ */

test("a referral link carrying an affiliate's discount code credits that affiliate", async () => {
  // The buyer arrived on ?ref=PALMBELLA10 — Palm Bella's discount code, not a
  // referral code — then typed the store's VYTA20, which credits nobody.
  const { db, inserted } = paidSale({
    code: null,
    discountCode: { id: 'dc-pb', code: 'PALMBELLA10', affiliate_id: 'aff-pb', commission_rate: null, active: true },
    affiliate: { commission_rate: 0.1, active: true },
  });

  const res = await recordAffiliateCommission(db, {
    invoiceId: 'inv-ref-dc',
    subtotalCents: 10000,
    referralCode: 'PALMBELLA10',
  });

  assert.equal(res.recorded, true);
  assert.equal(inserted[0].affiliate_id, 'aff-pb');
  assert.equal(inserted[0].amount, 10);
  // Not booked against the discount code: it took nothing off this sale.
  assert.equal(inserted[0].discount_code_id, undefined);
});

test("that discount code's own commission rate applies", async () => {
  const { db, inserted } = paidSale({
    code: null,
    discountCode: { id: 'dc-pb', code: 'PALMBELLA10', affiliate_id: 'aff-pb', commission_rate: 15, active: true },
    affiliate: { commission_rate: 0.1, active: true },
  });

  await recordAffiliateCommission(db, {
    invoiceId: 'inv-ref-dc-rate',
    subtotalCents: 20000,
    referralCode: 'PALMBELLA10',
  });

  assert.equal(inserted[0].amount, 30);
  assert.equal(inserted[0].commission_rate, 15);
});

test('a switched-off discount code on a referral link credits nobody', async () => {
  const { db, inserted } = paidSale({
    code: null,
    discountCode: { id: 'dc-off', code: 'OLD10', affiliate_id: 'aff-pb', commission_rate: null, active: false },
  });

  const res = await recordAffiliateCommission(db, {
    invoiceId: 'inv-ref-dc-off',
    subtotalCents: 10000,
    referralCode: 'OLD10',
  });

  assert.equal(res.recorded === false && res.reason, 'no-attribution');
  assert.equal(inserted.length, 0);
});

test('a code the affiliate has since renamed still credits them, on their live code', async () => {
  const { db } = makeDb((call) => {
    if (call.table === 'referral_codes') {
      // The old code is gone; looking up by affiliate finds the renamed row.
      return ok(filterValue(call, 'affiliate_id') === 'aff-r' ? { id: 'code-new' } : null);
    }
    if (call.table === 'referral_code_requests') {
      assert.equal(filterValue(call, 'previous_code'), 'OLDNAME10');
      assert.equal(filterValue(call, 'status'), 'approved');
      return ok({ affiliate_id: 'aff-r' });
    }
    if (call.table === 'affiliates') return ok({ active: true });
    return empty;
  });

  const owner = await resolveReferralCodeOwner(db, 'oldname10');

  assert.equal(owner?.affiliateId, 'aff-r');
  assert.equal(owner?.via, 'retired_referral_code');
  assert.equal(owner?.referralCodeId, 'code-new');
});

test('a live referral code wins over a discount code with the same name', async () => {
  const { db, calls } = makeDb((call) => {
    if (call.table === 'referral_codes') return ok({ id: 'code-1', code: 'SAME10', affiliate_id: 'aff-ref', active: true });
    if (call.table === 'discount_codes') return ok({ id: 'dc', code: 'SAME10', affiliate_id: 'aff-dc', active: true });
    if (call.table === 'affiliates') return ok({ active: true });
    return empty;
  });

  const owner = await resolveReferralCodeOwner(db, 'SAME10');

  assert.equal(owner?.affiliateId, 'aff-ref');
  assert.equal(owner?.via, 'referral_code');
  assert.equal(calls.some((c) => c.table === 'discount_codes'), false);
});
