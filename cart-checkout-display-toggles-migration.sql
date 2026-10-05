-- ============================================================
-- Cart & checkout — show/hide switches for two more sections
-- ============================================================
--
-- Admin → Settings → Cart & Checkout Sections can now hide:
--   * cart_trust_strip_enabled — the three badges at the top of the cart
--     ("Free, Fast & Discreet Shipping / Secure Checkout / Carefully Packaged").
--   * checkout_verify_notice_enabled — the "A few quick questions first"
--     notice under the checkout's pay button.
--
-- Both default on so an existing store keeps them until an admin hides them.
--
-- Idempotent: safe to re-run. The cart, checkout and settings API read the
-- columns defensively (`?? true`), so both keep showing until this has been
-- run — but the admin switches cannot be SAVED before then.
--
-- Run this in the Supabase SQL editor (same as every other *-migration.sql).

ALTER TABLE site_settings
  ADD COLUMN IF NOT EXISTS cart_trust_strip_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS checkout_verify_notice_enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN site_settings.cart_trust_strip_enabled IS
  'Show the shipping / secure checkout / packaging trust badges at the top of the cart page.';
COMMENT ON COLUMN site_settings.checkout_verify_notice_enabled IS
  'Show the "A few quick questions first" notice under the checkout pay button.';

-- Make PostgREST pick the new columns up immediately.
NOTIFY pgrst, 'reload schema';
