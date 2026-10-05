-- ============================================================
-- Product page — show/hide switches for specs and benefits
-- ============================================================
--
-- Admin → Settings → Storefront Sections → Product page can now hide:
--   * product_specs_enabled — the Purity / Strength / Form tiles under the
--     product name.
--   * product_benefits_enabled — the Key Research Benefits list.
--
-- Both default on so an existing store keeps them until an admin hides them.
--
-- Idempotent: safe to re-run. The product page and settings API read the
-- columns defensively, so both keep showing until this has been run — but
-- the admin switches cannot be SAVED before then.
--
-- Run this in the Supabase SQL editor (same as every other *-migration.sql).

ALTER TABLE site_settings
  ADD COLUMN IF NOT EXISTS product_specs_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS product_benefits_enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN site_settings.product_specs_enabled IS
  'Show the Purity / Strength / Form tiles on product pages.';
COMMENT ON COLUMN site_settings.product_benefits_enabled IS
  'Show the Key Research Benefits list on product pages.';

-- Make PostgREST pick the new columns up immediately.
NOTIFY pgrst, 'reload schema';
