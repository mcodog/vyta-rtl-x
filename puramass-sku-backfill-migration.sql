-- ============================================================
-- PuraMass SKU backfill
-- ============================================================
--
-- Fills products.puramass_sku (case) and products.puramass_sku_vial
-- (single vial) where they are still NULL, using the IDs from
-- puramass-store-products.csv. Products are matched on trimmed slug.
--
-- Only NULL/blank columns are written; existing SKUs are never overwritten.
-- Idempotent: safe to re-run.
--
-- Run this in the Supabase SQL editor (same as every other *-migration.sql).

WITH skus(slug, case_sku, vial_sku) AS (VALUES
  ('e-spray', 'puramass-e-spray-case', 'puramass-e-spray-vial'),  -- E Spray
  ('PIN20', 'puramass-pinaleon-20mg-case', 'puramass-pinaleon-20mg-vial'),  -- Pinaleon 20mg
  ('OT10', 'puramass-oxytocin-acetate-10mg-case', 'puramass-oxytocin-acetate-10mg-vial'),  -- Oxytocin Acetate 10mg
  ('test-e', 'puramass-test-e-case', 'puramass-test-e-vial'),  -- Test E
  ('BAPF', 'puramass-bacteriostatic-water-pfizer-30ml-case', 'puramass-bacteriostatic-water-pfizer-30ml-vial'),  -- Bacteriostatic Water Pfizer 30mL
  ('BC500T', 'puramass-bpc-157-500mcg-bottle-case', 'puramass-bpc-157-500mcg-bottle-vial'),  -- BPC - 157 500mcg Bottle
  ('KLOW', 'puramass-klow-80mg-case', 'puramass-klow-80mg-vial'),  -- KLOW 80mg
  ('CX20', 'puramass-cartalax-case', 'puramass-cartalax-vial'),  -- Cartalax
  ('ELO5', 'puramass-eloralintide-elo5-case', 'puramass-eloralintide-elo5-vial'),  -- Eloralintide
  ('vitamin-m', 'puramass-vitamin-m-case', 'puramass-vitamin-m-vial'),  -- Vitamin M
  ('332T', 'puramass-slu-pp-332-1000mcg-tablets-case', 'puramass-slu-pp-332-1000mcg-tablets-vial'),  -- SLU-PP-332 1000mcg (Tablets)
  ('ELO10', 'puramass-eloralintide-elo10-case', 'puramass-eloralintide-elo10-vial'),  -- Eloralintide
  ('RT40/ML', 'puramass-reta20mg-trize40mg-10ml-case', 'puramass-reta20mg-trize40mg-10ml-vial'),  -- Reta20mg +Trize40mg/(10ml)
  ('RC33', 'puramass-retatrutide-30mg-cagrilintide-3mg-case', 'puramass-retatrutide-30mg-cagrilintide-3mg-vial'),  -- Retatrutide 30mg + Cagrilintide 3mg
  ('GKP70', 'puramass-cu50-kpv10-bpc10-case', 'puramass-cu50-kpv10-bpc10-vial'),  -- CU50+KPV10+BPC10
  ('TR50', 'puramass-tirzepatide-50mg-case', 'puramass-tirzepatide-50mg-vial'),  -- Tirzepatide 50mg
  ('TR60', 'puramass-tirzepatide-60mg-case', 'puramass-tirzepatide-60mg-vial'),  -- Tirzepatide 60mg
  ('ENHSP', 'puramass-enchance-spray-case', 'puramass-enchance-spray-vial'),  -- Enchance Spray
  ('NAD100', 'puramass-nad-100mg-case', 'puramass-nad-100mg-vial'),  -- NAD 100mg
  ('TC200', 'puramass-test-c-10ml-case', 'puramass-test-c-10ml-vial'),  -- Test C (10ml)
  ('PRO20', 'puramass-alprostadil-20mcg-case', 'puramass-alprostadil-20mcg-vial'),  -- Alprostadil 20mcg
  ('XS20', 'puramass-semax-10mg-selank-10mg-case', 'puramass-semax-10mg-selank-10mg-vial')   -- Semax 10mg + Selank 10mg
)
UPDATE products p
SET
  puramass_sku      = COALESCE(NULLIF(TRIM(p.puramass_sku), ''),      s.case_sku),
  puramass_sku_vial = COALESCE(NULLIF(TRIM(p.puramass_sku_vial), ''), s.vial_sku),
  updated_at        = now()
FROM skus s
WHERE TRIM(p.slug) = s.slug
  AND (NULLIF(TRIM(p.puramass_sku), '') IS NULL
       OR NULLIF(TRIM(p.puramass_sku_vial), '') IS NULL);
