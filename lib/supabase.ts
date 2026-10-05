import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://swpcvpkcfxihxmjpjqow.supabase.co';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// Single shared client for client-side usage
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Server-side client with service role key (bypasses RLS) for API routes
export function getSupabase() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || supabaseAnonKey;
  return createClient(supabaseUrl, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// User role type. `affiliate` is a first-class role: affiliates get a scoped
// /admin portal (see lib/permissions.ts → canAccessAdmin / AFFILIATE_PAGES).
// `warehouse` staff use the /warehouse portal (see canAccessWarehouse).
// `analytics` is an external marketing/analytics partner with a scoped portal
// (ANALYTICS_PAGES): read analytics, edit product copy, categories, branding.
export type UserRole = 'customer' | 'assistant' | 'admin' | 'affiliate' | 'warehouse' | 'analytics';

// Re-export invoicing types so admin UI can import them from a single place.
export type {
  InvoiceStatus,
  PaymentMethod,
  Invoice,
  InvoiceLineItem,
  Payment,
  SalesPerson,
  SalesCommission,
  AgingBucket,
  AgingReport,
} from '@/lib/types/ecommerce';

// ---- Pricing: named pricelists ----
export interface Pricelist {
  id: string;
  name: string;
  /** Optional description shown in admin views (added by the enhancements migration). */
  description: string | null;
  is_active: boolean;
  /** Creator FK — nullable for legacy lists created before the column existed. */
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PricelistItem {
  id: string;
  pricelist_id: string;
  product_id: string;
  price: number;
  created_at: string;
  updated_at: string;
}

// Database types
export interface Affiliate {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  wallet_address: string | null;
  password_hash: string;
  active: boolean;
  total_earnings: number;
  commission_rate: number;
  created_at: string;
  updated_at: string;
}

export interface ReferralCode {
  id: string;
  affiliate_id: string;
  code: string;
  active: boolean;
  uses_count: number;
  created_at: string;
}

/**
 * An affiliate's bid for a particular referral code, or the record of an admin
 * setting one outright (`source: 'admin'`, written already approved).
 *
 * `decision_notes` and `decided_by_name` ARE ADMIN-ONLY. The affiliate-facing
 * route selects an explicit, narrower column list — see `MyCodeRequest` in
 * lib/affiliate/referral-codes.ts.
 */
export interface ReferralCodeRequest {
  id: string;
  affiliate_id: string;
  requested_code: string;
  previous_code: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  source: 'affiliate' | 'admin';
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_notes: string | null;
  created_at: string;
}

export interface Commission {
  id: string;
  /** Set for storefront/legacy orders. Mutually exclusive with invoice_id. */
  order_id: string | null;
  /** Set for hosted (Stealth Health) sales, which materialise as an invoice. */
  invoice_id: string | null;
  affiliate_id: string;
  referral_code_id: string | null;
  amount: number;
  order_total: number;
  commission_rate: number;
  status: 'pending' | 'paid' | 'cancelled';
  paid_at: string | null;
  created_at: string;
}

export interface Customer {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  password_hash: string;
  wallet_address: string | null;
  phone: string | null;
  shipping_address: string | null;
  shipping_city: string | null;
  shipping_state: string | null;
  shipping_postal_code: string | null;
  shipping_country: string | null;
  is_admin: boolean;
  role: UserRole;
  active: boolean;
  affiliate_id: string | null;
  preferred_currency: string;
  last_login_at: string | null;
  email_verified: boolean;
  created_at: string;
  updated_at: string;
  has_completed_first_order: boolean;
  // Consent + claim workflow (see registration-alerts-migration.sql)
  contact_consent: boolean;
  claimed_by_id: string | null;
  claimed_by_email: string | null;
  claimed_by_name: string | null;
  claimed_at: string | null;
  registration_alert_sent_at: string | null;
  abandoned_alert_sent_at: string | null;
}

// A single tracked interaction from a logged-in customer — powers the admin
// "customer insights" page (searches / product views / cart adds).
export interface CustomerActivity {
  id: string;
  customer_id: string;
  activity_type: 'search' | 'view' | 'cart';
  search_query: string | null;
  product_id: string | null;
  product_name: string | null;
  quantity: number | null;
  created_at: string;
}

export type CryptoChain = 'btc' | 'eth' | 'sol';

export interface Order {
  id: string;
  customer_id: string | null;
  order_number: string;
  items: { name: string; quantity: number; price: number; strength?: string; product_id?: string }[];
  total: number;
  email: string | null;
  shipping_address: {
    firstName: string;
    lastName: string;
    address: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    phone?: string;
  } | null;
  crypto: CryptoChain;
  status: 'pending' | 'received' | 'confirmed' | 'expired' | 'processing' | 'shipped' | 'delivered' | 'cancelled';
  payment_address: string | null;
  payment_amount_expected: string | null;
  payment_amount_received: string | null;
  payment_tx_hash: string | null;
  payment_derivation_index: number | null;
  payment_confirmations: number;
  payment_confirmed_at: string | null;
  payment_expires_at: string | null;
  referral_code: string | null;
  tracking_number: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderItem {
  id: string;
  order_id: string;
  product_name: string;
  product_id: string | null;
  quantity: number;
  price_at_time: number;
  strength: string | null;
  created_at: string;
}

export interface Product {
  id: string;
  name: string;
  description: string | null;
  /** Catalog case (box) price — i.e. `vial_price * vials_per_box`. */
  price: number;
  /** Optional explicit USD override. When null, the UI computes it from
   *  `price × site_settings.usd_exchange_rate` and labels it "auto". */
  price_usd: number | null;
  /** Optional explicit per-vial price. When null, the UI derives it from the
   *  case price — `price / vials_per_box` (also labelled "auto"). */
  vial_price: number | null;
  stock_quantity: number;
  /** Vials per box. Product stock is denominated in vials; boxes convert
   *  via this factor (default 10, CHECK > 0). */
  vials_per_box: number;
  /** Pack quantities this product may be sold in, e.g. [1, 3, 5, 10]. NULL /
   *  empty = not opted in, so the storefront falls back to the historical pair
   *  (single vial + one full case). See lib/pricing.ts `packSizesFor`. */
  pack_sizes: number[] | null;
  /** Per-pack configuration: [{size, label, badge, price, compare_at,
   *  enabled}]. NULL = fall back to `pack_sizes`, then to the historical pair.
   *  A NULL `price` on a row means the derived vial price × size; `badge` is
   *  the merchandising tag on the PDP's pack picker ("Most Popular", "Best
   *  Value"). See lib/pricing.ts `packOptionsFor`. */
  pack_options: import('@/lib/pricing').StoredPackOption[] | null;
  low_stock_threshold: number;
  /** Dedupe flag: true once a low-stock alert has been emailed. Reset when
   *  stock recovers above the threshold. */
  low_stock_alerted: boolean;
  category: string | null;
  /** FK link to store_categories.id. The `category` text column above mirrors
   *  the linked category's slug and is kept in sync by DB triggers. */
  category_id: string | null;
  image_url: string | null;
  /** Optional secondary image for box/packaging. */
  box_image_url: string | null;
  strength: string | null;
  /** Stealth Health 10-pack SKU this product maps to (null = unmapped). */
  puramass_sku: string | null;
  /** Stealth Health single-vial SKU this product maps to (null = unmapped). */
  puramass_sku_vial: string | null;
  /** Offered as an upsell on the Stealth Health checkout screen (store stock ignored). */
  is_checkout_addon: boolean;
  purity: string | null;
  form: string | null;
  featured: boolean;
  active: boolean;
  slug: string | null;
  sku: string | null;
  description_short: string | null;
  benefits: string | null;
  mechanism: string | null;
  coa_url: string[] | null;
  created_at: string;
  updated_at: string;
}

export interface ShippingOrigin {
  line_1?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  country_alpha2?: string;
  company?: string;
  phone?: string;
  email?: string;
}

export interface ShippingBox {
  length?: number;
  width?: number;
  height?: number;
}

// ---- Analytics (re-exported from lib/admin/analytics.ts) ----
// These type aliases exist so consumers can import them from the same
// place as the other domain types. `CurrencyRevenue` is the spec's
// name for `RevenueBucket`.
export type {
  AnalyticsSummary,
  AnalyticsRange,
  RevenueBucket,
  RevenueBucket as CurrencyRevenue,
} from './admin/analytics';

export interface SiteSettings {
  id: string;
  checkout_type: 'email' | 'crypto';
  admin_emails: string[];
  // Invoice email config
  invoice_cc_emails: string[];
  invoice_customer_email_subject: string;
  invoice_customer_email_body: string;
  invoice_admin_email_subject: string;
  invoice_admin_email_body: string;
  // Checkout config
  pickup_address: string;
  guest_checkout_enabled: boolean;
  // Stealth Health hosted checkout: always true (it is the only checkout) + read-only credential status
  // (`puramass_configured` is derived from server env, never a stored column).
  puramass_checkout_enabled: boolean;
  /** Hosted-checkout buyers pick a live courier rate; off = flat shipping fee. */
  puramass_shipping_rates_enabled: boolean;
  /** Flat hosted-checkout shipping fee (CAD) when live rates are off. */
  puramass_flat_shipping: number;
  /** Free shipping past a subtotal. Forced off without live courier rates. */
  puramass_free_shipping_enabled: boolean;
  puramass_free_shipping_threshold: number;
  /** Read-only: the promo is on AND the hosted checkout is the active one. */
  puramass_free_shipping_active: boolean;
  puramass_configured: boolean;
  // Paid-ads welcome discount: percent off for a signed-in visitor who arrived
  // on a paid ad. Applied by lowering the hosted-checkout line prices.
  ad_discount_enabled: boolean;
  ad_discount_percent: number;
  /** Read-only: the promo is on AND the hosted checkout is the active one. */
  ad_discount_active: boolean;
  // Limited-time cart offer: percent off once the cart carries `min_items`.
  // Open to everyone — what earns it is the cart, not the buyer.
  cart_offer_enabled: boolean;
  cart_offer_min_items: number;
  cart_offer_percent: number;
  /** ISO timestamp the offer stops at; null = runs until switched off. */
  cart_offer_ends_at: string | null;
  /** Read-only: the promo is on AND the hosted checkout is the active one. */
  cart_offer_active: boolean;
  /** Show the operator-curated "Frequently bought together" block on the cart. */
  cart_fbt_enabled: boolean;
  /** Show the computed "You may also like" block on the cart. */
  cart_similar_enabled: boolean;
  /** Show the "Complete your order" box (reconstitution help + add-ons) on the checkout. */
  checkout_addons_enabled: boolean;
  /** Show the three trust badges (shipping / secure checkout / packaging) at the top of the cart. */
  cart_trust_strip_enabled: boolean;
  /** Show the "A few quick questions first" notice under the checkout's pay button. */
  checkout_verify_notice_enabled: boolean;
  /** Show the 99% Purity / GMP / COA / Ships from Canada strip on product pages. */
  product_trust_badges_enabled: boolean;
  /** Show the Customer Reviews section on product pages. */
  product_reviews_enabled: boolean;
  // Easyship shipping config
  easyship_enabled: boolean;
  easyship_api_key_set: boolean; // never the key itself
  shipping_origin: ShippingOrigin;
  shipping_box: ShippingBox;
  shipping_item_weight_kg: number;
  shipping_flat_rate: number;
  // Processing fee folded into the live shipping rate (never shown separately).
  shipping_handling_fee_type: 'flat' | 'pct';
  shipping_handling_fee_value: number;
  // Klaviyo (the private key itself is never returned)
  klaviyo_enabled: boolean;
  klaviyo_private_key_set: boolean;
  klaviyo_private_key_source: 'db' | 'env' | null;
  klaviyo_public_key: string;
  klaviyo_list_id: string;
  klaviyo_onsite_enabled: boolean;
  klaviyo_server_events_enabled: boolean;
  klaviyo_sync_signups: boolean;
  // Registration alerts
  registration_alert_enabled: boolean;
  abandoned_registration_enabled: boolean;
  abandoned_registration_hours: number;
  /** Hours a hosted checkout sits unpaid before it counts as abandoned. */
  abandoned_checkout_hours: number;
  created_at: string;
  updated_at: string;
}
