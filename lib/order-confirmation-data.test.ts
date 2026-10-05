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
  shipToFrom,
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
    accountOrderId: 'o1',
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
    items: [{ name: 'TB-500', quantity: 2, price: 45, unit: 'case', vialsPerBox: 5 }],
    subtotal: 90,
    discount: 0,
    shipping: 15,
    total: 105,
    currency: 'CAD',
    tax: 0,
  });
});

test('Stealth Health payload carries what the email shows', () => {
  const data = stealthHealthConfirmationData(
    {
      id: 'p2',
      status: 'paid',
      customer_email: 'm@buyer.ca',
      customer_name: 'Marguerite P',
      customer_phone: '289-489-1471',
      shipping_address: { address: '322 Locheed Dr', city: 'Hamilton', state: 'ON', zip: 'L8T 4Z6', country: 'CA' },
    },
    {
      id: '11111111-2222-4333-8444-555555555555',
      invoice_number: 'INV-1016',
      status: 'paid',
      paid_at: '2026-10-04T18:00:00Z',
      subtotal: 364.8,
      shipping_cost: 0,
      tax_total: 0,
      total: 364.8,
      currency: 'CAD',
    },
    [
      {
        description: 'GLP-3 20mg — Single vial',
        qty: 2,
        unit_price: 133,
        price_type: 'vial',
        vials_per_unit: 1,
        product_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      },
      { description: 'Custom blend', qty: 1, unit_price: 98.8, product_id: 'not-a-uuid' },
    ],
  );
  assert.ok(data);
  assert.deepEqual(data.items, [
    { name: 'GLP-3 20mg', quantity: 2, price: 133, unit: 'vial', productId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
    { name: 'Custom blend', quantity: 1, price: 98.8 },
  ]);
  assert.equal(data.orderDate, '2026-10-04T18:00:00Z');
  assert.equal(data.paymentStatus, 'Paid');
  assert.deepEqual(data.shipTo, {
    name: 'Marguerite P',
    lines: ['322 Locheed Dr', 'Hamilton, ON L8T 4Z6', 'Canada'],
    phone: '289-489-1471',
  });
  assert.equal(data.accountOrderId, '11111111-2222-4333-8444-555555555555');
});

const P1 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const P2 = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';

test('discounted Stealth Health order shows list prices and a Discount row', () => {
  const ledger = {
    id: 'p3',
    status: 'paid',
    customer_email: 'm@buyer.ca',
    discount_code: 'VYTA20',
    discount_code_percent: 20,
    ad_discount_percent: 0,
    cart_offer_percent: 5,
    items: [
      { product_id: P1, pack_size: 1, quantity: 2, unit_price_cents: 10108, list_unit_price_cents: 13300 },
      { product_id: P2, pack_size: 5, quantity: 1, unit_price_cents: 37544, list_unit_price_cents: 49400 },
    ],
  };
  const invoice = { id: 'i3', invoice_number: 'INV-1016', status: 'paid', subtotal: 577.6, shipping_cost: 0, tax_total: 0, total: 577.6 };
  const lines = [
    { description: 'GLP-3 20mg — Single vial', qty: 2, unit_price: 101.08, price_type: 'vial', vials_per_unit: 1, product_id: P1 },
    { description: 'MOTS C 40mg — Pack of 5', qty: 1, unit_price: 375.44, price_type: 'box', vials_per_unit: 5, product_id: P2 },
  ];
  const data = stealthHealthConfirmationData(ledger, invoice, lines);
  assert.ok(data);
  assert.deepEqual(data.items.map((i) => i.price), [133, 494]);
  assert.equal(data.subtotal, 760);
  assert.equal(data.discount, 182.4);
  assert.equal(data.discountLabel, 'VYTA20 + 5% limited-time offer');
  // The rows still add up to what was charged.
  assert.equal(Math.round((data.subtotal - data.discount + data.shipping + (data.tax ?? 0)) * 100), Math.round(data.total * 100));
});

test('without list prices for every line, charged prices and no discount row', () => {
  const ledger = {
    id: 'p4',
    customer_email: 'm@buyer.ca',
    items: [{ product_id: P1, pack_size: 1, quantity: 2, unit_price_cents: 10108, list_unit_price_cents: 13300 }],
  };
  const invoice = { id: 'i4', subtotal: 577.6, total: 577.6 };
  const lines = [
    { description: 'GLP-3 20mg — Single vial', qty: 2, unit_price: 101.08, vials_per_unit: 1, product_id: P1 },
    { description: 'MOTS C 40mg — Pack of 5', qty: 1, unit_price: 375.44, vials_per_unit: 5, product_id: P2 },
  ];
  const data = stealthHealthConfirmationData(ledger, invoice, lines);
  assert.ok(data);
  assert.deepEqual(data.items.map((i) => i.price), [101.08, 375.44]);
  assert.equal(data.subtotal, 577.6);
  assert.equal(data.discount, 0);
  assert.equal(data.discountLabel, undefined);
});

test('shipToFrom handles blanks and JSON strings', () => {
  assert.equal(shipToFrom(null), undefined);
  assert.equal(shipToFrom({ address: '  ' }), undefined);
  assert.deepEqual(shipToFrom('{"address1":"1 Main","city":"Toronto","country":"Canada"}'), {
    name: null,
    lines: ['1 Main', 'Toronto', 'Canada'],
    phone: null,
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
