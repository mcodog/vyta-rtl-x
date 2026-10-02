-- ============================================================
-- PuraMass SKU backfill: Semax - Selank 10mg Mix (slug ss10)
-- ============================================================
--
-- Fills products.puramass_sku (case) and products.puramass_sku_vial
-- (single vial) for this one product, using the IDs from
-- puramass-semax-selank-mix.csv. Only NULL/blank columns are written.
-- Idempotent: safe to re-run.
--
-- Run this in the Supabase SQL editor (same as every other *-migration.sql).

UPDATE products
SET
  puramass_sku      = COALESCE(NULLIF(TRIM(puramass_sku), ''),      'puramass-semax-selank-10mg-mix-case'),
  puramass_sku_vial = COALESCE(NULLIF(TRIM(puramass_sku_vial), ''), 'puramass-semax-selank-10mg-mix-vial'),
  updated_at        = now()
WHERE id = '173e1085-ea5e-4baf-9fcd-857e7ed59343'
  AND (NULLIF(TRIM(puramass_sku), '') IS NULL
       OR NULLIF(TRIM(puramass_sku_vial), '') IS NULL);
