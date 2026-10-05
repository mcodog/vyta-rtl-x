-- ============================================================
-- ECOMMERCE BACKEND MODULES MIGRATION
-- Modules: Inventory Management, Invoicing, Order Management
-- ============================================================

-- ============================================================
-- MODULE 1: INVENTORY MANAGEMENT
-- ============================================================

-- Suppliers
CREATE TABLE IF NOT EXISTS suppliers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  contact_name   text,
  email          text,
  phone          text,
  lead_time_days integer DEFAULT 7,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Extend products table with new fields
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS sku               text,
  ADD COLUMN IF NOT EXISTS cost_price        numeric(10,2),
  ADD COLUMN IF NOT EXISTS sale_price        numeric(10,2),
  ADD COLUMN IF NOT EXISTS weight_grams      integer,
  ADD COLUMN IF NOT EXISTS length_cm         numeric(8,2),
  ADD COLUMN IF NOT EXISTS width_cm          numeric(8,2),
  ADD COLUMN IF NOT EXISTS height_cm         numeric(8,2),
  ADD COLUMN IF NOT EXISTS supplier_id       uuid REFERENCES suppliers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS warehouse_location text,
  ADD COLUMN IF NOT EXISTS is_active         boolean NOT NULL DEFAULT true;

-- Product Variants
CREATE TABLE IF NOT EXISTS product_variants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id        uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku               text NOT NULL,
  option_name       text NOT NULL,   -- e.g. "Size", "Concentration"
  option_value      text NOT NULL,   -- e.g. "5mg", "10mg"
  qty_on_hand       integer NOT NULL DEFAULT 0,
  reorder_threshold integer NOT NULL DEFAULT 5,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, sku)
);

-- Inventory Log
CREATE TABLE IF NOT EXISTS inventory_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id   uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  change_qty   integer NOT NULL,   -- positive = add, negative = subtract
  reason       text NOT NULL CHECK (reason IN ('sale','return','adjustment','restock')),
  reference_id text,               -- order id, return id, etc.
  note         text,
  created_by   uuid REFERENCES customers(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Indexes for Inventory
CREATE INDEX IF NOT EXISTS idx_product_variants_product_id ON product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_sku ON product_variants(sku);
CREATE INDEX IF NOT EXISTS idx_inventory_log_variant_id ON inventory_log(variant_id);
CREATE INDEX IF NOT EXISTS idx_inventory_log_created_at ON inventory_log(created_at DESC);

-- Updated_at trigger for product_variants
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS product_variants_updated_at ON product_variants;
CREATE TRIGGER product_variants_updated_at
  BEFORE UPDATE ON product_variants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Low-stock notification function (called by the API layer)
CREATE OR REPLACE FUNCTION get_low_stock_variants()
RETURNS TABLE (
  variant_id        uuid,
  product_id        uuid,
  product_name      text,
  sku               text,
  option_name       text,
  option_value      text,
  qty_on_hand       integer,
  reorder_threshold integer
) LANGUAGE sql STABLE AS $$
  SELECT
    pv.id,
    pv.product_id,
    p.name,
    pv.sku,
    pv.option_name,
    pv.option_value,
    pv.qty_on_hand,
    pv.reorder_threshold
  FROM product_variants pv
  JOIN products p ON p.id = pv.product_id
  WHERE pv.qty_on_hand < pv.reorder_threshold
  ORDER BY (pv.qty_on_hand::float / NULLIF(pv.reorder_threshold, 0)) ASC;
$$;

-- ============================================================
-- MODULE 2: INVOICING
-- ============================================================

-- Invoice number sequence
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START 1000;

-- Invoices
CREATE TABLE IF NOT EXISTS invoices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number text NOT NULL UNIQUE DEFAULT ('VYTA-' || nextval('invoice_number_seq')),
  order_id       uuid REFERENCES orders(id) ON DELETE SET NULL,
  customer_id    uuid REFERENCES customers(id) ON DELETE SET NULL,
  issue_date     date NOT NULL DEFAULT CURRENT_DATE,
  due_date       date NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '30 days'),
  subtotal       numeric(10,2) NOT NULL DEFAULT 0,
  tax_total      numeric(10,2) NOT NULL DEFAULT 0,
  shipping_cost  numeric(10,2) NOT NULL DEFAULT 0,
  total          numeric(10,2) NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','sent','paid','partial','overdue')),
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Invoice Line Items
CREATE TABLE IF NOT EXISTS invoice_line_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id          uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_variant_id  uuid REFERENCES product_variants(id) ON DELETE SET NULL,
  description         text NOT NULL,
  qty                 integer NOT NULL DEFAULT 1,
  unit_price          numeric(10,2) NOT NULL,
  discount_pct        numeric(5,2) NOT NULL DEFAULT 0,
  line_total          numeric(10,2) NOT NULL
);

-- Payments
CREATE TABLE IF NOT EXISTS payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id     uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount         numeric(10,2) NOT NULL,
  method         text NOT NULL CHECK (method IN ('card','e-transfer','cash','other')),
  reference_note text,
  paid_at        timestamptz NOT NULL DEFAULT now(),
  recorded_by    uuid REFERENCES customers(id) ON DELETE SET NULL
);

-- Indexes for Invoicing
CREATE INDEX IF NOT EXISTS idx_invoices_customer_id ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_order_id ON invoices(order_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON invoices(due_date);
CREATE INDEX IF NOT EXISTS idx_invoice_line_items_invoice_id ON invoice_line_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice_id ON payments(invoice_id);

-- Updated_at trigger for invoices
DROP TRIGGER IF EXISTS invoices_updated_at ON invoices;
CREATE TRIGGER invoices_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Automatically mark invoices as overdue
CREATE OR REPLACE FUNCTION mark_overdue_invoices()
RETURNS void LANGUAGE sql AS $$
  UPDATE invoices
  SET status = 'overdue'
  WHERE due_date < CURRENT_DATE
    AND status IN ('sent', 'partial');
$$;

-- ============================================================
-- MODULE 3: ORDER MANAGEMENT EXTENSIONS
-- ============================================================

-- Extend orders table with new fields
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS billing_address     jsonb,
  ADD COLUMN IF NOT EXISTS shipping_method     text,
  ADD COLUMN IF NOT EXISTS shipping_carrier    text,
  ADD COLUMN IF NOT EXISTS shipping_cost       numeric(10,2),
  ADD COLUMN IF NOT EXISTS discount_total      numeric(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_total           numeric(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS subtotal            numeric(10,2),
  ADD COLUMN IF NOT EXISTS staff_notes         text,
  ADD COLUMN IF NOT EXISTS easyship_shipment_id text,
  ADD COLUMN IF NOT EXISTS packed_at           timestamptz,
  ADD COLUMN IF NOT EXISTS shipped_at          timestamptz,
  ADD COLUMN IF NOT EXISTS delivered_at        timestamptz,
  ADD COLUMN IF NOT EXISTS refunded_at         timestamptz;

-- Extend order_items table
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS product_variant_id  uuid REFERENCES product_variants(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sku_snapshot        text,
  ADD COLUMN IF NOT EXISTS name_snapshot       text,
  ADD COLUMN IF NOT EXISTS discount_pct        numeric(5,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS line_total          numeric(10,2),
  ADD COLUMN IF NOT EXISTS restocked           boolean NOT NULL DEFAULT false;

-- Index for fast order search
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product_variant_id ON order_items(product_variant_id);

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================

-- Enable RLS
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

-- Service-role bypass policy (all tables)
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['suppliers','product_variants','inventory_log','invoices','invoice_line_items','payments']
  LOOP
    EXECUTE format('
      DROP POLICY IF EXISTS service_role_all ON %I;
      CREATE POLICY service_role_all ON %I
        USING (true) WITH CHECK (true);
    ', tbl, tbl);
  END LOOP;
END;
$$;
