"use client";

import React, { useState, useEffect, Suspense } from "react";
import { Beaker, Loader2 } from "lucide-react";
import PuramassCheckoutContent from "./PuramassCheckoutContent";
import { DEFAULT_FLAT_SHIPPING } from "@/lib/payments/puramass-settings";

// Branded loading state for the whole checkout route — a header shell plus a
// shimmering skeleton of the layout, so the page never flashes a bare spinner
// while the checkout-mode setting (and, downstream, the cart) resolve.
function CheckoutLoadingScreen() {
  return (
    <div className="min-h-screen bg-white">
      <div className="bg-white border-b border-line">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 py-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="relative w-10 h-10 bg-ink rounded-xl flex items-center justify-center">
                <Beaker className="w-5 h-5 text-white animate-pulse" />
              </div>
              <div className="flex flex-col">
                <span className="text-lg font-bold text-ink tracking-tight leading-none">
                  VYTA
                </span>
                <span className="text-[10px] text-teal-dark tracking-[0.15em] font-medium uppercase mt-0.5">
                  Secure Checkout
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2 px-4 py-2 bg-surface rounded-full border border-line">
              <Loader2 className="w-4 h-4 text-teal-dark animate-spin" />
              <span className="text-sm font-medium text-ink-muted">
                Loading checkout…
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="px-5 sm:px-8 py-8 md:py-12">
        <div className="max-w-6xl mx-auto">
          <div className="h-16 rounded-2xl border border-line bg-surface/60 animate-pulse mb-6" />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {[0, 1, 2].map((col) => (
              <div
                key={col}
                className="rounded-2xl border border-line bg-white p-5"
                style={{ animationDelay: `${col * 120}ms` }}
              >
                <div className="flex items-center gap-3 mb-4">
                  <div className="h-10 w-10 rounded-xl bg-line/40 animate-pulse" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3.5 w-1/2 rounded bg-line/40 animate-pulse" />
                    <div className="h-2.5 w-3/4 rounded bg-line/30 animate-pulse" />
                  </div>
                </div>
                <div className="space-y-3">
                  {[0, 1, 2].map((row) => (
                    <div
                      key={row}
                      className="h-11 rounded-lg bg-line/30 animate-pulse"
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// /checkout always hands the cart off to the Stealth Health hosted checkout
// (the old on-site e-Transfer checkout has been removed). The settings read is
// `no-store` because it carries the guest-checkout, shipping and promo flags
// the hosted checkout renders with. Every cart entry point (Proceed, Buy Now,
// cart drawer) navigates here.
function CheckoutRouter() {
  const [loaded, setLoaded] = useState(false);
  const [guestCheckoutEnabled, setGuestCheckoutEnabled] = useState(true);
  const [shippingRatesEnabled, setShippingRatesEnabled] = useState(false);
  const [addonsEnabled, setAddonsEnabled] = useState(true);
  const [verifyNoticeEnabled, setVerifyNoticeEnabled] = useState(true);
  const [flatShipping, setFlatShipping] = useState(DEFAULT_FLAT_SHIPPING);
  const [freeShipping, setFreeShipping] = useState({ active: false, threshold: 0 });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/settings", { cache: "no-store" });
        const json = await res.json();
        const s = json?.settings ?? {};
        if (cancelled) return;
        setGuestCheckoutEnabled(s.guest_checkout_enabled ?? true);
        setShippingRatesEnabled(!!s.puramass_shipping_rates_enabled);
        setAddonsEnabled(s.checkout_addons_enabled ?? true);
        setVerifyNoticeEnabled(s.checkout_verify_notice_enabled ?? true);
        // `??` + a finite check, not `||`: a saved fee of 0 is a real setting
        // (free flat shipping), not a missing one.
        const flat = Number(s.puramass_flat_shipping ?? DEFAULT_FLAT_SHIPPING);
        setFlatShipping(Number.isFinite(flat) && flat >= 0 ? flat : DEFAULT_FLAT_SHIPPING);
        setFreeShipping({
          active: !!s.puramass_free_shipping_active,
          threshold: Number(s.puramass_free_shipping_threshold) || 0,
        });
      } catch {
        // Fall through with the defaults above.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!loaded) {
    return <CheckoutLoadingScreen />;
  }

  return (
    <PuramassCheckoutContent
      guestCheckoutEnabled={guestCheckoutEnabled}
      shippingRatesEnabled={shippingRatesEnabled}
      addonsEnabled={addonsEnabled}
      verifyNoticeEnabled={verifyNoticeEnabled}
      flatShipping={flatShipping}
      freeShippingActive={freeShipping.active}
      freeShippingThreshold={freeShipping.threshold}
    />
  );
}

export default function CheckoutPage() {
  return (
    <Suspense fallback={<CheckoutLoadingScreen />}>
      <CheckoutRouter />
    </Suspense>
  );
}
