/**
 * Business time zone helpers.
 *
 * The store runs on New York time. Browsers format dates in the viewer's own
 * zone and Vercel functions run in UTC, so anything that turns a date into a
 * calendar day — a label, a "today" default, a group key — goes through here.
 *
 * Two kinds of value come back from the database:
 *  - date-only columns (`issue_date`, `due_date`, ...) as "YYYY-MM-DD". These
 *    are already a calendar day; `new Date("2026-10-04")` reads them as UTC
 *    midnight, which is the evening of Oct 3 in New York, so they must never
 *    be shifted by a time zone.
 *  - timestamps (`created_at`, `paid_at`, ...). These are instants, shown as
 *    the New York day/time they happened in.
 */

export const APP_TIME_ZONE = 'America/New_York';

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateOnly(value: unknown): value is string {
  return typeof value === 'string' && DATE_ONLY_RE.test(value);
}

type DateInput = string | number | Date | null | undefined;

/** Parse a value and pick the zone that renders it as the right calendar day. */
function resolve(value: DateInput): { date: Date; timeZone: string } | null {
  if (value == null || value === '') return null;
  if (isDateOnly(value)) {
    return { date: new Date(`${value}T00:00:00Z`), timeZone: 'UTC' };
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return { date, timeZone: APP_TIME_ZONE };
}

/**
 * Format a date-only value or timestamp as a New York calendar date.
 * Defaults to the medium style ("Oct 4, 2026"); returns `fallback` when the
 * value is empty or unparseable.
 */
export function formatAppDate(
  value: DateInput,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
  locale: string | undefined = undefined,
  fallback = '—',
): string {
  const r = resolve(value);
  if (!r) return fallback;
  return r.date.toLocaleDateString(locale, { ...options, timeZone: r.timeZone });
}

/** Format a timestamp as a New York date and time ("Oct 4, 2026, 9:12 PM"). */
export function formatAppDateTime(
  value: DateInput,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
  locale: string | undefined = undefined,
  fallback = '—',
): string {
  const r = resolve(value);
  if (!r) return fallback;
  return r.date.toLocaleString(locale, { ...options, timeZone: r.timeZone });
}

/** The New York calendar day ("YYYY-MM-DD") a value falls on, or null. */
export function appDayKey(value: DateInput): string | null {
  const r = resolve(value);
  if (!r) return null;
  // en-CA formats as YYYY-MM-DD.
  return r.date.toLocaleDateString('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: r.timeZone,
  });
}

/** Today's date in New York as "YYYY-MM-DD". */
export function todayInAppTz(now: Date = new Date()): string {
  return appDayKey(now) as string;
}

/** Shift a "YYYY-MM-DD" day by a whole number of days. */
export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
