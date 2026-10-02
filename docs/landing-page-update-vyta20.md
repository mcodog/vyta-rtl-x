# Landing page update: 20% / VYTA20

Changes for the landing page site (the separate domain). Nothing needs to
change on vytabio.com except **one admin setting** (step 1).

| What | Before | After |
| --- | --- | --- |
| Headline | Your First Order Is 35% Off* | **Claim 20% Off Your First Order*** |
| Under the headline | — | **Use Code: VYTA20** (dashed coupon chip) |
| Button | Claim My 35% Off › | **CLICK TO SHOP NOW ›** |
| Strip, 1st | Third-party tested | **Free Shipping** (truck icon) |
| Strip, 2nd | COA every batch | **Lab Tested** (flask icon) |
| Strip, 3rd | Secure checkout | **Discreet Packaging** (box icon) |
| Tab title | …Your First Order Is 35% Off | …Claim 20% Off Your First Order |
| Paragraph and legal line | unchanged | unchanged |
| **Bug:** shows 35%, then 20% a few seconds later | — | **Fixed**, see below |

---

## 1. First, in Admin on vytabio.com

**Admin → Marketing → Landing Pages → Edit** your landing page:

- **Percent off:** `20`
- **Discount code:** `VYTA20`

Save. The page now prints the code, so the code in admin **must be exactly
`VYTA20`**. Otherwise a buyer who types it at checkout is told it isn't valid.
(Checkout still fills the field with the right code automatically for anyone
who clicks through, but people do retype codes.)

If saving says *"VYTA20 is already used by another discount code"*: a
separate VYTA20 code already exists under **Partners → Discount Codes**.
Delete it, or rename it if it has orders, then save the landing page again.

Check it worked: open `https://www.vytabio.com/api/landing/standards` (use
your slug). It should say `"percent": 20`.

---

## 2. Why it showed 35% and then 20%

The page's HTML still had the launch figure, **35%**, written into it. The
browser drew that immediately. A moment later the page's script heard back
from vytabio.com ("the offer is 20%") and swapped the number. That answer can
take a couple of seconds when the store's server has been idle (a "cold
start"), which is the delay you saw.

**The fix, in the new file below:**

1. **The HTML now says 20% and VYTA20**, so the first thing drawn is already
   right.
2. **The offer text waits for the store's answer before showing.** The
   eyebrow, headline, code chip and fine print stay invisible (but keep their
   space, so nothing jumps) until vytabio.com answers, for at most 0.9
   seconds. Then they fade in. The logo, paragraph, button and strip show
   instantly as before.
3. **The request starts earlier**: in the page's `<head>`, in parallel with the
   fonts and logo, instead of after the page has loaded.

Tested against a simulated store:

| Store answers… | Visitor sees |
| --- | --- |
| fast | 20% after ~0.3s, never anything else |
| slowly (cold start, 2.5s) | 20% at 0.9s, never anything else |
| fast, after admin changed the % | only the new %; the HTML's figure never shows |
| offer switched off | the no-offer headline; no number, no code |
| not at all | 20% / VYTA20 from the HTML, button still works |

The only way a number can still change on screen is if **admin is changed and
the HTML isn't**, and the store is slow that time. The page then writes a
warning in the browser console saying the HTML is out of date. So:

> **Whenever you change the offer in admin, update the HTML to match.** Change
> the `20%` (three places) and `VYTA20` (one place) in `index.html`, and
> redeploy. See section 5.

---

## 3. Apply the changes

**If the site is the reference page** (a single `index.html` plus an `assets/`
folder): replace `index.html` with the complete file in [section 7](#7-the-complete-indexhtml)
and redeploy. The `assets/` folder is unchanged. That's the whole job.

**If the page was rebuilt in something else** (a site builder, another
framework), make these edits instead:

### a. Headline

```html
<h1 data-offer data-offer-hold>Claim <span class="hl"><span data-offer-percent>20%</span> Off</span> <span data-offer-scope>Your First Order</span><span class="ast" aria-hidden="true">*</span></h1>
```

### b. Code chip, directly under the headline

```html
<p class="code" data-offer data-offer-hold>Use Code: <strong data-offer-code>VYTA20</strong></p>
```

```css
.code {
  display: inline-flex; align-items: center; gap: .5rem;
  margin-top: 1rem; padding: .5rem .95rem;
  border: 1.5px dashed #438B9E;      /* Bio Teal */
  border-radius: .75rem;
  background: #F1F8F9;               /* Teal 50 */
  font-size: .9375rem; font-weight: 500; color: #56707F;
}
.code strong { font-weight: 750; letter-spacing: .08em; color: #07203A; }
```

### c. Button

Label `Click to Shop Now`. The CSS uppercases it, so screen readers don't
spell it out letter by letter. One label whether or not an offer is running.

```css
.cta { font-size: 1rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
```

### d. Strip

Three items, left to right: **Free Shipping** (truck), **Lab Tested**
(flask), **Discreet Packaging** (box). Same 18px Bio Teal stroke icons as
before. The exact SVGs are in the file in section 7.

### e. The no-flash behaviour

1. Mark the offer text with `data-offer-hold`: the eyebrow, the headline, the
   code chip and the fine-print span.
2. Add this CSS:

   ```css
   [data-offer-hold] { transition: opacity 160ms ease; }
   .offer-pending [data-offer-hold] { opacity: 0; }
   ```
3. Put the small `<script>` from the top of section 7's `<head>` into your
   `<head>`. It adds `offer-pending` to `<html>` before anything is drawn, and
   starts the request to vytabio.com.
4. Your page script then fills in the store's figures and removes
   `offer-pending` when the answer arrives, or after 0.9s at the latest. The
   script at the bottom of section 7 does exactly this.

Everything else (forwarding `fbclid`/`utm_*` to the button, `?lp=` on the
link, hiding the offer when the store says it's off) works as before.

---

## 4. Check it after deploying

In a private window, open the landing page with a test parameter, e.g.
`https://<landing-domain>/?utm_source=test&fbclid=abc`.

- [ ] The headline reads **Claim 20% Off Your First Order\***, and reload a few
      times: **35% never appears**, not even for a moment
- [ ] **Use Code: VYTA20** sits under the headline
- [ ] The button reads **CLICK TO SHOP NOW ›**
- [ ] The strip reads **Free Shipping · Lab Tested · Discreet Packaging**
- [ ] Hover the button: the link ends `?lp=<slug>&utm_source=test&fbclid=abc`
- [ ] Click it, add a product, go to checkout: the discount field shows
      **VYTA20** and 20% comes off

---

## 5. When you change the offer later

1. Change it in **Admin → Landing Pages** (percent and/or code).
2. In `index.html`, update the figures to match. Search for `20%` (the eyebrow,
   the headline and the `<title>`/`og:title` tags) and `VYTA20` (the code
   chip), and redeploy.
3. Update the ad creative if it names the number or code.

If step 2 is skipped, the page still corrects itself from the store, but a
visitor may briefly see the old figure when the store is slow.

---

## 6. Notes

- **"Free Shipping" is a promise on an ad landing page.** If shipping is only
  free above a threshold, say so, e.g. **Free Shipping Over $150**, or the
  page advertises something checkout doesn't do (and ad platforms treat that
  as misleading). Check Admin → Promotions for the current rule.
- **The code is part of the page, not read from the store.** The store's offer
  API sends the percentage but not the code, so `VYTA20` lives in the HTML and
  has to match admin by hand (section 5). The page is already wired to use a
  code from the store if it ever sends one. That needs a small change on
  vytabio.com, which can be done separately if wanted.
- The paragraph ("Third-party tested, with a certificate of analysis…") and the
  research-use line at the bottom are unchanged.

---

## 7. The complete `index.html`

Replace the whole file with this. Only the `slug` and `fallbackUrl` in the
`<head>` script need to match your landing page in admin. They're set to
`standards`, as before.

```html
<!doctype html>
<html lang="en-CA">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>VYTA Biosciences — Claim 20% Off Your First Order</title>
  <meta name="description" content="Third-party tested, with a certificate of analysis for every batch. Shipped from Canada in discreet packaging.">
  <!-- A pre-sell page: keep it out of search so it never competes with vytabio.com. -->
  <meta name="robots" content="noindex, follow">
  <meta name="theme-color" content="#07203A">
  <meta property="og:title" content="Claim 20% Off Your First Order — VYTA Biosciences">
  <meta property="og:description" content="Third-party tested. COA with every batch. Shipped from Canada.">
  <meta property="og:type" content="website">
  <link rel="icon" type="image/png" href="assets/vyta-mark-192.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="preconnect" href="https://www.vytabio.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..800&display=swap" rel="stylesheet">

  <script>
    /*
     * Runs before anything is drawn. Two jobs:
     *  1. Ask vytabio.com for the live offer straight away, in parallel with
     *     the fonts and logo — not after the page has finished loading.
     *  2. Hold the offer text invisible until that answer arrives (at most
     *     HOLD_MS), so a visitor never sees one percentage and then another.
     * With JavaScript off, neither happens and the HTML below shows as written.
     */
    window.VYTA_OFFER = {
      slug: 'standards',                                            // = slug in Admin → Landing Pages
      api: 'https://www.vytabio.com/api/landing/',
      fallbackUrl: 'https://www.vytabio.com/products?lp=standards', // = "Button link" in admin
      holdMs: 900,      // longest the offer text waits for the store before showing the HTML's own figures
      timeoutMs: 6000   // after this, stop waiting for the store altogether
    };
    document.documentElement.classList.add('offer-pending');
    (function (c) {
      var ctl = 'AbortController' in window ? new AbortController() : null;
      setTimeout(function () { if (ctl) ctl.abort(); }, c.timeoutMs);
      c.request = fetch(c.api + encodeURIComponent(c.slug), { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
        .then(function (res) { return res.json(); });
    })(window.VYTA_OFFER);
  </script>

  <style>
    /* ------------------------------------------------------------------
       VYTA design tokens — the storefront's tailwind.config.ts, verbatim.
       The six core swatches are exact brand values; do not alter them.
       ------------------------------------------------------------------ */
    :root {
      --navy: #07203A;        /* Midnight Navy — ink and darkest surface */
      --ocean: #0E3F5F;       /* Deep Ocean — CTA hover */
      --vital: #1B5D83;       /* Vital Blue — small accent text (AA on white) */
      --teal: #438B9E;        /* Bio Teal — accents, focus, large text only */
      --aqua: #6EB2B8;        /* Aqua */
      --mist: #BBD6D6;        /* Mist — highlight band */
      --cloud: #F7FAFB;       /* Cloud — page ground */
      --teal-50: #F1F8F9;
      --teal-100: #E1EFF1;
      --ink-muted: #56707F;   /* body copy on white */
      --ink-light: #6E8898;   /* fine print */
      --line: #DCE7EB;
      --shadow-card: 0 1px 2px rgba(7, 32, 58, 0.04), 0 8px 24px -12px rgba(7, 32, 58, 0.10);
      --shadow-cta: 0 10px 24px -10px rgba(7, 32, 58, 0.45);
      --focus: 0 0 0 3px rgba(67, 139, 158, 0.28);
      --radius-card: 1.125rem;
      --radius-cta: 999px;
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    html { -webkit-text-size-adjust: 100%; }

    body {
      min-height: 100vh;
      min-height: 100dvh;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
      font-size: 16px;
      line-height: 1.5;
      color: var(--navy);
      /* Calm near-white ground with the faintest Cloud wash, as on vytabio.com. */
      background: linear-gradient(180deg, #FFFFFF 0%, var(--cloud) 55%, #FFFFFF 100%);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    .wrap {
      width: 100%;
      max-width: 34rem;
      margin: 0 auto;
      padding: clamp(1.5rem, 6vh, 4rem) 1rem 2rem;
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    .pane {
      background: #FFFFFF;
      border: 1px solid var(--line);
      border-radius: var(--radius-card);
      box-shadow: var(--shadow-card);
      padding: 2.25rem 1.5rem 1.75rem;
      text-align: center;
      position: relative;
      overflow: hidden;
    }
    /* The navy → teal brand rule across the top of the card. */
    .pane::before {
      content: '';
      position: absolute;
      inset: 0 0 auto 0;
      height: 4px;
      background: linear-gradient(90deg, #07203A 0%, #1B5D83 50%, #6EB2B8 100%);
    }

    /* Full lockup, at the guidelines' 160px minimum digital width. */
    .mark {
      display: block;
      width: 160px;
      height: auto;
      margin: 0 auto 1.5rem;
    }

    .eyebrow {
      font-size: 0.6875rem;
      font-weight: 600;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--vital);
      margin-bottom: 0.75rem;
    }

    h1 {
      /* "Inter Display": Inter driven to its display optical size. */
      font-optical-sizing: auto;
      font-variation-settings: 'opsz' 32;
      font-size: clamp(2rem, 8.5vw, 3.25rem);
      font-weight: 750;
      line-height: 1.06;
      letter-spacing: -0.03em;
      color: var(--navy);
      text-wrap: balance;
    }
    /* The number, marked like a highlighter pass in Mist. */
    h1 .hl {
      color: var(--vital);
      white-space: nowrap;
      background: linear-gradient(transparent 64%, var(--mist) 64%, var(--mist) 92%, transparent 92%);
      padding: 0 0.08em;
    }
    h1 .ast {
      color: var(--teal);
      font-size: 0.55em;
      vertical-align: super;
      margin-left: 0.04em;
      font-weight: 600;
    }

    .lede {
      margin: 1rem auto 0;
      max-width: 26rem;
      font-size: 1.0625rem;
      line-height: 1.55;
      color: var(--ink-muted);
      text-wrap: pretty;
    }

    .cta {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      width: 100%;
      min-height: 3.5rem;
      margin: 1.75rem 0 0;
      padding: 0 1.5rem;
      border-radius: var(--radius-cta);
      background: var(--navy);
      color: #FFFFFF;
      font-size: 1rem;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      text-decoration: none;
      box-shadow: var(--shadow-cta);
      transition: background-color 180ms ease, transform 180ms ease, box-shadow 180ms ease;
      -webkit-tap-highlight-color: transparent;
    }
    .cta:hover { background: var(--ocean); }
    .cta:active { transform: translateY(1px); }
    .cta:focus-visible { outline: none; box-shadow: var(--shadow-cta), var(--focus); }
    .cta .chev {
      font-size: 1.5rem;
      line-height: 1;
      margin-top: -0.12em;
      transition: transform 180ms ease;
    }
    .cta:hover .chev { transform: translateX(3px); }

    .note {
      margin-top: 0.875rem;
      font-size: 0.8125rem;
      color: var(--ink-muted);
    }
    .note .fine { color: var(--ink-light); }

    /* Three proof points under the card, on a teal-tinted band. */
    .strip {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 0.5rem;
      padding: 0.875rem 0.75rem;
      border-radius: var(--radius-card);
      background: var(--teal-50);
      border: 1px solid var(--teal-100);
    }
    .strip p {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.375rem;
      font-size: 0.75rem;
      font-weight: 600;
      line-height: 1.25;
      color: var(--navy);
      text-align: center;
    }
    .strip svg { width: 1.125rem; height: 1.125rem; color: var(--teal); flex-shrink: 0; }

    .legal {
      font-size: 0.6875rem;
      line-height: 1.5;
      color: var(--ink-light);
      text-align: center;
      padding: 0 0.5rem;
    }

    /* Use Code: VYTA20 — a coupon-style chip under the headline. */
    .code {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      margin-top: 1rem;
      padding: 0.5rem 0.95rem;
      border: 1.5px dashed var(--teal);
      border-radius: 0.75rem;
      background: var(--teal-50);
      font-size: 0.9375rem;
      font-weight: 500;
      color: var(--ink-muted);
    }
    .code strong {
      font-weight: 750;
      letter-spacing: 0.08em;
      color: var(--navy);
      font-variant-numeric: tabular-nums;
    }

    /* Offer text waits, invisible but still taking its space, until the store
       has confirmed the offer — so the page never shows one number then
       another, and nothing below it jumps when it appears. */
    [data-offer-hold] { transition: opacity 160ms ease; }
    .offer-pending [data-offer-hold] { opacity: 0; }

    /* Hidden until the offer API says otherwise — see the script. */
    [data-no-offer] { display: none; }
    .no-offer [data-offer] { display: none; }
    .no-offer [data-no-offer] { display: revert; }

    @media (min-width: 640px) {
      .pane { padding: 3rem 3rem 2.25rem; }
      .strip p { flex-direction: row; justify-content: center; font-size: 0.8125rem; }
    }

    @media (prefers-reduced-motion: reduce) {
      .cta, .cta .chev, [data-offer-hold] { transition: none; }
    }
  </style>
</head>
<body>
  <main class="wrap">
    <div class="pane">
      <picture>
        <source srcset="assets/vyta-logo-320.webp" type="image/webp">
        <img class="mark" src="assets/vyta-logo-320.png" width="160" height="141" alt="VYTA Biosciences">
      </picture>

      <p class="eyebrow" data-offer data-offer-hold>First order · Save <span data-offer-percent>20%</span></p>
      <p class="eyebrow" data-no-offer>VYTA Biosciences</p>

      <h1 data-offer data-offer-hold>Claim <span class="hl"><span data-offer-percent>20%</span> Off</span> <span data-offer-scope>Your First Order</span><span class="ast" aria-hidden="true">*</span></h1>
      <h1 data-no-offer>Research Compounds, <span class="hl">Tested</span></h1>

      <p class="code" data-offer data-offer-hold>Use Code: <strong data-offer-code>VYTA20</strong></p>

      <p class="lede">Third-party tested, with a certificate of analysis for every batch. Shipped from Canada in discreet packaging.</p>

      <a class="cta" id="cta" href="https://www.vytabio.com/products?lp=standards" rel="nofollow noopener">
        <span>Click to Shop Now</span>
        <span class="chev" aria-hidden="true">›</span>
      </a>

      <p class="note">
        Ships from Canada 🇨🇦<span data-offer data-offer-hold> · <span class="fine" id="fine-print">*First order only. Excludes bacteriostatic water.</span></span>
      </p>
    </div>

    <div class="strip">
      <p>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/></svg>
        Free Shipping
      </p>
      <p>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3h6"/><path d="M10 3v6.5L4.6 18.2A2 2 0 0 0 6.3 21h11.4a2 2 0 0 0 1.7-2.8L14 9.5V3"/><path d="M7.5 15h9"/></svg>
        Lab Tested
      </p>
      <p>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7"/><path d="m7.5 4.27 9 5.15"/></svg>
        Discreet Packaging
      </p>
    </div>

    <p class="legal">For laboratory research use only. Not for human or veterinary consumption. VYTA Biosciences does not diagnose, treat, prescribe, or provide medical or dosing instructions.</p>
  </main>

  <script>
    /*
     * The landing page's contract with vytabio.com — see LANDING_PAGES.md in
     * the store's repository.
     *
     *   1. The offer is READ from the store, never decided here. The HTML above
     *      carries the current figures (20%, VYTA20) so the page is right even
     *      if the store is slow or unreachable; when the store answers, its
     *      figures win, and if it says there is no offer the offer is hidden.
     *   2. The button forwards every query parameter this page was opened with
     *      (fbclid, gclid, utm_*) and always carries ?lp=<slug>, which is what
     *      makes the store put the code into the checkout's discount field.
     */
    (function () {
      var CONFIG = window.VYTA_OFFER;
      var root = document.documentElement;
      var cta = document.getElementById('cta');
      var incoming = new URLSearchParams(window.location.search);
      var revealed = false;

      function reveal() {
        if (revealed) return;
        revealed = true;
        root.classList.remove('offer-pending');
      }

      // The store's link for this page, plus every parameter the ad put on
      // this page's URL. The slug always wins — a visitor editing ?lp= here
      // must not pick another page's offer.
      function withForwardedParams(base) {
        var url;
        try { url = new URL(base); } catch (e) { url = new URL(CONFIG.fallbackUrl); }
        incoming.forEach(function (value, key) {
          if (key === 'lp') return;
          if (!url.searchParams.has(key)) url.searchParams.set(key, value);
        });
        url.searchParams.set('lp', CONFIG.slug);
        return url.toString();
      }

      function setText(selector, text) {
        var nodes = document.querySelectorAll(selector);
        for (var i = 0; i < nodes.length; i++) {
          if (nodes[i].textContent !== text) nodes[i].textContent = text;
        }
      }

      function apply(offer) {
        if (offer.cta_url) cta.href = withForwardedParams(offer.cta_url);

        if (!(offer.active && offer.percent > 0)) {
          // Switched off, ended, or no such slug. Never print a number the
          // store would not honour — the tab title included.
          root.classList.add('no-offer');
          document.title = 'VYTA Biosciences — Third-Party Tested, Shipped from Canada';
          return;
        }

        var label = offer.percent_label || (offer.percent + '%');
        if (revealed && document.querySelector('[data-offer-percent]').textContent !== label) {
          // The store answered after the hold and disagrees with the HTML: the
          // page is showing a stale figure. Update it, and say so.
          console.warn('[landing] The HTML says ' + document.querySelector('[data-offer-percent]').textContent +
            ' but Admin → Landing Pages says ' + label + '. Update the figures in index.html.');
        }
        setText('[data-offer-percent]', label);
        // Only if the store ever sends the code; until then the HTML's stands.
        if (offer.code) setText('[data-offer-code]', offer.code);

        var scope = offer.first_order_only ? 'Your First Order' : 'Your Order';
        setText('[data-offer-scope]', scope);
        if (!offer.first_order_only) setText('.eyebrow[data-offer]', 'Save ' + label);
        document.title = 'VYTA Biosciences — Claim ' + label + ' Off ' + scope;

        var fine = document.getElementById('fine-print');
        if (fine) {
          if (offer.fine_print) setText('#fine-print', offer.fine_print);
          else fine.parentNode.style.display = 'none';
        }
      }

      // Usable immediately, before the offer answer arrives.
      cta.href = withForwardedParams(CONFIG.fallbackUrl);

      // Never hold the text longer than this, however slow the store is.
      setTimeout(reveal, CONFIG.holdMs);

      CONFIG.request
        .then(function (offer) { apply(offer || {}); })
        .catch(function () {
          // Store unreachable: keep the HTML's figures and the fallback link.
          // Checkout applies the offer from ?lp= on its own, so it still holds.
        })
        .then(reveal);
    })();
  </script>
</body>
</html>
```
