/**
 * Tests for the order confirmation email template.
 *
 *   node --test --import tsx lib/order-confirmation-email.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatOrderDate,
  orderConfirmationSubject,
  renderOrderConfirmationHtml,
  renderOrderConfirmationText,
} from './order-confirmation-email';
import type { ConfirmationEmailData } from './order-confirmation-data';

const base: ConfirmationEmailData = {
  to: 'm@buyer.ca',
  customerName: 'Marguerite <b>',
  orderNumber: 'INV-1016',
  items: [
    { name: 'GLP-3 20mg', quantity: 2, price: 133, unit: 'vial', imageUrl: 'https://www.vytabio.com/images/products/GLP-3%2020mg.png' },
    { name: 'MOTS C 40mg', quantity: 1, price: 214, unit: 'case', vialsPerBox: 5 },
  ],
  subtotal: 480,
  discount: 115.2,
  discountLabel: 'VYTA20 + 5% limited-time offer',
  shipping: 0,
  total: 364.8,
  currency: 'CAD',
  orderDate: '2026-10-04T18:00:00Z',
  paymentStatus: 'Paid',
  tax: 0,
  shipTo: { name: 'Marguerite P', lines: ['322 Locheed Dr', 'Hamilton, ON L8T 4Z6', 'Canada'], phone: '289-489-1471' },
  viewOrderUrl: 'https://www.vytabio.com/login?redirect=%2Faccount%2Forders%2Fabc%3Fclaim%3Dx&email=m%40buyer.ca',
};

test('dates render as the store-local long date', () => {
  assert.equal(formatOrderDate('2026-10-04T18:00:00Z'), 'October 4, 2026');
  assert.equal(formatOrderDate('2026-10-05'), 'October 5, 2026');
  // 02:00 UTC on Oct 5 is still Oct 4 in New York.
  assert.equal(formatOrderDate('2026-10-05T02:00:00Z'), 'October 4, 2026');
  assert.equal(formatOrderDate('nope'), null);
  assert.equal(formatOrderDate(undefined), null);
});

test('subject is unchanged', () => {
  assert.equal(orderConfirmationSubject(base), 'Order Confirmed - INV-1016');
});

test('html carries every section, escaped', () => {
  const html = renderOrderConfirmationHtml(base, 'https://www.vytabio.com/');
  assert.match(html, /Thank you<br>for <span[^>]*>your order\.<\/span>/);
  assert.match(html, /INV-1016/);
  assert.match(html, /October 4, 2026/);
  assert.match(html, /\$266\.00/); // 2 × 133
  assert.match(html, /Pack of 5/);
  assert.match(html, /Single vial/);
  assert.match(html, /\$364\.80 CAD/);
  assert.ok(!html.includes('You saved'));
  assert.match(html, /Discount <span[^>]*>\(VYTA20 \+ 5% limited-time offer\)<\/span>/);
  assert.match(html, /-\$115\.20/);
  // Lucide / Font Awesome icons as hosted PNGs, never emoji or inline SVG.
  for (const name of ['file-text-blue', 'calendar-blue', 'check-teal', 'map-pin-blue', 'package-blue', 'truck-blue', 'package-open-blue', 'mail-blue', 'shield-check-white', 'canadian-maple-leaf-white', 'arrow-right-white']) {
    assert.ok(html.includes(`src="https://www.vytabio.com/images/email/${name}.png"`), name);
  }
  assert.ok(!/<svg/i.test(html));
  assert.ok(!/&#1\d{5};/.test(html), 'no emoji entities');
  assert.match(html, /322 Locheed Dr/);
  assert.match(html, /View Order Details/);
  assert.ok(html.includes('href="https://www.vytabio.com/login?redirect=%2Faccount%2Forders%2Fabc%3Fclaim%3Dx&amp;email=m%40buyer.ca"'));
  assert.ok(html.includes('src="https://www.vytabio.com/images/vyta-mark.png"'));
  assert.ok(html.includes('Marguerite &lt;b&gt;'));
  assert.ok(!html.includes('Marguerite <b>'));
  assert.match(html, /For research purposes only/);
});

test('optional sections drop out cleanly', () => {
  const { viewOrderUrl: _u, shipTo: _s, orderDate: _d, tax: _t, ...rest } = base;
  const { discountLabel: _l, ...noLabel } = rest;
  const html = renderOrderConfirmationHtml({ ...noLabel, discount: 10 }, 'https://www.vytabio.com');
  assert.ok(!html.includes('View Order Details'));
  assert.ok(!html.includes('Shipping Address'));
  assert.ok(!html.includes('Order Date'));
  assert.match(html, /-\$10\.00/);
  assert.ok(!html.includes('(VYTA20'));
  assert.match(html, /Free/);
});

test('plain-text body mirrors the html', () => {
  const text = renderOrderConfirmationText(base);
  assert.match(text, /Order number: INV-1016/);
  assert.match(text, /GLP-3 20mg \(Single vial\) × 2 — \$266\.00/);
  assert.match(text, /Discount \(VYTA20 \+ 5% limited-time offer\): -\$115\.20/);
  assert.match(text, /Total: \$364\.80 CAD/);
  assert.match(text, /View your order/);
});
