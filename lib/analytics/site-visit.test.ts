/**
 * Unit tests for the site visitor count: once per browser per day, staff pages
 * ignored, blocked storage still counted.
 *
 * Run with a TS-aware loader, e.g.
 * `node --test --import tsx lib/analytics/site-visit.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldCountSiteVisit, SITE_VISIT_KEY } from './site-visit';

function memoryStore() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

test('a browser is counted once a day', () => {
  const local = memoryStore();
  assert.equal(shouldCountSiteVisit('/', local, '2026-10-02'), true);
  assert.equal(local.map.get(SITE_VISIT_KEY), '2026-10-02');
  // Another page, a reload or a new tab the same day is the same visitor.
  assert.equal(shouldCountSiteVisit('/products', local, '2026-10-02'), false);
  // The next day it counts again.
  assert.equal(shouldCountSiteVisit('/', local, '2026-10-03'), true);
});

test('staff pages are not storefront traffic', () => {
  const local = memoryStore();
  assert.equal(shouldCountSiteVisit('/admin/analytics', local, '2026-10-02'), false);
  assert.equal(shouldCountSiteVisit('/warehouse', local, '2026-10-02'), false);
  // ...and do not use up the day's count either.
  assert.equal(local.map.has(SITE_VISIT_KEY), false);
  assert.equal(shouldCountSiteVisit('/administrators-guide', local, '2026-10-02'), true);
});

test('a browser that blocks storage is still counted', () => {
  const throwing = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  assert.equal(shouldCountSiteVisit('/', throwing, '2026-10-02'), true);
  assert.equal(shouldCountSiteVisit('/', null, '2026-10-02'), true);
});
