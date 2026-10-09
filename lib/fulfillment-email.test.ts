/**
 * Tests for the "Your Order Has Shipped!" email template.
 *
 *   node --test --import tsx lib/fulfillment-email.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDeliveryWindow,
  fulfillmentEmailSubject,
  parseRecipients,
  renderFulfillmentEmailHtml,
  renderFulfillmentEmailText,
  trackingUrlFor,
  type FulfillmentEmailData,
} from './fulfillment-email';

const SITE = 'https://www.vytabio.com';

const shipped: FulfillmentEmailData = {
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
  assert.equal(fulfillmentEmailSubject(shipped), 'Your VYTA order VYTA-10432 has shipped');
});

test('shipped email without tracking drops the Track button and tracking rows', () => {
  const html = renderFulfillmentEmailHtml({ ...shipped, tracking: { number: null, carrier: null, url: null } }, SITE);
  assert.doesNotMatch(html, /Track Your Order/);
  assert.doesNotMatch(html, /Tracking Number/);
});

test('there is one design: no tracking yet still renders the shipped email', () => {
  const data: FulfillmentEmailData = {
    ...shipped,
    tracking: { number: null, carrier: null, url: null },
    viewOrderUrl: `${SITE}/account/orders/1`,
  };
  const html = renderFulfillmentEmailHtml(data, SITE);
  assert.match(html, /Your Order Has Shipped!/);
  assert.match(html, /shipped-hero\.jpg/);
  assert.doesNotMatch(html, /packed|Pickup/i);
  assert.match(html, /View Order Details/);
});

test('no shipping address on file leaves the address card out', () => {
  const html = renderFulfillmentEmailHtml({ ...shipped, shipTo: undefined }, SITE);
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

test('formatDeliveryWindow: range, single date, or nothing', () => {
  assert.equal(formatDeliveryWindow({ from: '2026-03-27', to: '2026-03-31' }), 'Mar 27, 2026 – Mar 31, 2026');
  assert.equal(formatDeliveryWindow({ from: '2026-03-27', to: null }), 'Mar 27, 2026');
  assert.equal(formatDeliveryWindow({ from: null, to: '2026-03-31' }), 'Mar 31, 2026');
  assert.equal(formatDeliveryWindow({ from: '2026-03-27', to: '2026-03-27' }), 'Mar 27, 2026');
  assert.equal(formatDeliveryWindow({ from: 'soon', to: null }), null);
  assert.equal(formatDeliveryWindow(null), null);
});

test('shipped email shows the estimated delivery in the card, next steps and text', () => {
  const data: FulfillmentEmailData = { ...shipped, estimatedDelivery: { from: '2026-03-27', to: '2026-03-31' } };
  const html = renderFulfillmentEmailHtml(data, SITE);
  assert.match(html, /Estimated Delivery/);
  assert.match(html, /Estimated delivery Mar 27, 2026 – Mar 31, 2026\./);
  assert.match(renderFulfillmentEmailText(data), /Estimated delivery: Mar 27, 2026 – Mar 31, 2026/);
  // Left out when no window is given.
  assert.doesNotMatch(renderFulfillmentEmailHtml(shipped, SITE), /Estimated Delivery/);
});

test('tracking row has a selectable number and copy icon; UPS shows its logo', () => {
  const html = renderFulfillmentEmailHtml(shipped, SITE);
  assert.match(html, /user-select: all;">1Z9VYTA1234567890</);
  assert.match(html, /images\/email\/copy-blue\.png/);
  assert.match(html, /images\/email\/carrier-ups\.png/);
});

test('carriers without a logo file show just their name', () => {
  const html = renderFulfillmentEmailHtml(
    { ...shipped, tracking: { number: '7023210039414604', carrier: 'Canada Post', url: null } },
    SITE,
  );
  assert.match(html, /Canada Post/);
  assert.doesNotMatch(html, /carrier-/);
});

test('parseRecipients: one or several addresses, deduped, invalid ones reported', () => {
  assert.deepEqual(parseRecipients('sam@x.com'), { emails: ['sam@x.com'], invalid: [] });
  assert.deepEqual(parseRecipients(' sam@x.com, ops@y.ca;SAM@x.com  lab@z.org '), {
    emails: ['sam@x.com', 'ops@y.ca', 'lab@z.org'],
    invalid: [],
  });
  assert.deepEqual(parseRecipients('sam@x.com, nope, a@b.test'), {
    emails: ['sam@x.com'],
    invalid: ['nope', 'a@b.test'],
  });
  assert.deepEqual(parseRecipients(''), { emails: [], invalid: [] });
  assert.deepEqual(parseRecipients(undefined), { emails: [], invalid: [] });
});

test('admin copy carries a notice bar above the cover; the customer email has none', () => {
  const copy = renderFulfillmentEmailHtml(shipped, SITE, { notice: 'this shipped email was sent to <sam@x.com> by ops@vytabio.com.' });
  assert.match(copy, /Admin copy<\/strong> — this shipped email was sent to &lt;sam@x\.com&gt;/);
  assert.ok(copy.indexOf('Admin copy') < copy.indexOf('shipped-hero.jpg'));
  assert.doesNotMatch(renderFulfillmentEmailHtml(shipped, SITE), /Admin copy/);
});
