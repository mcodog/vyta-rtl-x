-- ============================================================
-- Checkout — "Complete your order" box on/off switch
-- ============================================================
--
-- The checkout's middle column ("Complete your order" — the bacteriostatic
-- water explainer, the WhatsApp help link and the add-on products flagged
-- is_checkout_addon) can now be switched off from Admin → Settings →
-- Checkout Add-ons. Off, the checkout shows two columns (contact + order
-- summary) and does not load the add-ons at all.
--
-- On by default so an existing store keeps the box until an admin hides it.
--
-- Idempotent: safe to re-run. The checkout and the settings API read the
-- column defensively (`?? true`), so the box keeps showing until this has been
-- run — but the admin switch cannot be SAVED before then.
--
-- Run this in the Supabase SQL editor (same as every other *-migration.sql).

ALTER TABLE site_settings
  ADD COLUMN IF NOT EXISTS checkout_addons_enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN site_settings.checkout_addons_enabled IS
  'Show the "Complete your order" box (reconstitution help + add-on products) on the checkout page.';

-- Make PostgREST pick the new column up immediately.
NOTIFY pgrst, 'reload schema';
