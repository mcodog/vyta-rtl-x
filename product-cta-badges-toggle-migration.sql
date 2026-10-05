-- ============================================================
-- Product page — show/hide switch for the Add to Cart badge row
-- ============================================================
--
-- Admin → Settings → Storefront Sections → Product page can now hide
-- product_cta_badges_enabled — the "99% Purity / Third-Party Tested /
-- COA Available / Ships from Canada" row under the Add to Cart button.
--
-- On by default so an existing store keeps it until an admin hides it.
--
-- Idempotent: safe to re-run. The product page and settings API read the
-- column defensively, so the row keeps showing until this has been run —
-- but the admin switch cannot be SAVED before then.
--
-- Run this in the Supabase SQL editor (same as every other *-migration.sql).

ALTER TABLE site_settings
  ADD COLUMN IF NOT EXISTS product_cta_badges_enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN site_settings.product_cta_badges_enabled IS
  'Show the 99% Purity / Third-Party Tested / COA / Ships from Canada row under Add to Cart on product pages.';

-- Make PostgREST pick the new column up immediately.
NOTIFY pgrst, 'reload schema';
