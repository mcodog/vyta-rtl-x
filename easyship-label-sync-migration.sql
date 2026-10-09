-- =====================================================================
-- Easyship label sync: the full shipment record on the invoice, and the
-- automatic "Your Order Has Shipped!" email
-- =====================================================================
-- When a shipment's label is generated (bought from the admin, auto-bought,
-- bought in the Easyship dashboard and reported by the webhook, or linked by
-- the Easyship sync dialog) lib/shipping/label-generated.ts reads the shipment
-- back from Easyship and writes its record onto the order AND the invoice,
-- then emails the customer (admins copied) once.
--
-- The core shipment columns (tracking number/link, carrier, label) already
-- exist from easyship-invoice-shipment-migration.sql — run that first. This
-- adds the rest of the record, and the claim column that stops the webhook
-- and the buy-label route from both sending the email for the same label.
--
-- Until this runs, the core record and the email still work; only the extra
-- details below are skipped, and the email falls back to a non-atomic check.
--
-- Idempotent: safe to re-run.
-- Run this in the Supabase SQL editor (same as every other *-migration.sql).

-- 1. The rest of the shipment record, on both tables ---------------------
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS shipping_service        TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS shipping_label_cost     NUMERIC(10, 2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS shipping_label_currency TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS est_delivery_min_days   INTEGER;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS est_delivery_max_days   INTEGER;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS label_generated_at      TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS easyship_synced_at      TIMESTAMPTZ;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_service        TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_label_cost     NUMERIC(10, 2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_label_currency TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS est_delivery_min_days   INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS est_delivery_max_days   INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS label_generated_at      TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS easyship_synced_at      TIMESTAMPTZ;

-- 2. One automatic shipped email per invoice ------------------------------
-- Set by a conditional UPDATE before sending; cleared again if the send fails
-- so the next label event retries.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS shipped_email_auto_claimed_at TIMESTAMPTZ;

-- 3. Shipments book the best-value UPS / Canada Post service --------------
-- The site-wide preference is no longer read (shipping is free, so the buyer
-- never picks a rate; every shipment books the cheapest service that arrives
-- within 2 days). Align the stored value so the table doesn't say otherwise.
ALTER TABLE site_settings
  ADD COLUMN IF NOT EXISTS easyship_auto_courier_preference TEXT;
ALTER TABLE site_settings
  ALTER COLUMN easyship_auto_courier_preference SET DEFAULT 'best_value';
UPDATE site_settings SET easyship_auto_courier_preference = 'best_value';

NOTIFY pgrst, 'reload schema';
