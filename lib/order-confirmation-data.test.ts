/**
 * Tests for the paid-order confirmation payload builders.
 *
 *   node --test --import tsx lib/order-confirmation-data.test.ts
 *
 * The properties that matter:
 *   • No payload without a real address — a placeholder or blank email is
 *     "nothing to send", never an SMTP bounce.
 *   • Money comes from the order/invoice, not re-derived, when it's there.
 *   • The summary counts only successful sends but flags a newer failure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deliverableEmail,
  isStorefrontCheckoutSource,
  stealthHealthConfirmationData,
  storefrontConfirmationData,
  summarizeConfirmationLog,
} from './order-confirmation-data';

test('filters undeliverable addresses', () => {
  assert.equal(deliverableEmail('  a@b.co '), 'a@b.co');
  assert.equal(deliverableEmail(''), null);
  assert.equal(deliverableEmail(null), null);
  assert.equal(deliverableEmail('not-an-email'), null);
  assert.equal(deliverableEmail('guest+123@vyta.local'), null);
  assert.equal(deliverableEmail('x@example.invalid'), null);
});

test('only e-transfer sources are storefront checkouts', () => {
  assert.equal(isStorefrontCheckoutSource('e-transfer'), true);
  assert.equal(isStorefrontCheckoutSource('e-transfer-pickup'), true);
  assert.equal(isStorefrontCheckoutSource('website'), false);
  assert.equal(isStorefrontCheckoutSource(null), false);
});

test('builds a storefront payload', () => {
  const data = storefrontConfirmationData({
    id: 'o1',
    order_number: ' VY-1001 ',
    email: 'buyer@example.com',
    currency: 'cad',
    shipping_address: { firstName: 'Ada', lastName: 'Lovelace' },
    items: [
      { name: 'BPC-157', quantity: 2, price: 50, strength: '10mg', unit: 'case', vials_per_box: 5 },
      { name: '', quantity: 0, price: '12.5', unit: 'box' },
      'junk',
    ],
    subtotal: 112.5,
    discount_total: 10,
    shipping_cost: 0,
    total: 102.5,
  });
  assert.deepEqual(data, {
    to: 'buyer@example.com',
    customerName: 'Ada Lovelace',
    orderNumber: 'VY-1001',
    items: [
      { name: 'BPC-157', quantity: 2, price: 50, strength: '10mg', unit: 'case', vialsPerBox: 5 },
      { name: 'Item', quantity: 1, price: 12.5 },
    ],
    subtotal: 112.5,
    discount: 10,
    shipping: 0,
    total: 102.5,
    currency: 'CAD',
  });
});

test('storefront payload derives missing totals and greets "there"', () => {
  const data = storefrontConfirmationData({
    id: 'o2',
    email: 'b@c.io',
    items: [{ name: 'X', quantity: 3, price: 10 }],
    discount_amount: 5,
    shipping_cost: 15,
  });
  assert.ok(data);
  assert.equal(data.orderNumber, 'o2');
  assert.equal(data.customerName, 'there');
  assert.equal(data.subtotal, 30);
  assert.equal(data.total, 40);
  assert.equal(data.currency, 'CAD');
});

test('storefront payload is null without an address', () => {
  assert.equal(storefrontConfirmationData({ id: 'o3', email: '', items: [] }), null);
});

test('builds a Stealth Health payload from the ledger and invoice', () => {
  const data = stealthHealthConfirmationData(
    { id: 'p1', customer_email: 'nope', customer_name: '', partner_reference: 'ref-1', currency: 'usd' },
    { invoice_number: 'INV-0042', customer_email: 'sh@buyer.ca', customer_name: 'Sam', subtotal: 90, shipping_cost: 15, total: 105, currency: 'CAD' },
    [{ description: 'TB-500 — Pack of 5', qty: 2, unit_price: 45 }],
  );
  assert.deepEqual(data, {
    to: 'sh@buyer.ca',
    customerName: 'Sam',
    orderNumber: 'INV-0042',
    items: [{ name: 'TB-500 — Pack of 5', quantity: 2, price: 45 }],
    subtotal: 90,
    discount: 0,
    shipping: 15,
    total: 105,
    currency: 'CAD',
  });
});

test('summarises the send history', () => {
  assert.equal(summarizeConfirmationLog([]).sendCount, 0);

  const summary = summarizeConfirmationLog([
    { created_at: '2026-10-01T10:00:00Z', to_email: 'a@b.co', success: true, sent_by_email: null },
    { created_at: '2026-10-03T10:00:00Z', to_email: 'a@b.co', success: false, error: 'SMTP down' },
    { created_at: '2026-10-02T10:00:00Z', to_email: 'c@d.co', success: true, sent_by_email: 'admin@vyta.com' },
  ]);
  assert.deepEqual(summary, {
    sendCount: 2,
    lastSentAt: '2026-10-02T10:00:00Z',
    lastSentTo: 'c@d.co',
    lastSentBy: 'admin@vyta.com',
    lastAttemptFailed: true,
    lastError: 'SMTP down',
  });
});
