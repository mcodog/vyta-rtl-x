/**
 * Browser-side half of the site visitor count.
 *
 * Each browser reports itself to POST /api/site/visit once per (UTC) day, as an
 * anonymous tally — the Visitors figure in Admin → Analytics. The only thing
 * kept in the browser is the date it was last counted; no id is minted and
 * nothing sent identifies the browser, which is why this is recorded whether
 * or not the cookie banner was accepted. See site-traffic-counters-migration.sql.
 */

/** localStorage: the 'YYYY-MM-DD' this browser was last counted. */
export const SITE_VISIT_KEY = 'vyta_last_visit';

/** Paths that are staff tools, not storefront traffic. */
const STAFF_PREFIXES = ['/admin', '/warehouse'];

/** The slice of Storage this needs, so tests can hand in a plain object. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Decide whether this page load is a visit worth counting, and record that it
 * has been. True the first time this browser opens a storefront page today.
 *
 * A storage that throws (a browser blocking site data) is treated as empty:
 * the visit still counts, and at worst such a browser counts once per page
 * load — better than missing it.
 */
export function shouldCountSiteVisit(
  pathname: string,
  local: KeyValueStore | null,
  today: string,
): boolean {
  if (STAFF_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return false;
  try {
    if (local?.getItem(SITE_VISIT_KEY) === today) return false;
    local?.setItem(SITE_VISIT_KEY, today);
  } catch {
    /* no local storage — count it */
  }
  return true;
}

let reported = false;

/**
 * Report today's visit, if it hasn't been. Fire-and-forget: never throws, never
 * delays the page, and a failure costs one tally.
 */
export function reportSiteVisit(pathname: string): void {
  if (typeof window === 'undefined' || reported) return;
  let local: KeyValueStore | null = null;
  try {
    local = window.localStorage;
  } catch {
    /* blocked */
  }
  if (!shouldCountSiteVisit(pathname, local, new Date().toISOString().slice(0, 10))) return;
  // Also guarded in memory: React runs effects twice in development.
  reported = true;
  try {
    void fetch('/api/site/visit', { method: 'POST', credentials: 'omit', keepalive: true }).catch(() => {});
  } catch {
    /* best-effort */
  }
}
