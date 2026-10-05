'use client';

/**
 * The cart.
 *
 * Two columns on a desktop: the lines and what to add next on the left, the
 * money and the way out on the right. The right column is sticky, because the
 * left one now scrolls well past a fold once the suggestion blocks are in it,
 * and the checkout button must never scroll away from a buyer who is ready.
 *
 * The three things under the line items each answer a different question:
 *
 *   • the free-shipping bar — "how close am I?" — is the promo the operator
 *     set, measured against this cart and settled again server-side;
 *   • "Frequently bought together" is the operator's own pairings;
 *   • "You may also like" is computed from what people actually buy together.
 *
 * And on the right, the limited-time offer strip: what the cart must add to
 * earn the discount, or the discount itself, already in the total below it.
 *
 * NOTHING here decides money. Every promo shown is re-read, re-priced and
 * re-decided by `/api/checkout/puramass` at hand-off against the catalog — the
 * numbers on this page are what the buyer is TOLD, not what they are charged.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  ArrowRight,
  BadgePercent,
  Beaker,
  CheckCircle2,
  Flame,
  Gift,
  Lock,
  Minus,
  Package,
  Plus,
  ShieldCheck,
  ShoppingBag,
  ShoppingCart,
  Trash2,
  Truck,
} from 'lucide-react';
import Link from 'next/link';
import Navigation from '@/components/Navigation';
import Footer from '@/components/Footer';
import { useCart } from '@/contexts/CartContext';
import { siteConfig } from '@/lib/config';
import { useRouter } from 'next/navigation';
import FreeShippingProgress from '@/components/FreeShippingProgress';
import LimitedTimeOffer from '@/components/cart/LimitedTimeOffer';
import FrequentlyBoughtTogether from '@/components/cart/FrequentlyBoughtTogether';
import YouMayAlsoLike from '@/components/cart/YouMayAlsoLike';
import { useCartRecommendations } from '@/components/cart/recommendations';
import { usePromos } from '@/contexts/PromosContext';
import { useSiteConfig } from '@/contexts/SiteConfigContext';

/** At or below this many units left, a line says how few rather than "in stock". */
const LOW_STOCK_AT = 5;

/** The assurances under the page title. */
const HEADER_TRUST = [
  { icon: Truck, title: 'Free, Fast & Discreet Shipping', note: 'Canada-wide' },
  { icon: ShieldCheck, title: 'Secure Checkout', note: 'SSL encrypted' },
  { icon: Package, title: 'Carefully Packaged', note: 'Your privacy matters' },
];

/** The four icons that close the order summary. */
const SUMMARY_TRUST = [
  { icon: Package, label: 'Discreet Packaging' },
  { icon: Truck, label: 'Ships in 24 Hours' },
  { icon: Beaker, label: 'Canada Wide' },
  { icon: ShieldCheck, label: '100% Secure' },
];

export default function CartPage() {
  const router = useRouter();
  const { items, removeItem, updateQuantity, totalPrice, totalItems, clearCart } = useCart();
  const { config } = useSiteConfig();
  const { frequentlyBoughtTogether, youMayAlsoLike } = useCartRecommendations();

  // Admin → Settings → Cart & Checkout Sections. Held back until the setting
  // is known so a store that hid the badges never flashes them.
  const [trustStripEnabled, setTrustStripEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/settings', { cache: 'no-store' })
      .then((res) => res.json())
      .then((json) => {
        if (!cancelled) setTrustStripEnabled(json?.settings?.cart_trust_strip_enabled ?? true);
      })
      .catch(() => {
        if (!cancelled) setTrustStripEnabled(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The promos running on this cart. Resolved once for the whole app by
  // PromosProvider: `freeShipping.active` already accounts for the hosted
  // checkout being the live one and for courier rates being on, `adDiscountOn`
  // returns zero unless this visitor has actually earned the paid-ads discount
  // — came from an ad, signed in, and has not ordered before — and `cartOffer`
  // has already been measured against this cart's item count and the offer's
  // end date. All three are settled again server-side at hand-off.
  const { freeShipping, adDiscount, adDiscountEligible, adDiscountOn, cartOffer, landingOffer } =
    usePromos();

  // Order of operations, and it matters: the first discount comes off the
  // subtotal first, then the cart offer comes off what is left. That is what
  // `combineDiscountPercents` does at the checkout, so showing them any other
  // way here would quote a total the hand-off then disagrees with by a cent.
  //
  // "The first discount" is whichever of two takes more off, the same rule the
  // hand-off applies: the landing page's code (off the products it does not
  // exclude) or the paid-ads welcome discount (off everything). They never
  // stack.
  const landingSaving = landingOffer.amountOn(
    items.map((item) => ({ productId: item.productId, amount: item.price * item.quantity })),
  );
  const welcomeSaving = adDiscountOn(totalPrice);
  const landingWins = landingSaving > 0 && landingSaving >= welcomeSaving;
  const adSaving = landingWins ? 0 : welcomeSaving;
  const afterFirst = Math.max(0, totalPrice - (landingWins ? landingSaving : adSaving));
  const offerSaving = cartOffer.amountOn(afterFirst);
  const estimatedTotal = Math.max(0, afterFirst - offerSaving);

  // The cart's own scarcity note, taken from the tightest line rather than
  // invented: `stock_quantity` on a line is already the cap in that line's own
  // unit (packs, not vials), which is what the shopper is buying.
  const lowestStock = useMemo(
    () =>
      items.reduce((lowest, item) => {
        const left = Number(item.stock_quantity);
        return Number.isFinite(left) ? Math.min(lowest, left) : lowest;
      }, Number.POSITIVE_INFINITY),
    [items],
  );
  const scarce = Number.isFinite(lowestStock) && lowestStock > 0 && lowestStock <= LOW_STOCK_AT;

  // Redirect out when e-commerce is disabled — in an effect, not during render.
  useEffect(() => {
    if (!siteConfig.ecommerceEnabled) router.replace('/products');
  }, [router]);

  if (!siteConfig.ecommerceEnabled) return null;

  return (
    <main className="min-h-screen bg-surface/40">
      <Navigation />

      <div className="pt-32 sm:pt-36 md:pt-44 pb-16 sm:pb-20 md:pb-28">
        <div className="max-w-7xl mx-auto px-4 sm:px-8 lg:px-12">
          {/* Header */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-6 sm:mb-8"
          >
            <Link
              href="/products"
              className="inline-flex items-center gap-2 text-ink-muted hover:text-ink transition-colors mb-4 text-sm"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Continue Shopping</span>
            </Link>

            <div className="flex flex-wrap items-end justify-between gap-4 sm:gap-6">
              <div>
                <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold text-ink tracking-tight">
                  Your Cart{items.length > 0 ? ` (${items.length})` : ''}
                </h1>
                {items.length > 0 && (
                  <p className="mt-1 text-sm text-ink-muted">
                    You&apos;re one step closer to a better you.
                  </p>
                )}
              </div>

              {items.length > 0 && trustStripEnabled && (
                <div className="flex flex-wrap items-center gap-4 sm:gap-6">
                  {HEADER_TRUST.map(({ icon: Icon, title, note }) => (
                    <div key={title} className="flex items-center gap-2">
                      <Icon className="h-5 w-5 flex-shrink-0 text-ink-muted" />
                      <div className="leading-tight">
                        <p className="text-[11px] font-semibold text-ink">{title}</p>
                        <p className="text-[10px] text-ink-muted">{note}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>

          {items.length === 0 ? (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-center py-12 sm:py-16 md:py-20"
            >
              <div className="w-16 sm:w-20 h-16 sm:h-20 bg-white rounded-2xl flex items-center justify-center mx-auto mb-5 sm:mb-6 border border-line">
                <ShoppingBag className="w-8 sm:w-10 h-8 sm:h-10 text-ink-muted" />
              </div>
              <h2 className="text-lg sm:text-xl md:text-2xl font-bold text-ink mb-2 sm:mb-3">
                Your cart is empty
              </h2>
              <p className="text-ink-muted mb-6 sm:mb-8 text-sm">
                Looks like you haven&apos;t added any products yet.
              </p>
              <Link
                href="/products"
                className="inline-flex items-center gap-2 bg-ink hover:bg-ink/90 text-white font-semibold px-5 sm:px-6 py-3 rounded-xl transition-all text-sm"
              >
                <ShoppingCart className="w-4 h-4" />
                <span>Browse Products</span>
              </Link>
            </motion.div>
          ) : (
            <div className="grid gap-4 sm:gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-8">
              {/* ---- Left: lines, then what to add next ---- */}
              <motion.div
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                className="min-w-0 space-y-6 sm:space-y-8"
              >
                <div className="rounded-2xl border border-line bg-white p-3 sm:p-4">
                  <div className="divide-y divide-line">
                    {items.map((item, index) => {
                      const left = Number(item.stock_quantity);
                      const low = Number.isFinite(left) && left <= LOW_STOCK_AT;
                      return (
                        <motion.div
                          key={item.id}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: index * 0.05 }}
                          className="flex items-start gap-3 py-3 sm:gap-4 sm:py-4"
                        >
                          {/* Product image */}
                          <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-xl border border-line bg-surface sm:h-20 sm:w-20">
                            {item.image_url ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={item.image_url}
                                alt={item.name}
                                className="h-full w-full rounded-xl object-contain p-1.5"
                              />
                            ) : (
                              <Beaker className="h-7 w-7 text-line" />
                            )}
                          </div>

                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <h3 className="truncate text-sm font-semibold text-ink sm:text-base">
                                  {item.name}
                                </h3>
                                <p className="mt-0.5 text-[11px] text-ink-muted sm:text-xs">
                                  {item.strength}
                                  <span className="mx-1.5 text-line">|</span>
                                  {item.packSize > 1 ? `Pack of ${item.packSize}` : 'Single vial'}
                                </p>
                              </div>

                              <div className="flex items-start gap-2 sm:gap-3">
                                <p className="whitespace-nowrap text-sm font-bold text-ink tabular-nums sm:text-base">
                                  ${(item.price * item.quantity).toFixed(2)}
                                </p>
                                <button
                                  onClick={() => removeItem(item.id)}
                                  aria-label={`Remove ${item.name} from cart`}
                                  className="p-1 text-ink-muted transition-colors hover:text-red-500"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              </div>
                            </div>

                            <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                              <p
                                className={`inline-flex items-center gap-1.5 text-[11px] font-medium sm:text-xs ${
                                  low ? 'text-amber-700' : 'text-emerald-700'
                                }`}
                              >
                                <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />
                                {low ? (
                                  <>Only {left} left — order soon</>
                                ) : (
                                  <>In Stock &ndash; Ships in 24h</>
                                )}
                              </p>

                              {/* Quantity */}
                              <div className="flex items-center gap-1.5 rounded-xl border border-line px-1 py-1">
                                <button
                                  onClick={() => updateQuantity(item.id, item.quantity - 1)}
                                  aria-label={`Decrease quantity of ${item.name}`}
                                  className="flex h-7 w-7 items-center justify-center rounded-lg text-ink transition-colors hover:bg-surface"
                                >
                                  <Minus className="h-3.5 w-3.5" />
                                </button>
                                <span className="w-6 text-center text-sm font-semibold tabular-nums">
                                  {item.quantity}
                                </span>
                                <button
                                  onClick={() => updateQuantity(item.id, item.quantity + 1)}
                                  disabled={item.quantity >= item.stock_quantity}
                                  aria-label={`Increase quantity of ${item.name}`}
                                  className="flex h-7 w-7 items-center justify-center rounded-lg text-ink transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                  <Plus className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>

                  <FreeShippingProgress
                    subtotal={totalPrice}
                    threshold={freeShipping.threshold}
                    active={freeShipping.active}
                    variant="bar"
                    className="mt-1"
                  />

                  <div className="mt-3 flex justify-end">
                    <button
                      onClick={clearCart}
                      className="text-xs font-medium text-ink-muted transition-colors hover:text-red-500"
                    >
                      Clear cart
                    </button>
                  </div>
                </div>

                <FrequentlyBoughtTogether
                  products={frequentlyBoughtTogether}
                  pairedWith={items[0]?.name}
                />

                <YouMayAlsoLike products={youMayAlsoLike} />
              </motion.div>

              {/* ---- Right: the money and the way out ---- */}
              <motion.div
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                className="min-w-0"
              >
                <div className="space-y-3 lg:sticky lg:top-36">
                  <LimitedTimeOffer />

                  <div className="rounded-2xl border border-line bg-white p-4 sm:p-5">
                    <h2 className="mb-4 text-base font-semibold text-ink sm:text-lg">
                      Order Summary
                    </h2>

                    <div className="space-y-2.5">
                      <div className="flex justify-between text-xs text-ink-muted sm:text-sm">
                        <span>Subtotal</span>
                        <span className="font-medium text-ink tabular-nums">
                          ${totalPrice.toFixed(2)}
                        </span>
                      </div>

                      {landingWins && (
                        <div className="text-xs sm:text-sm">
                          <div className="flex justify-between">
                            <span className="inline-flex items-center gap-1.5 text-emerald-700">
                              <BadgePercent className="h-3.5 w-3.5" />
                              {+landingOffer.percent.toFixed(2)}%{' '}
                              {landingOffer.firstOrderOnly ? 'first-order offer' : 'welcome offer'}
                            </span>
                            <span className="font-semibold text-emerald-700 tabular-nums">
                              -${landingSaving.toFixed(2)}
                            </span>
                          </div>
                          <p className="mt-0.5 text-[10px] text-ink-muted sm:text-xs">
                            Code {landingOffer.code} is applied automatically at checkout
                            {landingOffer.exclusions ? ` · excludes ${landingOffer.exclusions}` : ''}.
                          </p>
                        </div>
                      )}

                      {adDiscountEligible && adSaving > 0 && (
                        <div className="flex justify-between text-xs sm:text-sm">
                          <span className="inline-flex items-center gap-1.5 text-emerald-700">
                            <BadgePercent className="h-3.5 w-3.5" />
                            {adDiscount.percent}% first-order discount
                          </span>
                          <span className="font-semibold text-emerald-700 tabular-nums">
                            -${adSaving.toFixed(2)}
                          </span>
                        </div>
                      )}

                      {offerSaving > 0 && (
                        <div className="flex justify-between text-xs sm:text-sm">
                          <span className="inline-flex items-center gap-1.5 text-emerald-700">
                            <Gift className="h-3.5 w-3.5" />
                            {cartOffer.percent}% limited-time offer
                          </span>
                          <span className="font-semibold text-emerald-700 tabular-nums">
                            -${offerSaving.toFixed(2)}
                          </span>
                        </div>
                      )}

                      <div className="flex justify-between text-xs text-ink-muted sm:text-sm">
                        <span>Shipping</span>
                        <span className="font-medium text-ink">Calculated at checkout</span>
                      </div>

                      <div className="border-t border-line pt-3">
                        <div className="flex items-baseline justify-between">
                          <span className="text-sm font-semibold text-ink sm:text-base">
                            Estimated Total{' '}
                            <span className="text-xs font-normal text-ink-muted">(CAD)</span>
                          </span>
                          <span className="text-lg font-bold text-ink tabular-nums sm:text-xl">
                            ${estimatedTotal.toFixed(2)}
                          </span>
                        </div>
                        <p className="mt-1.5 text-[10px] text-ink-muted sm:text-xs">
                          Plus shipping, calculated at checkout once your address is entered.
                        </p>
                      </div>
                    </div>

                    <Link
                      href="/checkout"
                      className="group mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-ink py-3.5 text-sm font-semibold text-white transition-all hover:bg-ink/90"
                    >
                      <Lock className="h-4 w-4" />
                      <span>Proceed to Secure Checkout</span>
                      <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                    </Link>

                    {/* Why buy here — the same four claims the rest of the site
                        makes, restated where the decision is being made. */}
                    <div className="mt-4 border-t border-line pt-4">
                      <p className="mb-2.5 flex items-center gap-2 text-sm font-semibold text-ink">
                        <ShieldCheck className="h-4 w-4 text-ink-muted" />
                        Why Customers Choose {config.store_name}
                      </p>
                      <ul className="space-y-1.5">
                        {[
                          '99%+ Purity Guaranteed',
                          'Third-Party Tested (COA Available)',
                          'Free, Fast & Discreet Shipping',
                          'Proudly Canadian',
                          'Secure & Encrypted Checkout',
                        ].map((claim) => (
                          <li
                            key={claim}
                            className="flex items-start gap-2 text-xs text-ink-muted"
                          >
                            <CheckCircle2 className="mt-px h-3.5 w-3.5 flex-shrink-0 text-emerald-600" />
                            {claim}
                          </li>
                        ))}
                      </ul>
                    </div>

                    {scarce && (
                      <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-red-100 bg-red-50 px-3.5 py-3">
                        <Flame className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-500" />
                        <div>
                          <p className="text-sm font-semibold text-red-700">
                            Only {lowestStock} left in stock
                          </p>
                          <p className="text-xs text-red-600/90">
                            Order now to avoid missing out.
                          </p>
                        </div>
                      </div>
                    )}

                    <div className="mt-4 grid grid-cols-4 gap-2 border-t border-line pt-4">
                      {SUMMARY_TRUST.map(({ icon: Icon, label }) => (
                        <div key={label} className="text-center">
                          <Icon className="mx-auto mb-1 h-4 w-4 text-ink-muted" />
                          <span className="text-[9px] leading-tight text-ink-muted">{label}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <p className="text-center text-[11px] text-ink-muted">
                    {totalItems} item{totalItems === 1 ? '' : 's'} in your cart
                  </p>
                </div>
              </motion.div>
            </div>
          )}
        </div>
      </div>

      <Footer />
    </main>
  );
}
