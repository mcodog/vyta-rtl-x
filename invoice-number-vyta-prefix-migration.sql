-- ============================================================
-- INVOICE NUMBER PREFIX: INV- → VYTA-
-- ============================================================
--
-- New invoices are numbered VYTA-1021, VYTA-1022, … (same sequence, new
-- prefix), and existing INV-#### numbers become VYTA-#### so the two
-- series don't sit side by side (INV-1020 → VYTA-1020).
--
-- Nothing in the app looks an invoice up by its number, so renaming is safe.
-- Emails already sent and Easyship / PuraMass references made before this
-- runs keep the old INV- text.
--
-- Idempotent: safe to run more than once.
-- Undo: swap the prefixes in both statements below.

BEGIN;

-- 1. New invoices.
ALTER TABLE invoices
  ALTER COLUMN invoice_number SET DEFAULT ('VYTA-' || nextval('invoice_number_seq'));

-- 2. Existing invoices. Skips any whose VYTA- number is somehow already taken
--    (the column is UNIQUE), rather than failing the whole migration.
UPDATE invoices AS i
   SET invoice_number = 'VYTA-' || substring(i.invoice_number FROM 5)
 WHERE i.invoice_number LIKE 'INV-%'
   AND NOT EXISTS (
     SELECT 1 FROM invoices AS t
      WHERE t.invoice_number = 'VYTA-' || substring(i.invoice_number FROM 5)
   );

COMMIT;

-- Check: should return 0 rows.
-- SELECT id, invoice_number FROM invoices WHERE invoice_number LIKE 'INV-%';
