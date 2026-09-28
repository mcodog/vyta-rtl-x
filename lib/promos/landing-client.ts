/**
 * Browser-side half of landing pages: counting the click-through.
 *
 * When a page loads with `?lp=<slug>`, someone pressed a landing page's button
 * and arrived. That is reported to POST /api/landing/<slug>/arrive as an
 * anonymous tally — once per browser tab session, and flagged `first` the very
 * first time this browser arrives through that page, which is what the report
 * counts as a new visitor.
 *
 * The only things kept in the browser are the slug and the day, in session and
 * local storage — no id is minted, and nothing sent identifies the browser.
 * See landing-page-counters-migration.sql for why these tallies count every
 * visitor while the per-visitor journey waits for the cookie banner.
 */
import { LANDING_PARAM, normalizeLandingSlug } from './landing';

/** localStorage: `{ [slug]: 'YYYY-MM-DD' }` of pages this browser arrived through. */
export const LANDING_SEEN_KEY = 'vyta_lp_seen';
/** sessionStorage prefix: this tab has already reported its arrival. */
export const LANDING_ARRIVED_PREFIX = 'vyta_lp_arrived:';

/** The slice of Storage this needs, so tests can hand in a plain object. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Decide whether this page load is an arrival worth counting, and record that
 * it has been. Returns null when there is nothing to report: no valid `?lp=`,
 * or this tab already reported it (a reload, or the back button).
 *
 * A storage that throws (a browser blocking site data) is treated as empty:
 * the arrival still counts, and at worst a reload in such a browser counts
 * twice — better than missing the visit.
 */
export function landingArrival(
  search: string,
  storage: { session: KeyValueStore | null; local: KeyValueStore | null },
  today: string,
): { slug: string; first: boolean } | null {
  let slug: string | null = null;
  try {
    slug = normalizeLandingSlug(new URLSearchParams(search).get(LANDING_PARAM));
  } catch {
    return null;
  }
  if (!slug) return null;

  const sessionKey = `${LANDING_ARRIVED_PREFIX}${slug}`;
  try {
    if (storage.session?.getItem(sessionKey)) return null;
    storage.session?.setItem(sessionKey, '1');
  } catch {
    /* no session storage — count it */
  }

  let first = true;
  try {
    const seen = JSON.parse(storage.local?.getItem(LANDING_SEEN_KEY) || '{}') as Record<string, string>;
    first = !(seen && typeof seen === 'object' && seen[slug]);
    storage.local?.setItem(LANDING_SEEN_KEY, JSON.stringify({ ...(seen || {}), [slug]: today }));
  } catch {
    /* no local storage — a visitor we cannot tell apart, counted as new */
  }
  return { slug, first };
}

const reported = new Set<string>();

/**
 * Report this page load's landing arrival, if it is one. Fire-and-forget:
 * never throws, never delays the page, and a failure costs one tally.
 */
export function reportLandingArrival(): void {
  if (typeof window === 'undefined') return;
  const safe = (get: () => Storage): KeyValueStore | null => {
    try {
      return get();
    } catch {
      return null;
    }
  };
  const arrival = landingArrival(
    window.location.search,
    { session: safe(() => window.sessionStorage), local: safe(() => window.localStorage) },
    new Date().toISOString().slice(0, 10),
  );
  // Also guarded in memory: React runs effects twice in development.
  if (!arrival || reported.has(arrival.slug)) return;
  reported.add(arrival.slug);
  try {
    void fetch(`/api/landing/${encodeURIComponent(arrival.slug)}/arrive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ first: arrival.first }),
      credentials: 'omit',
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* best-effort */
  }
}
