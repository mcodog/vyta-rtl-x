# 2026-09-28 — Landing pages: an offer on another domain, honoured here

## Summary

A landing page on its own domain can now send visitors to vytabio.com with
`?lp=<slug>`, and from then on the store:

1. **records where they came from.** The landing page is stored on the
   visitor's first/last touch, on their visitor row, on their customer row
   when they sign up, and on every hosted order they place;
2. **honours the landing page's discount.** Its code is put into the
   checkout's discount field automatically, and the hand-off applies it
   server-side even when the browser never sent it.

The landing page reads the percentage it prints from
`GET /api/landing/<slug>`, which returns that same code's percentage. So the
number on the page, the code in the field and the money taken off all come
from one discount-code row, and changing it in admin changes all three.

Setup, the landing-page contract, deployment, ad parameters, a test plan and
the design scheme are in [`LANDING_PAGES.md`](../../LANDING_PAGES.md). A
ready-to-deploy page is in [`landing-page/`](../../landing-page/index.html).

**Needs `landing-pages-migration.sql`.** Until it runs, everything works as
before and no landing offer is applied (money fails closed).

## What changed

**Discount codes gained two restrictions**, available to every code:

- *First order only*: refused to a buyer with a paid order or a checkout
  awaiting payment, checked by account **and by email**, so a guest checkout
  counts (`firstOrderStatus` in `lib/promos/first-order.ts`). Only a signed-in
  buyer is checked at preview; a guest is checked at hand-off with the email
  they pay with, so the preview endpoint can't be used to ask whether an
  address has ordered.
- *Excluded products*: the percentage comes off every other line. Needed for
  "*excluding Bac water". Lines with different percentages are split by
  `distributeLineDiscounts`, which groups lines by percentage and runs the
  existing buyer-favourable split per group. An order where every line shares
  one percentage is priced exactly as before.

A form that predates these fields no longer resets them on a full edit: they
are only written when the payload carries them.

**Code vs. paid-ads welcome discount** is now compared by what each takes off
the whole order, since a code with exclusions only discounts part of it. With
no exclusions this is the same percentage comparison as before.

**Storefront.** `PromosContext` resolves the landing offer, only for
browsers carrying the `vyta_lp` cookie. The nav notice shows the landing
percentage instead of the ad offer (a landing visitor from a Meta ad also
counts as ad traffic, and "25%" after a page said "35%" would read as bait and
switch). The cart shows the saving on eligible lines. The checkout fills the
discount field, labels it "Applied automatically from your welcome offer",
names the lines it doesn't discount, and remembers if the buyer removes it
(`declineLandingOffer`, so the hand-off doesn't put it back).

**Admin → Marketing → Landing Pages.** Create a page and its offer in one
form (the code is created alongside), copy the button link and API URL, and see
visitors, sign-ups, checkouts, purchasers, paid orders, revenue and discounts
per page for any range. The discount-code modal edits the two restrictions
too, and codes that belong to a landing page are tagged in the list.

## Database

`landing-pages-migration.sql` adds `landing_pages`,
`discount_codes.first_order_only` and `excluded_product_ids`,
`visitor_attribution.first_landing_page` and `last_landing_page`,
`customers.attribution_landing_page`, and `puramass_orders.landing_page`.
Every writer sheds the new columns when the database doesn't know them yet.
Code reads moved to `select('*')` so they never name a column that might not
exist.

## Tests

`lib/promos/landing.test.ts` is new. New cases in `discount-codes.test.ts`,
`ad-discount.test.ts` and `first-order.test.ts`. 496 tests pass (464 before).
No new typecheck errors against the baseline.
