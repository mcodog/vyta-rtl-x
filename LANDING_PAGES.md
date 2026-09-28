# Landing Pages

How to run a landing page on its own domain that sends visitors to
**vytabio.com**, records that they came from it, and gets the discount it
advertises put into the checkout's discount field for them.

This document has everything needed to build, deploy and operate one. A
working, ready-to-deploy page is in [`landing-page/`](landing-page/index.html).
The [design scheme](#8-design-scheme) is in section 8.

---

## Contents

1. [How it works](#1-how-it-works)
2. [One-time setup on vytabio.com](#2-one-time-setup-on-vytabiocom)
3. [Create the landing page in admin](#3-create-the-landing-page-in-admin)
4. [Build the landing page](#4-build-the-landing-page)
5. [Deploy it on the new domain](#5-deploy-it-on-the-new-domain)
6. [Point the ads at it](#6-point-the-ads-at-it)
7. [Test it end to end](#7-test-it-end-to-end)
8. [Design scheme](#8-design-scheme)
9. [The discount rules](#9-the-discount-rules)
10. [What gets recorded, and where to see it](#10-what-gets-recorded-and-where-to-see-it)
11. [Day-to-day operation](#11-day-to-day-operation)
12. [Troubleshooting](#12-troubleshooting)
13. [Reference](#13-reference)

---

## 1. How it works

```
 Ad (Meta / Google)
   │  https://getvyta.ca/?fbclid=…&utm_source=facebook&utm_medium=paid_social&utm_campaign=…
   ▼
 Landing page  (getvyta.ca — its own domain, static HTML)
   │  • asks vytabio.com what it is offering:   GET https://www.vytabio.com/api/landing/standards
   │    → { active: true, percent: 35, fine_print: "*First order only. Excludes bacteriostatic water." }
   │  • prints that percentage
   │  • button → https://www.vytabio.com/products?lp=standards&fbclid=…&utm_source=…   (every param forwarded)
   ▼
 vytabio.com  (middleware.ts, on arrival)
   │  • classifies the visit as usual (fbclid → meta_ads) and records landing_page = "standards"
   │    on the first/last-touch cookies
   │  • sets the vyta_lp=standards cookie (30 days) — the landing page's OFFER
   ▼
 Storefront
   │  • nav bar: "✓ 35% off your first order — applied at checkout"
   │  • cart:    "35% first-order offer  −$X"
   ▼
 Checkout
   │  • the discount field is filled with the landing page's code (e.g. STANDARDS35) and applied
   ▼
 Hand-off to the payment page  (/api/checkout/puramass)
      • re-checks everything server-side and takes the discount off the line prices
      • if the browser did not send the code for any reason, applies it anyway from the cookie
      • stamps the order with landing_page = "standards"
```

**The single source of truth is one discount code.** Each landing page points
at a discount code in Admin. The landing page prints that code's percentage
(read live from the API), checkout puts that code into the discount field, and
the hand-off charges that code's discount. Change the percentage in admin and
all three follow — the landing page on its next page view, with no redeploy.

**Two layers make the discount reliable:**

1. The storefront fills the discount field with the code automatically, so the
   buyer sees it applied before they pay.
2. The hand-off applies the landing code server-side whenever the discount
   field arrives empty. So the discount still lands if the visitor's browser
   blocked a script, the offer request failed, or they clicked Pay before it
   finished loading. It is only skipped if the buyer deliberately removed the
   code or replaced it with another one.

---

## 2. One-time setup on vytabio.com

1. **Run the migration.** In the Supabase SQL editor, run
   [`landing-pages-migration.sql`](landing-pages-migration.sql). It is
   idempotent (safe to re-run). It needs
   `affiliate-discount-codes-payouts-migration.sql` and
   `marketing-attribution-migration.sql` to have run already, as they have on
   production.

   Until it runs, nothing breaks: the storefront, checkout and existing
   discount codes work exactly as before. Landing offers are simply not
   honoured, and Admin → Landing Pages says the migration is needed.

2. **Deploy this branch.** No new environment variables and no new
   dependencies.

That's all. There is nothing to configure in code per landing page.

---

## 3. Create the landing page in admin

**Admin → Marketing → Landing Pages → New landing page.**

| Field | What to enter | Example |
| --- | --- | --- |
| Name | Internal label | `Meta — first order 35%` |
| Slug | What rides on the button link as `?lp=`. 2–40 lower-case letters, digits, dashes. **This must match `CONFIG.slug` in the landing page.** | `standards` |
| Landing domain | Where the page is hosted (reference only) | `getvyta.ca` |
| Button goes to | A path on vytabio.com | `/products` |
| This landing page offers a discount | On | ✓ |
| Percent off | The number the page will print | `35` |
| Discount code | Auto-suggested from slug + percent; editable | `STANDARDS35` |
| First order only | On by default. Refuses buyers who already ordered, **checked by account and by email** so guest checkouts count | ✓ |
| Excluded products | Click **"+ Exclude all bacteriostatic water"** to match "*excluding Bac water" | 4 bac water products |
| Starts / Ends / Usage limit | Optional | — |
| Active | Master switch: off stops the offer everywhere at once | ✓ |

Save. The card that appears shows:

- **Button link:** e.g. `https://www.vytabio.com/products?lp=standards`. This
  is the landing page's `fallbackUrl`.
- **Offer API:** e.g. `https://www.vytabio.com/api/landing/standards`. Open
  it in a browser to see exactly what the landing page will receive.

The code also appears under **Partners → Discount Codes**, tagged
`Landing: standards`, with its orders and revenue.

---

## 4. Build the landing page

### 4.1 Fastest route: deploy the reference page

[`landing-page/`](landing-page/) is complete and ready to deploy:

```
landing-page/
├── index.html               ← the page (HTML + CSS + JS in one file)
└── assets/
    ├── vyta-logo-320.webp   ← full lockup, 2× for a 160px display width (20 KB)
    ├── vyta-logo-320.png    ← fallback for browsers without WebP
    └── vyta-mark-192.png    ← favicon
```

Edit the `CONFIG` block at the bottom of `index.html`:

```js
var CONFIG = {
  slug: 'standards',                                           // = the slug in admin
  api: 'https://www.vytabio.com/api/landing/',
  fallbackUrl: 'https://www.vytabio.com/products?lp=standards', // = "Button link" in admin
  timeoutMs: 3000
};
```

Then update the three places the launch percentage appears in the HTML
(`35%` inside each `data-offer-percent` span), and the fine print, so the page
reads correctly even before its script runs. That's all. Go to
[section 5](#5-deploy-it-on-the-new-domain).

### 4.2 Building your own: the contract

A landing page can look however you like, but it **must** do these five
things. The reference page does all of them. Copy its `<script>` if you're
building in something else.

#### ① The number on the page comes from the API

Fetch `GET https://www.vytabio.com/api/landing/<slug>` on page load and print
its `percent_label` wherever the percentage appears.

- The HTML may carry the launch figure so the page reads correctly with no
  JavaScript (and for link-preview crawlers), but the script **replaces** it
  with what the API returns.
- If the API returns `active: false` or a 404, **hide the percentage
  entirely**: the offer is switched off or ended. The reference page switches
  to a no-offer headline ("Research Compounds, Tested" / "Shop VYTA").
- Never print a percentage the API didn't return. If the page says 35% and
  admin says 30%, the buyer gets 30%.

#### ② The button carries `?lp=<slug>`

That parameter is what makes vytabio.com remember the offer and put its code
into the discount field. Use `cta_url` from the API (it already has `?lp=` and
the right destination), or `fallbackUrl` if the API can't be reached.

#### ③ Forward every query parameter to the button

Whatever the ad put on the landing page URL (`fbclid`, `gclid`, `gbraid`,
`wbraid`, `msclkid`, `ttclid`, `utm_source`, `utm_medium`, `utm_campaign`,
`utm_term`, `utm_content`) must be appended to the button link. Without them
the store sees the visit as a referral from the landing domain rather than a
paid Meta or Google click, which:

- credits the sale to the wrong channel in every report;
- loses the `gclid` a future server-side Google Ads conversion upload needs.

The one exception is `lp`: the button always uses the page's own slug, so a
visitor who edits `?lp=` in the address bar cannot pick another page's offer.

#### ④ The fine print matches what checkout does

Use the API's `fine_print` (e.g. `*First order only. Excludes bacteriostatic
water.`). It is generated from the code's actual settings, so it can't
drift. If you write your own, only say "first order" when `first_order_only`
is true, and only name exclusions that are in `exclusions`.

#### ⑤ Every visitor sees the same page

No bot detection, no user-agent or IP-based variants, nothing that shows ad
reviewers something different from what shoppers see. Ad platforms treat that
as cloaking, and it's the fastest way to lose the ad account.

### 4.3 The API

`GET https://www.vytabio.com/api/landing/<slug>`. Public, CORS open to any
origin, never cached, rate-limited to 240 requests per minute per IP.

**Offer live**: `200`

```json
{
  "ok": true,
  "slug": "standards",
  "active": true,
  "percent": 35,
  "percent_label": "35%",
  "first_order_only": true,
  "exclusions": "bacteriostatic water",
  "fine_print": "*First order only. Excludes bacteriostatic water.",
  "ends_at": null,
  "cta_url": "https://www.vytabio.com/products?lp=standards"
}
```

**Page exists but offers nothing right now** (code switched off, ended, not
started, or the offer was removed): `200`

```json
{ "ok": true, "slug": "standards", "active": false, "percent": 0,
  "cta_url": "https://www.vytabio.com/products?lp=standards" }
```

**No such landing page** (typo in the slug, or the page is switched off):
`404`

```json
{ "ok": false, "active": false, "percent": 0 }
```

The discount code itself is never in this response. The landing page has no
use for it, and the storefront fetches it separately for visitors who actually
arrive.

### 4.4 Copy

Stick to claims vytabio.com already makes about itself:

| Use | Avoid |
| --- | --- |
| Third-party tested | Any health, treatment, dosing or results claim |
| Certificate of analysis (COA) with every batch | "Pharmaceutical grade", "FDA/Health Canada approved" |
| Ships from Canada · discreet packaging | Naming specific compounds or what they're "for" |
| Secure checkout | Countdown timers or scarcity that isn't real |

Keep the research-use disclaimer at the foot of the page:

> For laboratory research use only. Not for human or veterinary consumption.
> VYTA Biosciences does not diagnose, treat, prescribe, or provide medical or
> dosing instructions.

### 4.5 Optional: an ad pixel on the landing page

If the ad account wants a pixel on the landing domain (Meta Pixel, Google
tag), add its base snippet in `<head>` as that platform documents, and fire
one event when the button is clicked. For example, for Meta:

```js
document.getElementById('cta').addEventListener('click', function () {
  if (window.fbq) fbq('track', 'Lead');
});
```

vytabio.com already runs GTM/GA4 and records the arrival itself. The pixel is
only for the ad platform's own optimisation on the landing domain.

---

## 5. Deploy it on the new domain

The landing page is static: any static host works. Vercel is shown because
vytabio.com already uses it. Use a **separate project** so the landing domain
has nothing to do with the store's deployment.

**Vercel**

1. Vercel → **Add New → Project** → import this repository.
2. **Root Directory:** `landing-page`. **Framework preset:** Other. No build
   command, no output directory (the folder is served as-is).
3. Deploy, then **Settings → Domains → Add**: `getvyta.ca` and
   `www.getvyta.ca` (redirect one to the other).
4. At the domain registrar, create the DNS records Vercel shows: normally an
   `A` record for the apex (`76.76.21.21`) and a `CNAME` for `www`
   (`cname.vercel-dns.com`). Wait for the certificate to issue.

**Netlify / Cloudflare Pages**: same idea. Publish directory `landing-page`,
no build command, add the custom domain, follow their DNS instructions.

**Any other host / a website builder**: upload `index.html` and `assets/`,
or paste the page's `<style>` and `<script>` into the builder's custom-code
blocks. What matters is the contract in [4.2](#42-building-your-own-the-contract).

After deploying, open `https://getvyta.ca/?utm_source=test&fbclid=abc`, hover
the button, and confirm the link is
`https://www.vytabio.com/products?lp=standards&utm_source=test&fbclid=abc`.

---

## 6. Point the ads at it

The ad's **destination URL is the landing domain**, not vytabio.com. The
landing page passes everything through.

**Meta Ads Manager**: Website URL `https://getvyta.ca/`, and under
**URL parameters**:

```
utm_source=facebook&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_content={{ad.name}}
```

`fbclid` is added by Meta automatically.

**Google Ads**: Final URL `https://getvyta.ca/`. Leave auto-tagging on so
`gclid` is added. Final URL suffix:

```
utm_source=google&utm_medium=cpc&utm_campaign={campaignid}
```

These are the same parameters `MARKETING_ATTRIBUTION.md` documents for ads
that go straight to vytabio.com, so landing-page traffic lands in the same
channels (`meta_ads`, `google_ads`) as everything else.

**Several landing pages, or A/B variants:** give each its own slug (and its
own row in admin), e.g. `standards` and `standards-b`. They can share a
percentage but should each have their own code, so their revenue stays
separate.

---

## 7. Test it end to end

Do this once after launch and after any change to the page, in a private
window so no old cookies interfere.

| # | Do | Expect |
| --- | --- | --- |
| 1 | Open `https://www.vytabio.com/api/landing/<slug>` | `active: true`, the right `percent`, the right `fine_print` |
| 2 | Open `https://getvyta.ca/?utm_source=facebook&utm_medium=paid_social&utm_campaign=launch-test&fbclid=TEST123` | The page shows the same percentage and fine print |
| 3 | Hover the button | `…/products?lp=<slug>&utm_source=facebook&utm_medium=paid_social&utm_campaign=launch-test&fbclid=TEST123` |
| 4 | Click it | vytabio.com opens. Nav bar shows "✓ 35% off your first order — applied at checkout", not the 25% ad offer |
| 5 | Add a product **and** a bacteriostatic water to the cart | Cart shows "35% first-order offer −$…" computed on the product only, with "Code STANDARDS35 is applied automatically at checkout · excludes bacteriostatic water" |
| 6 | Go to checkout | The discount field shows **STANDARDS35**, "Applied automatically from your welcome offer · first order only", and "Not discounted by this code: Bacteriostatic Water …" |
| 7 | Fill in a **new** email and continue to payment | The payment page shows the product at 35% off and the bac water at list price |
| 8 | Admin → Landing Pages | Visitors, checkouts and (once paid) orders and revenue go up for the page |
| 9 | Repeat 6–7 with an email that has **already ordered** | Checkout says "That code is for first orders only." and lets them continue without it |
| 10 | Switch the landing page off in admin, reload the landing page | Percentage disappears, headline becomes "Research Compounds, Tested", button still works |

Switch it back on when done.

---

## 8. Design scheme

The landing page uses vytabio.com's own design system: the same tokens as
`tailwind.config.ts`, from the VYTA Brand Identity Guidelines v1.0. The goal
is a page that feels like the front door of vytabio.com, so arriving at the
store is seamless: calm, clinical, generous white space, one decision.

### 8.1 Colour

The six core swatches are exact brand values. **Do not alter them.**

| Token | Hex | Swatch role | Used on the landing page for |
| --- | --- | --- | --- |
| Midnight Navy | `#07203A` | The anchor: ink and darkest surface | Headline, button background, strip text |
| Deep Ocean | `#0E3F5F` | Deep surface | Button hover |
| Vital Blue | `#1B5D83` | Accessible accent text (AA on white at body size) | Eyebrow, the highlighted percentage |
| Bio Teal | `#438B9E` | Interactive accent. **Large text and UI chrome only** (not AA for small text) | Asterisk, strip icons, focus ring |
| Aqua | `#6EB2B8` | Vitality accent | End of the brand rule |
| Mist | `#BBD6D6` | Soft accent | Highlighter band behind the percentage |

Derived ramp (built for contrast on the surfaces they're used on):

| Token | Hex | Used for |
| --- | --- | --- |
| Cloud | `#F7FAFB` | Page ground (gradient white → Cloud → white) |
| Teal 50 | `#F1F8F9` | Strip background |
| Teal 100 | `#E1EFF1` | Strip border |
| Line | `#DCE7EB` | Card border, dividers |
| Ink muted | `#56707F` | Body copy / lede on white |
| Ink light | `#6E8898` | Fine print, legal |
| White | `#FFFFFF` | Card surface, button text |

Gradients:

| Name | Value | Used for |
| --- | --- | --- |
| Brand rule | `linear-gradient(90deg, #07203A 0%, #1B5D83 50%, #6EB2B8 100%)` | 4px bar across the top of the card |
| Brand gradient | `linear-gradient(135deg, #07203A 0%, #0E3F5F 45%, #438B9E 100%)` | Available for a hero band or ad creative; not used on the reference page |
| Page ground | `linear-gradient(180deg, #FFFFFF 0%, #F7FAFB 55%, #FFFFFF 100%)` | `body` |

Shadows are navy-tinted, never neutral grey:

| Name | Value |
| --- | --- |
| Card | `0 1px 2px rgba(7,32,58,.04), 0 8px 24px -12px rgba(7,32,58,.10)` |
| Button | `0 10px 24px -10px rgba(7,32,58,.45)` |
| Focus ring | `0 0 0 3px rgba(67,139,158,.28)` |

### 8.2 Typography

One family: **Inter** (variable, with the optical-size axis), from Google
Fonts:

```html
<link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..800&display=swap" rel="stylesheet">
```

"Inter Display" for headings is the same font driven to its display optical
size (`font-variation-settings: 'opsz' 32`), exactly as vytabio.com does it.

| Element | Size | Weight | Line height | Tracking | Colour |
| --- | --- | --- | --- | --- | --- |
| H1 headline | `clamp(2rem, 8.5vw, 3.25rem)` (32–52px) | 750, `opsz 32` | 1.06 | −0.03em | Navy |
| Highlighted percentage | inherits H1 | inherits | inherits | inherits | Vital Blue on a Mist band |
| Asterisk | 0.55em, superscript | 600 | — | — | Bio Teal |
| Eyebrow | 11px (0.6875rem) | 600 | — | +0.14em, UPPERCASE | Vital Blue |
| Lede | 17px (1.0625rem) | 400 | 1.55 | normal | Ink muted |
| Button label | 17px | 650 | — | −0.005em | White |
| Note / fine print | 13px (0.8125rem) | 400 | — | normal | Ink muted / Ink light |
| Strip labels | 12px mobile, 13px ≥640px | 600 | 1.25 | normal | Navy |
| Legal | 11px | 400 | 1.5 | normal | Ink light |

Headline: `text-wrap: balance`. Lede: `text-wrap: pretty`. The percentage never
wraps (`white-space: nowrap`).

### 8.3 Layout and spacing

- **Single column**, centred, max width **34rem (544px)**, side gutter
  **16px**. Top padding `clamp(1.5rem, 6vh, 4rem)`, so the button sits above
  the fold on a phone.
- **Card** (`.pane`): white, 1px Line border, radius **18px (1.125rem)**, Card
  shadow, 4px brand rule along the top edge. Padding **36px 24px 28px** on
  phones, **48px 48px 36px** from 640px up. Content centred.
- **Vertical rhythm inside the card:** logo → 24px → eyebrow → 12px → H1 →
  16px → lede → 28px → button → 14px → note.
- **Strip** below the card, 16px gap: three equal columns, Teal 50 background,
  Teal 100 border, same 18px radius, 14px/12px padding. Icons stack above the
  label on phones and sit beside it from 640px.
- **Legal** below the strip, centred.
- Nothing scrolls horizontally at 320px width.

### 8.4 Components

**Logo.** The full lockup (mark + VYTA + BIOSCIENCES), full colour, on white,
at **160px wide**: the guidelines' minimum digital width for the full lockup.
Serve it as `vyta-logo-320.webp` (2× for sharpness) with a PNG fallback. Never
stretch, rotate, recolour, or add a shadow. Keep clear space of at least half
the icon's width around it.

**Eyebrow.** `FIRST ORDER · SAVE 35%`: a small all-caps kicker that states
the offer in plain words before the headline does.

**Headline.** `Your First Order Is 35% Off*`. The percentage is the only
coloured word, marked with a Mist highlighter band (a linear gradient from 64%
to 92% of the line height, so it sits under the lower half of the numerals like
a pen stroke).

**Button.** Full-width pill (radius 999px), min height **56px** (comfortably
above the 44px touch minimum), Midnight Navy with white text. Hover: Deep
Ocean, and the `›` chevron nudges 3px right. Active: 1px press. Keyboard focus:
the Bio Teal focus ring. Label: `Claim My 35% Off ›`. One button only: the
page has a single decision.

**Note.** `Ships from Canada 🇨🇦 · *First order only. Excludes bacteriostatic
water.`: the asterisk's explanation, directly under the button, never hidden
further down.

**Proof strip.** Three icon + label pairs: *Third-party tested* (flask),
*COA every batch* (document with a tick), *Secure checkout* (padlock). 18px
stroke icons in Bio Teal, 2px stroke, round caps. Same visual family as the
store's Lucide icons.

**Legal.** The research-use disclaimer, in the smallest, lightest type on the
page. Present, not prominent.

### 8.5 Motion

Minimal and purposeful: 180ms ease on button colour, press and chevron. No
entrance animations, parallax or autoplay: the page should be readable
instantly. Everything is disabled under `prefers-reduced-motion`.

### 8.6 Accessibility

- All text meets WCAG AA against its background. That's why small accent
  text uses Vital Blue, not Bio Teal.
- The logo has `alt="VYTA Biosciences"`. Decorative icons and the asterisk are
  `aria-hidden`.
- Visible keyboard focus on the button.
- `lang="en-CA"`, and the viewport honours device zoom.

### 8.7 Performance budget

It's the page an ad pays for, so it has to be fast:

- One HTML file with inline CSS and JS, no framework, no build step.
- The logo is 20 KB (WebP). Total page weight under 100 KB before fonts.
- `preconnect` to Google Fonts and to `www.vytabio.com` (for the offer API).
- The offer request times out after 3 seconds, and the page is complete and
  clickable before it answers.

### 8.8 Don'ts

- Don't use colours outside the palette above, or tint the logo.
- Don't use neutral grey shadows or pure black text.
- Don't add a second call to action, navigation, or links away from the offer.
- Don't show product photos of specific compounds or make claims about them.
- Don't hard-code the discount code anywhere on the page.

---

## 9. The discount rules

The landing offer is a discount code, so every rule codes already follow
applies: active, start and end dates, usage limit, the minimum order. Two new
restrictions, which any code can now use (Discount Codes → edit):

**First order only.** Refused to a buyer who has ordered before, checked
against every record a past order leaves: their account's first-order flag,
any account under the same email, hosted orders under their account **or their
email**, and legacy orders under their email. Emails are matched
case-insensitively. So a guest can't claim it twice by skipping sign-in.
A signed-in customer who has already ordered doesn't see the offer at all.

A checkout that is still **awaiting payment** holds the offer, the same rule
the paid-ads welcome discount already uses (it stops someone opening ten
discounted checkouts and paying all of them). An abandoned checkout gives the
offer back once it expires. If a buyer returns while one is still open, they're
told: *"Your first-order discount is already on a checkout that is awaiting
payment. Complete that checkout, or it becomes available again once that
checkout expires."*

**Excluded products.** The percentage comes off every line except these. They
stay at list price and the buyer sees which lines weren't discounted. A cart of
nothing but excluded products is told the code doesn't apply to it.

**How it combines with the other promotions:**

| Promotion | Relationship to the landing code |
| --- | --- |
| Paid-ads welcome discount (25%, Admin → Promotions) | **Never stacks.** The buyer gets whichever takes more off the order. With 35% vs 25% that's the landing code, unless the cart is mostly excluded products |
| Limited-time cart offer | **Stacks**, composed like every other pair (35% then 10% = 41.5% off eligible lines) |
| Another discount code | One code per order. A code the buyer types **replaces** the landing code; removing it brings the landing code back |
| Free shipping | Unaffected. The threshold is measured at list price, as always |

**Nothing in the browser is trusted.** The hand-off re-reads the cookie,
re-resolves the offer, re-prices the cart from the catalogue, re-checks the
buyer's history by account and email, and then takes the discount off the line
prices it sends to the payment page. The storefront's display is only ever a
preview of that.

---

## 10. What gets recorded, and where to see it

| Where | Field | When | Meaning |
| --- | --- | --- | --- |
| Cookie `vyta_lp` | slug | Arrival with `?lp=`; 30 days; latest wins | Which landing page's offer this visitor holds |
| Cookies `aminocan_attr` / `aminocan_attr_last` | `lp` inside the touch | Arrival | First/last touch now record the landing page, next to channel and campaign |
| `visitor_attribution` | `first_landing_page`, `last_landing_page` | First recorded event / page views | The funnel per landing page |
| `customers` | `attribution_landing_page` | Sign-up during a landing visit (frozen, set once) | Which landing page won this customer |
| `puramass_orders` | `landing_page` | Hand-off to payment (frozen) | Which landing page this order came through |
| `puramass_orders` | `discount_code`, `discount_code_percent`, `discount_code_cents` | Hand-off | The landing code and what it took off |

**Admin → Landing Pages** shows, per page and for any date range: visitors,
sign-ups, checkouts, purchasers (with conversion rates), paid orders,
revenue (goods after discount, per currency), and total discounts given.

Visitor-level counts only include people who accepted cookies while the
consent banner is on, so read them as a floor. Orders and revenue are exact:
every order is stamped whatever the consent state.

Elsewhere:

- **Discount Codes:** the landing code's uses, revenue and discount given.
- **Customers → a customer:** "Came from" includes `landing page standards`.
- **Analytics → Acquisition:** landing traffic appears under its real channel
  (`Meta ads`, `Google ads`) because the landing page forwards the click IDs.

---

## 11. Day-to-day operation

| To | Do |
| --- | --- |
| Change the percentage | Admin → Landing Pages → Edit → Percent. The landing page updates on its next view. Also update the launch figure in the page's HTML at your next deploy, and the ad creative if it names the number |
| Pause the offer | Switch the landing page off. The page hides its percentage and checkout stops applying the code, immediately |
| End it on a date | Set **Ends** on the offer. The page hides the percentage at that moment |
| Run a second page | New landing page with its own slug and code; deploy a copy of the page with that slug |
| Retire a page | Switch it off. Pages that produced orders can't be deleted, so their revenue keeps a name |

**Changing a slug** breaks the live landing page until its `CONFIG.slug` is
updated, and visitors already holding the old slug lose the offer. Prefer
creating a new page.

---

## 12. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Landing page shows no percentage | API says inactive or 404 | Open the Offer API URL. 404: the slug in `CONFIG` doesn't match admin, or the page is off. `active: false`: the code is off, ended or not started |
| Percentage on the page differs from admin | The page is showing its baked-in HTML because its script didn't run | Check the browser console on the landing page; make sure `CONFIG.api` is `https://www.vytabio.com/api/landing/` |
| Discount field empty at checkout | No `vyta_lp` cookie: the button link lost `?lp=` | Hover the button and check the link. The hand-off still applies the code if the cookie exists |
| Nav shows 25% instead of the landing percentage | Visitor arrived without `?lp=` | Same as above |
| "That code is for first orders only" | The email or account has a paid order | Expected |
| "…already on a checkout that is awaiting payment" | The buyer started a checkout and came back | They can pay the open checkout, or wait for it to expire |
| Sales show as "Referral" from the landing domain | The page isn't forwarding `fbclid` / `utm_*` | Fix per rule ③ in [4.2](#42-building-your-own-the-contract) |
| Admin says to run the migration | `landing-pages-migration.sql` hasn't run | Run it |

---

## 13. Reference

**Files**

| File | What it does |
| --- | --- |
| `landing-pages-migration.sql` | Schema |
| `landing-page/` | The reference landing page |
| `lib/promos/landing.ts` | Slugs, cookie, button link, offer shaping, admin form validation (pure) |
| `lib/promos/landing-server.ts` | Loading a landing page and its offer; fine print |
| `middleware.ts` | Captures `?lp=` into the touch and the `vyta_lp` cookie |
| `lib/analytics/attribution.ts` / `attribution-server.ts` | `landing_page` on the touch and on visitor rows |
| `app/api/landing/[slug]/route.ts` | The public offer API the landing page reads |
| `app/api/promos/landing/route.ts` | The storefront's read of the visitor's offer (includes the code) |
| `contexts/PromosContext.tsx` | `landingOffer` for the nav, cart and checkout |
| `app/checkout/PuramassCheckoutContent.tsx` | Fills the discount field |
| `app/api/checkout/puramass/route.ts` | Applies it server-side, with the fallback; stamps `landing_page` |
| `lib/affiliate/discount-codes.ts` | First-order-only and exclusions for every code |
| `lib/promos/first-order.ts` | `firstOrderStatus`: order history by account and email |
| `lib/promos/ad-discount.ts` | `distributeLineDiscounts`: per-line percentages, buyer-favourable rounding |
| `app/(admin)/admin/landing-pages/` + `app/api/admin/landing-pages/` | Admin |

**Tests:** `node --test --import tsx lib/promos/landing.test.ts`, plus
the new cases in `lib/affiliate/discount-codes.test.ts`,
`lib/promos/ad-discount.test.ts` and `lib/promos/first-order.test.ts`.

**Known limitations**

- Payment happens on the hosted payment page, so the landing domain's pixel
  never sees the purchase. The same limitation, and the same future fix
  (server-side conversion upload keyed on the stored `gclid`/`fbclid`), as in
  `MARKETING_ATTRIBUTION.md`.
- A shopper who reads the code off the checkout can share it. First-order-only
  limits it to new customers, the audience the landing page targets anyway.
- A pending checkout holds a first-order offer until it's paid or expires
  (see [section 9](#9-the-discount-rules)).
