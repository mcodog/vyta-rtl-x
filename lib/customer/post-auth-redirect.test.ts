/**
 *   node --test --import tsx lib/customer/post-auth-redirect.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { authHref, isOrderRedirect, safeRedirect } from './post-auth-redirect';

test('only same-site paths are followed', () => {
  assert.equal(safeRedirect('/account/orders/x?claim=y'), '/account/orders/x?claim=y');
  assert.equal(safeRedirect('https://evil.example'), null);
  assert.equal(safeRedirect('//evil.example'), null);
  assert.equal(safeRedirect('/\\evil.example'), null);
  assert.equal(safeRedirect(''), null);
  assert.equal(safeRedirect(null), null);
});

test('recognises the order page', () => {
  assert.equal(isOrderRedirect('/account/orders/abc?claim=1'), true);
  assert.equal(isOrderRedirect('/account/orders'), false);
  assert.equal(isOrderRedirect('/'), false);
});

test('auth links carry the destination and email', () => {
  assert.equal(authHref('/login', '/', null), '/login');
  assert.equal(
    authHref('/signup', '/account/orders/abc?claim=t', 'a@b.co'),
    '/signup?redirect=%2Faccount%2Forders%2Fabc%3Fclaim%3Dt&email=a%40b.co',
  );
  assert.equal(authHref('/login', 'https://evil.example', ''), '/login');
});
