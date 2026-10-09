/**
 * Tests for the affiliate "You earned a new commission" email template.
 *
 *   node --test --import tsx lib/affiliate-commission-email.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  affiliateCommissionSubject,
  renderAffiliateCommissionHtml,
  renderAffiliateCommissionText,
  type AffiliateCommissionEmailData,
} from './affiliate-commission-email';

const SITE = 'https://www.vytabio.com';

const data: AffiliateCommissionEmailData = {
  affiliateName: 'Al Wasserberger',
  orderNumber: 'LPGUSA-1218',
  orderTotal: 250.99,
  commission: 18.48,
  referralCode: 'ALWASSERBERGER',
  dashboardUrl: `${SITE}/affiliate/dashboard`,
};

test('commission email follows the mock: cover, icon, heading, details, note, button, footer', () => {
  const html = renderAffiliateCommissionHtml(data, SITE);
  assert.match(html, /images\/email\/affiliate-hero\.jpg/);
  assert.doesNotMatch(html, /shipped-hero\.jpg/);
  assert.match(html, /images\/email\/affiliate-network\.png/);
  assert.match(html, /Affiliate Notification/);
  assert.match(html, /You earned a new commission/);
  assert.match(html, /A customer just placed an order using your affiliate link or code\./);
  for (const label of ['Order Number', 'Order Total', 'Commission Earned', 'Affiliate', 'Referral Code']) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /LPGUSA-1218/);
  assert.match(html, /\$250\.99/);
  assert.match(html, /\$18\.48/);
  assert.match(html, /Al Wasserberger/);
  assert.match(html, /ALWASSERBERGER/);
  assert.match(html, /images\/email\/copy-blue\.png/);
  assert.match(html, /images\/email\/coins-teal\.png/);
  assert.match(html, /Your commission has been recorded/);
  assert.match(html, /and will be included in your next payout\./);
  assert.match(html, /View Affiliate Dashboard/);
  assert.match(html, /href="https:\/\/www\.vytabio\.com\/affiliate\/dashboard"/);
  assert.match(html, />vytabio\.com</);
});

test('subject names the amount and the order', () => {
  assert.equal(affiliateCommissionSubject(data), 'You earned a $18.48 commission on order LPGUSA-1218');
});

test('rows without a value are left out', () => {
  const html = renderAffiliateCommissionHtml({ ...data, affiliateName: '', referralCode: null }, SITE);
  assert.doesNotMatch(html, /Referral Code/);
  assert.doesNotMatch(html, />Affiliate</);
  assert.match(html, /Commission Earned/);
});

test('escapes affiliate data', () => {
  const html = renderAffiliateCommissionHtml({ ...data, affiliateName: '<b>x</b>', orderNumber: 'A&B' }, SITE);
  assert.doesNotMatch(html, /<b>x<\/b>/);
  assert.match(html, /A&amp;B/);
});

test('plain-text version carries the same facts', () => {
  const text = renderAffiliateCommissionText(data);
  assert.match(text, /Hi Al Wasserberger,/);
  assert.match(text, /Order number: LPGUSA-1218/);
  assert.match(text, /Order total: \$250\.99/);
  assert.match(text, /Commission earned: \$18\.48/);
  assert.match(text, /Referral code: ALWASSERBERGER/);
  assert.match(text, /next payout/);
  assert.match(text, /\/affiliate\/dashboard/);
});
