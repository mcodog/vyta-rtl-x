/**
 * Tests for the admin invoice page's discount / affiliate breakdown.
 *
 *   node --test --import tsx lib/admin/invoice-breakdown.test.ts
 *
 * The properties that matter:
 *   • It says what the paid-order email says: same list prices, same discount.
 *   • List price − discount is exactly the charged subtotal.
 *   • The affiliate's cut is the recorded commission, never recomputed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInvoiceBreakdown } from './invoice-breakdown';
import { stealthHealthOrderSummary } from '../order-confirmation-data';

const P1 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const P2 = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const ledger = {
  id: 'p3',
  status: 'paid',
  customer_email: 'm@buyer.ca',
  discount_code: 'VYTA20',
  discount_code_percent: 20,
  ad_discount_percent: 0,
  cart_offer_percent: 5,
  referral_code: 'SAMR',
  items: [
    { product_id: P1, pack_size: 1, quantity: 2, unit_price_cents: 10108, list_unit_price_cents: 13300 },
    { product_id: P2, pack_size: 5, quantity: 1, unit_price_cents: 37544, list_unit_price_cents: 49400 },
  ],
};
const invoice = { id: 'i3', invoice_number: 'VYTA-1016', status: 'paid', subtotal: 577.6, shipping_cost: 0, tax_total: 0, total: 577.6 };
const lines = [
  { id: 'l1', description: 'GLP-3 20mg — Single vial', qty: 2, unit_price: 101.08, price_type: 'vial', vials_per_unit: 1, product_id: P1 },
  { id: 'l2', description: 'MOTS C 40mg — Pack of 5', qty: 1, unit_price: 375.44, price_type: 'box', vials_per_unit: 5, product_id: P2 },
];

test('Stealth Health: list prices, discount and label match the email', () => {
  const b = buildInvoiceBreakdown({ invoice, lines, ledger });
  const email = stealthHealthOrderSummary(ledger, invoice, lines);
  assert.equal(b.subtotalBeforeDiscount, email.subtotal);
  assert.equal(b.discount, email.discount);
  assert.equal(b.discountLabel, email.discountLabel);
  assert.equal(b.subtotalBeforeDiscount, 760);
  assert.equal(b.discount, 182.4);
  assert.equal(b.chargedSubtotal, 577.6);
  assert.deepEqual(b.lines, [
    { lineId: 'l1', listUnitPrice: 133 },
    { lineId: 'l2', listUnitPrice: 494 },
  ]);
  assert.deepEqual(b.discountParts, [
    { kind: 'discount_code', label: 'Discount code', detail: 'VYTA20 · 20%' },
    { kind: 'cart_offer', label: 'Limited-time offer', detail: '5%' },
  ]);
  assert.equal(b.referralCode, 'SAMR');
  assert.equal(b.affiliate, null);
});

test('the affiliate cut is the recorded commission', () => {
  const b = buildInvoiceBreakdown({
    invoice,
    lines,
    ledger,
    commission: {
      id: 'c1',
      affiliate_id: 'a1',
      amount: '57.76',
      commission_rate: '10.00',
      order_total: '577.60',
      status: 'pending',
      paid_at: null,
    },
    affiliate: { id: 'a1', first_name: 'Sam', last_name: 'Reyes', email: 'sam@aff.ca' },
    attribution: { via: 'discount_code', code: 'VYTA20' },
  });
  assert.deepEqual(b.affiliate, {
    affiliateId: 'a1',
    name: 'Sam Reyes',
    email: 'sam@aff.ca',
    via: 'discount_code',
    code: 'VYTA20',
    commission: { id: 'c1', amount: 57.76, rate: 10, base: 577.6, status: 'pending', paidAt: null },
  });
});

test('an affiliate with no commission row yet is still shown', () => {
  const b = buildInvoiceBreakdown({
    invoice: { ...invoice, status: 'sent' },
    lines,
    ledger,
    affiliate: { id: 'a1', first_name: 'Sam', last_name: '', email: null },
    attribution: { via: 'referral_code', code: 'SAMR' },
  });
  assert.equal(b.affiliate?.name, 'Sam');
  assert.equal(b.affiliate?.commission, null);
});

test('no discount: charged prices, no parts, no per-line list price', () => {
  const plain = { id: 'p5', customer_email: 'm@buyer.ca', items: [] };
  const b = buildInvoiceBreakdown({ invoice, lines, ledger: plain });
  assert.equal(b.discount, 0);
  assert.equal(b.subtotalBeforeDiscount, 577.6);
  assert.equal(b.chargedSubtotal, 577.6);
  assert.equal(b.discountLabel, null);
  assert.deepEqual(b.discountParts, []);
  assert.deepEqual(b.lines, []);
});

test('manual invoice: line discounts become the discount row', () => {
  const manual = { id: 'm1', status: 'paid', subtotal: 180, shipping_cost: 15, tax_total: 0, total: 195 };
  const mLines = [
    { id: 'm-l1', description: 'BPC-157 — Pack of 10', qty: 2, unit_price: 100, discount_pct: 10, line_total: 180 },
  ];
  const b = buildInvoiceBreakdown({ invoice: manual, lines: mLines, ledger: null });
  assert.equal(b.subtotalBeforeDiscount, 200);
  assert.equal(b.discount, 20);
  assert.equal(b.chargedSubtotal, 180);
  // Its unit price already is the list price; the Disc. column shows the 10%.
  assert.deepEqual(b.lines, []);
  assert.deepEqual(b.discountParts, [{ kind: 'line', label: 'Line discount', detail: '10%' }]);
  assert.equal(b.discountLabel, '10% line discount');
  assert.equal(b.referralCode, null);
});

test('a code a bigger promo beat is marked as credit only', () => {
  const b = buildInvoiceBreakdown({
    invoice,
    lines,
    ledger: { ...ledger, discount_code_percent: 0, ad_discount_percent: 24, cart_offer_percent: 0 },
  });
  assert.deepEqual(b.discountParts, [
    { kind: 'discount_code', label: 'Discount code', detail: 'VYTA20 · credit only' },
    { kind: 'first_order', label: 'First-order discount', detail: '24%' },
  ]);
});
