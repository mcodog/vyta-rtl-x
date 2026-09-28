'use client';

/**
 * Storefront promotions, resolved once for the whole app.
 *
 * Three offers run on the storefront and they need the same facts — the
 * admin's promo settings, who this visitor is, and what is in their cart:
 *
 *   • free shipping past a spend threshold (`FreeShippingToast`, the cart and
 *     checkout progress bars);
 *   • the paid-ads welcome discount (`AdDiscountBanner`, the cart and checkout
 *     totals, and the hand-off itself) — for ad visitors, on their first order
 *     only;
 *   • the limited-time cart offer (the cart's offer strip and both checkout
 *     totals) — for any cart carrying enough items, while the offer runs;
 *   • the landing-page offer (the nav notice, the cart line, and the code the
 *     checkout puts into its discount field) — for visitors who arrived from
 *     one of our landing pages (lib/promos/landing.ts).
 *
 * Resolving them here rather than in each component means one settings fetch
 * per app load instead of one per screen, and one definition of "eligible" that
 * the nav strip, the cart and the checkout cannot drift apart on.
 *
 * NONE of this is trusted for money. `/api/checkout/puramass` re-reads the
 * settings, re-reads the attribution cookies and re-prices the cart from the
 * catalog before it discounts anything — what happens here only decides what
 * the buyer is told.
 */
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useCart } from '@/contexts/CartContext';
import { useCustomer } from '@/contexts/CustomerContext';
import { supabase } from '@/lib/supabase';
import { visitorChannels } from '@/lib/analytics/attribution-client';
import {
  adDiscountAmount,
  DEFAULT_AD_DISCOUNT,
  isAdTraffic,
  qualifiesForAdDiscount,
  type AdDiscountSettings,
} from '@/lib/promos/ad-discount';
import { eligibleSubtotal } from '@/lib/affiliate/discount-codes';
import { LANDING_COOKIE } from '@/lib/promos/landing';
import {
  cartOfferAmount,
  DEFAULT_CART_OFFER,
  itemsToUnlockCartOffer,
  qualifiesForCartOffer,
  type CartOfferSettings,
} from '@/lib/promos/cart-offer';

export interface FreeShippingPromo {
  /** The promo is on AND the checkout that honours it is the live one. */
  active: boolean;
  /** Goods subtotal in CAD that unlocks it. */
  threshold: number;
}

export interface CartOfferValue extends CartOfferSettings {
  /** This cart has enough items, and the offer has not expired. */
  earned: boolean;
  /** How many more items would earn it. Zero once it is earned. */
  itemsAway: number;
  /** What it takes off a given subtotal, in CAD. Zero when not earned. */
  amountOn: (subtotal: number) => number;
}

/** One cart line, as the landing offer measures it. */
export interface PromoLine {
  productId: string;
  /** The line's list total, CAD. */
  amount: number;
}

/**
 * The offer made by the landing page this visitor arrived through. Its `code`
 * is a real discount code: the checkout puts it into the discount field, and
 * the hand-off applies it even if the browser never did.
 */
export interface LandingOfferValue {
  /** This visitor holds a landing offer, and as far as we know it is theirs. */
  active: boolean;
  slug: string | null;
  code: string | null;
  percent: number;
  firstOrderOnly: boolean;
  excludedProductIds: string[];
  /** "bacteriostatic water" — the excluded products as one phrase, for copy. */
  exclusions: string | null;
  /**
   * Why a signed-in customer cannot use it (they have ordered before), or
   * null. The offer is hidden in that case rather than advertised.
   */
  reason: string | null;
  /** What it takes off these lines, CAD — excluded products count for nothing. */
  amountOn: (lines: PromoLine[]) => number;
}

export interface PromosValue {
  /** False once the settings fetch has settled, either way. */
  loading: boolean;
  freeShipping: FreeShippingPromo;
  adDiscount: AdDiscountSettings & { active: boolean };
  /** This visitor arrived on a paid ad (first or last touch). */
  isAdVisitor: boolean;
  /**
   * This customer has not ordered yet, so the welcome discount is still theirs
   * to use. False for guests, and while the check is still in flight.
   */
  isFirstOrder: boolean;
  /** The ad discount applies to this visitor's order, here and now. */
  adDiscountEligible: boolean;
  /** What that takes off a given subtotal, in CAD. Zero when not eligible. */
  adDiscountOn: (subtotal: number) => number;
  /**
   * The limited-time cart offer, already measured against the current cart.
   * Unlike the welcome discount this one is open to everyone — what earns it
   * is the cart, so the item count is read here rather than passed in.
   */
  cartOffer: CartOfferValue;
  landingOffer: LandingOfferValue;
}

const NO_LANDING_OFFER: LandingOfferValue = {
  active: false,
  slug: null,
  code: null,
  percent: 0,
  firstOrderOnly: false,
  excludedProductIds: [],
  exclusions: null,
  reason: null,
  amountOn: () => 0,
};

/** Does this browser carry a landing-page cookie? Read before asking the server. */
function hasLandingCookie(): boolean {
  if (typeof document === 'undefined') return false;
  return document.cookie.split('; ').some((row) => row.startsWith(`${LANDING_COOKIE}=`));
}

const EMPTY: PromosValue = {
  loading: true,
  freeShipping: { active: false, threshold: 0 },
  adDiscount: { ...DEFAULT_AD_DISCOUNT, active: false },
  isAdVisitor: false,
  isFirstOrder: false,
  adDiscountEligible: false,
  adDiscountOn: () => 0,
  cartOffer: {
    ...DEFAULT_CART_OFFER,
    earned: false,
    itemsAway: 0,
    amountOn: () => 0,
  },
  landingOffer: NO_LANDING_OFFER,
};

const PromosContext = createContext<PromosValue>(EMPTY);

export function PromosProvider({ children }: { children: React.ReactNode }) {
  const { customer } = useCustomer();
  const { totalItems } = useCart();
  const [loading, setLoading] = useState(true);
  const [freeShipping, setFreeShipping] = useState<FreeShippingPromo>(EMPTY.freeShipping);
  const [adDiscount, setAdDiscount] = useState(EMPTY.adDiscount);
  const [cartOffer, setCartOffer] = useState<CartOfferSettings>(DEFAULT_CART_OFFER);
  // Bumped once, exactly when a limited-time offer's end date passes, so the
  // cart stops showing it without the app re-rendering on a 1s interval. The
  // countdown itself ticks inside the component that draws it.
  const [expiryTick, setExpiryTick] = useState(0);
  // Read in an effect, never during render: the cookies do not exist on the
  // server, so deriving this inline would hydrate to a different tree.
  const [channels, setChannels] = useState<(string | null)[]>([]);
  // Whether this customer still has their welcome discount. It cannot be read
  // off the customer row: `has_completed_first_order` is only written by the
  // legacy checkout, so the server joins it with their hosted orders for us.
  const [isFirstOrder, setIsFirstOrder] = useState(false);
  const [landingOffer, setLandingOffer] = useState<Omit<LandingOfferValue, 'amountOn'>>(NO_LANDING_OFFER);

  useEffect(() => {
    setChannels(visitorChannels());
  }, []);

  // Re-asked whenever the signed-in customer changes — on sign-out the answer
  // must fall back to false rather than linger from the previous account. Keyed
  // on the id rather than the object so a re-fetch that returns the same
  // customer does not re-run this.
  const customerId = customer?.id ?? null;
  useEffect(() => {
    let cancelled = false;
    if (!customerId) {
      setIsFirstOrder(false);
      return;
    }
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        if (!token) return;
        const res = await fetch('/api/promos/first-order', {
          cache: 'no-store',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok || cancelled) return;
        const json = await res.json();
        if (!cancelled) setIsFirstOrder(!!json?.firstOrder);
      } catch {
        /* Unknown means "not a first order": never advertise an offer the
           checkout would then refuse to honour. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  // The landing-page offer. Only asked for when the cookie is there — nobody
  // who did not come through a landing page pays for the request. Re-asked on
  // sign-in and sign-out, because a first-order-only offer is withdrawn from a
  // signed-in customer who has already ordered.
  useEffect(() => {
    let cancelled = false;
    if (!hasLandingCookie()) {
      setLandingOffer(NO_LANDING_OFFER);
      return;
    }
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        const res = await fetch('/api/promos/landing', {
          cache: 'no-store',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok || cancelled) return;
        const json = await res.json();
        const o = json?.offer;
        if (cancelled) return;
        if (!o?.code || !(Number(o.percent) > 0)) {
          setLandingOffer(NO_LANDING_OFFER);
          return;
        }
        setLandingOffer({
          active: json.eligible !== false,
          slug: o.slug ?? null,
          code: String(o.code),
          percent: Number(o.percent) || 0,
          firstOrderOnly: !!o.first_order_only,
          excludedProductIds: Array.isArray(o.excluded_product_ids) ? o.excluded_product_ids : [],
          exclusions: o.exclusions ?? null,
          reason: json.reason ?? null,
        });
      } catch {
        /* No offer is shown if it can't be read. The hand-off still applies
           it: it reads the same cookie itself. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // `no-store`: these decide what the buyer is offered, and a promo that
        // has just been switched off must not keep being advertised from cache.
        const res = await fetch('/api/admin/settings', { cache: 'no-store' });
        if (!res.ok) return;
        const s = (await res.json())?.settings ?? {};
        if (cancelled) return;
        setFreeShipping({
          active: !!s.puramass_free_shipping_active,
          threshold: Number(s.puramass_free_shipping_threshold) || 0,
        });
        setAdDiscount({
          enabled: !!s.ad_discount_enabled,
          percent: Number(s.ad_discount_percent) || 0,
          active: !!s.ad_discount_active,
        });
        // `_active` already folds in the hosted-checkout toggle, the same way
        // the welcome discount does: an offer the checkout cannot apply is an
        // offer the cart must not advertise.
        setCartOffer({
          enabled: !!s.cart_offer_active,
          minItems: Number(s.cart_offer_min_items) || 1,
          percent: Number(s.cart_offer_percent) || 0,
          endsAt: s.cart_offer_ends_at ?? null,
        });
      } catch {
        /* No promo is shown if the settings can't be read — never block a page. */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Wake up once at the offer's end date. A timer rather than a poll, and one
  // that is re-armed only when the date itself changes — the clock running out
  // is a single event, so it costs a single timeout.
  useEffect(() => {
    if (!cartOffer.endsAt) return;
    const remaining = new Date(cartOffer.endsAt).getTime() - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    // setTimeout tops out around 24.8 days; anything further off is re-armed
    // when the page is next loaded, long before it matters.
    if (remaining > 2_147_483_647) return;
    const timer = setTimeout(() => setExpiryTick((tick) => tick + 1), remaining + 250);
    return () => clearTimeout(timer);
  }, [cartOffer.endsAt]);

  const value = useMemo<PromosValue>(() => {
    const settings: AdDiscountSettings = {
      enabled: adDiscount.active,
      percent: adDiscount.percent,
    };
    const eligible = qualifiesForAdDiscount(settings, {
      signedIn: !!customer,
      firstOrder: isFirstOrder,
      channels,
    });
    return {
      loading,
      freeShipping,
      adDiscount,
      isAdVisitor: isAdTraffic(channels),
      isFirstOrder,
      adDiscountEligible: eligible,
      adDiscountOn: (subtotal: number) =>
        eligible ? adDiscountAmount(subtotal, adDiscount.percent) : 0,
      cartOffer: {
        ...cartOffer,
        earned: qualifiesForCartOffer(cartOffer, totalItems),
        itemsAway: itemsToUnlockCartOffer(cartOffer, totalItems),
        amountOn: (subtotal: number) =>
          qualifiesForCartOffer(cartOffer, totalItems)
            ? cartOfferAmount(subtotal, cartOffer.percent)
            : 0,
      },
      landingOffer: {
        ...landingOffer,
        amountOn: (lines: PromoLine[]) =>
          landingOffer.active
            ? Math.round(eligibleSubtotal(lines, landingOffer.excludedProductIds) * landingOffer.percent) / 100
            : 0,
      },
    };
    // `expiryTick` is a dependency on purpose: it is what re-runs this the
    // moment a limited-time offer's end date passes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    loading,
    freeShipping,
    adDiscount,
    channels,
    customer,
    isFirstOrder,
    cartOffer,
    totalItems,
    expiryTick,
    landingOffer,
  ]);

  return <PromosContext.Provider value={value}>{children}</PromosContext.Provider>;
}

export function usePromos(): PromosValue {
  return useContext(PromosContext);
}
