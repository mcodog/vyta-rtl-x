'use client';

import React, { useRef } from 'react';
import { motion, useReducedMotion, useScroll, useTransform } from 'framer-motion';
import Link from 'next/link';
import { ArrowRight, FileText, FlaskConical, ShieldCheck, Truck } from 'lucide-react';
import { useSiteConfig } from '@/contexts/SiteConfigContext';
import MapleLeaf, { MAPLE_RED } from '@/components/icons/MapleLeaf';

// ─────────────────────────────────────────────────────────────────────────────
// HERO MEDIA
//
// One still fills the whole hero — there is no background clip any more, on any
// screen size. The image is set in Admin → Branding & Tracking
// (`site_settings.hero_image_url`), so swapping the hero for a new render is an
// upload, not a deploy; the constant below is only the fallback for a store
// that has never set one, and for the first paint before the config has loaded.
//
// docs/hero-media-prompt.md carries the generation brief.
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_HERO_IMAGE = '/images/hero-desktop.webp';

// Portrait still for phones and tablets (below lg), where the landscape hero
// would be cropped to a sliver. Shipped with the site rather than admin-set.
const MOBILE_HERO_IMAGE = '/images/hero-mobile.webp';

// Film-grain texture overlay (inline SVG turbulence — no asset needed).
const GRAIN_TEXTURE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

/**
 * The frosted ground the copy is read on. It is translucent the whole way
 * across — never a solid plate — and from the 40% mark it thins out in small
 * steps until there is nothing left of it at the far edge.
 *
 * The hero image is brand art now rather than a still graded hard to Midnight
 * Navy (see `.hero-image-grade`), so these carry more white than they used to:
 * the ground has to hold navy type over whatever the uploaded image is, not
 * only over a dark one.
 *
 * The tint gradient alone would leave a hard edge where the blur stops, so the
 * same shape is repeated as a mask — `backdrop-filter` is clipped by the
 * element's own alpha, which is what makes the blur itself thin out with the
 * white rather than ending in a line.
 */
const BAND_TINT_X =
  'linear-gradient(90deg, rgba(255,255,255,0.88) 0%, rgba(255,255,255,0.84) 40%, rgba(255,255,255,0.7) 56%, rgba(255,255,255,0.46) 72%, rgba(255,255,255,0.22) 86%, rgba(255,255,255,0) 100%)';
const BAND_MASK_X =
  'linear-gradient(90deg, #000 0%, #000 40%, rgba(0,0,0,0.85) 56%, rgba(0,0,0,0.6) 72%, rgba(0,0,0,0.28) 86%, transparent 100%)';

// Stacked, the copy runs the full width, so the ground thins downward instead.
// It holds steady to just past the body copy, then clears in a short fade
// behind the button (which carries its own solid fill), so the vials in the
// portrait mobile still read through, undimmed, from there down. It carries
// less white than the desktop band so the portrait art shows behind the copy
// too.
const BAND_TINT_Y =
  'linear-gradient(180deg, rgba(255,255,255,0.56) 0%, rgba(255,255,255,0.5) 46%, rgba(255,255,255,0.18) 52%, rgba(255,255,255,0) 58%)';
const BAND_MASK_Y =
  'linear-gradient(180deg, #000 0%, #000 46%, rgba(0,0,0,0.4) 52%, transparent 58%)';

const TRUST_BADGES = [
  { icon: ShieldCheck, label: '99%+\nPurity Guaranteed' },
  { icon: FlaskConical, label: 'Third-Party\nTested' },
  { icon: FileText, label: 'COAs\nAvailable' },
  { icon: MapleLeaf, label: 'Proudly\nCanadian', accent: true },
  { icon: Truck, label: 'Free, Fast &\nDiscreet Shipping' },
];

export default function Hero() {
  const prefersReducedMotion = useReducedMotion();
  // Admin-set hero image, falling back to the shipped one. The provider seeds
  // from DEFAULT_SITE_CONFIG, so the first render is the fallback either way
  // and there is no hydration mismatch.
  const { config: siteSettings } = useSiteConfig();
  const heroImageUrl = siteSettings.hero_image_url ?? DEFAULT_HERO_IMAGE;

  const sectionRef = useRef<HTMLElement | null>(null);

  // Subtle parallax: the media drifts slower than the page while the content
  // eases upward and dissolves as the hero scrolls out.
  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ['start start', 'end start'],
  });
  const mediaY = useTransform(scrollYProgress, [0, 1], ['0%', '10%']);
  const contentY = useTransform(scrollYProgress, [0, 1], [0, 60]);
  const contentOpacity = useTransform(scrollYProgress, [0, 0.6], [1, 0]);

  return (
    <section
      ref={sectionRef}
      className="relative lg:min-h-svh flex flex-col overflow-hidden bg-ink"
    >
      {/* The frame the image and copy fill. On phones it is a full screen of its
          own, so the hero opens edge to edge and the badge strip waits below
          the fold; from lg up it goes static, so the layers below position
          against the section and the strip sits over the image's base. */}
      <div className="relative lg:static flex-1 flex flex-col min-h-svh lg:min-h-0">
        {/* Media layer — oversized vertically so the parallax drift never
            reveals an edge. */}
        <motion.div
          aria-hidden="true"
          style={prefersReducedMotion ? undefined : { y: mediaY }}
          className="absolute inset-x-0 -inset-y-[8%]"
        >
          {/* Below lg the hero stacks into a tall, narrow frame, so it gets its
              own portrait still, shown at full brightness; from lg up it is the
              admin-set image, settled by the grade. */}
          <picture>
            <source media="(max-width: 1023px)" srcSet={MOBILE_HERO_IMAGE} />
            <img
              src={heroImageUrl}
              alt=""
              className="absolute inset-0 w-full h-full object-cover object-[center_75%] lg:object-center lg:hero-image-grade"
            />
          </picture>
        </motion.div>

        {/* Film grain */}
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-[0.07] mix-blend-soft-light"
          style={{ backgroundImage: GRAIN_TEXTURE }}
        />

        {/* Scrims — the copy has the frosted band under it, so these only settle
            the media down behind the nav and the badge strip. Desktop only: on
            phones the portrait still is shown undimmed. */}
        <div aria-hidden="true" className="absolute inset-0 hidden lg:block bg-gradient-to-r from-ink/30 via-ink/20 to-ink/10" />
        <div aria-hidden="true" className="absolute inset-0 hidden lg:block bg-gradient-to-b from-ink/45 via-transparent to-ink/55" />

        {/* Frosted band — full height down the left, dissolving into the media
            before it reaches the middle. */}
        <motion.div
          aria-hidden="true"
          style={{
            backgroundImage: BAND_TINT_Y,
            maskImage: BAND_MASK_Y,
            WebkitMaskImage: BAND_MASK_Y,
            ...(prefersReducedMotion ? {} : { opacity: contentOpacity }),
          }}
          className="absolute inset-0 lg:hidden backdrop-blur-2xl"
        />
        <motion.div
          aria-hidden="true"
          style={{
            backgroundImage: BAND_TINT_X,
            maskImage: BAND_MASK_X,
            WebkitMaskImage: BAND_MASK_X,
            ...(prefersReducedMotion ? {} : { opacity: contentOpacity }),
          }}
          className="absolute inset-y-0 left-0 hidden lg:block w-[78%] xl:w-[74%] backdrop-blur-2xl"
        />

        {/* Content — centred, but below lg the deep bottom padding lifts the
            copy into the upper part of the screen, clear of the vials. */}
        <div className="relative flex-1 flex items-center w-full">
          <motion.div
            style={prefersReducedMotion ? undefined : { y: contentY, opacity: contentOpacity }}
            className="w-full max-w-7xl mx-auto px-5 sm:px-8 lg:px-12 pt-24 sm:pt-32 pb-[30svh] lg:pb-16"
          >
            <div className="grid lg:grid-cols-12">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
                className="lg:col-span-7 xl:col-span-6"
              >
                {/* Vital Blue rather than the eyebrow's default Bio Teal: on a ground
                    this sheer, the lighter teal drops under 3:1. */}
                <p className="text-eyebrow !text-teal-dark mb-3 sm:mb-4">Premium Peptides</p>

                <h1 className="font-display text-4xl sm:text-5xl lg:text-[3.2rem] font-bold text-ink leading-[1.06] mb-4 sm:mb-5">
                  A Higher
                  <br />
                  Standard for
                  <br />
                  Your Wellness Journey
                </h1>

                <p className="text-base sm:text-lg text-ink/80 leading-relaxed max-w-md mb-7 sm:mb-8">
                  Pure compounds. Verified quality. Trusted by a growing community
                  across Canada.
                </p>

                <div className="flex flex-col sm:flex-row gap-3">
                  <Link href="/products" className="w-full sm:w-auto">
                    <button className="w-full sm:w-auto inline-flex items-center justify-center gap-2.5 bg-ink hover:bg-ocean text-white px-7 py-3.5 font-semibold text-sm rounded-full shadow-card transition-colors">
                      Shop Peptides
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  </Link>
                </div>
              </motion.div>
            </div>
          </motion.div>
        </div>
      </div>

      {/* Trust badges — the promises the storefront is held to, on a frosted
          strip along the hero's base (below it, on solid white, on phones) */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.3 }}
        className="relative border-t border-white/40 bg-white lg:bg-white/75 backdrop-blur-md"
      >
        <ul className="max-w-7xl mx-auto px-5 sm:px-8 lg:px-12 py-4 sm:py-6 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-x-4 gap-y-5 sm:gap-y-6">
          {TRUST_BADGES.map(({ icon: Icon, label, accent }, i) => (
            <li
              key={label}
              // Five badges in two columns leave the last one stranded in a
              // half-empty row, so on a phone it takes the whole width.
              className={`flex flex-col items-center text-center gap-1.5 sm:gap-2 ${
                i === TRUST_BADGES.length - 1 ? 'col-span-2 sm:col-span-1' : ''
              }`}
            >
              <Icon
                className="w-5 h-5 sm:w-7 sm:h-7 text-ink"
                style={accent ? { color: MAPLE_RED } : undefined}
                strokeWidth={1.5}
              />
              <span className="text-[10px] sm:text-xs font-medium text-ink leading-snug whitespace-pre-line">
                {label}
              </span>
            </li>
          ))}
        </ul>
      </motion.div>
    </section>
  );
}
