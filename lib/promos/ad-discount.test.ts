/**
 * Unit tests for the paid-ads welcome discount.
 *
 * The repo has no test runner wired up, so these use Node's built-in
 * `node:test` + `node:assert` (zero dependencies). Run with a TS-aware loader,
 * e.g. `node --test --import tsx lib/promos/ad-discount.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adDiscountAmount,
  clampDiscountPercent,
  DEFAULT_AD_DISCOUNT_PERCENT,
  distributeAdDiscount,
  qualifiesForAdDiscount,
  shapeAdDiscountSettings,
  type AdDiscountLine,
  distributeLineDiscounts,
} from './ad-discount';

const ON = { enabled: true, percent: 25 };

// ---- settings -------------------------------------------------------------

test('settings default off when the columns are not there', () => {
  const s = shapeAdDiscountSettings(null);
  assert.equal(s.enabled, false);
  assert.equal(s.percent, DEFAULT_AD_DISCOUNT_PERCENT);
});

test('settings read the stored toggle and percentage', () => {
  assert.deepEqual(shapeAdDiscountSettings({ ad_discount_enabled: true, ad_discount_percent: 15 }), {
    enabled: true,
    percent: 15,
  });
});

test('a zero or negative percentage forces the promo off', () => {
  assert.equal(shapeAdDiscountSettings({ ad_discount_enabled: true, ad_discount_percent: 0 }).enabled, false);
  assert.equal(shapeAdDiscountSettings({ ad_discount_enabled: true, ad_discount_percent: -5 }).enabled, false);
});

test('percentages are clamped to 0–100', () => {
  assert.equal(clampDiscountPercent(250), 100);
  assert.equal(clampDiscountPercent('12.345'), 12.35);
  assert.equal(clampDiscountPercent(undefined), 0);
});

// ---- eligibility ----------------------------------------------------------

test('a signed-in visitor from a paid ad qualifies', () => {
  assert.equal(qualifiesForAdDiscount(ON, { signedIn: true, firstOrder: true, channels: ['google_ads'] }), true);
  assert.equal(qualifiesForAdDiscount(ON, { signedIn: true, firstOrder: true, channels: ['meta_ads'] }), true);
  assert.equal(qualifiesForAdDiscount(ON, { signedIn: true, firstOrder: true, channels: ['other_paid'] }), true);
});

test('a guest from a paid ad does not — the offer is what the account is for', () => {
  assert.equal(qualifiesForAdDiscount(ON, { signedIn: false, firstOrder: true, channels: ['google_ads'] }), false);
});

test('organic, affiliate and direct traffic never qualifies', () => {
  for (const channel of ['google_organic', 'affiliate', 'referral', 'direct', 'email', null]) {
    assert.equal(qualifiesForAdDiscount(ON, { signedIn: true, firstOrder: true, channels: [channel] }), false, String(channel));
  }
});

test('either recorded channel is enough — cookie or the frozen customer row', () => {
  assert.equal(qualifiesForAdDiscount(ON, { signedIn: true, firstOrder: true, channels: [null, 'meta_ads'] }), true);
  assert.equal(qualifiesForAdDiscount(ON, { signedIn: true, firstOrder: true, channels: ['direct', 'google_ads'] }), true);
});

test('a switched-off promo disqualifies everyone', () => {
  const off = { enabled: false, percent: 25 };
  assert.equal(qualifiesForAdDiscount(off, { signedIn: true, firstOrder: true, channels: ['google_ads'] }), false);
});

// ---- first order only -----------------------------------------------------

test('a repeat buyer from a paid ad does not qualify — it is a welcome offer', () => {
  assert.equal(
    qualifiesForAdDiscount(ON, { signedIn: true, firstOrder: false, channels: ['google_ads'] }),
    false,
  );
});

test('first-order alone is not enough — the traffic still has to be paid', () => {
  assert.equal(
    qualifiesForAdDiscount(ON, { signedIn: true, firstOrder: true, channels: ['direct'] }),
    false,
  );
});

test('all three conditions together are what earns the discount', () => {
  const visitor = { signedIn: true, firstOrder: true, channels: ['meta_ads'] };
  assert.equal(qualifiesForAdDiscount(ON, visitor), true);
  // Drop any one of them and it goes away.
  assert.equal(qualifiesForAdDiscount(ON, { ...visitor, signedIn: false }), false);
  assert.equal(qualifiesForAdDiscount(ON, { ...visitor, firstOrder: false }), false);
  assert.equal(qualifiesForAdDiscount(ON, { ...visitor, channels: ['direct'] }), false);
});

// ---- the advertised figure ------------------------------------------------

test('the advertised discount is a plain percentage of the subtotal', () => {
  assert.equal(adDiscountAmount(400, 25), 100);
  assert.equal(adDiscountAmount(129.99, 25), 32.5);
  assert.equal(adDiscountAmount(0, 25), 0);
  assert.equal(adDiscountAmount(400, 0), 0);
});

// ---- distributing it over the lines --------------------------------------

const sum = (lines: { discountedUnitPriceCents: number; quantity: number }[]) =>
  lines.reduce((t, l) => t + l.discountedUnitPriceCents * l.quantity, 0);

test('an exact split takes exactly the percentage off', () => {
  const lines: AdDiscountLine[] = [
    { key: 'a', unitPriceCents: 10000, quantity: 2 },
    { key: 'b', unitPriceCents: 4000, quantity: 1 },
  ];
  const out = distributeAdDiscount(lines, 25);
  assert.equal(out.subtotalCents, 24000);
  assert.equal(out.discountCents, 6000);
  assert.equal(out.totalCents, 18000);
  assert.equal(out.lines[0].discountedUnitPriceCents, 7500);
  assert.equal(out.lines[1].discountedUnitPriceCents, 3000);
  assert.equal(sum(out.lines), out.totalCents);
});

test('the line prices always add back up to the charged total', () => {
  const cases: AdDiscountLine[][] = [
    [{ key: 'a', unitPriceCents: 999, quantity: 3 }],
    [
      { key: 'a', unitPriceCents: 15633, quantity: 7 },
      { key: 'b', unitPriceCents: 4111, quantity: 2 },
      { key: 'c', unitPriceCents: 87, quantity: 13 },
    ],
    [
      { key: 'a', unitPriceCents: 1, quantity: 1 },
      { key: 'b', unitPriceCents: 3, quantity: 99 },
    ],
  ];
  for (const lines of cases) {
    for (const pct of [5, 10, 25, 33.33, 50, 100]) {
      const out = distributeAdDiscount(lines, pct);
      assert.equal(sum(out.lines), out.totalCents);
      assert.equal(out.subtotalCents - out.discountCents, out.totalCents);
    }
  }
});

test('rounding never favours the store — the discount is at least the advertised one', () => {
  const lines: AdDiscountLine[] = [
    { key: 'a', unitPriceCents: 999, quantity: 3 },
    { key: 'b', unitPriceCents: 4567, quantity: 2 },
  ];
  for (const pct of [7, 12.5, 25, 33.33]) {
    const out = distributeAdDiscount(lines, pct);
    const advertised = Math.round((out.subtotalCents * pct) / 100);
    assert.ok(
      out.discountCents >= advertised,
      `${pct}%: took ${out.discountCents}, advertised ${advertised}`,
    );
    // …and never runs away with it: at most one extra cent per unit.
    const units = lines.reduce((t, l) => t + l.quantity, 0);
    assert.ok(out.discountCents - advertised <= units, `${pct}% overshot by too much`);
  }
});

test('no line is ever marked up above its list price', () => {
  const lines: AdDiscountLine[] = [
    { key: 'a', unitPriceCents: 5, quantity: 40 },
    { key: 'b', unitPriceCents: 12345, quantity: 1 },
  ];
  const out = distributeAdDiscount(lines, 25);
  for (const line of out.lines) {
    assert.ok(line.discountedUnitPriceCents <= line.unitPriceCents, line.key);
    assert.ok(line.discountedUnitPriceCents >= 0, line.key);
  }
});

test('a 100% discount zeroes every line', () => {
  const out = distributeAdDiscount(
    [
      { key: 'a', unitPriceCents: 1234, quantity: 3 },
      { key: 'b', unitPriceCents: 99, quantity: 1 },
    ],
    100,
  );
  assert.equal(out.totalCents, 0);
  assert.equal(out.discountCents, out.subtotalCents);
  assert.deepEqual(out.lines.map((l) => l.discountedUnitPriceCents), [0, 0]);
});

test('a zero percentage leaves every price untouched', () => {
  const lines: AdDiscountLine[] = [{ key: 'a', unitPriceCents: 1234, quantity: 3 }];
  const out = distributeAdDiscount(lines, 0);
  assert.equal(out.discountCents, 0);
  assert.equal(out.lines[0].discountedUnitPriceCents, 1234);
});

test('empty and zero-quantity lines are dropped rather than divided by', () => {
  const out = distributeAdDiscount(
    [
      { key: 'a', unitPriceCents: 1000, quantity: 0 },
      { key: 'b', unitPriceCents: 1000, quantity: 2 },
    ],
    25,
  );
  assert.equal(out.lines.length, 1);
  assert.equal(out.subtotalCents, 2000);
  assert.equal(out.totalCents, 1500);
  assert.deepEqual(distributeAdDiscount([], 25).lines, []);
  assert.equal(distributeAdDiscount([], 25).discountCents, 0);
});

test('a free line stays free instead of going negative', () => {
  const out = distributeAdDiscount(
    [
      { key: 'free', unitPriceCents: 0, quantity: 2 },
      { key: 'paid', unitPriceCents: 8000, quantity: 1 },
    ],
    25,
  );
  assert.equal(out.lines[0].discountedUnitPriceCents, 0);
  assert.equal(out.lines[1].discountedUnitPriceCents, 6000);
  assert.equal(out.discountCents, 2000);
});

// ---------------------------------------------------------------------------
// distributeLineDiscounts — different percentages on different lines
// ---------------------------------------------------------------------------

test('one shared percentage is exactly the single split it always was', () => {
  const lines = [
    { key: 'a', unitPriceCents: 4999, quantity: 3 },
    { key: 'b', unitPriceCents: 12000, quantity: 1 },
  ];
  const single = distributeAdDiscount(lines, 35);
  const grouped = distributeLineDiscounts(lines.map((l) => ({ ...l, percent: 35 })));
  assert.equal(grouped.discountCents, single.discountCents);
  assert.equal(grouped.totalCents, single.totalCents);
  assert.deepEqual(
    grouped.lines.map((l) => l.discountedUnitPriceCents),
    single.lines.map((l) => l.discountedUnitPriceCents),
  );
});

test('an excluded line keeps its list price; the rest take the full percentage', () => {
  const split = distributeLineDiscounts([
    { key: 'peptide', unitPriceCents: 10000, quantity: 2, percent: 35 },
    { key: 'bac-water', unitPriceCents: 1500, quantity: 1, percent: 0 },
  ]);
  const bac = split.lines.find((l) => l.key === 'bac-water')!;
  const peptide = split.lines.find((l) => l.key === 'peptide')!;
  assert.equal(bac.discountedUnitPriceCents, 1500);
  assert.equal(peptide.discountedUnitPriceCents, 6500);
  // 35% of the $200 of peptide, and nothing of the water.
  assert.equal(split.discountCents, 7000);
  assert.equal(split.subtotalCents, 21500);
  assert.equal(split.totalCents, 14500);
});

test('each group is rounded in the buyer favour on its own', () => {
  const split = distributeLineDiscounts([
    { key: 'a', unitPriceCents: 3333, quantity: 3, percent: 35 },
    { key: 'b', unitPriceCents: 999, quantity: 7, percent: 10 },
  ]);
  const a = split.lines.find((l) => l.key === 'a')!;
  const b = split.lines.find((l) => l.key === 'b')!;
  const aSaved = (3333 - a.discountedUnitPriceCents) * 3;
  const bSaved = (999 - b.discountedUnitPriceCents) * 7;
  assert.ok(aSaved >= Math.round(3333 * 3 * 0.35));
  assert.ok(bSaved >= Math.round(999 * 7 * 0.1));
  assert.equal(split.discountCents, aSaved + bSaved);
  // Never marked up.
  assert.ok(a.discountedUnitPriceCents <= 3333 && b.discountedUnitPriceCents <= 999);
});

test('the lines come back in the order they were given', () => {
  const split = distributeLineDiscounts([
    { key: 'z', unitPriceCents: 1000, quantity: 1, percent: 0 },
    { key: 'y', unitPriceCents: 1000, quantity: 1, percent: 20 },
    { key: 'x', unitPriceCents: 1000, quantity: 1, percent: 0 },
  ]);
  assert.deepEqual(split.lines.map((l) => l.key), ['z', 'y', 'x']);
});
