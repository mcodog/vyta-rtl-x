-- ============================================================
-- Storefront — show/hide switches for optional sections
-- ============================================================
--
-- Admin → Settings → Storefront Sections can now hide:
--   * product_trust_badges_enabled — the "99% Purity / GMP Certified /
--     COA Available / Ships from Canada" strip under the product image.
--   * product_reviews_enabled — the Customer Reviews section on product pages.
--   * cart_trust_strip_enabled — the three badges at the top of the cart
--     ("Free, Fast & Discreet Shipping / Secure Checkout / Carefully Packaged").
--   * checkout_verify_notice_enabled — the "A few quick questions first"
--     notice under the checkout's pay button.
--
-- All default on so an existing store keeps them until an admin hides them.
--
-- Idempotent: safe to re-run. The storefront and settings API read the
-- columns defensively, so everything keeps showing until this has been run —
-- but the admin switches cannot be SAVED before then.
--
-- Run this in the Supabase SQL editor (same as every other *-migration.sql).

ALTER TABLE site_settings
  ADD COLUMN IF NOT EXISTS product_trust_badges_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS product_reviews_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS cart_trust_strip_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS checkout_verify_notice_enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN site_settings.product_trust_badges_enabled IS
  'Show the 99% Purity / GMP / COA / Ships from Canada strip under the product image.';
COMMENT ON COLUMN site_settings.product_reviews_enabled IS
  'Show the Customer Reviews section on product pages.';
COMMENT ON COLUMN site_settings.cart_trust_strip_enabled IS
  'Show the shipping / secure checkout / packaging trust badges at the top of the cart page.';
COMMENT ON COLUMN site_settings.checkout_verify_notice_enabled IS
  'Show the "A few quick questions first" notice under the checkout pay button.';

-- Make PostgREST pick the new columns up immediately.
NOTIFY pgrst, 'reload schema';
