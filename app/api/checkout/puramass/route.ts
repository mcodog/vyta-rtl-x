import { NextRequest, NextResponse, after } from 'next/server';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit, getClientIp, RATE_LIMITS } from '@/lib/rate-limit';
import {
  isPuramassConfigured,
  createPuramassOrder,
  PuramassApiError,
  PURAMASS_CURRENCY,
  type PuramassOrderLine,
} from '@/lib/payments/puramass';
import {
  readVisitorContext,
  attributionColumns,
  landingPageOf,
  linkVisitorIdentity,
  stampVisitorMilestone,
} from '@/lib/analytics/attribution-server';
import {
  flatHostedRate,
  freeHostedRate,
  PURAMASS_FLAT_COURIER_ID,
  selectHostedRate,
  type HostedShippingRate,
} from '@/lib/payments/puramass-shipping';
import {
  quoteHostedRates,
  type HostedQuoteDestination,
} from '@/lib/payments/puramass-rates-server';
import {
  qualifiesForFreeShipping,
  shapeHostedShippingSettings,
  type HostedShippingSettings,
} from '@/lib/payments/puramass-settings';
import { validateShippingAddress } from '@/lib/payments/puramass-address';
import { isShippableCountry } from '@/lib/shipping/regions';
import { isMissingColumnError } from '@/lib/payments/puramass-columns';
import { trackStartedCheckout } from '@/lib/klaviyo/events';
import { createPendingStealthHealthInvoice } from '@/lib/payments/puramass-fulfillment';
import {
  distributeLineDiscounts,
  isAdTraffic,
  qualifiesForAdDiscount,
  shapeAdDiscountSettings,
  type AdDiscountSettings,
} from '@/lib/promos/ad-discount';
import {
  combineDiscountPercents,
  qualifiesForCartOffer,
  shapeCartOfferSettings,
} from '@/lib/promos/cart-offer';
import { isCustomerFirstOrder } from '@/lib/promos/first-order';
import { eligibleSubtotal, lookupDiscountCode } from '@/lib/affiliate/discount-codes';
import { resolveLandingOffer } from '@/lib/promos/landing-server';
import { resolvePriceMap } from '@/lib/pricing/resolve';
import { packPriceFor, round2, vialPriceFor, vialsPerBoxOf } from '@/lib/pricing';
import { isValidPhone } from '@/lib/phone';

// All access is server-side against the service-role client (RLS-bypassing).
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const clampPacks = (n: number) => Math.min(99, Math.max(1, n));

interface IncomingLine {
  id: string;
  packSize: number;
  quantity: number;
}

/**
 * Re-quote couriers and resolve the option the buyer picked into an amount we
 * are willing to charge.
 *
 * The browser sends back only a `courier_id` — never a price. Shipping is
 * money, so the only figure that may reach Stealth Health is one Easyship has just
 * confirmed, or the flat fee. Goes through the same `quoteHostedRates` helper
 * the rates endpoint uses, so the list priced here is the list the buyer was
 * shown.
 *
 * A courier that has dropped off the list since they chose it yields a null
 * rate, so the caller can hand the fresh options back and ask them to pick
 * again rather than silently charging something else. When there is nothing
 * live to offer, the flat fee stands — which is what the picker was showing.
 *
 * `freeShipping` zeroes the price of whatever they picked without discarding
 * the courier: a parcel still travels by a service, and the shipment booked
 * later needs to know which.
 */
async function resolveHostedShipping(
  settings: HostedShippingSettings,
  courierId: string | null,
  destination: HostedQuoteDestination,
  vials: number,
  freeShipping: boolean,
): Promise<{ rate: HostedShippingRate | null; rates: HostedShippingRate[] }> {
  const price = (rate: HostedShippingRate | null) =>
    rate && freeShipping ? freeHostedRate(rate) : rate;

  if (!settings.ratesEnabled) {
    const flat = flatHostedRate(settings.flatShipping);
    return { rate: price(flat), rates: [flat] };
  }

  const quote = await quoteHostedRates(db, destination, vials, settings);
  if (!quote.live) return { rate: price(quote.rates[0]), rates: quote.rates };
  return { rate: price(selectHostedRate(quote.rates, courierId)), rates: quote.rates };
}

/**
 * The `site_settings` singleton, read once for everything this route decides:
 * whether the hosted checkout is live at all, what shipping costs, and whether
 * a paid-ads discount is running.
 *
 * `select('*')` for the same reason every other reader of this table uses it —
 * naming a column PostgREST has not seen yet fails the WHOLE query, and these
 * columns arrive across several migrations. Each shaper defaults what is
 * absent, and a read that fails outright yields an empty row, which reads as
 * "nothing is switched on" rather than "everything is".
 */
async function readSiteSettings(): Promise<Record<string, any>> {
  try {
    const { data, error } = await db
      .from('site_settings')
      .select('*')
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error('[puramass] settings read failed:', error.message);
      return {};
    }
    return (data as Record<string, any>) ?? {};
  } catch (err: any) {
    console.error('[puramass] settings read threw:', err?.message ?? err);
    return {};
  }
}

/**
 * Price every cart line from the catalog, in cents.
 *
 * Derived here rather than taken from the request because both things that
 * depend on it are money: the free-shipping threshold, and the paid-ads
 * discount that is subtracted from these very prices before the hand-off. A
 * browser that could name its own prices could hand itself either.
 *
 * Priced through the same chain the storefront quotes from (customer override >
 * active pricelist > products.price, then the pack rule), the same way the
 * regular order route does, so what is sent is the pack price the buyer saw
 * in their cart. A line we cannot price comes back at zero, which the caller
 * refuses to send.
 *
 * Keyed by `${product id}::${pack size}`, and priced per PACK: one unit of a
 * 5-pack line is the 5-pack's price.
 */
async function priceCartLines(
  lines: { id: string; packSize: number }[],
  products: Map<string, any>,
  customerId: string | null,
): Promise<Map<string, number>> {
  const ids = [...new Set(lines.map((l) => l.id))];
  let priceMap = new Map<string, { price: number; source: string; base: number }>();
  try {
    priceMap = await resolvePriceMap(db, { customerId, productIds: ids });
  } catch (err) {
    console.error('[puramass] price resolution failed:', err);
  }

  const unitCents = new Map<string, number>();
  for (const line of lines) {
    const product = products.get(line.id);
    if (!product) continue;
    const vialsPerBox = vialsPerBoxOf(product.vials_per_box);
    const resolved = priceMap.get(line.id) ?? {
      price: Number(product.price ?? 0),
      source: 'base',
      base: Number(product.price ?? 0),
    };
    // Same rule as the retired on-site checkout: a pricelist / per-customer override
    // restates the per-vial price and drops the catalog's fixed pack prices.
    const vialPrice =
      resolved.source === 'base'
        ? vialPriceFor({
            price: resolved.base,
            vial_price: product.vial_price ?? null,
            vials_per_box: vialsPerBox,
          })
        : round2(resolved.price / vialsPerBox);
    const unit = packPriceFor(
      {
        price: resolved.base,
        vial_price: vialPrice,
        vials_per_box: vialsPerBox,
        pack_options: resolved.source === 'base' ? (product.pack_options ?? null) : null,
      },
      line.packSize,
    );
    unitCents.set(
      `${line.id}::${line.packSize}`,
      Number.isFinite(unit) && unit > 0 ? Math.round(unit * 100) : 0,
    );
  }
  return unitCents;
}

/**
 * Is this buyer owed the paid-ads welcome discount?
 *
 * Decided entirely server-side. The browser says nothing about it — it only
 * displays what it expects — because this is what lowers the prices that get
 * charged.
 *
 * Their channel is looked for in both places it is recorded: the attribution
 * cookies `middleware.ts` wrote, and the snapshot frozen onto their customer
 * row at signup. Either is proof, because a buyer who cleared their cookies
 * since creating the account is still a buyer that ad won.
 *
 * It is a WELCOME offer, so it is also their first order or nothing:
 * `isCustomerFirstOrder` decides that from the legacy first-order flag and this
 * customer's existing hosted hand-offs. The storefront asks the same function
 * through `/api/promos/first-order`, but nothing it says is trusted here — a
 * repeat buyer whose browser claims otherwise is still charged list price.
 */
async function earnsAdDiscount(
  settings: AdDiscountSettings,
  customerId: string | null,
  visitor: { first: { channel: string } | null; last: { channel: string } | null },
): Promise<boolean> {
  if (!settings.enabled || !customerId) return false;

  let frozen: string | null = null;
  try {
    const { data } = await db
      .from('customers')
      .select('attribution_channel')
      .eq('id', customerId)
      .maybeSingle();
    frozen = (data?.attribution_channel as string | null) ?? null;
  } catch {
    // The column arrives with marketing-attribution-migration.sql. Without it
    // the cookies still decide; they are the same fact, freshly read.
  }

  // Cheapest first: if the channel does not qualify there is no reason to ask
  // the database whether they have ordered before.
  const fromAd = isAdTraffic([
    frozen,
    visitor.first?.channel ?? null,
    visitor.last?.channel ?? null,
  ]);
  if (!fromAd) return false;

  const firstOrder = await isCustomerFirstOrder(db, customerId);

  return qualifiesForAdDiscount(settings, {
    signedIn: true,
    firstOrder,
    channels: [frozen, visitor.first?.channel ?? null, visitor.last?.channel ?? null],
  });
}

/**
 * POST /api/checkout/puramass — hand the cart off to the Stealth Health hosted
 * checkout. Resolves each cart product to its Stealth Health SKU server-side (never
 * trusting a client-sent SKU or price), converts cart quantity to packs,
 * creates the hosted order, records a ledger row, and returns the payment link
 * the storefront redirects to.
 *
 * The hand-off is denominated in CAD (`PURAMASS_CURRENCY`), so the hosted page
 * prices and charges in Canadian dollars instead of converting our catalog to
 * its own USD listings. Goods prices are normally Stealth Health's own — ours are
 * sent only when a discount applies (the paid-ads welcome discount, the
 * limited-time cart offer, or both composed into one), because lowering the
 * line prices is the only way this API has of taking money off (step 8b). The
 * shipping total is always ours, and only when hosted rates are enabled (see
 * `resolveHostedShipping`).
 */
export async function POST(req: NextRequest) {
  // 1. Rate-limit by IP (same budget as the legacy on-site checkout).
  const ip = getClientIp(req);
  const rl = checkRateLimit(`puramass:${ip}`, RATE_LIMITS.orders);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    );
  }

  // 2. Configured?
  if (!isPuramassConfigured()) {
    return NextResponse.json(
      { error: 'Hosted checkout is not available right now.' },
      { status: 503 },
    );
  }

  // 3. Settings. Everything this route reads from site_settings comes off this
  //    one row — shipping and the promos below. The hosted checkout is the
  //    only checkout, so there is no on/off toggle to honour here.
  const settingsRow = await readSiteSettings();

  // 4. Parse + validate.
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const rawItems: IncomingLine[] = Array.isArray(body?.items) ? body.items : [];
  if (rawItems.length === 0) {
    return NextResponse.json({ error: 'Your cart is empty.' }, { status: 400 });
  }

  const email = String(body?.customer?.email ?? '').trim();
  if (!emailRegex.test(email)) {
    return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });
  }
  const firstName = String(body?.customer?.firstName ?? '').trim() || undefined;
  const lastName = String(body?.customer?.lastName ?? '').trim() || undefined;
  if (!firstName || !lastName) {
    return NextResponse.json({ error: 'Enter your first and last name.' }, { status: 400 });
  }
  // Required on every checkout, whether or not a ship-to is collected here.
  const phone = String(body?.customer?.phone ?? body?.shipping?.phone ?? '').trim();
  if (!isValidPhone(phone)) {
    return NextResponse.json(
      { error: 'Enter a valid phone number.', fields: { phone: 'Enter a valid phone number.' } },
      { status: 400 },
    );
  }
  const referralCode = String(body?.referralCode ?? '').trim() || null;
  const discountCodeInput = String(body?.discountCode ?? '').trim() || null;
  // The buyer took the landing page's code out of the discount field
  // themselves, so the fallback in step 8c must not put it back.
  const declineLandingOffer = body?.declineLandingOffer === true;

  // 4b. Ship-to. Only collected when the buyer picks a live courier rate —
  //     with the flat fee there is nothing to quote, so Stealth Health goes on
  //     collecting the address on its own hosted page as it always has.
  //
  //     The same validator the /shipping-address/<token> form uses, so the
  //     browser and the server can't disagree about what a complete address is.
  const shippingSettings = shapeHostedShippingSettings(settingsRow);
  const address = validateShippingAddress({
    full_name:
      [firstName, lastName].filter(Boolean).join(' ').trim() ||
      String(body?.shipping?.full_name ?? '').trim(),
    phone,
    address: body?.shipping?.address,
    address2: body?.shipping?.address2,
    city: body?.shipping?.city,
    state: body?.shipping?.state,
    zip: body?.shipping?.zip,
    country: body?.shipping?.country,
  });
  // Canada is the only place we ship. A country is only checked when one was
  // sent, so a checkout without the address step still goes through.
  const shipCountry = String(body?.shipping?.country ?? '').trim();
  if (shipCountry && !isShippableCountry(shipCountry)) {
    return NextResponse.json(
      { error: 'We only ship within Canada.', fields: { country: 'We only ship within Canada.' } },
      { status: 400 },
    );
  }
  if (shippingSettings.ratesEnabled && !address.ok) {
    return NextResponse.json(
      { error: 'Enter a complete shipping address.', fields: address.errors },
      { status: 400 },
    );
  }

  // 5. Read the cart lines. `quantity` is the TOTAL VIALS in the line and
  //    `packSize` is the vials in one of its units; the SKU mapping itself is
  //    decided in step 7a, once the products (and their case size) are loaded.
  const rawLines: { id: string; packSize: number; vials: number }[] = [];
  // Whole cart counted in single vials — what the parcel weight is derived from.
  let totalVials = 0;
  // The same cart counted in UNITS — a line of "3 × pack of 5" is 3 here and 15
  // above. This is what the limited-time offer's minimum is measured in,
  // because it is what the shopper was asked to add to.
  let cartUnits = 0;
  for (const line of rawItems) {
    const id = String(line?.id ?? '').trim();
    const packSize = Number(line?.packSize);
    const quantity = Number(line?.quantity);
    if (!id || !Number.isFinite(packSize) || packSize <= 0 || !Number.isFinite(quantity) || quantity <= 0) {
      continue;
    }
    const vials = Math.round(quantity);
    totalVials += vials;
    cartUnits += Math.max(1, Math.round(vials / Math.round(packSize)));
    rawLines.push({ id, packSize: Math.round(packSize), vials });
  }
  if (rawLines.length === 0) {
    return NextResponse.json({ error: 'Your cart is empty.' }, { status: 400 });
  }

  // 6. Best-effort customer id from a bearer token (guests → null).
  let customerId: string | null = null;
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (token) {
    try {
      const { data: { user } } = await db.auth.getUser(token);
      customerId = user?.id ?? null;
    } catch {
      customerId = null;
    }
  }

  // 7. Load the products' server-side SKU mapping, and the prices the
  //    free-shipping threshold is measured against. Never trust client SKUs or
  //    client prices.
  //    Fall back to a box-only select if the vial column migration hasn't run.
  const ids = [...new Set(rawLines.map((l) => l.id))];
  let products: any[] = [];
  const withVial = await db
    .from('products')
    .select('id, name, price, vial_price, vials_per_box, pack_options, puramass_sku, puramass_sku_vial')
    .in('id', ids);
  if (withVial.error) {
    const boxOnly = await db
      .from('products')
      .select('id, name, price, vial_price, vials_per_box, puramass_sku')
      .in('id', ids);
    if (boxOnly.error) {
      return NextResponse.json({ error: 'Could not load your cart.' }, { status: 500 });
    }
    products = boxOnly.data ?? [];
  } else {
    products = withVial.data ?? [];
  }
  const byId = new Map(products.map((p) => [p.id, p]));

  // 7a. Decide each line's SKU now that the products are loaded. Stealth
  //     Health stocks two SKUs per product: a single vial (`puramass_sku_vial`)
  //     and a case (`puramass_sku`). A single vial maps to the vial SKU; EVERY
  //     pack of more than one — a 3-pack, a 5-pack, a 10-pack, a 20-pack —
  //     maps to the case SKU, one unit per pack, priced at that pack's own
  //     price (`unit_price_cents` below).
  const normalized: { id: string; mapping: 'box' | 'vial'; packSize: number; units: number }[] = [];
  for (const line of rawLines) {
    const asBox = line.packSize > 1;
    normalized.push({
      id: line.id,
      mapping: asBox ? 'box' : 'vial',
      packSize: asBox ? line.packSize : 1,
      units: clampPacks(asBox ? Math.max(1, Math.round(line.vials / line.packSize)) : line.vials),
    });
  }

  // 8. Merge lines by SKU AND pack size, carrying our own price for one unit
  //    alongside the quantity; collect any unmapped products. A 5-pack and a
  //    10-pack of one product share the case SKU at different prices, so they
  //    travel as separate lines rather than being merged at one price.
  //
  //    The same pack added twice is summed and re-clamped — and the discount
  //    below is worked out from THESE merged lines, after the clamp, so what it
  //    is measured against is exactly what gets sent.
  const unitCentsByLine = await priceCartLines(normalized, byId, customerId);
  const linesBySku = new Map<
    string,
    {
      sku: string;
      quantity: number;
      unitPriceCents: number;
      // Carried for the invoice written at hand-off: which product the line
      // takes stock from, and how many vials one unit of it is.
      productId: string;
      productName: string;
      packSize: number;
    }
  >();
  const unmapped: string[] = [];
  for (const line of normalized) {
    const product = byId.get(line.id);
    const sku = (line.mapping === 'vial' ? product?.puramass_sku_vial : product?.puramass_sku)?.trim();
    if (!sku) {
      const base = product?.name ?? line.id;
      const label = line.mapping === 'vial' ? `${base} (single vial)` : `${base} (pack of ${line.packSize})`;
      if (!unmapped.includes(label)) unmapped.push(label);
      continue;
    }
    const key = `${sku}::${line.packSize}`;
    const merged = linesBySku.get(key);
    linesBySku.set(key, {
      sku,
      quantity: clampPacks((merged?.quantity ?? 0) + line.units),
      // `||` rather than `??`: two products can share one SKU, and a line we
      // failed to price (0) must not shut out a sibling we did.
      unitPriceCents:
        merged?.unitPriceCents || unitCentsByLine.get(`${line.id}::${line.packSize}`) || 0,
      productId: merged?.productId ?? line.id,
      productName: merged?.productName ?? String(product?.name ?? sku),
      packSize: line.packSize,
    });
  }

  if (unmapped.length > 0) {
    return NextResponse.json(
      {
        error: 'Some items are not available for hosted checkout.',
        unmapped,
      },
      { status: 409 },
    );
  }

  // 8a. Every line travels with OUR price. Nothing is left to Stealth Health's own
  //     catalog, so a line we could not price stops the hand-off here rather
  //     than going out without one and being charged at their list.
  const unpriced = [...linesBySku.values()]
    .filter((line) => !(line.unitPriceCents > 0))
    .map((line) => line.sku);
  if (unpriced.length > 0) {
    console.error('[puramass] hand-off refused: no price for %s', unpriced.join(', '));
    return NextResponse.json(
      { error: 'We could not price your cart. Please try again or contact support.' },
      { status: 500 },
    );
  }

  // 8b. The discounts: the paid-ads welcome discount and the limited-time cart
  //     offer. Both can land on one order.
  //
  //     The hosted order has no discount field, so the only way to take money
  //     off is to send lower prices: `distributeLineDiscounts` splits the
  //     percentage across the lines and each one travels as its own
  //     `unit_price_cents`. Undiscounted lines carry our list price. Our own
  //     summary shows the saving as one deduction off the subtotal; the hosted
  //     page can only show the already-reduced line prices.
  //
  //     Stacked promos are COMPOSED into one percentage per line and split once
  //     (`combineDiscountPercents`: 25% then 10% is 32.5% off, not 35%). Two
  //     splits in a row would round twice, and adding the percentages could
  //     reach 100 — a zero line price, which this API reads as "use your own
  //     price" and charges at full list. Lines only differ in percentage when
  //     a discount code excludes some products (step 8c).
  //
  //     Both are decided here, and neither is asked of the browser: the
  //     welcome discount from the cookies and the customer row, the cart offer
  //     from the settings row's own minimum and end date, measured against the
  //     quantities this request is actually ordering.
  //
  //     One guard on the split, about that same zero: every discounted price
  //     must still be above zero. If one is not, the discount is dropped and
  //     the lines go out at list, rather than handing out free product.
  const visitor = readVisitorContext(req.cookies);
  const adDiscountSettings = shapeAdDiscountSettings(settingsRow);
  const earnedAd = await earnsAdDiscount(adDiscountSettings, customerId, visitor);

  const cartOfferSettings = shapeCartOfferSettings(settingsRow);
  const earnedOffer = qualifiesForCartOffer(cartOfferSettings, cartUnits);

  // 8c. The discount code — the one the buyer typed, or the one checkout put
  //     into the field for them from the landing page they arrived through.
  //     Checked against the LIST subtotal of exactly these lines, the same
  //     figure its minimum and any fixed amount are measured in, and against
  //     these lines by product, for a code that excludes some. A code the
  //     buyer sent that does not apply is an error they can fix, not something
  //     to drop silently on the way to the payment page.
  //
  //     It does not stack with the paid-ads welcome discount — the buyer gets
  //     whichever takes more off — but does stack with the cart offer,
  //     composed the same way as every other pair.
  const listSubtotalCents = [...linesBySku.values()].reduce(
    (total, line) => total + line.unitPriceCents * line.quantity,
    0,
  );
  const codeLines = [...linesBySku.values()].map((line) => ({
    productId: line.productId,
    amount: (line.unitPriceCents * line.quantity) / 100,
  }));

  // The landing page's code, when the buyer sent none. The storefront puts it
  // into the discount field itself; this is the backstop for when it could
  // not — the offer fetch failed, the buyer pressed Pay before it landed, or
  // their browser blocks our scripts. The promise was made on the landing
  // page, so keeping it cannot depend on the browser.
  //
  // It is only a default: a code the buyer typed replaces it, and a buyer who
  // took it out of the field is not given it back. And unlike a typed code,
  // one that turns out not to apply (they have ordered before) does not stop
  // the checkout — they never asked for it, so they pay list price as anyone
  // else would.
  let codeToApply = discountCodeInput;
  let codeFromLanding = false;
  if (!codeToApply && !declineLandingOffer && visitor.landingPage) {
    const landing = await resolveLandingOffer(db, visitor.landingPage);
    if (landing?.offer.code) {
      codeToApply = landing.offer.code;
      codeFromLanding = true;
    }
  }

  let appliedCode:
    | { id: string; code: string; percent: number; excluded: Set<string>; eligibleCents: number }
    | null = null;
  if (codeToApply) {
    const lookup = await lookupDiscountCode(db, codeToApply, {
      subtotal: listSubtotalCents / 100,
      customerId,
      email,
      lines: codeLines,
    });
    if (lookup.ok) {
      const excluded = new Set(lookup.code.excluded_product_ids.map((id) => id.toLowerCase()));
      appliedCode = {
        id: lookup.code.id,
        code: lookup.code.code,
        percent: lookup.percent,
        excluded,
        eligibleCents: Math.round(eligibleSubtotal(codeLines, lookup.code.excluded_product_ids) * 100),
      };
    } else if (codeFromLanding) {
      console.info(
        '[puramass] landing offer %s not applied for this buyer: %s',
        visitor.landingPage,
        lookup.reason,
      );
    } else {
      return NextResponse.json(
        { error: lookup.message, discount_code_error: true },
        { status: 400 },
      );
    }
  }

  // Code against welcome discount, compared by what each would take off the
  // whole order: a code that excludes products takes its percentage off only
  // part of it. With no exclusions the eligible share is exactly 1, so this is
  // the plain percentage comparison it always was.
  const adPercent = earnedAd ? adDiscountSettings.percent : 0;
  const codeEffectivePercent =
    appliedCode && listSubtotalCents > 0
      ? (appliedCode.percent * appliedCode.eligibleCents) / listSubtotalCents
      : 0;
  const codeBeatsAd = appliedCode !== null && codeEffectivePercent >= adPercent;
  const usedAd = earnedAd && !codeBeatsAd;
  const offerPercent = earnedOffer ? cartOfferSettings.percent : 0;

  // Each line's own percentage: the winning first discount (none on a line the
  // code excludes), composed with the cart offer. Lines sharing a percentage
  // are split together, so an order where every line shares one is priced by
  // exactly the single split it always was.
  const percentLines = [...linesBySku.entries()].map(([key, line]) => {
    const first = codeBeatsAd
      ? appliedCode!.excluded.has(line.productId.toLowerCase())
        ? 0
        : appliedCode!.percent
      : usedAd
        ? adPercent
        : 0;
    return {
      key,
      unitPriceCents: line.unitPriceCents,
      quantity: line.quantity,
      percent: combineDiscountPercents(first, offerPercent),
    };
  });
  const excludedLinesInCart =
    codeBeatsAd &&
    [...linesBySku.values()].some((line) => appliedCode!.excluded.has(line.productId.toLowerCase()));

  let discount: ReturnType<typeof distributeLineDiscounts> | null = null;
  if (percentLines.some((line) => line.percent > 0)) {
    const split = distributeLineDiscounts(percentLines);
    if (split.lines.every((l) => l.discountedUnitPriceCents > 0)) {
      discount = split;
    } else {
      console.error(
        '[puramass] discount skipped: %s would zero a line price; sending list prices',
        percentLines.map((l) => `${l.percent}%`).join('/'),
      );
    }
  }
  // One figure for the whole saving, as a share of the list subtotal — the
  // percentage itself when every line got the same one.
  const uniformPercent = new Set(percentLines.map((l) => l.percent)).size === 1 ? percentLines[0].percent : null;
  const overallPercent = discount
    ? uniformPercent ?? Math.round((discount.discountCents / Math.max(1, discount.subtotalCents)) * 10000) / 100
    : 0;

  const discountedBySku = new Map(
    (discount?.lines ?? []).map((l) => [l.key, l.discountedUnitPriceCents]),
  );
  const items: PuramassOrderLine[] = [...linesBySku.entries()].map(([key, line]) => ({
    sku: line.sku,
    quantity: line.quantity,
    unit_price_cents: discountedBySku.get(key) ?? line.unitPriceCents,
  }));

  // 9. Price the shipping. Re-quoted here rather than trusted from the
  //    browser; a courier that is no longer on offer sends the buyer back to
  //    the picker with the fresh list instead of being charged something else.
  //    The free-shipping promo is settled against a subtotal derived from the
  //    catalog, never one the browser supplied.
  //
  //    Measured at LIST price, before any ad discount: the threshold is what
  //    the cart's progress bar counts toward, and the two must agree or a buyer
  //    watching it fill would lose the free shipping at the last step.
  const goodsSubtotal = [...linesBySku.values()].reduce(
    (total, line) => total + (line.unitPriceCents * line.quantity) / 100,
    0,
  );
  const freeShipping = shippingSettings.freeShippingEnabled
    ? qualifiesForFreeShipping(shippingSettings, Math.round(goodsSubtotal * 100) / 100)
    : false;
  const { rate: shippingRate, rates: shippingRates } = await resolveHostedShipping(
    shippingSettings,
    String(body?.shipping?.courier_id ?? '').trim() || null,
    {
      country: address.value.address.country ?? '',
      postal_code: address.value.address.zip ?? '',
      city: address.value.address.city ?? '',
      state: address.value.address.state ?? undefined,
    },
    totalVials,
    freeShipping,
  );
  if (!shippingRate) {
    return NextResponse.json(
      {
        error: 'Those shipping options have changed. Please choose a delivery method again.',
        rates: shippingRates,
      },
      { status: 409 },
    );
  }
  const shippingTotalCents = Math.round(shippingRate.total_charge * 100);

  // 10. Our idempotency key, echoed back by Stealth Health and unique in the ledger.
  const partnerReference = `amc_${crypto.randomUUID()}`;

  // 11. Create the hosted order.
  let order;
  try {
    order = await createPuramassOrder({
      items,
      customer: { email, first_name: firstName, last_name: lastName, phone },
      partnerReference,
      currency: PURAMASS_CURRENCY,
      shippingTotalCents,
    });
  } catch (err) {
    if (err instanceof PuramassApiError) {
      // Surface 4xx messages (client can act on them); collapse the rest to 502
      // so partner-side detail never leaks and no charge is implied.
      if (err.status >= 400 && err.status < 500) {
        return NextResponse.json({ error: err.detail }, { status: err.status });
      }
      return NextResponse.json({ error: 'Checkout is temporarily unavailable.' }, { status: 502 });
    }
    return NextResponse.json({ error: 'Checkout is temporarily unavailable.' }, { status: 502 });
  }

  // 12. Record the hand-off (best-effort — never block the redirect).
  //
  // The attribution snapshot is the important part of this row. Once the buyer
  // is redirected to Stealth Health they leave our cookies behind, and the payment
  // comes back through a webhook that knows nothing but an email address — so
  // the channel has to be frozen here, on the way out, or it is lost.
  const attribution = attributionColumns(visitor);

  // Columns the base puramass-hosted-checkout migration created — always safe.
  const base: Record<string, unknown> = {
    partner_reference: partnerReference,
    transaction_id: order.transaction_id,
    payment_link: order.payment_link,
    status: order.status || 'payment_pending',
    // Stamped at hand-off so reporting reads CAD from the start instead of
    // defaulting to USD while the order waits for its first webhook.
    currency: order.currency ?? PURAMASS_CURRENCY,
    subtotal_cents: order.subtotal_cents ?? null,
    customer_id: customerId,
    customer_email: email,
    items,
    referral_code: referralCode,
  };

  // The ship-to the buyer typed here. Marked `customer` so a later partner
  // payload can't overwrite it — see `buildPuramassContactPatch`. Only written
  // when we actually collected one, so a flat-fee hand-off still leaves
  // Stealth Health's own reported address to fill the row in.
  const addressColumns: Record<string, unknown> = address.ok
    ? {
        shipping_address: address.value.address,
        shipping_address_source: 'customer',
        shipping_address_updated_at: new Date().toISOString(),
        customer_name: address.value.full_name || null,
        customer_phone: address.value.phone,
      }
    : {};

  // What we charged for shipping, so the fulfillment invoice can stamp the
  // real amount instead of the flat fallback.
  const pickedCourier = shippingRate.courier_id !== PURAMASS_FLAT_COURIER_ID;
  const shippingColumns: Record<string, unknown> = {
    shipping_total_cents: shippingTotalCents,
    shipping_courier: pickedCourier
      ? `${shippingRate.courier_name} · ${shippingRate.service_name}`.trim() +
        (freeShipping ? ' (free shipping)' : '')
      : null,
    // The Easyship service id, so the shipment booked once the order is paid
    // is the one the buyer paid for rather than one re-picked by preference.
    shipping_courier_id: pickedCourier ? shippingRate.courier_id : null,
  };

  // Try the richest row first and shed the optional column groups one at a
  // time when the database says it doesn't know them. The hand-off has already
  // been created on Stealth Health's side, so the row MUST land — but an unmigrated
  // column must not cost us the marketing attribution either, which is why the
  // newest group is dropped before the older one.
  // What the discounts took off, so a discounted order can be told from a
  // cheaper cart when the settlement ledger is reconciled against the catalog.
  // `ad_discount_cents` is the whole saving — there is one split, at the
  // composed percentage — while the two `_percent` columns record which promo
  // granted what. Null on every order that earned neither.
  const discountColumns: Record<string, unknown> = discount
    ? {
        ad_discount_percent: usedAd ? adDiscountSettings.percent : 0,
        ad_discount_cents: discount.discountCents,
        cart_offer_percent: earnedOffer ? cartOfferSettings.percent : null,
        cart_offer_min_items: earnedOffer ? cartOfferSettings.minItems : null,
      }
    : {};

  // The discount code, recorded whether or not the split landed: it is what
  // credits the affiliate and counts against the code's usage limit.
  // `discount_code_cents` is the code's own share of the saving — what it
  // alone would have taken off the list total of the lines it applies to.
  const codeColumns: Record<string, unknown> = appliedCode
    ? {
        discount_code_id: appliedCode.id,
        discount_code: appliedCode.code,
        discount_code_percent: codeBeatsAd && discount ? appliedCode.percent : 0,
        discount_code_cents:
          codeBeatsAd && discount
            ? Math.round((appliedCode.eligibleCents * appliedCode.percent) / 100)
            : 0,
      }
    : {};

  // Which landing page sent this buyer — the one whose offer they hold, else
  // the one on their first or last touch. Frozen here for the same reason the
  // channel is: past this point they are on Stealth Health's domain, and
  // nothing about their visit comes back with the payment.
  const landingPage = landingPageOf(visitor);
  const landingColumns: Record<string, unknown> = landingPage ? { landing_page: landingPage } : {};

  const attempts: Record<string, unknown>[] = [
    {
      ...base,
      ...attribution,
      ...addressColumns,
      ...shippingColumns,
      ...discountColumns,
      ...codeColumns,
      ...landingColumns,
    },
    { ...base, ...attribution, ...addressColumns, ...shippingColumns, ...discountColumns, ...codeColumns },
    { ...base, ...attribution, ...addressColumns, ...shippingColumns, ...discountColumns },
    { ...base, ...attribution, ...addressColumns, ...shippingColumns },
    { ...base, ...attribution, ...addressColumns },
    { ...base, ...attribution },
    base,
  ];
  let ledgerId: string | null = null;
  try {
    for (const row of attempts) {
      const { data, error } = await db.from('puramass_orders').insert(row).select('id').single();
      if (!error) {
        ledgerId = (data?.id as string | undefined) ?? null;
        break;
      }
      if (!isMissingColumnError(error)) {
        console.error('[puramass] ledger insert failed:', error.message);
        break;
      }
    }
  } catch (err) {
    console.error('[puramass] ledger insert threw:', err);
  }

  // 12b. The invoice, written now in `pending_payment` so it carries exactly
  //      what the buyer was charged — goods, shipping and the courier they
  //      picked — in CAD. It is flipped to paid by the webhook/poller.
  //      Best-effort: if it cannot be written the order is invoiced on payment.
  if (ledgerId) {
    const invoiceLines = [...linesBySku.entries()].map(([key, line]) => ({
      product_id: line.productId,
      description:
        line.packSize > 1
          ? `${line.productName} — Pack of ${line.packSize}`
          : `${line.productName} — Single vial`,
      qty: line.quantity,
      unit_price: (discountedBySku.get(key) ?? line.unitPriceCents) / 100,
      price_type: (line.packSize > 1 ? 'box' : 'vial') as 'box' | 'vial',
      vials_per_unit: line.packSize,
    }));
    const chargedSubtotal = invoiceLines.reduce((sum, l) => sum + l.qty * l.unit_price, 0);
    const discountParts = [
      appliedCode && codeBeatsAd
        ? `code ${appliedCode.code}, ${appliedCode.percent}% off` +
          (excludedLinesInCart ? ' eligible items (excluded products at list price)' : '')
        : null,
      usedAd ? `${adPercent}% first-order discount` : null,
      earnedOffer ? `${offerPercent}% limited-time offer` : null,
    ].filter(Boolean);
    const discountNote = discount
      ? `Discount applied: ${discountParts.join(' + ') || `${overallPercent}% off`}` +
        ` — saved $${(discount.discountCents / 100).toFixed(2)} CAD.`
      : null;
    await createPendingStealthHealthInvoice(db, {
      ledgerId,
      customerId,
      customerEmail: email,
      customerName:
        (address.ok ? address.value.full_name : '') ||
        [firstName, lastName].filter(Boolean).join(' ') ||
        null,
      customerPhone: phone,
      lines: invoiceLines,
      subtotal: chargedSubtotal,
      shipping: shippingTotalCents / 100,
      courierId: pickedCourier ? shippingRate.courier_id : null,
      note: discountNote,
    });
  }

  // Tie the email to this visitor so the webhook/poller can attribute the
  // payment when it lands, and mark them as having reached a checkout.
  void linkVisitorIdentity(db, visitor.anonymousId, { email, customerId });
  void stampVisitorMilestone(db, visitor.anonymousId, 'checkout_at');

  // Klaviyo "Started Checkout" — drives the abandoned-checkout flow. The
  // payment link is the resume URL; Klaviyo drops the flow for anyone who
  // goes on to trigger "Placed Order". After the response, so the redirect
  // never waits on it.
  const nameBySku = new Map<string, string>();
  for (const line of normalized) {
    const product = byId.get(line.id);
    const sku = (line.mapping === 'vial' ? product?.puramass_sku_vial : product?.puramass_sku)?.trim();
    if (sku && product?.name) {
      nameBySku.set(
        `${sku}::${line.packSize}`,
        line.mapping === 'vial' ? `${product.name} (single vial)` : `${product.name} (pack of ${line.packSize})`,
      );
    }
  }
  const klaviyoItems = [...linesBySku.entries()].map(([key, line]) => ({
    sku: line.sku,
    name: nameBySku.get(key) ?? line.sku,
    quantity: line.quantity,
    price: (discountedBySku.get(key) ?? line.unitPriceCents) / 100,
  }));
  after(() =>
    trackStartedCheckout(db, {
      checkoutId: partnerReference,
      email,
      firstName: firstName ?? null,
      lastName: lastName ?? null,
      customerId,
      items: klaviyoItems,
      value:
        klaviyoItems.reduce((sum, i) => sum + i.price * i.quantity, 0) + shippingRate.total_charge,
      currency: PURAMASS_CURRENCY,
      checkoutUrl: order.payment_link ?? null,
    }),
  );

  // 13. Redirect target.
  return NextResponse.json({
    payment_link: order.payment_link,
    transaction_id: order.transaction_id,
    status: order.status,
    shipping_total: shippingRate.total_charge,
    free_shipping: freeShipping,
    // Echoed back so the screen that is about to redirect can confirm the
    // discounts landed, rather than asserting them from its own guess.
    // `ad_discount` is the whole saving in CAD, whichever promos made it up;
    // the percentages say which ones did.
    ad_discount_percent: discount && usedAd ? adDiscountSettings.percent : 0,
    discount_code: appliedCode?.code ?? null,
    discount_code_percent: discount && codeBeatsAd ? appliedCode!.percent : 0,
    // True when the code was the landing page's, applied here because the
    // browser did not send one.
    discount_code_from_landing: codeFromLanding && appliedCode !== null,
    cart_offer_percent: discount && earnedOffer ? cartOfferSettings.percent : 0,
    discount_percent: overallPercent,
    ad_discount: discount ? discount.discountCents / 100 : 0,
  });
}
