-- ============================================================================
-- STEALTH HEALTH — ONE-OFF STOCK BACKFILL
-- Depends on: stock-ledger-migration.sql (run that first)
-- ============================================================================
--
-- Takes the stock that paid Stealth Health orders never took, and records it on
-- the stock ledger against each order's invoice (actor "stealth-health (backfill)").
--
-- For every PAID Stealth Health invoice:
--   1. Each line with no product is linked to one, read from its description:
--        "Name — Pack of 5"   -> product "Name", 5 vials per unit
--        "Name — Single vial" -> product "Name", 1 vial per unit
--        "Name (Single Vial)" -> product "Name", 1 vial per unit
--        "<vial SKU>"         -> that product,   1 vial per unit
--      A line is linked only when exactly one product matches.
--   2. take_stock_for_invoice_lines() then takes the stock: the whole invoice if
--      its stock pass never ran, otherwise only the lines linked in step 1.
--
-- Anything it can't resolve for sure (e.g. a case SKU with no pack size, or a
-- paid order whose invoice is missing or still unpaid) is left alone and listed
-- in the report at the end. Fix those under Admin → Stock Ledger → Needs attention.
--
-- Safe to run more than once: linked lines and invoices whose stock is already
-- taken are skipped, so a second run changes nothing.
-- ============================================================================

DO $$
BEGIN
  IF to_regprocedure('take_stock_for_invoice_lines(uuid, jsonb, uuid, text)') IS NULL THEN
    RAISE EXCEPTION 'Run stock-ledger-migration.sql first.';
  END IF;
END $$;

DROP TABLE IF EXISTS pg_temp.stock_backfill_report;
CREATE TEMP TABLE stock_backfill_report (
  invoice_number text,
  invoice_id     uuid,
  line           text,
  outcome        text
);

DO $$
DECLARE
  inv        record;
  ln         record;
  m          text[];
  v_name     text;
  v_vpu      integer;
  v_prod     uuid;
  v_matches  integer;
  v_links    jsonb;
  v_linked   integer;
BEGIN
  FOR inv IN
    SELECT id, invoice_number, stock_adjusted
      FROM invoices
     WHERE source = 'stealth_health'
       AND status = 'paid'
     ORDER BY created_at
  LOOP
    v_links := '[]'::jsonb;

    FOR ln IN
      SELECT id, description, qty
        FROM invoice_line_items
       WHERE invoice_id = inv.id
         AND product_id IS NULL
    LOOP
      v_name := NULL;
      v_vpu  := NULL;
      v_prod := NULL;

      m := regexp_match(trim(ln.description), '^(.*?)\s+[—–-]\s+pack of\s+(\d+)\s*$', 'i');
      IF m IS NOT NULL THEN
        v_name := trim(m[1]);
        v_vpu  := GREATEST(1, m[2]::integer);
      ELSE
        m := regexp_match(trim(ln.description), '^(.*?)\s+[—–-]\s+single vial\s*$', 'i');
        IF m IS NULL THEN
          m := regexp_match(trim(ln.description), '^(.*?)\s*\(\s*single\s+vial\s*\)\s*$', 'i');
        END IF;
        IF m IS NOT NULL THEN
          v_name := trim(m[1]);
          v_vpu  := 1;
        END IF;
      END IF;

      IF v_name IS NOT NULL THEN
        SELECT count(*), min(id::text)::uuid INTO v_matches, v_prod
          FROM products
         WHERE lower(trim(name)) = lower(v_name);
      ELSE
        -- A legacy line may carry the partner's single-vial SKU as its description.
        SELECT count(*), min(id::text)::uuid INTO v_matches, v_prod
          FROM products
         WHERE lower(trim(puramass_sku_vial)) = lower(trim(ln.description));
        v_vpu := 1;
      END IF;

      IF v_matches = 1 THEN
        v_links := v_links || jsonb_build_array(jsonb_build_object(
          'line_id', ln.id, 'product_id', v_prod, 'vials_per_unit', v_vpu));
        INSERT INTO stock_backfill_report VALUES
          (inv.invoice_number, inv.id, ln.description,
           'linked to ' || (SELECT name FROM products WHERE id = v_prod) ||
           ', ' || (ln.qty * v_vpu) || ' vial(s) taken');
      ELSE
        INSERT INTO stock_backfill_report VALUES
          (inv.invoice_number, inv.id, ln.description,
           CASE WHEN v_matches = 0 THEN 'NOT FIXED — no matching product'
                ELSE 'NOT FIXED — ' || v_matches || ' products match' END ||
           '; link it under Stock Ledger → Needs attention');
      END IF;
    END LOOP;

    IF jsonb_array_length(v_links) > 0 OR inv.stock_adjusted IS DISTINCT FROM true THEN
      v_linked := take_stock_for_invoice_lines(inv.id, v_links, NULL, 'stealth-health (backfill)');
      IF inv.stock_adjusted IS DISTINCT FROM true THEN
        INSERT INTO stock_backfill_report VALUES
          (inv.invoice_number, inv.id, NULL, 'stock pass had never run — taken now for every linked line');
      END IF;
    END IF;
  END LOOP;

  -- Paid on Stealth Health, but the invoice is missing or not marked paid:
  -- nothing here can take its stock yet.
  INSERT INTO stock_backfill_report
  SELECT i.invoice_number, po.invoice_id, po.partner_reference,
         CASE WHEN po.invoice_id IS NULL OR i.id IS NULL
              THEN 'NOT FIXED — paid order has no invoice'
              ELSE 'NOT FIXED — invoice is "' || i.status || '", not paid' END
    FROM puramass_orders po
    LEFT JOIN invoices i ON i.id = po.invoice_id
   WHERE po.status = 'paid'
     AND (i.id IS NULL OR i.status <> 'paid');
END $$;

-- What happened, then every stock movement now on the ledger for these
-- invoices. (One result set: the Supabase SQL editor only shows the last.)
SELECT invoice_number, line AS item, outcome AS result, NULL::timestamptz AS at
  FROM stock_backfill_report
UNION ALL
SELECT i.invoice_number,
       p.name,
       'ledger: ' || h.old_value || ' → ' || h.new_value || ' by ' || COALESCE(h.actor_email, 'system'),
       h.created_at
  FROM product_history h
  JOIN invoices i ON i.id::text = h.reference_id
  JOIN products p ON p.id = h.product_id
 WHERE h.reference_type = 'invoice'
   AND h.field = 'stock_quantity'
   AND i.source = 'stealth_health'
 ORDER BY invoice_number NULLS LAST, at NULLS FIRST;
