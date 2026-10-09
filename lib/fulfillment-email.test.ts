/**
 * Tests for the packed / shipped email templates.
 *
 *   node --test --import tsx lib/fulfillment-email.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fulfillmentEmailSubject,
  renderFulfillmentEmailHtml,
  renderFulfillmentEmailText,
  trackingUrlFor,
  type FulfillmentEmailData,
} from './fulfillment-email';

const SITE = 'https://www.vytabio.com';

const shipped: FulfillmentEmailData = {
  kind: 'shipped',
  fulfillmentType: 'shipment',
  customerName: 'Sam Lee',
  orderNumber: 'VYTA-10432',
  orderDate: '2026-03-24',
  items: [{ name: 'SS-31', strength: '50mg', quantity: 2, price: 129, unit: 'vial' }],
  shipTo: { name: 'Sam Lee', lines: ['123 Research Drive', 'Toronto, ON M5V 2T6', 'Canada'], phone: null },
  tracking: { number: '1Z9VYTA1234567890', carrier: 'UPS', url: null },
};

test('trackingUrlFor prefers the stored URL, else builds the carrier link', () => {
  assert.equal(trackingUrlFor({ number: 'X1', carrier: 'UPS', url: 'https://track.example/abc' }), 'https://track.example/abc');
  assert.equal(trackingUrlFor({ number: '1Z 9', carrier: 'UPS Standard', url: null }), 'https://www.ups.com/track?tracknum=1Z%209');
  assert.match(trackingUrlFor({ number: '123', carrier: 'Canada Post', url: '' })!, /canadapost-postescanada\.ca/);
  assert.equal(trackingUrlFor({ number: '123', carrier: 'Some Courier', url: null }), null);
  assert.equal(trackingUrlFor({ number: null, carrier: 'UPS', url: null }), null);
  assert.equal(trackingUrlFor(undefined), null);
});

test('shipped email: cover, tracking, items, address and Track button', () => {
  const html = renderFulfillmentEmailHtml(shipped, SITE);
  assert.match(html, /Your Order Has Shipped!/);
  assert.match(html, /images\/email\/shipped-hero\.jpg/);
  assert.match(html, /1Z9VYTA1234567890/);
  assert.match(html, /Track Your Order/);
  assert.match(html, /https:\/\/www\.ups\.com\/track\?tracknum=1Z9VYTA1234567890/);
  assert.match(html, /Items Shipped/);
  assert.match(html, /\$258\.00/);
  assert.match(html, /Shipping Address/);
  assert.match(html, /March 24, 2026/);
  assert.match(html, /Hi Sam Lee, great news!/);
  assert.equal(fulfillmentEmailSubject(shipped), 'Your VYTA order VYTA-10432 is on its way');
});

test('shipped email without tracking drops the Track button and tracking rows', () => {
  const html = renderFulfillmentEmailHtml({ ...shipped, tracking: { number: null, carrier: null, url: null } }, SITE);
  assert.doesNotMatch(html, /Track Your Order/);
  assert.doesNotMatch(html, /Tracking Number/);
});

test('packed email uses the cropped cover and no tracking', () => {
  const data: FulfillmentEmailData = { ...shipped, kind: 'packed', viewOrderUrl: `${SITE}/account/orders/1` };
  const html = renderFulfillmentEmailHtml(data, SITE);
  assert.match(html, /Your Order Has Been Packed!/);
  assert.match(html, /packed-hero\.jpg/);
  assert.doesNotMatch(html, /Tracking Number/);
  assert.match(html, /View Order Details/);
  assert.equal(fulfillmentEmailSubject(data), 'Your VYTA order VYTA-10432 has been packed');
});

test('pickup emails skip the shipping address', () => {
  const html = renderFulfillmentEmailHtml({ ...shipped, kind: 'packed', fulfillmentType: 'pickup' }, SITE);
  assert.match(html, /Ready for Pickup/);
  assert.doesNotMatch(html, /Shipping Address/);
});

test('escapes customer data', () => {
  const html = renderFulfillmentEmailHtml({ ...shipped, customerName: '<b>x</b>', orderNumber: 'A&B' }, SITE);
  assert.doesNotMatch(html, /<b>x<\/b>/);
  assert.match(html, /A&amp;B/);
});

test('plain text carries the essentials', () => {
  const text = renderFulfillmentEmailText(shipped);
  assert.match(text, /YOUR ORDER HAS SHIPPED!/);
  assert.match(text, /Tracking number: 1Z9VYTA1234567890/);
  assert.match(text, /Carrier: UPS/);
  assert.match(text, /Track your order: https:\/\/www\.ups\.com/);
  assert.match(text, /SS-31 50mg \(Single vial\) × 2 — \$258\.00/);
});
