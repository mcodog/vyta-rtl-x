/**
 * Tests for the order confirmation email template.
 *
 *   node --test --import tsx lib/order-confirmation-email.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adminOrderPaidSubject,
  formatOrderDate,
  renderAdminOrderPaidHtml,
  renderAdminOrderPaidText,
  orderConfirmationSubject,
  renderOrderConfirmationHtml,
  renderOrderConfirmationText,
  type AdminOrderPaidEmailData,
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
  assert.ok(html.includes("url('https://www.vytabio.com/images/email/order-hero.jpg')"));
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

const admin: AdminOrderPaidEmailData = {
  order: { ...base, to: '' },
  source: 'stealth_health',
  paidVia: 'checkout',
  customer: { name: 'Marguerite P', email: 'm@buyer.ca', phone: '289-489-1471' },
  courier: 'Canada Post Expedited',
  discountCode: 'VYTA20',
  stockWarnings: ['Custom blend × 1'],
  invoiceUrl: 'https://www.vytabio.com/admin/invoices/abc',
};

test('admin email: same design, admin details, no customer-only sections', () => {
  const html = renderAdminOrderPaidHtml(admin, 'https://www.vytabio.com');
  assert.equal(adminOrderPaidSubject(admin), 'New order: INV-1016 · Marguerite P · $364.80 CAD');
  assert.match(html, /New order<br><span[^>]*>paid\.<\/span>/);
  assert.ok(html.includes("url('https://www.vytabio.com/images/email/order-hero.jpg')"));
  assert.match(html, /Payment was collected on the Stealth Health checkout/);
  assert.match(html, /\$266\.00/);
  assert.match(html, /Discount <span[^>]*>\(VYTA20 \+ 5% limited-time offer\)<\/span>/);
  assert.match(html, /322 Locheed Dr/);
  assert.match(html, /mailto:m@buyer\.ca/);
  assert.match(html, /Canada Post Expedited/);
  assert.match(html, /Stock was not taken for:/);
  assert.match(html, /Custom blend × 1/);
  assert.ok(html.includes('href="https://www.vytabio.com/admin/invoices/abc"'));
  assert.ok(!html.includes('View Order Details'));
  assert.ok(!html.includes('What Happens Next'));
  assert.ok(!/<svg/i.test(html));
});

test('admin email for a manual invoice', () => {
  const manual: AdminOrderPaidEmailData = {
    ...admin,
    source: 'manual',
    paidVia: 'admin',
    courier: null,
    discountCode: null,
    stockWarnings: [],
    customer: { name: null, email: null, phone: null },
  };
  const html = renderAdminOrderPaidHtml(manual, 'https://www.vytabio.com');
  assert.equal(adminOrderPaidSubject(manual), 'Invoice paid: INV-1016 · Guest · $364.80 CAD');
  assert.match(html, /Invoice<br><span[^>]*>paid\.<\/span>/);
  assert.match(html, /This manual invoice is marked paid\./);
  assert.match(html, /Guest — no contact details\./);
  assert.ok(!html.includes('Stock was not taken'));
  assert.ok(!html.includes('Flat-rate shipping'));
  const text = renderAdminOrderPaidText(manual);
  assert.match(text, /^INVOICE PAID/);
  assert.match(text, /View invoice: https:\/\/www\.vytabio\.com\/admin\/invoices\/abc/);
});
