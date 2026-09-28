/**
 * The paid-ads welcome discount.
 *
 * Someone who arrived on a Google / Meta / Bing / TikTok / LinkedIn ad and then
 * created an account gets a percentage off the goods subtotal of their FIRST
 * hosted checkout. The offer is advertised on a strip under the nav bar,
 * restated on the cart and checkout screens, and settled server-side at
 * hand-off. It is a welcome offer: it applies once, to the first order, and
 * only to visitors that a paid ad actually won.
 *
 * Everything here is pure and isomorphic: the storefront imports it to draw the
 * offer, and `/api/checkout/puramass` imports the same functions to decide the
 * money. Neither touches `window`, `next/server` or Supabase, so the two can
 * never drift into disagreeing about who qualifies or for how much.
 *
 * ## Why the discount is distributed over the line prices
 *
 * The Stealth Health hosted order has no discount field. It has `unit_price_cents`
 * per line, and that is the only lever we have — so the discount is taken off
 * the lines themselves before the payload is sent, and the hosted page charges
 * the already-discounted amounts. `distributeAdDiscount` does that split.
 *
 * Per-unit integer prices cannot always land on an exact percentage (a line of
 * 3 units can only move in 3-cent steps), so the split is rounded in the
 * BUYER's favour: the discount actually taken is never less than the
 * advertised percentage of the subtotal, and never more than a cent per line
 * above it.
 *
 * ## The zero-price boundary
 *
 * One thing the partner API cannot express: a line at zero. Stealth Health reads a
 * zero `unit_price_cents` as "use your own catalog price", so
 * `buildPuramassOrderBody` refuses one — "free" would arrive as "full list".
 * The functions here happily return a zero (100% off really is zero), but the
 * caller must refuse to send a split that produced one, and the admin settings
 * route caps the percentage at 99 so it cannot be reached by configuration.
 */
import { isPaidChannel } from '@/lib/analytics/attribution';

/** The offer as advertised, and the default for a store that has not set one. */
export const DEFAULT_AD_DISCOUNT_PERCENT = 25;

export interface AdDiscountSettings {
  /** The promo is switched on and worth something. */
  enabled: boolean;
  /** Percentage off the goods subtotal, 0–100. */
  percent: number;
}

/**
 * Off. Used when the promo columns have not been migrated yet, or the settings
 * read failed — money fails closed, so an unconfigured install discounts
 * nothing rather than everything.
 */
export const DEFAULT_AD_DISCOUNT: AdDiscountSettings = {
  enabled: false,
  percent: DEFAULT_AD_DISCOUNT_PERCENT,
};

/** Clamp a stored/typed percentage into 0–100, to two decimals. */
export function clampDiscountPercent(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(100, Math.round(n * 100) / 100);
}

/**
 * Normalise a raw `site_settings` row.
 *
 * A zero (or absent) percentage forces the promo off: "25% off" with nothing
 * behind it would advertise an offer the checkout then fails to honour.
 */
export function shapeAdDiscountSettings(
  data: Record<string, any> | null | undefined,
): AdDiscountSettings {
  const d = data ?? {};
  const percent = clampDiscountPercent(
    d.ad_discount_percent ?? DEFAULT_AD_DISCOUNT_PERCENT,
  );
  return { enabled: !!d.ad_discount_enabled && percent > 0, percent };
}

/** True when any channel recorded for a visitor is a paid ad. */
export function isAdTraffic(channels: (string | null | undefined)[]): boolean {
  return channels.some((channel) => isPaidChannel(channel));
}

/**
 * Does this visitor get the discount?
 *
 * Three conditions, all required:
 *
 *   • at least one of their attribution channels is a paid ad. More than one is
 *     passed because the same fact is recorded in two places — the first-touch
 *     cookie in the browser, and `customers.attribution_channel` frozen at
 *     signup — and a buyer who cleared their cookies since signing up is still
 *     a buyer that ad won;
 *   • they are signed in. The offer is "sign up and get X% off": it is what the
 *     account is for, so a guest sees the invitation rather than the discount;
 *   • this is their FIRST order. It is a welcome offer — what the ad click paid
 *     for — not a standing discount on everything they ever buy.
 *
 * `firstOrder` is deliberately required rather than optional: it is the
 * condition that decides whether money comes off a repeat buyer's order, and a
 * call site that forgets it should not silently default to discounting. Who
 * still counts as a first-time buyer is decided server-side by
 * `lib/promos/first-order.ts`, which both the storefront and the hand-off read,
 * so the two cannot disagree.
 */
export function qualifiesForAdDiscount(
  settings: AdDiscountSettings,
  visitor: {
    signedIn: boolean;
    firstOrder: boolean;
    channels: (string | null | undefined)[];
  },
): boolean {
  if (!settings.enabled || settings.percent <= 0) return false;
  if (!visitor.signedIn) return false;
  if (!visitor.firstOrder) return false;
  return isAdTraffic(visitor.channels);
}

/**
 * The advertised discount on a subtotal, in CAD — what the storefront shows.
 *
 * The figure actually charged is computed from the line payload by
 * `distributeAdDiscount` and can be a cent or two larger; it is never smaller,
 * so no buyer is ever charged more than the number they were shown.
 */
export function adDiscountAmount(subtotal: number, percent: number): number {
  const pct = clampDiscountPercent(percent);
  const amount = Number(subtotal);
  if (pct <= 0 || !Number.isFinite(amount) || amount <= 0) return 0;
  return Math.round(amount * pct) / 100;
}

// ---------------------------------------------------------------------------
// Distributing the discount over the line prices
// ---------------------------------------------------------------------------

/** One line of the order as it would be priced WITHOUT the discount. */
export interface AdDiscountLine {
  /** Whatever the caller identifies the line by — the Stealth Health SKU, here. */
  key: string;
  /** Our undiscounted price for ONE catalog unit, in cents. */
  unitPriceCents: number;
  /** How many of those units the line carries. */
  quantity: number;
}

export interface AdDiscountedLine extends AdDiscountLine {
  /** What to send as `unit_price_cents`. Never negative, never above list. */
  discountedUnitPriceCents: number;
}

export interface AdDiscountBreakdown {
  lines: AdDiscountedLine[];
  /** Goods subtotal at list price, in cents. */
  subtotalCents: number;
  /** What the split actually takes off — at or just above the target. */
  discountCents: number;
  /** `subtotalCents - discountCents`; the sum the hosted page will charge. */
  totalCents: number;
  /** The percentage the split was asked for. */
  percent: number;
}

const passthrough = (line: AdDiscountLine): AdDiscountedLine => ({
  ...line,
  discountedUnitPriceCents: line.unitPriceCents,
});

function cleanLine(line: AdDiscountLine): AdDiscountLine {
  return {
    key: line.key,
    unitPriceCents: Math.max(0, Math.round(Number(line.unitPriceCents) || 0)),
    quantity: Math.max(0, Math.round(Number(line.quantity) || 0)),
  };
}

/**
 * Take `percent` off the subtotal by lowering each line's unit price.
 *
 * The hosted order charges `unit_price_cents × quantity` per line, so the only
 * reachable totals are sums of whole cents times whole quantities — a target
 * that falls between two of them is not payable. The split therefore:
 *
 *   1. floors every unit price at its exact discounted value, which can only
 *      overshoot (takes off at least the target), then
 *   2. hands whole cents back, largest fractional remainder first, while a
 *      line's `quantity` cents still fit under the target.
 *
 * The result is the closest payable total at or below the target, so the buyer
 * is never charged more than the offer promised. `discountCents` reports what
 * was really taken rather than what was asked for, and is what gets recorded
 * against the order.
 *
 * A line is never marked up: step 2 will not push a unit price back above its
 * list price even if other lines in the same order absorbed more of the split.
 *
 * A returned price of zero is arithmetically right but not sendable — see the
 * zero-price boundary at the top of this file. Callers check for it.
 */
export function distributeAdDiscount(
  lines: AdDiscountLine[],
  percent: number,
): AdDiscountBreakdown {
  const pct = clampDiscountPercent(percent);
  const clean = lines.map(cleanLine).filter((l) => l.quantity > 0);
  const subtotalCents = clean.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0);

  if (pct <= 0 || subtotalCents <= 0) {
    return {
      lines: clean.map(passthrough),
      subtotalCents,
      discountCents: 0,
      totalCents: subtotalCents,
      percent: pct,
    };
  }

  const targetTotal = subtotalCents - Math.round((subtotalCents * pct) / 100);

  const rate = 1 - pct / 100;
  const draft = clean.map((line) => {
    const ideal = line.unitPriceCents * rate;
    const unit = Math.floor(ideal);
    return { line, unit, remainder: ideal - unit };
  });
  let total = draft.reduce((sum, d) => sum + d.unit * d.line.quantity, 0);

  // Largest remainder first; a tie goes to the smaller line, because a cent
  // there moves the total in a finer step and lands closer to the target.
  const order = [...draft].sort(
    (a, b) => b.remainder - a.remainder || a.line.quantity - b.line.quantity,
  );
  let progressed = true;
  while (progressed && total < targetTotal) {
    progressed = false;
    for (const d of order) {
      if (d.unit >= d.line.unitPriceCents) continue;
      if (total + d.line.quantity > targetTotal) continue;
      d.unit += 1;
      total += d.line.quantity;
      progressed = true;
      if (total >= targetTotal) break;
    }
  }

  return {
    lines: draft.map((d) => ({ ...d.line, discountedUnitPriceCents: d.unit })),
    subtotalCents,
    discountCents: subtotalCents - total,
    totalCents: total,
    percent: pct,
  };
}

// ---------------------------------------------------------------------------
// Different percentages on different lines
// ---------------------------------------------------------------------------

/** A line together with the percentage that comes off it. */
export interface PercentLine extends AdDiscountLine {
  percent: number;
}

export interface LineDiscountBreakdown {
  lines: (AdDiscountedLine & { percent: number })[];
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
}

/**
 * Split discounts that do not apply to every line alike — a discount code that
 * excludes some products, stacked with an offer that does not.
 *
 * Lines are grouped by their percentage and each group is split on its own by
 * `distributeAdDiscount`, so every group keeps that function's guarantees: the
 * saving is never less than its advertised percentage of the group, a line is
 * never marked up, and the rounding goes the buyer's way. Splitting everything
 * at one blended percentage instead would move money from the excluded lines
 * onto the eligible ones — taking something off bac water after all.
 *
 * When every line shares one percentage this is exactly one
 * `distributeAdDiscount` call, so an order without exclusions is priced the
 * same as it always was.
 */
export function distributeLineDiscounts(lines: PercentLine[]): LineDiscountBreakdown {
  const groups = new Map<number, PercentLine[]>();
  for (const line of lines) {
    const pct = clampDiscountPercent(line.percent);
    const group = groups.get(pct) ?? [];
    group.push(line);
    groups.set(pct, group);
  }

  const byKey = new Map<string, AdDiscountedLine & { percent: number }>();
  let subtotalCents = 0;
  let discountCents = 0;
  for (const [pct, group] of groups) {
    const split = distributeAdDiscount(group, pct);
    subtotalCents += split.subtotalCents;
    discountCents += split.discountCents;
    for (const line of split.lines) byKey.set(line.key, { ...line, percent: pct });
  }

  // Back in the caller's order, so the payload reads the same as the cart.
  const ordered = lines
    .map((line) => byKey.get(line.key))
    .filter((line): line is AdDiscountedLine & { percent: number } => !!line);

  return {
    lines: ordered,
    subtotalCents,
    discountCents,
    totalCents: subtotalCents - discountCents,
  };
}
