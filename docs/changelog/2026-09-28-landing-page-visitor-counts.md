# 2026-09-28 — Landing page visitors counted whether or not cookies are accepted

## Summary

A test visit from a fresh incognito window never appeared in Admin → Landing
Pages. The report counted visitors from `visitor_attribution`, and that table
only records an anonymous visitor after they press **Accept** on the cookie
banner (MARKETING_ATTRIBUTION.md, "Consent"). A fresh window always shows the
banner, and most real ad visitors ignore it, so the column missed nearly
everyone.

Every figure on the report now comes from data that doesn't wait on the
banner:

| Column | From |
| --- | --- |
| Page views, Clicked through, Visitors | New anonymous daily tallies per landing page (`landing_page_daily`) |
| Sign-ups | `customers.attribution_landing_page` |
| Checkouts, Purchasers, Paid orders, Revenue, Discounts | `puramass_orders.landing_page` |

**Needs `landing-page-counters-migration.sql`.** Until it runs, the three
traffic columns show "—" with a banner saying why; the rest of the report
works.

## How the tallies stay anonymous

`landing_page_daily` is one row per page per day holding three integers. It
has no visitor id, cookie value, IP or email, which is why it is written for
everyone while the per-visitor journey still waits for consent.

- **Page views:** `GET /api/landing/<slug>` adds one after responding. The
  landing page calls it once per load.
- **Click-throughs:** on entry to a storefront page carrying `?lp=`, the
  browser posts `/api/landing/<slug>/arrive` once per tab session (a reload
  isn't another click-through).
- **Visitors:** that post says `first: true` the first time this browser
  arrives through that page. The browser remembers only `{slug: date}` in
  local storage to know.

Writes go through `landing_page_bump`, a database function that adds at most
one of each per call, only for slugs that exist, and can only be executed by
the service role. The arrival endpoint is rate-limited per IP.

## Tests

`lib/promos/landing.test.ts` covers the arrival rules: once per tab, first
once per browser, junk slugs ignored, blocked storage still counted. Verified
in a fresh browser against the dev server with the banner unanswered: the
existing tracking call is refused (`consent: false`) and the click-through is
counted (`first: true`). A reload adds nothing, and a new tab adds a
click-through but not a visitor. 499 tests pass; no new typecheck errors.
