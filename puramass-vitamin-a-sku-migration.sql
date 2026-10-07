-- ============================================================
-- PuraMass SKU backfill: Vitamin A 20mg (av20), Vitamin A 10mg (av10)
-- ============================================================
--
-- Fills products.puramass_sku (case) and products.puramass_sku_vial
-- (single vial) for these two products, using the IDs from
-- puramass-vitamin-a.csv. Matched on product id. Only NULL/blank
-- columns are written. Idempotent: safe to re-run.
--
-- Run this in the Supabase SQL editor (same as every other *-migration.sql).

WITH skus(id, case_sku, vial_sku) AS (VALUES
  ('66ad9917-0c61-4363-8ade-c8c8e95a3fa8'::uuid, 'puramass-vitamin-a-20mg-case', 'puramass-vitamin-a-20mg-vial'),  -- Vitamin A 20mg (av20)
  ('b7a7b326-37e2-4812-89e9-15aee849fa8a'::uuid, 'puramass-vitamin-a-10mg-case', 'puramass-vitamin-a-10mg-vial')   -- Vitamin A 10mg (av10)
)
UPDATE products p
SET
  puramass_sku      = COALESCE(NULLIF(TRIM(p.puramass_sku), ''),      s.case_sku),
  puramass_sku_vial = COALESCE(NULLIF(TRIM(p.puramass_sku_vial), ''), s.vial_sku),
  updated_at        = now()
FROM skus s
WHERE p.id = s.id
  AND (NULLIF(TRIM(p.puramass_sku), '') IS NULL
       OR NULLIF(TRIM(p.puramass_sku_vial), '') IS NULL);
