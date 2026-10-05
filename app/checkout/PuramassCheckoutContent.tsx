"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { motion, type Variants } from "framer-motion";
import {
  ShieldCheck,
  Loader2,
  Mail,
  User,
  ArrowRight,
  ShoppingCart,
  AlertCircle,
  Lock,
  Beaker,
  Info,
  Plus,
  Droplets,
  FlaskConical,
  Check,
  MessageCircle,
  MapPin,
  Truck,
  HelpCircle,
  BadgePercent,
  Gift,
  Ticket,
  X,
} from "lucide-react";
import { useCart, type PurchaseUnit } from "@/contexts/CartContext";
import { useCustomer } from "@/contexts/CustomerContext";
import { usePurchaseModal } from "@/contexts/PurchaseModalContext";
import { supabase } from "@/lib/supabase";
import { packOptionsFor, vialPriceFor } from "@/lib/pricing";
import { trackBeginCheckout } from "@/lib/analytics/ecommerce";
import { cartItemToAnalytics } from "@/lib/analytics/cart";
import { trackActivity } from "@/lib/customer/activity";
import AddressAutocomplete from "@/components/AddressAutocomplete";
import {
  SHIPPING_COUNTRIES,
  postalLabel,
  regionLabel,
  regionsFor,
} from "@/lib/shipping/regions";
import {
  deliveryEstimate,
  type HostedShippingRate,
} from "@/lib/payments/puramass-shipping";
import type { ShippingAddressErrors } from "@/lib/payments/puramass-address";
import FreeShippingProgress from "@/components/FreeShippingProgress";
import { usePromos } from "@/contexts/PromosContext";
import { isValidPhone } from "@/lib/phone";
import { eligibleSubtotal } from "@/lib/affiliate/discount-codes";

interface AddonProduct {
  id: string;
  name: string;
  strength: string | null;
  price: number;
  vial_price: number | null;
  vials_per_box: number | null;
  /** The product's own packs (3, 5, 10, …) and their per-pack prices. */
  pack_sizes: number[] | null;
  pack_options: unknown;
  stock_quantity: number;
  image_url: string | null;
  box_image_url: string | null;
  /** Forms Stealth Health can actually fulfil (derived from the SKU mappings). */
  allowedUnits: PurchaseUnit[];
  /** Cheapest offered unit price, for the "from $X" label. */
  fromPrice: number;
}

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Ship-to as this screen holds it, before the server validates it. */
interface ShippingForm {
  country: string;
  address: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
}

const EMPTY_SHIPPING: ShippingForm = {
  // Canada first: the storefront is Canadian and it is where most parcels go.
  country: "CA",
  address: "",
  address2: "",
  city: "",
  state: "",
  zip: "",
  phone: "",
};

/** Enough of an address to ask a courier what it would charge. */
function canQuote(f: ShippingForm): boolean {
  return !!(f.country && f.address.trim() && f.city.trim() && f.zip.trim());
}

const INPUT_CLASS =
  "w-full px-4 py-2.5 bg-surface rounded-lg border border-line text-sm text-ink placeholder-ink-muted focus:outline-none focus:ring-2 focus:ring-teal/40 focus:border-transparent transition";

/** Matches bacteriostatic / BAC water products so they can be featured. */
const isBacName = (name: string) => /bacteriostatic|bac[\s-]?water/i.test(name || "");

// ---- Motion presets (shared) ----
const containerVariants: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.08, delayChildren: 0.04 },
  },
};
const itemVariants: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.45, ease: [0.16, 1, 0.3, 1] },
  },
};

/** Shimmer placeholder for an add-on row while the list loads. */
/** Inline validation message under a field. Renders nothing when there is none. */
function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1.5 text-[11px] text-amber-700">{message}</p>;
}

/**
 * One courier option. The price shown is the price charged — the admin's
 * processing fee is already inside it and is never broken out here.
 */
function RateOption({
  rate,
  selected,
  free,
  onSelect,
}: {
  rate: HostedShippingRate;
  selected: boolean;
  /** The cart earned free shipping — the quoted price is struck through. */
  free?: boolean;
  onSelect: () => void;
}) {
  const eta = deliveryEstimate(rate);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3.5 py-3 text-left transition-all duration-200 ${
        selected
          ? "border-teal bg-teal/5 shadow-sm"
          : "border-line bg-white hover:border-teal/40"
      }`}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span
          className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border transition ${
            selected ? "border-teal bg-teal-dark text-white" : "border-line"
          }`}
        >
          {selected && <Check className="h-2.5 w-2.5" />}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-xs font-semibold text-ink">
            {rate.courier_name}
          </span>
          <span className="block truncate text-[11px] text-ink-muted">
            {rate.service_name}
            {eta ? ` · ${eta}` : ""}
          </span>
        </span>
      </span>
      <span className="flex-shrink-0 text-sm font-semibold tabular-nums">
        {free ? (
          <>
            <span className="mr-1.5 text-xs font-normal text-ink-muted line-through">
              ${rate.total_charge.toFixed(2)}
            </span>
            <span className="text-emerald-700">Free</span>
          </>
        ) : (
          <span className="text-ink">${rate.total_charge.toFixed(2)}</span>
        )}
      </span>
    </button>
  );
}

function AddonSkeleton() {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line p-3">
      <div className="h-12 w-12 flex-shrink-0 rounded-lg bg-line/40 animate-pulse" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="h-3 w-3/4 rounded bg-line/40 animate-pulse" />
        <div className="h-2.5 w-1/2 rounded bg-line/30 animate-pulse" />
      </div>
      <div className="h-9 w-9 flex-shrink-0 rounded-lg bg-line/40 animate-pulse" />
    </div>
  );
}

/** A single add-on row. `featured` gives the teal "Essential" treatment. */
function AddonRow({
  p,
  featured,
  onAdd,
}: {
  p: AddonProduct;
  featured?: boolean;
  onAdd: () => void;
}) {
  return (
    <motion.div
      variants={itemVariants}
      className={`group flex items-center gap-3 rounded-xl border p-3 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-sm ${
        featured
          ? "border-teal/40 bg-teal/[0.04] hover:border-teal/60"
          : "border-line hover:border-teal/40"
      }`}
    >
      <div className="relative flex h-12 w-12 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-surface">
        {p.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.image_url} alt="" className="h-full w-full object-contain p-1" />
        ) : (
          <Beaker className="h-6 w-6 text-line" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="truncate text-sm font-medium text-ink">{p.name}</p>
          {featured && (
            <span className="inline-flex flex-shrink-0 items-center rounded-full border border-teal/30 bg-teal/10 px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-teal-dark">
              Essential
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-ink-muted">
          {p.strength ? `${p.strength} · ` : ""}from ${p.fromPrice.toFixed(2)}
        </p>
      </div>
      <button
        type="button"
        onClick={onAdd}
        aria-label={`Add ${p.name}`}
        className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-ink text-white transition-all duration-150 hover:bg-ink/90 active:scale-90"
      >
        <Plus className="h-4 w-4" />
      </button>
    </motion.div>
  );
}

/** Read the referral code captured by middleware (best-effort). */
interface AppliedDiscountCode {
  code: string;
  discountType: "percent" | "fixed";
  discountValue: number;
  description: string;
  /** Products the code takes nothing off. */
  excludedProductIds: string[];
  firstOrderOnly: boolean;
  /** Put into the field by us, from the landing page the buyer arrived through. */
  fromLanding: boolean;
}

/**
 * The percentage a code takes off this subtotal. A fixed amount is re-measured
 * against the live subtotal, so it stays right as the cart changes; capped at
 * 99% like every other discount, since a zero line price is charged at list.
 */
function discountCodePercent(code: AppliedDiscountCode, subtotal: number): number {
  const raw =
    code.discountType === "fixed"
      ? subtotal > 0
        ? (code.discountValue / subtotal) * 100
        : 0
      : code.discountValue;
  return Math.min(99, Math.max(0, Math.round(raw * 100) / 100));
}

function readReferralCode(): string {
  if (typeof document === "undefined") return "";
  const row = document.cookie.split("; ").find((r) => r.startsWith("ref_code="));
  if (!row) return "";
  const raw = row.slice(row.indexOf("=") + 1);
  try {
    return decodeURIComponent(raw).toUpperCase();
  } catch {
    return raw.toUpperCase();
  }
}

/**
 * Stealth Health hosted-checkout screen. Collects contact info, shows the cart
 * summary, then hands the cart off to `/api/checkout/puramass` and redirects
 * to the payment link.
 *
 * The hand-off is denominated in CAD and carries our own per-unit prices, so
 * the hosted page charges the same CAD amounts shown here — only shipping and
 * any applicable taxes are added there.
 */
export default function PuramassCheckoutContent({
  guestCheckoutEnabled,
  shippingRatesEnabled,
  addonsEnabled = true,
  verifyNoticeEnabled = true,
  flatShipping,
  freeShippingActive,
  freeShippingThreshold,
}: {
  guestCheckoutEnabled: boolean;
  /** Admin toggle: buyer picks a live courier rate, or everyone pays the flat fee. */
  shippingRatesEnabled: boolean;
  /** Admin toggle: show the "Complete your order" box (reconstitution help + add-ons). */
  addonsEnabled?: boolean;
  /** Admin toggle: show the "A few quick questions first" notice under the pay button. */
  verifyNoticeEnabled?: boolean;
  /** Flat fee (CAD) charged when live rates are off or unavailable. */
  flatShipping: number;
  /** A free-shipping promo is running. */
  freeShippingActive: boolean;
  /** Goods subtotal that unlocks it, CAD. */
  freeShippingThreshold: number;
}) {
  const { items, totalPrice } = useCart();
  const { customer } = useCustomer();
  const { openPurchaseModal } = usePurchaseModal();
  // The discounts this buyer has earned: the paid-ads welcome discount, and
  // the limited-time cart offer. Display only — the hand-off re-decides both
  // (the welcome discount from the attribution cookies and the customer row,
  // the offer from the settings row and the quantities being ordered) and
  // takes the money off the line prices itself.
  const { adDiscount, adDiscountEligible, adDiscountOn, cartOffer, landingOffer } = usePromos();

  const [email, setEmail] = useState("");
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unmapped, setUnmapped] = useState<string[]>([]);
  const [referralCode, setReferralCode] = useState("");
  const [addons, setAddons] = useState<AddonProduct[]>([]);

  // ---- Discount code ----
  // Display only, like the promos above: the hand-off looks the code up again
  // against the catalog-priced cart and decides what comes off.
  const [codeInput, setCodeInput] = useState("");
  const [appliedCode, setAppliedCode] = useState<AppliedDiscountCode | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codeChecking, setCodeChecking] = useState(false);
  // The landing page's code: the subtotal it was last tried against (so a
  // cart that changes after a miss is tried again), and whether the buyer took
  // it out of the field — which the hand-off is told, so it does not put it
  // back (see `declineLandingOffer` in /api/checkout/puramass).
  const [landingTriedFor, setLandingTriedFor] = useState<number | null>(null);
  const [landingDeclined, setLandingDeclined] = useState(false);

  // ---- Shipping ----
  const [shipping, setShipping] = useState<ShippingForm>(EMPTY_SHIPPING);
  const [addressErrors, setAddressErrors] = useState<ShippingAddressErrors>({});
  const [rates, setRates] = useState<HostedShippingRate[]>([]);
  // True once a real courier quote came back. False means the flat fee is the
  // only option, so there is nothing for the buyer to choose.
  const [ratesLive, setRatesLive] = useState(false);
  const [ratesNote, setRatesNote] = useState<string | null>(null);
  const [ratesLoading, setRatesLoading] = useState(false);
  const [courierId, setCourierId] = useState<string | null>(null);
  // Drives the add-on loading skeleton so the third column never pops in blank.
  const [addonsLoading, setAddonsLoading] = useState(true);

  useEffect(() => {
    setReferralCode(readReferralCode());
  }, []);

  const applyDiscountCode = async (raw: string, opts: { fromLanding?: boolean } = {}) => {
    const code = raw.trim();
    if (!code) return;
    setCodeChecking(true);
    setCodeError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const res = await fetch("/api/checkout/discount-code", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          code,
          subtotal: totalPrice,
          // Per product, so a code that excludes some is measured against
          // the lines it applies to.
          items: items.map((it) => ({ productId: it.productId, amount: it.price * it.quantity })),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (json?.ok) {
        setAppliedCode({
          code: json.code,
          discountType: json.discount_type === "fixed" ? "fixed" : "percent",
          discountValue: Number(json.discount_value) || 0,
          description: json.description,
          excludedProductIds: Array.isArray(json.excluded_product_ids) ? json.excluded_product_ids : [],
          firstOrderOnly: !!json.first_order_only,
          fromLanding: !!opts.fromLanding,
        });
        setCodeInput(json.code);
        if (opts.fromLanding) setLandingDeclined(false);
      } else {
        setAppliedCode(null);
        setCodeError(json?.error || "That code isn't valid.");
      }
    } catch {
      setCodeError("Could not check that code. Please try again.");
    } finally {
      setCodeChecking(false);
    }
  };

  // A shared link can carry a code (`/checkout?discount=SPRING20`), the way an
  // affiliate hands one out. Applied once the cart has a subtotal to check.
  const [linkCodeTried, setLinkCodeTried] = useState(false);
  useEffect(() => {
    if (linkCodeTried || totalPrice <= 0) return;
    setLinkCodeTried(true);
    try {
      const params = new URLSearchParams(window.location.search);
      const fromLink = params.get("discount") || params.get("code");
      if (fromLink) {
        setCodeInput(fromLink);
        void applyDiscountCode(fromLink);
      }
    } catch {
      /* no URL to read */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalPrice, linkCodeTried]);

  // The landing page's offer goes into the discount field by itself — that is
  // the promise the landing page made. After the link code above has had its
  // turn, and never over a code the buyer has typed or applied. A miss (a cart
  // of nothing but excluded products) is tried again when the cart changes.
  //
  // This is the visible half. The hand-off applies the same code on its own
  // when the field arrives empty, so the discount does not depend on this
  // effect having run.
  useEffect(() => {
    if (!linkCodeTried || totalPrice <= 0 || codeChecking) return;
    if (!landingOffer.active || !landingOffer.code || landingDeclined) return;
    if (appliedCode || codeInput.trim()) return;
    if (landingTriedFor === totalPrice) return;
    setLandingTriedFor(totalPrice);
    void applyDiscountCode(landingOffer.code, { fromLanding: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    linkCodeTried,
    totalPrice,
    landingOffer.active,
    landingOffer.code,
    landingDeclined,
    appliedCode,
    codeInput,
    codeChecking,
    landingTriedFor,
  ]);

  // Checkout upsell — products flagged is_checkout_addon. Only forms Stealth
  // Health can fulfil are offered (a case and/or vial SKU); store stock is
  // ignored. Products with neither valid form are dropped. Not loaded at all
  // when the admin has hidden the "Complete your order" box.
  useEffect(() => {
    if (!addonsEnabled) {
      setAddonsLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        const res = await fetch("/api/products?addon=1", {
          cache: "no-store",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) return;
        const json = await res.json();
        const list: AddonProduct[] = (json.products ?? [])
          .map((p: any): AddonProduct => {
            const boxOk =
              typeof p.puramass_sku === "string" &&
              /-(case|10-pack)$/.test(p.puramass_sku.trim().toLowerCase());
            const vialOk =
              typeof p.puramass_sku_vial === "string" &&
              p.puramass_sku_vial.toLowerCase().endsWith("-vial");
            const allowedUnits: PurchaseUnit[] = [];
            if (vialOk) allowedUnits.push("vial");
            if (boxOk) allowedUnits.push("case");
            const vialPrice = vialPriceFor(p);
            // Every pack the product is sold in, each at its own price — the
            // price the hand-off charges (`priceCartLines`). Quoting vial ×
            // size instead showed e.g. a $375 10-pack as $700 here while
            // Stealth Health was sent, and charged, $375.
            const packs = packOptionsFor(p).filter((o) =>
              o.size === 1 ? vialOk : boxOk,
            );
            const fromPrice = packs.length > 0
              ? Math.min(...packs.map((o) => o.price))
              : vialPrice;
            return {
              id: p.id,
              name: p.name,
              strength: p.strength ?? null,
              price: p.price,
              vial_price: p.vial_price ?? null,
              vials_per_box: p.vials_per_box ?? null,
              pack_sizes: p.pack_sizes ?? null,
              pack_options: p.pack_options ?? null,
              stock_quantity: p.stock_quantity ?? 0,
              image_url: p.image_url ?? null,
              box_image_url: p.box_image_url ?? null,
              allowedUnits,
              fromPrice,
            };
          })
          .filter((p: AddonProduct) => p.allowedUnits.length > 0);
        if (!cancelled) setAddons(list);
      } catch {
        /* hide the upsell on failure */
      } finally {
        if (!cancelled) setAddonsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [addonsEnabled]);

  const openAddon = (p: AddonProduct) => {
    openPurchaseModal({
      id: p.id,
      name: p.name,
      strength: p.strength,
      price: p.price,
      vial_price: p.vial_price,
      vials_per_box: p.vials_per_box,
      // The same packs the product page offers, at the same per-pack prices.
      // Every multi-vial pack travels to Stealth Health as one case-SKU unit
      // at that pack's own price, so what is quoted here is what is charged;
      // allowedUnits drops the vial or the packs when a SKU is missing.
      pack_sizes: p.pack_sizes,
      pack_options: p.pack_options,
      stock_quantity: p.stock_quantity,
      image_url: p.image_url,
      box_image_url: p.box_image_url,
      allowedUnits: p.allowedUnits,
      ignoreStock: true,
    });
  };

  // Prefill from the signed-in customer once it hydrates.
  useEffect(() => {
    if (!customer) return;
    setEmail((e) => e || customer.email || "");
    setFirstName((f) => f || customer.first_name || "");
    setLastName((l) => l || customer.last_name || "");
    setShipping((f) => (f.phone ? f : { ...f, phone: customer.phone || "" }));
  }, [customer]);

  const emailValid = emailRegex.test(email.trim());
  const accountRequired = !guestCheckoutEnabled && !customer;

  // Whole cart in single vials (a pack of 10 counts as 10) — what the parcel
  // weight behind a rate quote is derived from.
  const totalVials = items.reduce(
    (sum, it) => sum + it.quantity * it.packSize,
    0,
  );

  const regions = regionsFor(shipping.country);
  const addressReady = canQuote(shipping);
  const selectedRate = ratesLive
    ? rates.find((r) => r.courier_id === courierId) ?? null
    : (rates[0] ?? null);

  // Whether this cart has earned free shipping. Shown here; settled again
  // server-side at hand-off against a subtotal derived from the catalog, so
  // this is a display decision only.
  const freeShipping =
    freeShippingActive && freeShippingThreshold > 0 && totalPrice >= freeShippingThreshold;

  // The flat fee stands in until a quote lands, so the summary never shows a
  // total that is missing its shipping line.
  const quotedShipping = selectedRate?.total_charge ?? flatShipping;
  const shippingCost = freeShipping ? 0 : quotedShipping;

  // What the discounts take off. Applied in the same order the hand-off
  // composes them — the welcome discount off the subtotal, the cart offer off
  // what is left — so the total quoted here is the one that gets charged. The
  // server may round a cent further in the buyer's favour when it splits this
  // across the line prices, so these are a floor on the saving rather than an
  // exact promise of the charge.
  //
  // A discount code does not stack with the first-order discount: the larger
  // of the two applies, the same rule the hand-off uses.
  //
  // A code that excludes products (the landing page's "*excluding Bac water")
  // is taken off the other lines only, so the two are compared by what each
  // takes off rather than by percentage.
  const welcomeSaving = adDiscountOn(totalPrice);
  const codeBase = appliedCode
    ? eligibleSubtotal(
        items.map((it) => ({ productId: it.productId, amount: it.price * it.quantity })),
        appliedCode.excludedProductIds,
      )
    : 0;
  const codePercent = appliedCode ? discountCodePercent(appliedCode, codeBase) : 0;
  const codeFullSaving = Math.round(codeBase * codePercent) / 100;
  const codeWins = appliedCode !== null && codePercent > 0 && codeFullSaving >= welcomeSaving;
  const codeSaving = codeWins ? codeFullSaving : 0;
  // Lines in this cart the applied code does not discount, by name.
  const excludedInCart = appliedCode
    ? items
        .filter((it) => appliedCode.excludedProductIds.includes(it.productId))
        .map((it) => it.name)
        .filter((name, i, all) => all.indexOf(name) === i)
    : [];
  const adSaving = codeWins ? 0 : welcomeSaving;
  const firstSaving = codeSaving + adSaving;
  const offerSaving = cartOffer.amountOn(Math.max(0, totalPrice - firstSaving));
  const discount = firstSaving + offerSaving;
  const discountedSubtotal = Math.max(0, totalPrice - discount);
  const showDiscount = discount > 0;
  const showAdDiscount = adDiscountEligible && adSaving > 0;
  const showOfferDiscount = offerSaving > 0;
  const showCodeDiscount = codeSaving > 0;
  const appliedLabels = [
    showCodeDiscount && appliedCode
      ? appliedCode.fromLanding
        ? `${appliedCode.description.replace(/ off$/, "")} welcome offer (code ${appliedCode.code})`
        : `code ${appliedCode.code}`
      : null,
    showAdDiscount ? `${adDiscount.percent}% first-order discount` : null,
    showOfferDiscount ? `${cartOffer.percent}% limited-time offer` : null,
  ].filter(Boolean) as string[];

  // A live picker means a delivery method has to be chosen before paying;
  // otherwise there is only one shipping price and nothing to pick.
  const deliveryChosen = !shippingRatesEnabled || !ratesLive || !!selectedRate;
  const namesValid = firstName.trim() !== "" && lastName.trim() !== "";
  const phoneValid = isValidPhone(shipping.phone);
  // With live rates on, the flat fee is only a fallback: until a quote has
  // come back (and, if live, a courier is picked) there is no shipping price
  // to show, so the summary says what's still needed instead of a number.
  const shippingPending =
    shippingRatesEnabled && (!addressReady || ratesLoading || (ratesLive && !selectedRate));
  const canSubmit =
    emailValid &&
    namesValid &&
    phoneValid &&
    (!shippingRatesEnabled || addressReady) &&
    !ratesLoading &&
    deliveryChosen;

  const setShip = (patch: Partial<ShippingForm>) => {
    setShipping((f) => ({ ...f, ...patch }));
    setAddressErrors({});
  };

  // Quote couriers for the address as it's typed. Debounced, and every
  // in-flight response is checked against the request that is still current, so
  // a slow quote for a half-typed address can't overwrite a newer one.
  useEffect(() => {
    if (!shippingRatesEnabled) return;
    if (!addressReady) {
      setRates([]);
      setRatesLive(false);
      setCourierId(null);
      return;
    }
    let cancelled = false;
    setRatesLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/checkout/puramass/rates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vials: totalVials,
            destination: {
              country: shipping.country,
              postal_code: shipping.zip.trim(),
              city: shipping.city.trim(),
              state: shipping.state.trim(),
            },
          }),
        });
        const json = await res.json().catch(() => ({}));
        // TEMP DEBUG: surface why live rates fell back. Remove once diagnosed.
        if (!res.ok || !json.live) {
          console.error("[checkout] shipping rates fallback", {
            status: res.status,
            error: json.error,
            note: json.note,
            debug: json.debug,
          });
        }
        if (cancelled) return;
        if (!res.ok) {
          setRates([]);
          setRatesLive(false);
          setRatesNote(null);
          return;
        }
        const next: HostedShippingRate[] = Array.isArray(json.rates) ? json.rates : [];
        setRates(next);
        setRatesLive(!!json.live);
        setRatesNote(json.note ?? null);
        // Prices move. A courier that is no longer offered must not stay
        // selected, or the buyer would be shown one price and charged another.
        setCourierId((current) =>
          current && next.some((r) => r.courier_id === current) ? current : null,
        );
      } catch (err) {
        console.error("[checkout] shipping rates request failed", err); // TEMP DEBUG
        if (!cancelled) {
          setRates([]);
          setRatesLive(false);
          setRatesNote(null);
        }
      } finally {
        if (!cancelled) setRatesLoading(false);
      }
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setRatesLoading(false);
    };
  }, [
    shippingRatesEnabled,
    addressReady,
    shipping.country,
    shipping.zip,
    shipping.city,
    shipping.state,
    totalVials,
  ]);

  // Split the add-ons so bacteriostatic water leads the list (it's the item
  // buyers most often forget), and count the peptide vials already in the cart
  // so the copy can nudge the right amount of water.
  const bacWater = addons.filter((p) => isBacName(p.name));
  const otherAddons = addons.filter((p) => !isBacName(p.name));
  const peptideVials = items
    .filter((it) => !isBacName(it.name))
    .reduce(
      (sum, it) => sum + it.quantity * it.packSize,
      0,
    );

  const handleSubmit = async () => {
    if (items.length === 0 || !canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    setUnmapped([]);
    setAddressErrors({});
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      const payload = {
        items: items.map((it) => ({
          id: it.productId,
          // packSize distinguishes the SKU form server-side: a single-vial line
          // sends packSize 1 (→ the vial SKU); a case line sends vials-per-pack
          // (→ the 10-pack SKU). `quantity` is always total vials in the line.
          packSize: it.packSize,
          quantity: it.quantity * it.packSize,
        })),
        customer: {
          email: email.trim(),
          firstName: firstName.trim() || undefined,
          lastName: lastName.trim() || undefined,
          phone: shipping.phone.trim(),
        },
        // Ship-to + the delivery method chosen above. Only the courier's id
        // travels: the server re-quotes and prices it, so nothing the browser
        // says about money is believed.
        shipping: shippingRatesEnabled
          ? {
              ...shipping,
              full_name: [firstName.trim(), lastName.trim()].filter(Boolean).join(" "),
              courier_id: selectedRate?.courier_id ?? null,
            }
          : undefined,
        referralCode: referralCode || undefined,
        discountCode: appliedCode?.code || undefined,
        // Only sent when the buyer removed the landing page's code themselves.
        declineLandingOffer: landingDeclined && !appliedCode ? true : undefined,
      };

      const res = await fetch("/api/checkout/puramass", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (json.discount_code_error) {
          // The code stopped applying between preview and pay (the cart
          // shrank under its minimum, or it hit its limit). Drop it so the
          // buyer can pay without it or try another.
          const wasLanding = !!appliedCode?.fromLanding;
          setAppliedCode(null);
          setCodeError(json.error || "That code no longer applies.");
          if (wasLanding) {
            // The buyer never typed it, so there is nothing for them to fix:
            // it has been taken out and they can pay without it.
            setLandingDeclined(true);
            setError(`${json.error || "Your welcome offer doesn't apply to this order."} You can continue without it.`);
          } else {
            setError(`${json.error || "That discount code no longer applies."} Remove it or try another to continue.`);
          }
        } else if (res.status === 409 && Array.isArray(json.unmapped)) {
          setUnmapped(json.unmapped);
          setError("Some items aren't available for the secure hosted checkout.");
        } else if (res.status === 409 && Array.isArray(json.rates)) {
          // Couriers re-quoted between picking and paying. Show the fresh list
          // rather than charging a price the buyer never agreed to.
          setRates(json.rates);
          setRatesLive(true);
          setCourierId(null);
          setError(json.error || "Please choose a delivery method again.");
        } else {
          if (json.fields && typeof json.fields === "object") {
            setAddressErrors(json.fields as ShippingAddressErrors);
          }
          setError(json.error || "Could not start checkout. Please try again.");
        }
        setSubmitting(false);
        return;
      }

      if (json.payment_link) {
        // GA4 `begin_checkout`. This is the last event Google gets from this
        // path: payment happens on Stealth Health's own domain, so no `purchase`
        // event can ever fire client-side here. Ads optimisation on this
        // funnel has to be fed from the server side of the ledger instead.
        trackBeginCheckout(items.map(cartItemToAnalytics));
        // Our own funnel record, which does not have that limitation — the
        // ledger row already carries the channel, and the webhook closes the
        // loop on the email.
        void trackActivity({
          type: "checkout_start",
          metadata: {
            kind: "puramass",
            items: items.length,
            // What the goods actually cost them, discount included — otherwise
            // the funnel reports a value no order will ever settle at.
            value: Number(
              (json.ad_discount ? totalPrice - json.ad_discount : totalPrice).toFixed(2),
            ),
          },
        });
        // Keep `submitting` true through the redirect so the CTA stays locked.
        window.location.href = json.payment_link;
        return;
      }
      setError("Could not start checkout. Please try again.");
      setSubmitting(false);
    } catch {
      setError("Could not start checkout. Please try again.");
      setSubmitting(false);
    }
  };

  // ---- Header (shared shell) ----
  const Header = (
    <div className="bg-white border-b border-line">
      <div className="max-w-6xl mx-auto px-5 sm:px-8 py-6">
        <div className="flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
            <img src="/images/vyta-mark.png" alt="" aria-hidden="true" className="relative w-10 h-10 object-contain" />
            <div className="flex flex-col">
              <span className="text-lg font-bold text-ink tracking-tight leading-none">
                VYTA
              </span>
              <span className="text-[10px] text-teal-dark tracking-[0.15em] font-medium uppercase mt-0.5">
                Secure Checkout
              </span>
            </div>
          </Link>
          <div className="flex items-center gap-2 px-4 py-2 bg-surface rounded-full border border-line">
            <Lock className="w-4 h-4 text-teal-dark" />
            <span className="text-sm font-medium text-ink-muted">SSL Encrypted</span>
          </div>
        </div>
      </div>
    </div>
  );

  // ---- Empty cart ----
  if (items.length === 0) {
    return (
      <div className="min-h-screen bg-white">
        {Header}
        <div className="px-5 sm:px-8 py-12">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            className="max-w-lg mx-auto bg-surface rounded-2xl p-10 md:p-12 text-center border border-line"
          >
            <div className="w-16 h-16 bg-white rounded-2xl flex items-center justify-center mx-auto mb-4 border border-line">
              <ShoppingCart className="w-8 h-8 text-ink-muted" />
            </div>
            <h2 className="text-xl font-bold text-ink mb-2">Your cart is empty</h2>
            <p className="text-ink-muted mb-6 text-sm">
              Add some research compounds before checking out.
            </p>
            <Link
              href="/products"
              className="inline-flex items-center gap-2 bg-ink hover:bg-ink/90 text-white px-6 py-3 rounded-xl font-semibold transition-all text-sm"
            >
              <span>Browse Catalog</span>
              <ArrowRight className="w-4 h-4" />
            </Link>
          </motion.div>
        </div>
      </div>
    );
  }

  // ---- Account-required gate ----
  if (accountRequired) {
    return (
      <div className="min-h-screen bg-white">
        {Header}
        <div className="px-5 sm:px-8 py-12">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            className="max-w-lg mx-auto bg-white rounded-2xl p-8 md:p-10 text-center border border-line"
          >
            <div className="w-16 h-16 bg-teal/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
              <Lock className="w-8 h-8 text-teal-dark" />
            </div>
            <h2 className="text-xl font-bold text-ink mb-2">Account required</h2>
            <p className="text-ink-muted mb-6 text-sm">
              Please sign in to your account to continue to secure checkout.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Link
                href="/products"
                className="px-6 py-2.5 border border-line rounded-xl text-sm font-medium text-ink hover:bg-surface transition-colors"
              >
                Continue Shopping
              </Link>
              <Link
                href="/"
                className="px-6 py-2.5 bg-ink text-white rounded-xl text-sm font-medium hover:bg-ink/90 transition-colors"
              >
                Sign in
              </Link>
            </div>
          </motion.div>
        </div>
      </div>
    );
  }

  // ---- Main ----
  return (
    <div className="min-h-screen bg-white">
      {Header}
      <div className="px-5 sm:px-8 py-8 md:py-12">
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate="show"
          className="max-w-6xl mx-auto"
        >
          {/* Redirect explainer */}
          <motion.div
            variants={itemVariants}
            className="flex items-start gap-3 rounded-2xl border border-teal/30 bg-teal/5 p-4 mb-6"
          >
            <ShieldCheck className="w-5 h-5 text-teal-dark flex-shrink-0 mt-0.5" />
            <div className="text-sm text-ink">
              <p className="font-semibold">You&apos;ll finish on our secure checkout partner.</p>
              <p className="text-ink-muted mt-0.5">
                Your order is priced in Canadian dollars and payment is collected on
                the secure hosted checkout page.{" "}
                {shippingRatesEnabled
                  ? "Tell us where it's going and pick a courier below — that shipping price is locked in before you pay."
                  : "Shipping and any applicable taxes are added there."}
              </p>
            </div>
          </motion.div>

          <div
            className={`grid grid-cols-1 gap-6 ${addonsEnabled ? "lg:grid-cols-3" : "lg:grid-cols-2"}`}
          >
            {/* ---- Column 1 · Contact ---- */}
            <motion.section variants={itemVariants}>
              <div className="h-full rounded-2xl border border-line bg-white p-5">
                <div className="flex items-center gap-3 mb-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-surface">
                    <User className="h-5 w-5 text-teal-dark" />
                  </div>
                  <div>
                    <h2 className="text-base font-semibold text-ink">Contact information</h2>
                    <p className="text-xs text-ink-muted">
                      We&apos;ll send your receipt here.
                    </p>
                  </div>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-ink-muted uppercase tracking-wider mb-1.5">
                      Email <span className="text-teal-dark">*</span>
                    </label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                      <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="you@example.com"
                        autoComplete="email"
                        className="w-full pl-10 pr-10 py-2.5 bg-surface rounded-lg border border-line text-sm text-ink placeholder-ink-muted focus:outline-none focus:ring-2 focus:ring-teal/40 focus:border-transparent transition"
                      />
                      {emailValid && (
                        <motion.span
                          initial={{ scale: 0, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          transition={{ type: "spring", stiffness: 400, damping: 20 }}
                          className="absolute right-3 top-1/2 -translate-y-1/2 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-white"
                        >
                          <Check className="h-3 w-3" />
                        </motion.span>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-ink-muted uppercase tracking-wider mb-1.5">
                        First name <span className="text-teal-dark">*</span>
                      </label>
                      <input
                        type="text"
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        placeholder="First name"
                        required
                        autoComplete="given-name"
                        className="w-full px-4 py-2.5 bg-surface rounded-lg border border-line text-sm text-ink placeholder-ink-muted focus:outline-none focus:ring-2 focus:ring-teal/40 focus:border-transparent transition"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-ink-muted uppercase tracking-wider mb-1.5">
                        Last name <span className="text-teal-dark">*</span>
                      </label>
                      <input
                        type="text"
                        value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                        placeholder="Last name"
                        required
                        autoComplete="family-name"
                        className="w-full px-4 py-2.5 bg-surface rounded-lg border border-line text-sm text-ink placeholder-ink-muted focus:outline-none focus:ring-2 focus:ring-teal/40 focus:border-transparent transition"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-ink-muted uppercase tracking-wider mb-1.5">
                      Phone <span className="text-teal-dark">*</span>
                    </label>
                    <input
                      type="tel"
                      value={shipping.phone}
                      onChange={(e) => setShip({ phone: e.target.value })}
                      onBlur={() => setPhoneTouched(true)}
                      placeholder="(416) 555-0199"
                      required
                      autoComplete="tel"
                      inputMode="tel"
                      className={INPUT_CLASS}
                    />
                    <FieldError
                      message={
                        phoneTouched && !phoneValid
                          ? "Enter a valid phone number (at least 10 digits)."
                          : addressErrors.phone
                      }
                    />
                    <p className="mt-1.5 text-[11px] leading-snug text-ink-muted">
                      Used only if we or the courier need to reach you about your order.
                    </p>
                  </div>

                  {/* ---- Ship-to. Only asked for when a courier has to quote it. ---- */}
                  {shippingRatesEnabled && (
                    <div className="border-t border-line pt-4 mt-1">
                      <div className="flex items-center gap-2 mb-3">
                        <MapPin className="h-4 w-4 text-teal-dark" />
                        <h3 className="text-sm font-semibold text-ink">Shipping address</h3>
                      </div>

                      <div className="space-y-3">
                        <div>
                          <label className="block text-xs font-medium text-ink-muted uppercase tracking-wider mb-1.5">
                            Country <span className="text-teal-dark">*</span>
                          </label>
                          <select
                            value={shipping.country}
                            onChange={(e) => setShip({ country: e.target.value, state: "" })}
                            className={INPUT_CLASS}
                          >
                            {SHIPPING_COUNTRIES.map((c) => (
                              <option key={c.code} value={c.code}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <label className="block text-xs font-medium text-ink-muted uppercase tracking-wider mb-1.5">
                            Street address <span className="text-teal-dark">*</span>
                          </label>
                          <AddressAutocomplete
                            value={shipping.address}
                            onChange={(next) => setShip({ address: next })}
                            onPick={(picked) =>
                              setShip({
                                address: picked.address,
                                city: picked.city,
                                state: picked.state,
                                zip: picked.postalCode,
                                country: "CA",
                              })
                            }
                          />
                          <FieldError message={addressErrors.address} />
                        </div>

                        <div>
                          <label className="block text-xs font-medium text-ink-muted uppercase tracking-wider mb-1.5">
                            Apartment, suite, unit
                          </label>
                          <input
                            type="text"
                            value={shipping.address2}
                            onChange={(e) => setShip({ address2: e.target.value })}
                            placeholder="Optional"
                            autoComplete="address-line2"
                            className={INPUT_CLASS}
                          />
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs font-medium text-ink-muted uppercase tracking-wider mb-1.5">
                              City <span className="text-teal-dark">*</span>
                            </label>
                            <input
                              type="text"
                              value={shipping.city}
                              onChange={(e) => setShip({ city: e.target.value })}
                              autoComplete="address-level2"
                              className={INPUT_CLASS}
                            />
                            <FieldError message={addressErrors.city} />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-ink-muted uppercase tracking-wider mb-1.5">
                              {postalLabel(shipping.country)} <span className="text-teal-dark">*</span>
                            </label>
                            <input
                              type="text"
                              value={shipping.zip}
                              onChange={(e) => setShip({ zip: e.target.value })}
                              autoComplete="postal-code"
                              className={INPUT_CLASS}
                            />
                            <FieldError message={addressErrors.zip} />
                          </div>
                        </div>

                        <div>
                          <label className="block text-xs font-medium text-ink-muted uppercase tracking-wider mb-1.5">
                            {regionLabel(shipping.country)}
                            {regions && <span className="text-teal-dark"> *</span>}
                          </label>
                          {regions ? (
                            <select
                              value={shipping.state}
                              onChange={(e) => setShip({ state: e.target.value })}
                              className={INPUT_CLASS}
                            >
                              <option value="">Select…</option>
                              {regions.map((r) => (
                                <option key={r.code} value={r.code}>
                                  {r.name}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type="text"
                              value={shipping.state}
                              onChange={(e) => setShip({ state: e.target.value })}
                              placeholder="Optional"
                              autoComplete="address-level1"
                              className={INPUT_CLASS}
                            />
                          )}
                          <FieldError message={addressErrors.state} />
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Reassurance list — fills the column and builds trust */}
                  <ul className="mt-1 space-y-2 border-t border-line pt-4">
                    {[
                      "Payment details entered on the encrypted partner page",
                      "Receipt & tracking emailed to you",
                      "No card data ever touches our servers",
                    ].map((line) => (
                      <li key={line} className="flex items-start gap-2 text-xs text-ink-muted">
                        <Check className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-teal-dark" />
                        <span>{line}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </motion.section>

            {/* ---- Column 2 · Complete your order (reconstitution) ---- */}
            {addonsEnabled && (
            <motion.section variants={itemVariants}>
              <div className="h-full rounded-2xl border border-line bg-white p-5">
                <div className="flex items-center gap-3 mb-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-teal/20 bg-teal/10">
                    <Droplets className="h-5 w-5 text-teal-dark" />
                  </div>
                  <div>
                    <h2 className="text-base font-semibold text-ink">Complete your order</h2>
                    <p className="text-xs text-ink-muted">Reconstitution essentials</p>
                  </div>
                </div>

                {/* Why you need bacteriostatic water */}
                <div className="rounded-xl border border-teal/20 bg-teal/5 p-3.5 mb-4">
                  <p className="text-xs leading-relaxed text-ink">
                    <span className="font-semibold">Most peptides ship freeze-dried</span>{" "}
                    (lyophilized) and must be reconstituted with{" "}
                    <span className="font-semibold">bacteriostatic water</span> before use.
                    Add enough to mix everything in your cart.
                  </p>
                  {peptideVials > 0 && (
                    <p className="mt-2.5 flex items-center gap-1.5 rounded-lg bg-white/70 px-2.5 py-1.5 text-[11px] font-medium text-teal-dark">
                      <FlaskConical className="h-3.5 w-3.5 flex-shrink-0" />
                      {peptideVials} vial{peptideVials === 1 ? "" : "s"} in your cart — don&apos;t
                      forget the water to reconstitute {peptideVials === 1 ? "it" : "them"}.
                    </p>
                  )}
                </div>

                {/* Not sure how to reconstitute? — WhatsApp guidance */}
                <a
                  href="https://wa.me/15147013824"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group mb-4 flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-3 transition-all duration-200 hover:-translate-y-0.5 hover:border-emerald-300 hover:shadow-sm"
                >
                  <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-emerald-500 text-white transition-transform duration-200 group-hover:scale-105">
                    <MessageCircle className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-ink">
                      Not sure how to do this?
                    </p>
                    <p className="text-[11px] leading-snug text-ink-muted">
                      Message us on WhatsApp and we&apos;ll guide you through it.
                    </p>
                  </div>
                  <ArrowRight className="h-4 w-4 flex-shrink-0 text-emerald-600 transition-transform duration-200 group-hover:translate-x-0.5" />
                </a>

                {addonsLoading ? (
                  <div className="space-y-2.5">
                    <AddonSkeleton />
                    <AddonSkeleton />
                    <AddonSkeleton />
                  </div>
                ) : addons.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center">
                    <Droplets className="mx-auto mb-2 h-6 w-6 text-line" />
                    <p className="text-xs text-ink-muted">
                      Reconstitution supplies can be added on the secure checkout page.
                    </p>
                  </div>
                ) : (
                  <motion.div
                    variants={containerVariants}
                    initial="hidden"
                    animate="show"
                    className="space-y-2.5"
                  >
                    {bacWater.map((p) => (
                      <AddonRow key={p.id} p={p} featured onAdd={() => openAddon(p)} />
                    ))}
                    {otherAddons.length > 0 && bacWater.length > 0 && (
                      <div className="flex items-center gap-2 pt-1">
                        <span className="h-px flex-1 bg-line" />
                        <span className="text-[10px] font-medium uppercase tracking-wider text-ink-muted">
                          Also recommended
                        </span>
                        <span className="h-px flex-1 bg-line" />
                      </div>
                    )}
                    {otherAddons.map((p) => (
                      <AddonRow key={p.id} p={p} onAdd={() => openAddon(p)} />
                    ))}
                  </motion.div>
                )}
              </div>
            </motion.section>
            )}

            {/* ---- Column 3 · Order summary + CTA ---- */}
            <motion.section variants={itemVariants}>
              <div className="lg:sticky lg:top-6">
                <div className="rounded-2xl border border-line bg-white p-5">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-surface">
                      <ShoppingCart className="h-5 w-5 text-teal-dark" />
                    </div>
                    <div>
                      <h2 className="text-base font-semibold text-ink">Your order</h2>
                      <p className="text-xs text-ink-muted">
                        {items.length} item{items.length === 1 ? "" : "s"}
                      </p>
                    </div>
                  </div>

                  <div className="divide-y divide-line/60">
                    {items.map((it) => (
                      <div key={it.id} className="flex items-start justify-between gap-3 py-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-ink truncate">{it.name}</p>
                          <p className="mt-0.5 text-xs text-ink-muted">
                            {it.strength ? `${it.strength} · ` : ""}
                            <span className="inline-flex items-center rounded-full border border-line bg-surface px-1.5 py-[1px] text-[10px] font-medium text-ink-muted">
                              {it.packSize > 1 ? `Pack of ${it.packSize}` : "Single vial"}
                            </span>
                            <span className="ml-1.5">× {it.quantity}</span>
                          </p>
                        </div>
                        <span className="text-sm text-ink tabular-nums whitespace-nowrap">
                          ${(it.price * it.quantity).toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>

                  <FreeShippingProgress
                    subtotal={totalPrice}
                    threshold={freeShippingThreshold}
                    active={freeShippingActive}
                    className="mt-4"
                  />

                  {/* ---- Delivery ---- */}
                  <div className="mt-4 pt-4 border-t border-line">
                    <div className="flex items-center gap-2 mb-3">
                      <Truck className="h-4 w-4 text-teal-dark" />
                      <h3 className="text-sm font-semibold text-ink">Delivery</h3>
                    </div>

                    {!shippingRatesEnabled ? (
                      <p className="text-xs leading-relaxed text-ink-muted">
                        {flatShipping > 0 ? (
                          <>
                            Flat <span className="font-semibold text-ink">${flatShipping.toFixed(2)}</span>{" "}
                            tracked shipping on every order.
                          </>
                        ) : (
                          <>
                            <span className="font-semibold text-emerald-700">Free</span> tracked
                            shipping on every order.
                          </>
                        )}{" "}
                        You&apos;ll give the courier your delivery address on the secure checkout
                        page.
                      </p>
                    ) : !addressReady ? (
                      <p className="text-xs leading-relaxed text-ink-muted">
                        Enter your shipping address and we&apos;ll show you the fastest
                        courier options for it.
                      </p>
                    ) : ratesLoading ? (
                      <div className="flex items-center gap-2 text-xs text-ink-muted">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Checking courier rates…
                      </div>
                    ) : ratesLive ? (
                      <div className="space-y-2">
                        {rates.map((rate) => (
                          <RateOption
                            key={rate.courier_id}
                            rate={rate}
                            selected={rate.courier_id === courierId}
                            free={freeShipping}
                            onSelect={() => setCourierId(rate.courier_id)}
                          />
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs leading-relaxed text-ink-muted">
                        {ratesNote ? `${ratesNote} ` : ""}
                        {freeShipping ? (
                          <>
                            Tracked shipping applies to this order, and it&apos;s{" "}
                            <span className="font-semibold text-emerald-700">free</span>.
                          </>
                        ) : (
                          <>
                            Flat{" "}
                            <span className="font-semibold text-ink">
                              ${shippingCost.toFixed(2)}
                            </span>{" "}
                            tracked shipping applies to this order.
                          </>
                        )}
                      </p>
                    )}
                  </div>

                  {/* ---- Discount code ---- */}
                  <div className="mt-4 pt-4 border-t border-line">
                    <label
                      htmlFor="discount-code"
                      className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-ink"
                    >
                      <Ticket className="h-3.5 w-3.5 text-ink-muted" />
                      Discount code
                    </label>
                    {appliedCode ? (
                      <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
                        <span className="text-sm text-emerald-800">
                          <span className="font-mono font-semibold">{appliedCode.code}</span>
                          <span className="ml-2 text-xs">{appliedCode.description}</span>
                          {appliedCode.fromLanding && (
                            <span className="mt-0.5 block text-[11px] text-emerald-700">
                              Applied automatically from your welcome offer
                              {appliedCode.firstOrderOnly ? " · first order only" : ""}.
                            </span>
                          )}
                          {excludedInCart.length > 0 && (
                            <span className="mt-0.5 block text-[11px] text-emerald-700">
                              Not discounted by this code: {excludedInCart.join(", ")}.
                            </span>
                          )}
                          {!codeWins && codePercent > 0 && (
                            <span className="mt-0.5 block text-[11px] text-emerald-700">
                              Your first-order discount is larger, so it applies instead.
                            </span>
                          )}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            // Taking the landing page's code out is remembered, so
                            // neither this screen nor the hand-off puts it back.
                            // Taking out any other code lets the landing code
                            // return, which is what an empty field means.
                            if (appliedCode.fromLanding) {
                              setLandingDeclined(true);
                            } else {
                              setLandingTriedFor(null);
                            }
                            setAppliedCode(null);
                            setCodeInput("");
                            setCodeError(null);
                          }}
                          className="rounded p-1 text-emerald-700 transition-colors hover:bg-emerald-100"
                          aria-label="Remove discount code"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : (
                      <form
                        className="flex gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void applyDiscountCode(codeInput);
                        }}
                      >
                        <input
                          id="discount-code"
                          value={codeInput}
                          onChange={(e) => {
                            setCodeInput(e.target.value.toUpperCase());
                            setCodeError(null);
                          }}
                          placeholder="Enter code"
                          autoComplete="off"
                          className="min-w-0 flex-1 rounded-lg border border-line bg-white px-3 py-2 font-mono text-sm uppercase text-ink placeholder:font-sans placeholder:normal-case placeholder:text-ink-muted focus:border-teal focus:outline-none"
                        />
                        <button
                          type="submit"
                          disabled={codeChecking || !codeInput.trim()}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-surface disabled:opacity-50"
                        >
                          {codeChecking && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                          Apply
                        </button>
                      </form>
                    )}
                    {codeError && (
                      <p className="mt-1.5 text-xs text-amber-700">{codeError}</p>
                    )}
                    {!appliedCode && !codeError && landingDeclined && landingOffer.active && landingOffer.code && (
                      <button
                        type="button"
                        onClick={() => {
                          setCodeInput(landingOffer.code!);
                          void applyDiscountCode(landingOffer.code!, { fromLanding: true });
                        }}
                        className="mt-1.5 text-xs font-medium text-teal-dark hover:underline"
                      >
                        Re-apply your {+landingOffer.percent.toFixed(2)}% welcome offer ({landingOffer.code})
                      </button>
                    )}
                  </div>

                  {/* ---- Totals ---- */}
                  <div className="mt-4 pt-4 border-t border-line space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-ink-muted">Subtotal</span>
                      <span className="text-sm text-ink tabular-nums">
                        ${totalPrice.toFixed(2)}
                      </span>
                    </div>
                    {showCodeDiscount && appliedCode && (
                      <div className="flex items-center justify-between">
                        <span className="inline-flex items-center gap-1.5 text-sm text-emerald-700">
                          <Ticket className="h-3.5 w-3.5" />
                          {appliedCode.fromLanding ? "Welcome offer" : "Code"} {appliedCode.code}
                        </span>
                        <span className="text-sm font-semibold text-emerald-700 tabular-nums">
                          -${codeSaving.toFixed(2)}
                        </span>
                      </div>
                    )}
                    {showAdDiscount && (
                      <div className="flex items-center justify-between">
                        <span className="inline-flex items-center gap-1.5 text-sm text-emerald-700">
                          <BadgePercent className="h-3.5 w-3.5" />
                          {adDiscount.percent}% first-order discount
                        </span>
                        <span className="text-sm font-semibold text-emerald-700 tabular-nums">
                          -${adSaving.toFixed(2)}
                        </span>
                      </div>
                    )}
                    {showOfferDiscount && (
                      <div className="flex items-center justify-between">
                        <span className="inline-flex items-center gap-1.5 text-sm text-emerald-700">
                          <Gift className="h-3.5 w-3.5" />
                          {cartOffer.percent}% limited-time offer
                        </span>
                        <span className="text-sm font-semibold text-emerald-700 tabular-nums">
                          -${offerSaving.toFixed(2)}
                        </span>
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-ink-muted">Shipping</span>
                      <span className="text-sm text-ink tabular-nums">
                        {shippingRatesEnabled && !addressReady ? (
                          <span className="text-ink-muted">Enter address above</span>
                        ) : shippingRatesEnabled && ratesLoading ? (
                          <span className="inline-flex items-center gap-1.5 text-ink-muted">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Calculating…
                          </span>
                        ) : shippingRatesEnabled && ratesLive && !selectedRate ? (
                          <span className="text-ink-muted">Choose a courier above</span>
                        ) : freeShipping || shippingCost === 0 ? (
                          <span className="font-semibold text-emerald-700">Free</span>
                        ) : (
                          `$${shippingCost.toFixed(2)}`
                        )}
                      </span>
                    </div>
                    <div className="flex items-center justify-between pt-2 border-t border-line">
                      <span className="text-sm font-medium text-ink">Total</span>
                      <span className="text-lg font-bold text-ink tabular-nums">
                        ${(discountedSubtotal + (shippingPending ? 0 : shippingCost)).toFixed(2)}
                      </span>
                    </div>
                  </div>
                  {/* The buyer is about to leave for Stealth Health's own page, where
                      there is no discount line to look at — the saving is
                      already baked into the prices sent over. Say so here,
                      while they can still see both numbers. */}
                  {showDiscount && (
                    <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5">
                      <BadgePercent className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" />
                      <div className="text-[11px] leading-snug text-emerald-800">
                        <p className="font-semibold">
                          Your {appliedLabels.join(" and ")}{" "}
                          {appliedLabels.length > 1 ? "are" : "is"} already applied.
                        </p>
                        <p className="mt-0.5 text-emerald-700">
                          The secure checkout page shows the discounted prices —
                          ${discountedSubtotal.toFixed(2)} instead of $
                          {totalPrice.toFixed(2)} — so there is no code to enter
                          there.
                        </p>
                      </div>
                    </div>
                  )}
                  <div className="mt-3 flex items-start gap-2 rounded-lg bg-surface px-3 py-2">
                    <Info className="w-3.5 h-3.5 text-ink-muted flex-shrink-0 mt-0.5" />
                    <p className="text-[11px] leading-snug text-ink-muted">
                      Any applicable taxes are added on the secure checkout page.
                    </p>
                  </div>

                  {/* Errors */}
                  {error && (
                    <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                      <div className="flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                        <div className="text-sm text-amber-800">
                          <p>{error}</p>
                          {unmapped.length > 0 && (
                            <ul className="mt-1 list-disc list-inside text-xs">
                              {unmapped.map((name) => (
                                <li key={name}>{name}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* CTA */}
                  <button
                    type="button"
                    onClick={handleSubmit}
                    disabled={!canSubmit || submitting}
                    className="group relative mt-5 w-full overflow-hidden inline-flex items-center justify-center gap-2 bg-ink hover:bg-ink/90 text-white font-semibold py-3.5 rounded-2xl transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-ink/15 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none text-sm"
                  >
                    {/* Shine sweep on hover */}
                    <span className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/20 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
                    {submitting ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" /> Redirecting…
                      </>
                    ) : (
                      <>
                        <ShieldCheck className="w-4 h-4" /> Continue to secure checkout
                        <ArrowRight className="w-4 h-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                      </>
                    )}
                  </button>
                  <p className="mt-3 text-center text-xs text-ink-muted">
                    {!emailValid
                      ? "Enter a valid email to continue."
                      : !namesValid
                        ? "Enter your first and last name to continue."
                        : !phoneValid
                          ? "Enter a valid phone number to continue."
                        : shippingRatesEnabled && !addressReady
                          ? "Enter your shipping address to continue."
                          : ratesLoading
                            ? "Calculating shipping rates…"
                            : !deliveryChosen
                              ? "Choose a courier to continue."
                              : "You'll be redirected to complete payment securely, in CAD."}
                  </p>

                  {/* What happens on the partner's page, so the extra step
                      doesn't come as a surprise mid-payment. */}
                  {verifyNoticeEnabled && (
                    <div className="mt-4 flex items-start gap-2 rounded-xl border border-teal/20 bg-teal/5 px-3.5 py-3">
                      <HelpCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-teal-dark" />
                      <p className="text-[11px] leading-relaxed text-ink-muted">
                        <span className="font-semibold text-ink">
                          A few quick questions first.
                        </span>{" "}
                        Our checkout partner runs a secure, encrypted page and will ask you to
                        answer a short set of questions to confirm the order is really yours.
                        Once they&apos;re answered you can pay, and we&apos;ll get your parcel
                        moving.
                      </p>
                    </div>
                  )}

                  {/* Trust badges */}
                  <div className="mt-4 flex items-center justify-center gap-5 pt-4 border-t border-line">
                    <div className="flex items-center gap-1.5 text-ink-muted">
                      <ShieldCheck className="h-3.5 w-3.5 text-teal-dark" />
                      <span className="text-[11px]">Secure checkout</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-ink-muted">
                      <Lock className="h-3.5 w-3.5 text-teal-dark" />
                      <span className="text-[11px]">SSL encrypted</span>
                    </div>
                  </div>
                </div>
              </div>
            </motion.section>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
