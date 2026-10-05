-- ============================================================
-- Invoice numbers: INV-1020 → VYTA-1020
-- ============================================================
--
-- Invoice numbers come from the column default
--   'INV-' || nextval('invoice_number_seq')
-- (ecommerce-backend-migration.sql). This switches the prefix to VYTA- for
-- every new invoice — same sequence, so numbering simply carries on — and
-- renames the existing INV-#### numbers to VYTA-#### (same digits), so the
-- admin, PDFs and emails all read the same.
--
-- Nothing in the app keys on the number's text (lookups are by id; admin
-- search matches any part of it), so renaming is safe. Emails and PDFs already
-- sent keep showing the old INV- number.
--
-- Idempotent: safe to re-run. Run this in the Supabase SQL editor (same as
-- every other *-migration.sql).

-- 1. New invoices.
ALTER TABLE invoices
  ALTER COLUMN invoice_number SET DEFAULT ('VYTA-' || nextval('invoice_number_seq'));

-- 2. Existing invoices: INV-1020 → VYTA-1020, only where the VYTA- number is
--    free (it always is unless one was typed by hand).
UPDATE invoices i
   SET invoice_number = 'VYTA-' || substr(i.invoice_number, 5)
 WHERE i.invoice_number LIKE 'INV-%'
   AND NOT EXISTS (
     SELECT 1 FROM invoices x WHERE x.invoice_number = 'VYTA-' || substr(i.invoice_number, 5)
   );

NOTIFY pgrst, 'reload schema';
