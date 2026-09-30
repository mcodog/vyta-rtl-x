-- ============================================================================
-- STOCK LEDGER — EVERY STOCK CHANGE RECORDED, STEALTH HEALTH STOCK RELIABLE
-- ============================================================================
--
-- WHY
-- ---
-- A Stealth Health order was paid and shipped but products.stock_quantity
-- never moved. The stock step depends on pieces spread over several earlier
-- migrations (product_history, invoice_line_items.vials_per_unit, the
-- `pending_payment` invoice status, the vial-aware stock RPCs); when any of
-- them is missing the app degrades silently and takes no stock. This file
-- carries every one of those pieces again, so running it alone is enough.
--
-- It also turns product_history into a complete stock ledger:
--
--   * Manual edits     -> set_product_stock(): the admin's change and its
--                         history row (who did it) land in ONE transaction.
--   * Automatic moves  -> the existing RPCs (invoice paid / cancelled, order
--                         confirmed / cancelled, purchase-order receipts)
--                         already write a history row pointing at the invoice,
--                         order or purchase order that caused it.
--   * Anything else    -> products_stock_ledger, a deferred trigger, logs any
--                         stock change that reached commit WITHOUT a history
--                         row (a Supabase dashboard edit, raw SQL, a future
--                         code path) as source 'untracked'. Nothing slips by.
--
-- Plus take_stock_for_invoice_lines(): links invoice lines that were paid with
-- no product attached (so took no stock) and takes their stock, exactly once.
--
-- Idempotent: safe to run more than once.
-- ============================================================================

-- 1. product_history (from product-history-migration.sql) --------------------
CREATE TABLE IF NOT EXISTS product_history (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  product_id     UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  change_type    TEXT NOT NULL CHECK (change_type IN ('price', 'stock', 'general')),
  field          TEXT NOT NULL,
  old_value      TEXT,
  new_value      TEXT,
  source         TEXT NOT NULL DEFAULT 'admin_edit',
  reference_type TEXT,
  reference_id   TEXT,
  note           TEXT,
  actor_id       UUID REFERENCES customers(id) ON DELETE SET NULL,
  actor_email    TEXT
);

CREATE INDEX IF NOT EXISTS idx_product_history_product
  ON product_history (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_history_change_type
  ON product_history (change_type);
CREATE INDEX IF NOT EXISTS idx_product_history_created_at
  ON product_history (created_at DESC);
-- The ledger page and the invoice repair look rows up by what caused them.
CREATE INDEX IF NOT EXISTS idx_product_history_reference
  ON product_history (reference_type, reference_id);

ALTER TABLE product_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "product_history_service_only" ON product_history;
CREATE POLICY "product_history_service_only" ON product_history
  FOR ALL TO public USING (false) WITH CHECK (false);

-- 2. Stealth Health prerequisites (from stealth-health-pending-invoice-migration.sql)
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check
  CHECK (status = ANY (ARRAY[
    'draft'::text,
    'sent'::text,
    'partial'::text,
    'paid'::text,
    'overdue'::text,
    'cancelled'::text,
    'pending_payment'::text,
    'expired'::text
  ]));

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS stock_adjusted boolean NOT NULL DEFAULT false;

ALTER TABLE invoice_line_items
  ADD COLUMN IF NOT EXISTS vials_per_unit integer NOT NULL DEFAULT 1;

DO $$ BEGIN
  ALTER TABLE invoice_line_items
    ADD CONSTRAINT invoice_line_items_vials_per_unit_positive CHECK (vials_per_unit >= 1);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 3. Vial-aware invoice stock RPCs (unchanged from the Stealth Health migration)
DROP FUNCTION IF EXISTS adjust_stock_for_invoice(uuid);
DROP FUNCTION IF EXISTS restore_stock_for_invoice(uuid);

CREATE OR REPLACE FUNCTION adjust_stock_for_invoice(
  p_invoice_id  uuid,
  p_actor_email text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_already boolean;
BEGIN
  SELECT stock_adjusted INTO v_already
  FROM invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF v_already IS DISTINCT FROM false THEN
    RETURN;  -- not found, or already adjusted
  END IF;

  WITH agg AS (
    SELECT product_id, SUM(qty * COALESCE(vials_per_unit, 1))::int AS qty
    FROM invoice_line_items
    WHERE invoice_id = p_invoice_id
      AND product_id IS NOT NULL
    GROUP BY product_id
  ),
  before AS (
    SELECT p.id, COALESCE(p.stock_quantity, 0) AS old_qty, agg.qty
    FROM products p
    JOIN agg ON p.id = agg.product_id
  ),
  upd AS (
    UPDATE products p
    SET stock_quantity = GREATEST(0, b.old_qty - b.qty)
    FROM before b
    WHERE p.id = b.id
    RETURNING p.id
  )
  INSERT INTO product_history (
    product_id, change_type, field, old_value, new_value,
    source, reference_type, reference_id, note, actor_email
  )
  SELECT
    b.id, 'stock', 'stock_quantity',
    b.old_qty::text,
    GREATEST(0, b.old_qty - b.qty)::text,
    'invoice_paid', 'invoice', p_invoice_id::text,
    'Stock decremented by ' || b.qty || ' when invoice was marked paid',
    p_actor_email
  FROM before b;

  UPDATE invoices SET stock_adjusted = true WHERE id = p_invoice_id;
END;
$$;

CREATE OR REPLACE FUNCTION restore_stock_for_invoice(
  p_invoice_id  uuid,
  p_actor_email text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_adjusted boolean;
BEGIN
  UPDATE invoices
     SET stock_adjusted = false
   WHERE id = p_invoice_id
     AND stock_adjusted = true
  RETURNING stock_adjusted INTO v_adjusted;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  WITH agg AS (
    SELECT product_id, SUM(qty * COALESCE(vials_per_unit, 1))::int AS qty
    FROM invoice_line_items
    WHERE invoice_id = p_invoice_id
      AND product_id IS NOT NULL
    GROUP BY product_id
  ),
  before AS (
    SELECT p.id, COALESCE(p.stock_quantity, 0) AS old_qty, agg.qty
    FROM products p
    JOIN agg ON p.id = agg.product_id
  ),
  upd AS (
    UPDATE products p
    SET stock_quantity = b.old_qty + b.qty
    FROM before b
    WHERE p.id = b.id
    RETURNING p.id
  )
  INSERT INTO product_history (
    product_id, change_type, field, old_value, new_value,
    source, reference_type, reference_id, note, actor_email
  )
  SELECT
    b.id, 'stock', 'stock_quantity',
    b.old_qty::text,
    (b.old_qty + b.qty)::text,
    'invoice_cancel', 'invoice', p_invoice_id::text,
    'Stock restored (+' || b.qty || ') when invoice was cancelled',
    p_actor_email
  FROM before b;
END;
$$;

-- 4. Manual stock edits --------------------------------------------------------
-- The admin product editor writes stock through this instead of a plain
-- UPDATE, so the change and the "who did it" row commit together.
CREATE OR REPLACE FUNCTION set_product_stock(
  p_product_id  uuid,
  p_new_qty     integer,
  p_actor_id    uuid DEFAULT NULL,
  p_actor_email text DEFAULT NULL,
  p_source      text DEFAULT 'admin_edit',
  p_note        text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_old   integer;
  v_actor uuid;
BEGIN
  IF p_new_qty IS NULL OR p_new_qty < 0 THEN
    RAISE EXCEPTION 'Stock quantity must be zero or more';
  END IF;

  SELECT stock_quantity INTO v_old
    FROM products
   WHERE id = p_product_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product % not found', p_product_id;
  END IF;

  IF v_old IS NOT DISTINCT FROM p_new_qty THEN
    RETURN;
  END IF;

  -- actor_id is a FK to customers; an actor without a row keeps the email only.
  SELECT id INTO v_actor FROM customers WHERE id = p_actor_id;

  UPDATE products SET stock_quantity = p_new_qty WHERE id = p_product_id;

  INSERT INTO product_history
    (product_id, change_type, field, old_value, new_value,
     source, note, actor_id, actor_email)
  VALUES
    (p_product_id, 'stock', 'stock_quantity', v_old::text, p_new_qty::text,
     COALESCE(NULLIF(p_source, ''), 'admin_edit'), p_note, v_actor, p_actor_email);
END;
$$;

-- 5. Paid invoice lines that took no stock ---------------------------------------
-- A line paid without a product_id takes no stock (adjust_stock_for_invoice
-- skips it). This links each listed line to its product and pack size and,
-- when the invoice's stock pass has already run, takes that line's stock now.
-- Only lines still unlinked are touched, so a repeated call changes nothing.
--
-- p_links: [{ "line_id": uuid, "product_id": uuid, "vials_per_unit": int }]
-- Returns the number of lines linked.
CREATE OR REPLACE FUNCTION take_stock_for_invoice_lines(
  p_invoice_id  uuid,
  p_links       jsonb,
  p_actor_id    uuid DEFAULT NULL,
  p_actor_email text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_status   text;
  v_adjusted boolean;
  v_actor    uuid;
  v_count    integer := 0;
  elem       jsonb;
  v_line     uuid;
  v_prod     uuid;
  v_vpu      integer;
  v_qty      integer;
  v_take     integer;
  v_old      integer;
  v_new      integer;
BEGIN
  SELECT status, stock_adjusted INTO v_status, v_adjusted
    FROM invoices
   WHERE id = p_invoice_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice % not found', p_invoice_id;
  END IF;
  IF v_status <> 'paid' THEN
    RAISE EXCEPTION 'Only a paid invoice takes stock (this one is %)', v_status;
  END IF;

  SELECT id INTO v_actor FROM customers WHERE id = p_actor_id;

  FOR elem IN SELECT * FROM jsonb_array_elements(COALESCE(p_links, '[]'::jsonb))
  LOOP
    v_line := (elem->>'line_id')::uuid;
    v_prod := (elem->>'product_id')::uuid;
    v_vpu  := GREATEST(1, COALESCE((elem->>'vials_per_unit')::integer, 1));

    SELECT qty INTO v_qty
      FROM invoice_line_items
     WHERE id = v_line
       AND invoice_id = p_invoice_id
       AND product_id IS NULL
     FOR UPDATE;

    IF NOT FOUND THEN
      CONTINUE;  -- already linked (or not this invoice's line)
    END IF;

    SELECT COALESCE(stock_quantity, 0) INTO v_old
      FROM products
     WHERE id = v_prod
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product % not found', v_prod;
    END IF;

    UPDATE invoice_line_items
       SET product_id = v_prod,
           vials_per_unit = v_vpu
     WHERE id = v_line;

    -- Before the stock pass has run, linking is enough: the pass below takes it.
    IF v_adjusted THEN
      v_take := COALESCE(v_qty, 0) * v_vpu;
      v_new  := GREATEST(0, v_old - v_take);

      UPDATE products SET stock_quantity = v_new WHERE id = v_prod;

      INSERT INTO product_history
        (product_id, change_type, field, old_value, new_value,
         source, reference_type, reference_id, note, actor_id, actor_email)
      VALUES
        (v_prod, 'stock', 'stock_quantity', v_old::text, v_new::text,
         'invoice_paid', 'invoice', p_invoice_id::text,
         'Stock decremented by ' || v_take ||
           ' for an invoice line linked to its product after payment',
         v_actor, p_actor_email);
    END IF;

    v_count := v_count + 1;
  END LOOP;

  IF NOT v_adjusted THEN
    PERFORM adjust_stock_for_invoice(p_invoice_id, p_actor_email);
  END IF;

  RETURN v_count;
END;
$$;

-- 6. Safety net: log any stock change nothing else logged -------------------------
-- Deferred to commit, so it sees the history rows the RPCs insert after their
-- UPDATE. A change is "already recorded" when a stock row for the product with
-- the same resulting value was written in this transaction (created_at
-- defaults to now(), the transaction's start time, for both).
CREATE OR REPLACE FUNCTION log_untracked_stock_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claims jsonb;
  v_actor  uuid;
  v_email  text;
  v_via    text;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM product_history h
     WHERE h.product_id = NEW.id
       AND h.field = 'stock_quantity'
       AND h.created_at = now()
       AND h.new_value IS NOT DISTINCT FROM NEW.stock_quantity::text
  ) THEN
    RETURN NULL;
  END IF;

  -- A PostgREST request carries the caller's JWT claims; SQL editor sessions don't.
  BEGIN
    v_claims := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  EXCEPTION WHEN others THEN
    v_claims := NULL;
  END;

  v_email := NULLIF(v_claims->>'email', '');
  IF (v_claims->>'sub') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT id, COALESCE(v_email, email) INTO v_actor, v_email
      FROM customers
     WHERE id = (v_claims->>'sub')::uuid;
  END IF;
  v_via := COALESCE(NULLIF(v_claims->>'role', ''), session_user::text);

  INSERT INTO product_history
    (product_id, change_type, field, old_value, new_value,
     source, note, actor_id, actor_email)
  VALUES
    (NEW.id, 'stock', 'stock_quantity', OLD.stock_quantity::text, NEW.stock_quantity::text,
     'untracked',
     'Changed outside the admin tools (' || v_via || ')',
     v_actor, COALESCE(v_email, 'database:' || v_via));

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS products_stock_ledger ON products;
CREATE CONSTRAINT TRIGGER products_stock_ledger
  AFTER UPDATE OF stock_quantity ON products
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.stock_quantity IS DISTINCT FROM NEW.stock_quantity)
  EXECUTE FUNCTION log_untracked_stock_change();

-- 7. Server-only -----------------------------------------------------------------
-- The app calls these with the service-role key. Without this, any signed-in
-- (or anonymous) visitor could set stock through PostgREST's /rpc endpoint.
REVOKE EXECUTE ON FUNCTION set_product_stock(uuid, integer, uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION take_stock_for_invoice_lines(uuid, jsonb, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION set_product_stock(uuid, integer, uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION take_stock_for_invoice_lines(uuid, jsonb, uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';
