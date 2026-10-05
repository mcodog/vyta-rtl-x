'use client';

import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { ShoppingCart, ArrowLeft, Check, Shield, Award, Beaker, BadgeCheck, FlaskConical, FileText, X, ChevronRight, Truck } from 'lucide-react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import Navigation from '@/components/Navigation';
import Footer from '@/components/Footer';
import { useCart } from '@/contexts/CartContext';
import { useToast } from '@/contexts/ToastContext';
import { siteConfig } from '@/lib/config';
import {
  packOptionsFor, packsInStock, round2, vialPriceFor, vialsPerBoxOf,
  type ResolvedPackOption,
} from '@/lib/pricing';
import { trackActivity } from '@/lib/customer/activity';
import { trackViewItem } from '@/lib/analytics/ecommerce';
import { productPath } from '@/lib/products/url';
import { parseBenefits } from '@/lib/products/benefits';
import { renderInline } from '@/components/content/RichText';
import ProductInfoTabs from '@/components/product/ProductInfoTabs';
import ProductReviews from '@/components/product/ProductReviews';

interface Product {
  id: string;
  name: string;
  slug: string;
  url_slug?: string | null;
  category: string;
  description: string;
  description_short: string | null;
  benefits: string | null;
  mechanism: string | null;
  price: number;
  vial_price: number | null;
  vials_per_box: number | null;
  /** Pack quantities this product is sold in. See lib/pricing.ts. */
  pack_sizes?: number[] | null;
  /** Per-pack label / price / compare-at, when an operator has set any. */
  pack_options?: unknown;
  strength: string;
  purity: string;
  form: string;
  stock_quantity: number;
  active: boolean;
  image_url: string | null;
  box_image_url: string | null;
  coa_url: string[] | null;
}

/**
 * The pack the picker opens on, when the product is sold in it and it is in
 * stock. Everything else — a product without a 3-pack, a 3-pack with too few
 * vials on hand — falls back to the first pack the customer could buy.
 */
const DEFAULT_PACK_SIZE = 3;

/** The four assurances under the hero image: icon over label over subtitle. */
const HERO_ASSURANCES = [
  { icon: BadgeCheck, title: '99% Purity', subtitle: 'Third party tested' },
  { icon: Award, title: 'GMP Certified', subtitle: 'Good Manufacturing' },
  { icon: FileText, title: 'COA Available', subtitle: 'Certificate of Analysis' },
  { icon: Truck, title: 'Ships from Canada', subtitle: 'Fast & Discreet' },
];

/** The one-line reassurances immediately under Add to Cart. */
const CTA_ASSURANCES = [
  { icon: BadgeCheck, label: '99% Purity' },
  { icon: FlaskConical, label: 'Third-Party Tested' },
  { icon: FileText, label: 'COA Available' },
  { icon: Truck, label: 'Ships from Canada' },
];

/**
 * Keep the volatile fields fresh on a cached page.
 *
 * The route is statically generated and revalidated every 5 minutes, which is
 * what makes it cheap to serve and fast for a crawler — but it also means the
 * stock count baked into the HTML can be up to 5 minutes old, and stock is what
 * caps the quantity picker and the add-to-cart button. So the server render is
 * used for the first paint (and is what Google indexes), then this re-reads the
 * few fields that move and merges them in.
 *
 * Only stock, pricing and the active flag: the copy, images and specs change
 * through a deploy or an admin edit, where 5 minutes of staleness is fine.
 */
function useLiveProduct(initial: Product): Product {
  const [live, setLive] = useState<Product>(initial);

  // A related-product navigation swaps `initial` without unmounting.
  useEffect(() => {
    setLive(initial);
  }, [initial]);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from('products')
      .select('stock_quantity, price, vial_price, pack_options, active')
      .eq('id', initial.id)
      .maybeSingle()
      .then(({ data, error }) => {
        // A failed refresh is not an error state: the server-rendered values
        // are still correct enough to shop with, and checkout re-checks stock
        // against the database before it takes an order.
        if (cancelled || error || !data) return;
        setLive((current) => ({ ...current, ...data }));
      });
    return () => {
      cancelled = true;
    };
  }, [initial.id]);

  return live;
}

export interface ProductDetailClientProps {
  /** Resolved server-side by app/products/[slug]/page.tsx. Never null: the
   *  route 404s before rendering, so this component has no loading, error or
   *  not-found state to handle. */
  product: Product;
  relatedProducts: Product[];
  batWater: Product | null;
  /** Admin → Settings: the assurance strip under the hero image. */
  showTrustBadges?: boolean;
  /** Admin → Settings: the Customer Reviews section. */
  showReviews?: boolean;
  /** Admin → Settings: the Purity / Strength / Form tiles. */
  showSpecs?: boolean;
  /** Admin → Settings: the Key Research Benefits list. */
  showBenefits?: boolean;
  /** Admin → Settings: the Quality Certifications panel. */
  showCertifications?: boolean;
}

export default function ProductDetailClient({
  product: serverProduct,
  relatedProducts,
  batWater,
  showTrustBadges = true,
  showReviews = true,
  showSpecs = true,
  showBenefits = true,
  showCertifications = true,
}: ProductDetailClientProps) {
  // Everything below reads `product`; the server render is the first paint and
  // the volatile fields are refreshed in place. See useLiveProduct above.
  const product = useLiveProduct(serverProduct);
  const [showCoaModal, setShowCoaModal] = useState(false);
  const [activeCoa, setActiveCoa] = useState<string | null>(null);
  const { addItem, flyToCart } = useCart();
  const toast = useToast();
  const heroImageRef = useRef<HTMLDivElement>(null);
  /** The pack the customer is currently looking at. Null until the effect
   *  below picks the first buyable pack. */
  const [packSize, setPackSize] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);

  // The product itself is server-rendered, so all that is left here is the
  // view tracking that has to run in the browser: the customer activity log
  // and the GA4 `view_item` event. Keyed on product.id, so navigating between
  // related products (which does not unmount this component) re-fires both.
  useEffect(() => {
    trackActivity({ type: 'view', productId: product.id, productName: product.name });
    // Priced per vial to match the headline price on the page (the case price
    // is a multiple of it).
    trackViewItem({
      item_id: product.id,
      item_name: product.name,
      item_variant: 'Vial',
      item_category: product.category,
      price: vialPriceFor(product),
      quantity: 1,
    });
    // Keyed on the id, not the object: useLiveProduct swaps in a new object
    // when the stock refresh lands, and that must not count as a second view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.id]);

  // The packs this product is sold in, each already carrying its label, price
  // and compare-at.
  const packs: ResolvedPackOption[] = packOptionsFor(product);
  const capFor = (size: number) => packsInStock(product.stock_quantity, size);
  const selectedPack =
    packs.find((option) => option.size === packSize) ?? packs[0] ?? null;
  // A multi-vial pack ships as a case, so the picker swaps the hero over to the
  // case photo. Single vials — and products with no case photo on file — keep
  // the vial shot.
  const heroImage =
    (selectedPack && selectedPack.size > 1 ? product.box_image_url : null) ??
    product.image_url ??
    null;

  // Open on the 3-vial pack — the one we want a customer landing on — and fall
  // back to the first pack they could actually buy, so the page never lands on
  // a sold-out option or on a pack this product isn't sold in. Re-runs when the
  // product changes (a related product navigates here without unmounting).
  useEffect(() => {
    if (packs.length === 0) return;
    const buyable = (option: ResolvedPackOption) => capFor(option.size) >= 1;
    const opening =
      packs.find((option) => option.size === DEFAULT_PACK_SIZE && buyable(option)) ??
      packs.find(buyable) ??
      packs[0];
    setPackSize(opening.size);
    setQty(1);
    setAdded(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.id]);

  const selectPack = (size: number) => {
    setPackSize(size);
    setQty(1); // each pack has its own stock ceiling
    setAdded(false);
  };

  /** Adds the chosen pack straight to the cart — no modal in between. */
  const handleAddToCart = () => {
    if (!product || !selectedPack) return;
    const cap = capFor(selectedPack.size);
    if (cap < 1) {
      toast.error(
        selectedPack.size > 1
          ? `Not enough stock for a ${selectedPack.label.toLowerCase()}.`
          : 'Out of stock.',
      );
      return;
    }

    let anyAdded = false;
    for (let i = 0; i < qty; i++) {
      const ok = addItem({
        productId: product.id,
        unit: selectedPack.size > 1 ? 'case' : 'vial',
        packSize: selectedPack.size,
        vialsPerBox: vialsPerBoxOf(product.vials_per_box),
        name: product.name,
        price: selectedPack.price,
        strength: product.strength ?? '',
        image_url: product.image_url || undefined,
        stock_quantity: cap,
      });
      anyAdded = anyAdded || ok;
    }

    if (!anyAdded) {
      toast.error(`Only ${cap} in stock — that's all we have.`);
      return;
    }
    flyToCart(heroImageRef.current, { image_url: heroImage || undefined });
    setAdded(true);
    setTimeout(() => setAdded(false), 1800);
  };

  // ---- Display pricing ----
  // The headline quotes the pack the customer has SELECTED, not a fixed unit:
  // the pack buttons below are the variant picker, so the big number has to
  // follow them. `packOptionsFor` resolves each pack's label, price and
  // compare-at (see lib/pricing.ts) — falling back, for a product nobody has
  // configured, to the historical single-vial + full-case pair at vial × size.
  const vialUnitPrice = vialPriceFor(product);
  const benefitPoints = parseBenefits(product.benefits);
  const headlinePrice = selectedPack?.price ?? vialUnitPrice;
  const headlineCompareAt = selectedPack?.compareAt ?? null;
  const selectedCap = selectedPack ? capFor(selectedPack.size) : 0;
  const lineTotal = round2(headlinePrice * qty);

  return (
    <main className="min-h-screen bg-white">
      <Navigation />

      {/* Hero Header */}
      <section className="relative bg-white border-b border-line overflow-hidden">
        <div className="absolute inset-0 opacity-[0.02]">
          <svg className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <pattern id="molecular-grid" x="0" y="0" width="60" height="60" patternUnits="userSpaceOnUse">
                <circle cx="30" cy="30" r="1.5" fill="#07203A" />
                <circle cx="0" cy="0" r="1" fill="#07203A" />
                <circle cx="60" cy="0" r="1" fill="#07203A" />
                <circle cx="0" cy="60" r="1" fill="#07203A" />
                <circle cx="60" cy="60" r="1" fill="#07203A" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#molecular-grid)" />
          </svg>
        </div>

        <div className="relative max-w-7xl mx-auto px-4 sm:px-8 lg:px-12 pt-28 pb-6 sm:pb-8">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <Link
              href="/products"
              className="inline-flex items-center gap-2 text-ink-muted hover:text-ink transition-colors text-sm mb-3 sm:mb-4"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Back to Products</span>
            </Link>
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <span className="text-[10px] sm:text-xs font-medium text-ink bg-surface px-2 sm:px-3 py-1 rounded-full border border-line">
                {product.category}
              </span>
              <span className="text-[10px] sm:text-xs font-semibold text-teal-dark bg-teal-50 px-2 sm:px-3 py-1 rounded-full border border-teal/20">
                {product.purity} Purity
              </span>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Product Detail */}
      <section className="py-6 sm:py-10 md:py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-8 lg:px-12">
          <div className="grid md:grid-cols-2 gap-6 sm:gap-8 md:gap-12 mb-10 sm:mb-16">
            {/* Product Image */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
            >
              <div
                ref={heroImageRef}
                data-product-hero-image
                className="bg-surface rounded-xl sm:rounded-2xl overflow-hidden border border-line relative"
              >
                <div className="aspect-square flex items-center justify-center p-4 sm:p-8">
                  {heroImage ? (
                    <img
                      key={heroImage}
                      src={heroImage}
                      alt={
                        selectedPack && selectedPack.size > 1
                          ? `${product.name} — ${selectedPack.label.toLowerCase()}`
                          : product.name
                      }
                      className={`h-full w-full object-contain ${product.stock_quantity === 0 ? 'opacity-40' : ''}`}
                    />
                  ) : (
                    <Beaker className="w-16 sm:w-24 h-16 sm:h-24 text-line" />
                  )}
                </div>
                {product.stock_quantity === 0 && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <span className="bg-black/65 text-white text-xs sm:text-sm font-semibold px-4 py-1.5 rounded-full tracking-wide">
                      Out of Stock
                    </span>
                  </div>
                )}
              </div>

              {/* Assurance strip under the hero shot. The lucide glyphs are
                  drawn without a ring of their own, so the ring here is ours:
                  Vital Blue on the border and on the icon. */}
              {showTrustBadges && (
                <div className="mt-4 sm:mt-6 grid grid-cols-4 gap-2 sm:gap-3">
                  {HERO_ASSURANCES.map(({ icon: Icon, title, subtitle }) => (
                    <div key={title} className="flex flex-col items-center text-center">
                      <span className="flex h-10 w-10 sm:h-12 sm:w-12 items-center justify-center rounded-full border border-teal-dark/40 text-teal-dark">
                        <Icon className="h-4 w-4 sm:h-5 sm:w-5" />
                      </span>
                      <p className="mt-2 text-[11px] sm:text-xs font-semibold leading-tight text-ink">
                        {title}
                      </p>
                      <p className="mt-0.5 text-[10px] sm:text-[11px] font-light leading-tight text-ink-muted">
                        {subtitle}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </motion.div>

            {/* Product Info */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.1 }}
              className="flex flex-col"
            >
              <p className="font-mono text-[10px] sm:text-[11px] font-bold uppercase tracking-[0.18em] text-teal-dark mb-1.5 sm:mb-2">
                Research Grade Peptide Blend
              </p>
              <h1 className="text-xl sm:text-2xl md:text-3xl lg:text-4xl font-bold text-ink mb-3 sm:mb-4 tracking-tight">
                {product.name}
              </h1>

              {/* Product Specs */}
              {showSpecs && (
                <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-4 sm:mb-6">
                  <div className="bg-surface rounded-lg sm:rounded-xl p-3 sm:p-4 text-center border border-line">
                    <div className="text-[9px] sm:text-[10px] text-ink-muted uppercase tracking-wider mb-1">Purity</div>
                    <div className="text-teal-dark font-bold text-sm sm:text-base">{product.purity}</div>
                  </div>
                  <div className="bg-surface rounded-lg sm:rounded-xl p-3 sm:p-4 text-center border border-line">
                    <div className="text-[9px] sm:text-[10px] text-ink-muted uppercase tracking-wider mb-1">Strength</div>
                    <div className="text-ink font-bold text-sm sm:text-base">{product.strength}</div>
                  </div>
                  <div className="bg-surface rounded-lg sm:rounded-xl p-3 sm:p-4 text-center border border-line">
                    <div className="text-[9px] sm:text-[10px] text-ink-muted uppercase tracking-wider mb-1">Form</div>
                    <div className="text-ink font-bold text-sm sm:text-base">{product.form}</div>
                  </div>
                </div>
              )}

              {/* COA Button */}
              {product.coa_url && product.coa_url.length > 0 && (
                <button
                  onClick={() => { setActiveCoa(product.coa_url![0]); setShowCoaModal(true); }}
                  className="w-full mb-4 sm:mb-6 flex items-center justify-between gap-3 px-4 sm:px-5 py-3 sm:py-4 rounded-xl bg-teal-dark text-white font-semibold hover:bg-teal/90 active:scale-[0.98] transition-all shadow-md shadow-teal/30 group"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex-shrink-0 bg-white/20 rounded-lg p-1.5">
                      <FileText className="w-4 h-4 sm:w-5 sm:h-5" />
                    </div>
                    <div className="text-left">
                      <div className="text-xs sm:text-sm font-bold uppercase tracking-wide leading-tight">Certificate of Analysis</div>
                      <div className="text-[10px] sm:text-xs text-white/75 font-normal">Third-party lab verified · PPB Analytical</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs font-semibold bg-white/20 rounded-lg px-2.5 py-1 group-hover:bg-white/30 transition-colors">
                    View{product.coa_url.length > 1 ? ` (${product.coa_url.length})` : ''}
                    <ChevronRight className="w-3.5 h-3.5" />
                  </div>
                </button>
              )}

              {/* Benefits — one point per line in the column (see
                  lib/products/benefits.ts), with a legacy comma-separated row
                  still read the way it always was. Each point goes through the
                  site's inline syntax, so a point can carry a bold phrase or a
                  link to the study behind it. */}
              {showBenefits && benefitPoints.length > 0 && (
                <div className="mb-4 sm:mb-6">
                  <h3 className="font-semibold text-ink mb-2 sm:mb-3 text-sm">Key Research Benefits</h3>
                  <ul className="space-y-1.5 sm:space-y-2">
                    {benefitPoints.map((benefit, idx) => (
                      <li key={idx} className="flex items-start gap-2">
                        <Check className="w-4 h-4 text-teal-dark flex-shrink-0 mt-0.5" />
                        <span className="text-ink-muted text-xs sm:text-sm">
                          {renderInline(benefit)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Pack picker, price and Add to Cart.
                  The packs are the variants: they are laid out on the page
                  itself so a customer can compare a 1, a 3 and a 10 — and see
                  what each saves — without opening anything. Picking one
                  updates the headline price and what the button adds. */}
              <div className="mt-auto pt-4 sm:pt-6 border-t border-line">
                {product.price === 0 ? (
                  <div className="mb-4 text-2xl sm:text-3xl md:text-4xl font-bold text-ink-muted">
                    N/A
                  </div>
                ) : (
                  <>
                    {packs.length > 1 && (
                      <div className="mb-4 sm:mb-5">
                        <div className="mb-2 flex items-baseline justify-between gap-2">
                          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                            Choose your pack
                          </p>
                          <span className="text-[11px] text-ink-muted tabular-nums">
                            ${vialUnitPrice.toFixed(2)} / vial at list price
                          </span>
                        </div>
                        {/* pt-2 leaves room for a pack's tag, which sits
                            proud of the button's top edge. */}
                        <div className="grid grid-cols-2 gap-2 pt-2 sm:grid-cols-4">
                          {packs.map((option) => {
                            const cap = capFor(option.size);
                            const soldOut = cap < 1;
                            const active = selectedPack?.size === option.size;
                            return (
                              <button
                                key={option.size}
                                type="button"
                                onClick={() => selectPack(option.size)}
                                disabled={soldOut}
                                aria-pressed={active}
                                className={`relative rounded-xl border p-2.5 text-left transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
                                  active
                                    ? 'border-ink bg-ink text-white shadow-sm'
                                    : 'border-line bg-surface text-ink hover:border-ink/40 hover:bg-white'
                                }`}
                              >
                                {/* Merchandising tag, set per pack in the admin
                                    (Products → Pack options & pricing → Tag). */}
                                {option.badge && !soldOut && (
                                  <span className="absolute -top-2 left-2 right-2 truncate rounded-full bg-teal-dark px-1.5 py-0.5 text-center text-[9px] font-bold uppercase tracking-wide text-white shadow-sm">
                                    {option.badge}
                                  </span>
                                )}
                                {active && (
                                  <span className="absolute right-1.5 top-1.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-white">
                                    <Check className="h-2.5 w-2.5 text-ink" />
                                  </span>
                                )}
                                <span className="block pr-4 text-[13px] font-semibold leading-tight">
                                  {option.label}
                                </span>
                                {soldOut ? (
                                  <span
                                    className={`block text-[10px] ${active ? 'text-white/70' : 'text-ink-muted'}`}
                                  >
                                    Not enough stock
                                  </span>
                                ) : (
                                  <>
                                    <span className="mt-0.5 block text-[13px] font-bold tabular-nums">
                                      ${option.price.toFixed(2)}
                                      {option.compareAt != null && (
                                        <span
                                          className={`ml-1 text-[10px] font-normal line-through ${
                                            active ? 'text-white/60' : 'text-ink-muted'
                                          }`}
                                        >
                                          ${option.compareAt.toFixed(2)}
                                        </span>
                                      )}
                                    </span>
                                    <span
                                      className={`block text-[10px] tabular-nums ${
                                        active ? 'text-white/70' : 'text-ink-muted'
                                      }`}
                                    >
                                      ${option.perVialPrice.toFixed(2)} / vial
                                    </span>
                                    {option.savings > 0 && (
                                      <span
                                        className={`mt-1 inline-block rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${
                                          active
                                            ? 'bg-white/20 text-white'
                                            : 'bg-emerald-50 text-emerald-700'
                                        }`}
                                      >
                                        Save ${option.savings.toFixed(2)}
                                        {option.savingsPercent > 0 && ` (${option.savingsPercent}%)`}
                                      </span>
                                    )}
                                  </>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Headline — the selected pack's own price */}
                    <div className="mb-4 sm:mb-5">
                      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                        <span className="text-2xl sm:text-3xl md:text-4xl font-bold text-ink tabular-nums">
                          ${headlinePrice.toFixed(2)}
                        </span>
                        {headlineCompareAt != null && (
                          <span className="text-base sm:text-lg font-medium text-ink-muted line-through tabular-nums">
                            ${headlineCompareAt.toFixed(2)}
                          </span>
                        )}
                        {/* The saving takes the slot the pack label used to
                            hold — the pack is already named on the button the
                            customer just pressed, and on Add to Cart below. */}
                        <span className="text-sm sm:text-base font-medium text-ink-muted">
                          CAD
                        </span>
                        {selectedPack && selectedPack.savings > 0 && (
                          <span className="text-sm sm:text-base font-semibold text-emerald-600 tabular-nums">
                            Save ${selectedPack.savings.toFixed(2)}
                            {selectedPack.savingsPercent > 0 &&
                              ` (${selectedPack.savingsPercent}%)`}
                          </span>
                        )}
                      </div>
                      {selectedPack && (
                        <p className="mt-1 text-xs sm:text-sm text-ink-muted tabular-nums">
                          ${selectedPack.perVialPrice.toFixed(2)} per vial
                          {selectedPack.size > 1 && ` · ${selectedPack.size} vials`}
                        </p>
                      )}
                    </div>

                    {/* Quantity — how many of the selected pack */}
                    {siteConfig.ecommerceEnabled && selectedCap >= 1 && (
                      <div className="mb-3 flex items-center gap-3">
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                          Quantity
                        </span>
                        <div className="flex items-center overflow-hidden rounded-xl border border-line bg-surface">
                          <button
                            type="button"
                            onClick={() => setQty((q) => Math.max(1, q - 1))}
                            disabled={qty <= 1}
                            className="px-3.5 py-2 font-medium text-ink transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
                            aria-label="Decrease quantity"
                          >
                            −
                          </button>
                          <span className="min-w-[2.5rem] text-center font-semibold tabular-nums">
                            {qty}
                          </span>
                          <button
                            type="button"
                            onClick={() => setQty((q) => Math.min(selectedCap, q + 1))}
                            disabled={qty >= selectedCap}
                            className="px-3.5 py-2 font-medium text-ink transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
                            aria-label="Increase quantity"
                          >
                            +
                          </button>
                        </div>
                        {qty > 1 && (
                          <span className="text-sm font-semibold text-ink tabular-nums">
                            ${lineTotal.toFixed(2)} total
                          </span>
                        )}
                      </div>
                    )}
                  </>
                )}

                <div className="flex items-stretch gap-3">
                  {siteConfig.ecommerceEnabled && (
                    product.stock_quantity === 0 ? (
                      <button
                        disabled
                        className="flex-1 font-semibold py-3 sm:py-4 rounded-xl bg-surface text-red-600 cursor-not-allowed flex items-center justify-center gap-2 text-sm border border-red-200"
                      >
                        <span>Out of Stock</span>
                      </button>
                    ) : product.price === 0 ? (
                      <button
                        disabled
                        className="flex-1 font-semibold py-3 sm:py-4 rounded-xl bg-surface text-ink-muted cursor-not-allowed flex items-center justify-center gap-2 text-sm border border-line"
                      >
                        <span>Currently Unavailable</span>
                      </button>
                    ) : (
                      <button
                        onClick={handleAddToCart}
                        disabled={selectedCap < 1}
                        className={`flex-1 font-semibold py-3 sm:py-4 rounded-xl transition-all duration-200 flex items-center justify-center gap-2 text-sm disabled:cursor-not-allowed disabled:opacity-50 ${
                          added ? 'bg-emerald-500 text-white' : 'bg-ink hover:bg-ink/90 text-white'
                        }`}
                      >
                        {added ? (
                          <>
                            <Check className="w-5 h-5" />
                            <span>Added to cart</span>
                          </>
                        ) : (
                          <>
                            <ShoppingCart className="w-5 h-5" />
                            <span>
                              Add to Cart
                              {selectedPack ? ` · ${selectedPack.label}` : ''}
                              {` - $${lineTotal.toFixed(2)}`}
                            </span>
                          </>
                        )}
                      </button>
                    )
                  )}

                  {/* Lab results button hidden for now — the certificate is
                      still reachable from the COA button above and from the
                      Quality & Testing tab. */}
                </div>

                {/* What every order carries, right under the button that
                    places it. Separated from the CTA by a hairline. */}
                <div className="mt-4 sm:mt-5 pt-4 sm:pt-5 border-t border-line">
                  <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 sm:grid-cols-4">
                    {CTA_ASSURANCES.map(({ icon: Icon, label }) => (
                      <div key={label} className="flex items-center gap-1.5">
                        <Icon className="h-4 w-4 flex-shrink-0 text-teal-dark" />
                        <span className="text-[11px] sm:text-xs font-medium leading-tight text-ink">
                          {label}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </motion.div>
          </div>

          {/* The reading half of the page: description, applications, testing,
              shipping and FAQs, in a full-width tab block below the buy
              controls rather than squeezed into the right-hand column. The
              mechanism copy lives in Research Applications. */}
          <ProductInfoTabs
            product={product}
            coaCount={product.coa_url?.length ?? 0}
            onViewCoa={() => {
              const first = product.coa_url?.[0];
              if (!first) return;
              setActiveCoa(first);
              setShowCoaModal(true);
            }}
          />

          {/* What other buyers made of it. Only customers with this product
              on a paid order can write here — /api/reviews checks the orders
              before it will take one. */}
          {showReviews && (
            <ProductReviews productId={product.id} productName={product.name} />
          )}

          {/* Essential Add-on - Bacteriostatic Water */}
          {product.slug !== 'bacteriostatic-water-30ml' && batWater && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.25 }}
              className="mb-8 sm:mb-10"
            >
              <div className="bg-ink rounded-xl sm:rounded-2xl p-4 sm:p-6 text-white">
                <div className="flex flex-col sm:flex-row items-center gap-4 sm:gap-6">
                  <div className="w-16 sm:w-20 h-16 sm:h-20 bg-white rounded-lg sm:rounded-xl flex items-center justify-center flex-shrink-0 overflow-hidden">
                    {batWater.image_url ? (
                      <img
                        src={batWater.image_url}
                        alt={batWater.name}
                        className="w-full h-full object-contain p-1.5 sm:p-2"
                      />
                    ) : (
                      <img
                        src="/images/products/Bacteriostatic Water 30ML.png"
                        alt={batWater.name}
                        className="w-full h-full object-contain p-1.5 sm:p-2"
                      />
                    )}
                  </div>
                  <div className="flex-1 text-center sm:text-left">
                    <div className="text-[10px] sm:text-xs font-medium text-teal-light mb-0.5 sm:mb-1">You&apos;ll also need</div>
                    <h3 className="text-base sm:text-lg font-bold mb-0.5 sm:mb-1">{batWater.name}</h3>
                    <p className="text-white/60 text-xs sm:text-sm">
                      Essential for reconstituting lyophilized peptides.
                    </p>
                  </div>
                  <div className="flex flex-col items-center gap-2 sm:gap-3 flex-shrink-0">
                    <div className="text-xl sm:text-2xl font-bold tabular-nums">${batWater.price.toFixed(2)}</div>
                    <Link
                      href={productPath(batWater)}
                      className="bg-white hover:bg-white/90 text-ink font-semibold px-4 sm:px-6 py-2 sm:py-2.5 rounded-lg transition-all text-xs sm:text-sm"
                    >
                      View Product
                    </Link>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {/* Quality Certifications */}
          {showCertifications && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
              className="mb-10 sm:mb-16"
            >
              <div className="bg-ink rounded-xl sm:rounded-2xl p-4 sm:p-6 md:p-8">
                <h2 className="text-base sm:text-lg md:text-xl font-bold text-white mb-4 sm:mb-6 text-center">Quality Certifications</h2>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-4">
                  <div className="flex flex-col items-center text-center p-3 sm:p-4 bg-white/5 rounded-lg sm:rounded-xl border border-white/10">
                    <div className="w-10 sm:w-12 h-10 sm:h-12 bg-teal/20 rounded-lg sm:rounded-xl flex items-center justify-center mb-2 sm:mb-3">
                      <Beaker className="w-5 sm:w-6 h-5 sm:h-6 text-teal-light" />
                    </div>
                    <h3 className="font-semibold text-white mb-0.5 sm:mb-1 text-xs sm:text-sm">99%+ Purity</h3>
                    <p className="text-[10px] sm:text-xs text-white/50">Third-party verified</p>
                  </div>
                  <div className="flex flex-col items-center text-center p-3 sm:p-4 bg-white/5 rounded-lg sm:rounded-xl border border-white/10">
                    <div className="w-10 sm:w-12 h-10 sm:h-12 bg-white/10 rounded-lg sm:rounded-xl flex items-center justify-center mb-2 sm:mb-3">
                      <Award className="w-5 sm:w-6 h-5 sm:h-6 text-white" />
                    </div>
                    <h3 className="font-semibold text-white mb-0.5 sm:mb-1 text-xs sm:text-sm">GMP Certified</h3>
                    <p className="text-[10px] sm:text-xs text-white/50">Good Manufacturing</p>
                  </div>
                  <div className="flex flex-col items-center text-center p-3 sm:p-4 bg-white/5 rounded-lg sm:rounded-xl border border-white/10">
                    <div className="w-10 sm:w-12 h-10 sm:h-12 bg-white/10 rounded-lg sm:rounded-xl flex items-center justify-center mb-2 sm:mb-3">
                      <BadgeCheck className="w-5 sm:w-6 h-5 sm:h-6 text-white" />
                    </div>
                    <h3 className="font-semibold text-white mb-0.5 sm:mb-1 text-xs sm:text-sm">ISO Compliant</h3>
                    <p className="text-[10px] sm:text-xs text-white/50">Intl standards</p>
                  </div>
                  <div className="flex flex-col items-center text-center p-3 sm:p-4 bg-white/5 rounded-lg sm:rounded-xl border border-white/10">
                    <div className="w-10 sm:w-12 h-10 sm:h-12 bg-white/10 rounded-lg sm:rounded-xl flex items-center justify-center mb-2 sm:mb-3">
                      <Shield className="w-5 sm:w-6 h-5 sm:h-6 text-white" />
                    </div>
                    <h3 className="font-semibold text-white mb-0.5 sm:mb-1 text-xs sm:text-sm">COA Available</h3>
                    <p className="text-[10px] sm:text-xs text-white/50">Certificate of Analysis</p>
                  </div>
                </div>
                <div className="mt-4 sm:mt-6 pt-4 sm:pt-6 border-t border-white/10 text-center">
                  <p className="text-xs sm:text-sm text-white/50">
                    <span className="font-medium text-white/70">For Research Purposes Only</span> - Not for human consumption.
                  </p>
                </div>
              </div>
            </motion.div>
          )}

          {/* Related Products */}
          {relatedProducts.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.35 }}
            >
              <h2 className="text-lg sm:text-xl md:text-2xl font-bold text-ink mb-4 sm:mb-6">Related Products</h2>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-4 md:gap-5">
                {relatedProducts.map((relProduct) => (
                  <Link key={relProduct.id} href={productPath(relProduct)}>
                    <div className="group bg-white rounded-lg sm:rounded-xl overflow-hidden border border-line hover:shadow-lg hover:shadow-ink/5 hover:border-ink/20 transition-all">
                      <div className="relative bg-surface aspect-square flex items-center justify-center p-2 sm:p-4">
                        {relProduct.image_url ? (
                          <img
                            src={relProduct.image_url}
                            alt={relProduct.name}
                            className={`h-full w-full object-contain group-hover:scale-105 transition-transform duration-300 ${relProduct.stock_quantity === 0 ? 'opacity-50' : ''}`}
                          />
                        ) : (
                          <Beaker className="w-8 sm:w-12 h-8 sm:h-12 text-line" />
                        )}
                        {/* Out of stock badge — don't let shoppers click into a dead end blind */}
                        {relProduct.stock_quantity === 0 && (
                          <div className="absolute inset-0 flex items-center justify-center">
                            <span className="bg-black/60 text-white text-[9px] sm:text-[10px] font-semibold px-2.5 sm:px-3 py-0.5 sm:py-1 rounded-full tracking-wide">
                              Out of Stock
                            </span>
                          </div>
                        )}
                      </div>
                      <div className="p-2.5 sm:p-4">
                        <p className="text-[9px] sm:text-[10px] text-ink-muted uppercase tracking-wider mb-0.5 sm:mb-1">{relProduct.strength}</p>
                        <h3 className="font-semibold text-ink group-hover:text-ink-muted transition-colors mb-1.5 sm:mb-2 line-clamp-1 text-xs sm:text-sm">
                          {relProduct.name}
                        </h3>
                        <div className="flex justify-between items-center gap-2">
                          {relProduct.price === 0 ? (
                            <span className="text-ink-muted font-bold text-sm">N/A</span>
                          ) : (
                            <span className="text-ink font-bold tabular-nums text-sm sm:text-base">
                              ${vialPriceFor(relProduct).toFixed(2)}{' '}
                              <span className="text-[9px] font-medium text-ink-muted">/ vial</span>
                            </span>
                          )}
                          {relProduct.stock_quantity === 0 && (
                            <span className="text-[10px] text-red-500 font-medium">Sold out</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </motion.div>
          )}
        </div>
      </section>

      <Footer />

      {/* COA Modal */}
      {showCoaModal && product.coa_url && product.coa_url.length > 0 && activeCoa && (
        <div
          className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
          onClick={() => setShowCoaModal(false)}
        >
          <div
            className="bg-white rounded-2xl w-full max-w-3xl max-h-[90vh] flex flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-line flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-teal/10 rounded-lg flex items-center justify-center">
                  <FileText className="w-4 h-4 text-teal-dark" />
                </div>
                <div>
                  <p className="text-[10px] text-ink-muted uppercase tracking-wider font-medium">Certificate of Analysis</p>
                  <p className="text-sm font-semibold text-ink leading-tight">{product.name}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={activeCoa}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-teal-dark hover:underline font-medium"
                >
                  Open in new tab
                </a>
                <button
                  onClick={() => setShowCoaModal(false)}
                  className="p-2 hover:bg-surface rounded-lg transition-colors text-ink-muted hover:text-ink"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Tab selector — only shown when multiple COAs */}
            {product.coa_url.length > 1 && (
              <div className="flex gap-1 px-5 pt-3 pb-0 flex-shrink-0 overflow-x-auto">
                {product.coa_url.map((url, idx) => (
                  <button
                    key={url}
                    onClick={() => setActiveCoa(url)}
                    className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      activeCoa === url
                        ? 'bg-teal/10 text-teal-dark border border-teal/25'
                        : 'text-ink-muted hover:text-ink hover:bg-surface'
                    }`}
                  >
                    COA {idx + 1}
                  </button>
                ))}
              </div>
            )}

            {/* PDF Viewer */}
            <div className="flex-1 overflow-hidden rounded-b-2xl min-h-0 mt-3">
              {/* Desktop: inline PDF preview */}
              <iframe
                key={activeCoa}
                src={`${activeCoa}#toolbar=0&navpanes=0`}
                className="w-full h-full hidden sm:block"
                style={{ minHeight: '60vh' }}
                title={`Certificate of Analysis — ${product.name}`}
              />
              {/* Mobile: inline PDF iframes are unreliable on iOS/Android, so
                  offer a prominent button that always opens the PDF directly. */}
              <div className="sm:hidden flex flex-col items-center justify-center text-center gap-4 px-6 py-10">
                <div className="w-14 h-14 bg-teal/10 rounded-2xl flex items-center justify-center">
                  <FileText className="w-7 h-7 text-teal-dark" />
                </div>
                <p className="text-sm text-ink-muted leading-relaxed">
                  Third-party lab certificate for {product.name}.
                </p>
                <a
                  href={activeCoa}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-2 w-full px-5 py-3.5 rounded-xl bg-teal-dark text-white font-semibold hover:bg-teal/90 active:scale-[0.98] transition-all shadow-md shadow-teal/30"
                >
                  <FileText className="w-4 h-4" />
                  Open Certificate of Analysis (PDF)
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
