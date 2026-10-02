# 2026-10-02 — Landing page: 20% / VYTA20 copy, and no more number flash

## Summary

The reference landing page (`landing-page/index.html`) gets new copy, and stops
showing one percentage and then another.

**Copy**

| | Before | After |
| --- | --- | --- |
| Headline | Your First Order Is 35% Off* | Claim 20% Off Your First Order* |
| Under it | — | Use Code: VYTA20 (dashed coupon chip) |
| Button | Claim My 35% Off › | CLICK TO SHOP NOW › |
| Strip | Third-party tested · COA every batch · Secure checkout | Free Shipping · Lab Tested · Discreet Packaging |

**The flash.** After the offer was changed to 20% in admin, the page showed
35% for a moment and then 20%. Its HTML still carried the launch figure, which
the browser drew straight away, and the script swapped in the store's answer
when it arrived. That can take a couple of seconds when the store's server has
been idle.

Now:

- the HTML carries the current figures (20%, VYTA20);
- the request to the store starts in `<head>`, in parallel with fonts and the
  logo;
- the offer text (eyebrow, headline, code chip, fine print) is held invisible,
  keeping its space, until the store answers, for at most 0.9s. It then
  fades in.

Checked in Chromium against a stubbed store, sampling what is visible every
40ms:

- **fast answer:** only 20%;
- **2.5s cold start:** only 20%;
- **admin changed and the store answers fast:** only the new figure;
- **offer off:** no-offer headline, code hidden;
- **store unreachable:** the HTML's figures.

A number can still change on screen only if admin is changed without updating
the HTML and the store is slow. The page then corrects itself and logs a
console warning naming both figures.

## Admin

The page prints the code, so the landing page's code in Admin → Landing Pages
must be exactly `VYTA20`. The store's offer API returns the percentage but not
the code. The page is wired to use a code from the API if one is ever added.

## Docs

`LANDING_PAGES.md` updated for the new copy, the `VYTA_OFFER` config (moved
into `<head>`), the hold-until-confirmed behaviour, and the stacking example at
20%. A signed-in landing visitor from an ad also qualifies for the 25% paid-ads
welcome discount, which is now the larger of the two, so they get 25%. A
handoff for whoever runs the landing domain, with the complete page inline, is
in `docs/landing-page-update-vyta20.md`.

No storefront code changed.
