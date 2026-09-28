/**
 * Unit tests for landing pages: slugs, the link a page's button uses, the
 * offer a page may print, and the admin form.
 *
 * Node's built-in runner, like the rest of the repo:
 *   node --test --import tsx lib/promos/landing.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  landingCtaUrl,
  landingOfferFrom,
  normalizeDestinationPath,
  normalizeLandingDomain,
  normalizeLandingSlug,
  shapeLandingPageInput,
  suggestLandingCode,
} from './landing';
import { exclusionsPhrase, landingFinePrint } from './landing-server';
import {
  decodeTouch,
  encodeTouch,
  isMeaningfulTouch,
  parseTouch,
} from '../analytics/attribution';

const code = {
  code: 'STANDARDS35',
  discount_type: 'percent' as const,
  discount_value: 35,
  active: true,
  starts_at: null,
  expires_at: null,
  first_order_only: true,
  excluded_product_ids: ['11111111-1111-4111-8111-111111111111'],
};

test('slugs forgive case and whitespace, and nothing else', () => {
  assert.equal(normalizeLandingSlug(' Standards '), 'standards');
  assert.equal(normalizeLandingSlug('first-order-35'), 'first-order-35');
  assert.equal(normalizeLandingSlug('my_page'), null);
  assert.equal(normalizeLandingSlug('a'), null);
  assert.equal(normalizeLandingSlug('-lead'), null);
  assert.equal(normalizeLandingSlug('x'.repeat(41)), null);
  assert.equal(normalizeLandingSlug(null), null);
  assert.equal(normalizeLandingSlug(''), null);
});

test('a destination is a path on this site, never somewhere else', () => {
  assert.equal(normalizeDestinationPath('/products'), '/products');
  assert.equal(normalizeDestinationPath('/products/bpc-157'), '/products/bpc-157');
  assert.equal(normalizeDestinationPath('https://evil.example'), '/products');
  assert.equal(normalizeDestinationPath('//evil.example'), '/products');
  assert.equal(normalizeDestinationPath('/\\evil.example'), '/products');
  assert.equal(normalizeDestinationPath(''), '/products');
});

test('the button link carries the slug', () => {
  assert.equal(
    landingCtaUrl('https://www.vytabio.com', '/products', 'standards'),
    'https://www.vytabio.com/products?lp=standards',
  );
  // A hostile destination cannot make the link leave the site.
  assert.equal(
    landingCtaUrl('https://www.vytabio.com', '//evil.example', 'standards'),
    'https://www.vytabio.com/products?lp=standards',
  );
});

test('a live percentage code is an offer a page may print', () => {
  const offer = landingOfferFrom('standards', code);
  assert.equal(offer.percent, 35);
  assert.equal(offer.code, 'STANDARDS35');
  assert.equal(offer.firstOrderOnly, true);
  assert.deepEqual(offer.excludedProductIds, code.excluded_product_ids);
});

test('anything that would not be honoured at checkout offers nothing', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  assert.equal(landingOfferFrom('s', null).percent, 0);
  assert.equal(landingOfferFrom('s', { ...code, active: false }).percent, 0);
  assert.equal(landingOfferFrom('s', { ...code, discount_type: 'fixed' }).percent, 0);
  assert.equal(landingOfferFrom('s', { ...code, discount_value: 0 }).percent, 0);
  assert.equal(
    landingOfferFrom('s', { ...code, starts_at: '2026-10-02T00:00:00Z' }, now).percent,
    0,
  );
  assert.equal(
    landingOfferFrom('s', { ...code, expires_at: '2026-09-30T00:00:00Z' }, now).percent,
    0,
  );
  // And none of those leak the code.
  assert.equal(landingOfferFrom('s', { ...code, active: false }).code, null);
});

test('the fine print says exactly what checkout does', () => {
  assert.equal(
    exclusionsPhrase([
      'Bacteriostatic Water 10mL',
      'Bacteriostatic Water 30mL',
      'Bacteriostatic Water Pfizer 30mL',
    ]),
    'bacteriostatic water',
  );
  assert.equal(exclusionsPhrase(['Bacteriostatic Water 3mL', 'Syringes']), 'bacteriostatic water and Syringes');
  assert.equal(exclusionsPhrase([]), null);
  assert.equal(exclusionsPhrase(['A', 'B', 'C', 'D', 'E']), 'A, B, C and 2 more');

  const offer = landingOfferFrom('standards', code);
  assert.equal(
    landingFinePrint(offer, 'bacteriostatic water'),
    '*First order only. Excludes bacteriostatic water.',
  );
  assert.equal(landingFinePrint({ ...offer, firstOrderOnly: false }, null), null);
});

test('?lp= is recorded on the touch, and alone makes the visit worth recording', () => {
  const touch = parseTouch({
    url: 'https://www.vytabio.com/products?lp=Standards&utm_source=facebook&utm_medium=paid_social&fbclid=abc',
    referrer: 'https://getvyta.ca/',
  });
  assert.equal(touch.landing_page, 'standards');
  assert.equal(touch.channel, 'meta_ads');
  assert.equal(touch.referrer_host, 'getvyta.ca');

  const bare = parseTouch({ url: 'https://www.vytabio.com/?lp=standards', referrer: null });
  assert.equal(bare.channel, 'direct');
  assert.equal(isMeaningfulTouch(bare), true);

  const junk = parseTouch({ url: 'https://www.vytabio.com/?lp=not_valid' });
  assert.equal(junk.landing_page, null);
  assert.equal(isMeaningfulTouch(junk), false);
});

test('the landing page survives the attribution cookie', () => {
  const touch = parseTouch({ url: 'https://www.vytabio.com/products?lp=standards&fbclid=x' });
  assert.deepEqual(decodeTouch(encodeTouch(touch)), touch);
  // A cookie written before this change still decodes, with no landing page.
  const legacy = encodeURIComponent(JSON.stringify({ c: 'google_ads', a: '2026-09-01T00:00:00Z' }));
  assert.equal(decodeTouch(legacy)?.landing_page, null);
});

test('domains are reduced to a host', () => {
  assert.equal(normalizeLandingDomain('https://www.GetVyta.ca/offer?x=1'), 'www.getvyta.ca');
  assert.equal(normalizeLandingDomain('getvyta.ca'), 'getvyta.ca');
  assert.equal(normalizeLandingDomain(''), null);
  assert.equal(normalizeLandingDomain('not a domain'), null);
});

test('a suggested code follows the slug and the percentage', () => {
  assert.equal(suggestLandingCode('standards', 35), 'STANDARDS35');
  assert.equal(suggestLandingCode('first-order', 12.5), 'FIRSTORDER13');
  assert.equal(suggestLandingCode('', 20), 'WELCOME20');
});

test('the admin form is validated', () => {
  const good = shapeLandingPageInput({
    slug: 'Standards',
    name: 'Meta — standards',
    domain: 'https://getvyta.ca/',
    destination_path: '/products',
    offer: { percent: '35', excluded_product_ids: ['x'] },
  });
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.value.slug, 'standards');
    assert.equal(good.value.domain, 'getvyta.ca');
    assert.equal(good.value.offer?.code, 'STANDARDS35');
    // First order only unless switched off — the offer is a welcome offer.
    assert.equal(good.value.offer?.first_order_only, true);
  }

  const noOffer = shapeLandingPageInput({ slug: 'plain', name: 'Plain', offer: null });
  assert.equal(noOffer.ok && noOffer.value.offer, null);

  assert.equal(shapeLandingPageInput({ slug: 'x', name: 'n' }).ok, false);
  assert.equal(shapeLandingPageInput({ slug: 'ok', name: '' }).ok, false);
  assert.equal(shapeLandingPageInput({ slug: 'ok', name: 'n', destination_path: 'https://x.y' }).ok, false);
  assert.equal(shapeLandingPageInput({ slug: 'ok', name: 'n', offer: { percent: 0 } }).ok, false);
  assert.equal(shapeLandingPageInput({ slug: 'ok', name: 'n', domain: 'nope' }).ok, false);
});
