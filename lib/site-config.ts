import type { SupabaseClient } from '@supabase/supabase-js';
import { klaviyoOnsiteKey } from '@/lib/klaviyo/settings';

/**
 * Public site configuration — branding + tracking. Sourced from the
 * `site_settings` singleton (see marketing-branding-migration.sql) but edited
 * through the separate /api/admin/marketing endpoint. Contains NO secrets:
 * GTM / GA4 / Meta Pixel IDs are public client-side identifiers.
 */
export interface SiteConfig {
  store_name: string;
  store_tagline: string;
  logo_url: string | null;
  favicon_url: string | null;
  /**
   * Retired. The hero runs on `hero_image_url` alone on every screen size, so
   * nothing reads this to render and Admin → Marketing no longer edits it. The
   * column and this field are kept only so an existing row still round-trips;
   * drop both once no deployment has a value left in it.
   */
  hero_video_url: string | null;
  /** Home-page hero background — the whole of it. Null uses the shipped
   *  image (see DEFAULT_HERO_IMAGE in components/Hero.tsx). */
  hero_image_url: string | null;
  /** Google Tag Manager container — GTM-XXXXXXX. */
  gtm_container_id: string | null;
  ga4_measurement_id: string | null;
  meta_pixel_id: string | null;
  /**
   * Klaviyo public key / Site ID for klaviyo.js — null unless the integration
   * and onsite tracking are both switched on in Admin → Settings → Klaviyo.
   */
  klaviyo_public_key: string | null;
  tracking_consent_required: boolean;
  /** Product page: the 99% Purity / GMP / COA / Ships from Canada strip
   *  under the hero image. Admin → Settings → Cart & Checkout Sections. */
  product_trust_badges_enabled: boolean;
  /** Product page: the Customer Reviews section. */
  product_reviews_enabled: boolean;
  /** Product page: the Purity / Strength / Form tiles under the name. */
  product_specs_enabled: boolean;
  /** Product page: the Key Research Benefits list. */
  product_benefits_enabled: boolean;
  /** Product page: the dark Quality Certifications panel (incl. the
   *  research-use line). */
  product_certifications_enabled: boolean;
}

function cleanString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * VYTA's own tags, used when the `site_settings` row has no value — either
 * because gtm-ga4-tracking-migration.sql hasn't run yet or because the column
 * is still empty. Same "DB first, env var as the fallback" shape the Easyship
 * settings use (see .env.example), with the shipped constant as a last resort
 * so the container is live on vytabio.com without any deploy-time setup.
 *
 * A white-label fork overrides both in Admin → Marketing (which writes the DB)
 * or via the NEXT_PUBLIC_* vars below.
 */
const BUILTIN_GTM_CONTAINER_ID = 'GTM-M2J3D7SG';
const BUILTIN_GA4_MEASUREMENT_ID = 'G-F44F1BB1QV';
// Klaviyo Site ID (public key) for klaviyo.js. Used until a Site ID is saved in
// Admin → Settings → Klaviyo; once one is, that key and its on/off switches win.
const BUILTIN_KLAVIYO_SITE_ID = 'SY9j8v';

const FALLBACK_GTM_CONTAINER_ID =
  cleanString(process.env.NEXT_PUBLIC_GTM_CONTAINER_ID) ?? BUILTIN_GTM_CONTAINER_ID;
const FALLBACK_GA4_MEASUREMENT_ID =
  cleanString(process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID) ?? BUILTIN_GA4_MEASUREMENT_ID;
const FALLBACK_KLAVIYO_SITE_ID =
  cleanString(process.env.NEXT_PUBLIC_KLAVIYO_SITE_ID) ?? BUILTIN_KLAVIYO_SITE_ID;

/**
 * Historical hardcoded branding. Used as the SSR / first-client-render seed
 * (so there is no flash / hydration mismatch) and as the fallback whenever the
 * DB read fails or the migration hasn't run.
 */
export const DEFAULT_SITE_CONFIG: SiteConfig = {
  store_name: 'VYTA',
  store_tagline: 'Biosciences',
  logo_url: null,
  favicon_url: null,
  hero_video_url: null,
  hero_image_url: null,
  gtm_container_id: FALLBACK_GTM_CONTAINER_ID,
  ga4_measurement_id: FALLBACK_GA4_MEASUREMENT_ID,
  meta_pixel_id: null,
  klaviyo_public_key: FALLBACK_KLAVIYO_SITE_ID,
  tracking_consent_required: true,
  product_trust_badges_enabled: true,
  product_reviews_enabled: true,
  product_specs_enabled: true,
  product_benefits_enabled: true,
  product_certifications_enabled: true,
};

/**
 * Read with select('*') so that a not-yet-migrated row (missing branding /
 * tracking columns) can't make the query fail — shapeSiteConfig defaults
 * anything absent.
 */
export const SITE_CONFIG_COLUMNS = '*';

/**
 * Normalise a raw `site_settings` row into a SiteConfig. Missing branding
 * falls back to DEFAULT_SITE_CONFIG; consent defaults to required (true)
 * unless the row explicitly stores `false`.
 */
export function shapeSiteConfig(row: Record<string, any> | null | undefined): SiteConfig {
  const d = row ?? {};
  return {
    store_name: cleanString(d.store_name) ?? DEFAULT_SITE_CONFIG.store_name,
    store_tagline: cleanString(d.store_tagline) ?? DEFAULT_SITE_CONFIG.store_tagline,
    logo_url: cleanString(d.logo_url),
    favicon_url: cleanString(d.favicon_url),
    hero_video_url: cleanString(d.hero_video_url),
    hero_image_url: cleanString(d.hero_image_url),
    gtm_container_id: cleanString(d.gtm_container_id) ?? FALLBACK_GTM_CONTAINER_ID,
    ga4_measurement_id: cleanString(d.ga4_measurement_id) ?? FALLBACK_GA4_MEASUREMENT_ID,
    meta_pixel_id: cleanString(d.meta_pixel_id),
    // A raw row carries the klaviyo_enabled / onsite switches and is gated on
    // them; an already-shaped config (the client re-shapes /api/site-config)
    // has only the resolved key, which is kept as is.
    klaviyo_public_key:
      'klaviyo_enabled' in d
        ? klaviyoOnsiteKey(d, FALLBACK_KLAVIYO_SITE_ID)
        : cleanString(d.klaviyo_public_key),
    tracking_consent_required: d.tracking_consent_required === false ? false : true,
    product_trust_badges_enabled: d.product_trust_badges_enabled !== false,
    product_reviews_enabled: d.product_reviews_enabled !== false,
    product_specs_enabled: d.product_specs_enabled !== false,
    product_benefits_enabled: d.product_benefits_enabled !== false,
    product_certifications_enabled: d.product_certifications_enabled !== false,
  };
}

/**
 * Server read of the branding/tracking config from the singleton. Falls back
 * to DEFAULT_SITE_CONFIG if the client/query fails or the migration hasn't run
 * — never throws, so metadata generation and SSR can't break on it.
 */
export async function readSiteConfigRow(db: SupabaseClient): Promise<SiteConfig> {
  try {
    const { data, error } = await db
      .from('site_settings')
      .select(SITE_CONFIG_COLUMNS)
      .limit(1)
      .maybeSingle();
    if (error) return DEFAULT_SITE_CONFIG;
    return shapeSiteConfig(data);
  } catch {
    return DEFAULT_SITE_CONFIG;
  }
}

/**
 * Client fetch of the public /api/site-config. Never throws; returns
 * DEFAULT_SITE_CONFIG on any failure.
 */
export async function fetchSiteConfig(): Promise<SiteConfig> {
  try {
    const res = await fetch('/api/site-config', { cache: 'no-store' });
    if (!res.ok) return DEFAULT_SITE_CONFIG;
    const data = await res.json().catch(() => null);
    if (!data?.config) return DEFAULT_SITE_CONFIG;
    return shapeSiteConfig(data.config);
  } catch {
    return DEFAULT_SITE_CONFIG;
  }
}
