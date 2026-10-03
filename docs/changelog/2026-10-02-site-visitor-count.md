# 2026-10-02 — Site visitors counted whether or not cookies are accepted

## Summary

The Visitors figure in Admin → Analytics was far below real traffic. It was
counted from `customer_activity`, which only records an anonymous visitor
after they press **Accept** on the cookie banner (MARKETING_ATTRIBUTION.md,
"Consent"). Most visitors never answer the banner, so they never counted.

Visitors now comes from a new anonymous daily tally, `site_traffic_daily`:
one row per day holding one number. The same approach already counts landing
page traffic (2026-09-28-landing-page-visitor-counts.md).

**Needs `site-traffic-counters-migration.sql`.** Until it runs, the report
keeps the old consented-only count.

## How it counts

- On the first storefront page a browser opens each (UTC) day, it posts
  `/api/site/visit` once. The browser remembers only that date, in local
  storage (`vyta_last_visit`). No id, cookie value, IP or email is stored,
  which is why it does not wait on the banner.
- Admin and warehouse pages are not counted. Requests from crawler user
  agents are ignored, and the endpoint is rate-limited per IP.
- Writes go through `site_traffic_bump`, a database function that adds one
  per call and can only be executed by the service role.

## What the figure means now

- **Per day:** browsers that visited that day. For a day before the tally
  existed, the old consented count is used (the larger of the two is shown).
- **Range total:** the sum of its days. A visitor who returns on three days
  counts three times, the same way the chart's weekly and monthly bars
  already add up days.
- **Paid-ads (analytics role) view:** unchanged. A tally carries no id, so it
  can't say which visitors an ad brought in; that view keeps counting
  consented visitors with a paid first touch.
- Clearing site data or a private window counts as a new browser.

## Tests

`lib/analytics/site-visit.test.ts`: once per browser per day, staff pages
ignored, blocked storage still counted. 505 tests pass; no new typecheck
errors.
