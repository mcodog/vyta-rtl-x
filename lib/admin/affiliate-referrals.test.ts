/**
 * Tests for who an affiliate brought in and what they spent.
 *
 *   node --test --import tsx lib/admin/affiliate-referrals.test.ts
 *
 * The properties that matter:
 *   • The affiliate's own account, bound to itself, is never a referral.
 *   • A hosted sale is an invoice; a commissioned one counts as a sale and its
 *     buyer as a customer, bound or not.
 *   • Each order and invoice is counted once.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAffiliateReferrals } from './affiliate-referrals';

const AFF = 'aff-1';
const affiliates = [{ id: AFF, email: 'Sam@Aff.ca' }];
const self = { id: AFF, affiliate_id: AFF, email: 'sam@aff.ca', first_name: 'Sam', last_name: 'R', created_at: '2026-09-01' };

test('two paid referral-code sales by two buyers: 2 customers, both sales', () => {
  const r = buildAffiliateReferrals({
    affiliates,
    boundCustomers: [self],
    commissions: [
      { affiliate_id: AFF, order_id: null, invoice_id: 'inv-1' },
      { affiliate_id: AFF, order_id: null, invoice_id: 'inv-2' },
    ],
    orders: [],
    invoices: [
      { id: 'inv-1', customer_id: 'cust-a', customer_email: 'a@x.ca', customer_name: 'Ann', total: 120, status: 'paid', created_at: '2026-10-01' },
      { id: 'inv-2', customer_id: null, customer_email: 'B@x.ca', customer_name: 'Bo', total: '80.50', status: 'paid', created_at: '2026-10-02' },
    ],
  }).get(AFF)!;

  assert.equal(r.customers.length, 2);
  assert.equal(r.sales, 2);
  assert.equal(r.revenue, 200.5);
  const bo = r.customers.find((c) => c.name === 'Bo')!;
  assert.equal(bo.id, null);
  assert.equal(bo.key, 'email:b@x.ca');
  assert.equal(bo.bound, false);
  assert.equal(bo.orders, 1);
  assert.equal(r.customers.find((c) => c.id === 'cust-a')!.revenue, 120);
});

test("the affiliate's own orders and self-binding don't count", () => {
  const r = buildAffiliateReferrals({
    affiliates,
    boundCustomers: [self],
    commissions: [],
    orders: [{ id: 'o-self', customer_id: AFF, total: 300, status: 'paid' }],
    invoices: [{ id: 'i-self', customer_id: null, customer_email: 'sam@aff.ca', total: 50, status: 'paid' }],
  }).get(AFF)!;
  assert.equal(r.customers.length, 0);
  assert.equal(r.revenue, 0);
  assert.equal(r.sales, 0);
});

test('a bound customer: orders and paid invoices, each sale once, dead ones skipped', () => {
  const bound = { id: 'cust-b', affiliate_id: AFF, email: 'b@x.ca', first_name: 'Bea', last_name: '', created_at: '2026-09-10' };
  const r = buildAffiliateReferrals({
    affiliates,
    boundCustomers: [self, bound],
    commissions: [
      { affiliate_id: AFF, order_id: 'o1', invoice_id: null },
      { affiliate_id: AFF, order_id: null, invoice_id: 'i1' },
    ],
    orders: [
      // Read twice (by customer and by commission) — still one sale.
      { id: 'o1', customer_id: 'cust-b', total: 100, status: 'delivered' },
      { id: 'o1', customer_id: 'cust-b', total: 100, status: 'delivered' },
      { id: 'o2', customer_id: 'cust-b', total: 999, status: 'cancelled' },
    ],
    invoices: [
      { id: 'i1', customer_id: 'cust-b', total: 40, status: 'paid' },
      { id: 'i1', customer_id: 'cust-b', total: 40, status: 'paid' },
      // The invoice raised for order o1 is the same sale.
      { id: 'i2', customer_id: 'cust-b', order_id: 'o1', total: 100, status: 'paid' },
      // Not paid yet: not a sale.
      { id: 'i3', customer_id: 'cust-b', total: 70, status: 'sent' },
    ],
  }).get(AFF)!;
  assert.equal(r.customers.length, 1);
  assert.equal(r.sales, 2);
  assert.equal(r.revenue, 140);
  assert.equal(r.customers[0].bound, true);
  assert.equal(r.customers[0].orders, 2);
});

test('a guest sale by a bound customer’s email lands on that customer', () => {
  const bound = { id: 'cust-c', affiliate_id: AFF, email: 'c@x.ca', first_name: 'Cy', last_name: '', created_at: '2026-09-10' };
  const r = buildAffiliateReferrals({
    affiliates,
    boundCustomers: [bound],
    commissions: [{ affiliate_id: AFF, order_id: null, invoice_id: 'i9' }],
    orders: [],
    invoices: [{ id: 'i9', customer_id: null, customer_email: 'C@X.ca', total: 60, status: 'paid' }],
  }).get(AFF)!;
  assert.equal(r.customers.length, 1);
  assert.equal(r.customers[0].id, 'cust-c');
  assert.equal(r.customers[0].revenue, 60);
});

test('invoice lines feed "what they buy"', () => {
  const r = buildAffiliateReferrals({
    affiliates,
    boundCustomers: [],
    commissions: [{ affiliate_id: AFF, order_id: null, invoice_id: 'i1' }],
    orders: [],
    invoices: [{ id: 'i1', customer_id: 'cust-d', total: 200, status: 'paid', created_at: '2026-10-03' }],
    invoiceLines: [
      { invoice_id: 'i1', description: 'BPC-157 10mg', qty: 2, unit_price: 100 },
    ],
  }).get(AFF)!;
  assert.deepEqual(r.products, [
    { key: 'bpc-157 10mg', name: 'BPC-157 10mg', quantity: 2, revenue: 200, orders: 1, lastAt: '2026-10-03' },
  ]);
});
