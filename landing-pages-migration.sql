-- ============================================================
-- Landing pages: an offer on another domain, honoured here
-- ============================================================
--
-- A landing page lives on its own domain (for example a clean pre-sell page an
-- ad points at) and sends the visitor on to vytabio.com with `?lp=<slug>` on
-- the link. From that moment this store:
--
--   1. records that the visitor came from that landing page — on their visitor
--      row, on their customer row when they sign up, and on every hosted order
--      they place;
--   2. carries the landing page's offer to checkout and puts its discount code
--      into the discount field for them, and applies it server-side at hand-off
--      even if the browser never did.
--
-- The offer IS a discount code (`discount_codes`), so everything the checkout
-- already does with codes — validation, expiry, usage limits, per-code revenue,
-- the ledger columns — applies unchanged. Two things codes could not say before
-- are added, because "Your first order is 35% off* — *excluding Bac water"
-- needs both:
--
--   • `first_order_only` — the code is refused to a buyer who has ordered
--     before, checked by customer id AND by email so a guest checkout counts;
--   • `excluded_product_ids` — products the percentage is not taken off.
--
-- The landing page itself reads its percentage from GET /api/landing/<slug>, so
-- the number the visitor is shown is the number the code takes off. See
-- LANDING_PAGES.md for the whole flow.
--
-- Adds:
--   1. discount_codes.first_order_only, discount_codes.excluded_product_ids
--   2. landing_pages                              — one row per landing page
--   3. visitor_attribution.first/last_landing_page — which page brought them
--   4. customers.attribution_landing_page         — frozen at signup
--   5. puramass_orders.landing_page               — frozen at hand-off
--
-- Idempotent: safe to re-run. Every call site reads and writes these columns
-- defensively, so the storefront keeps working unchanged until this has run —
-- and until it has, no landing offer is honoured (money fails closed).
--
-- Run this in the Supabase SQL editor (same as every other *-migration.sql).
-- Needs affiliate-discount-codes-payouts-migration.sql and
-- marketing-attribution-migration.sql to have been run first.

-- 1. Discount codes: first order only, and product exclusions -------------
ALTER TABLE discount_codes
  ADD COLUMN IF NOT EXISTS first_order_only BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS excluded_product_ids UUID[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN discount_codes.first_order_only IS
  'Refuse the code to a buyer who already has a paid or pending order (by customer id or email).';
COMMENT ON COLUMN discount_codes.excluded_product_ids IS
  'Products the code takes nothing off, e.g. bacteriostatic water. Empty = applies to the whole cart.';

-- 2. Landing pages -------------------------------------------------------
CREATE TABLE IF NOT EXISTS landing_pages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- What rides on the link as ?lp=<slug>. Lower-case letters, digits, dashes.
  slug              VARCHAR(40) NOT NULL UNIQUE
                      CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  -- Internal label, e.g. "Meta — standards page".
  name              TEXT NOT NULL,
  -- The domain the page is served from. Informational, and shown in admin.
  domain            TEXT,
  -- Where on vytabio.com the page's button lands.
  destination_path  TEXT NOT NULL DEFAULT '/products',
  -- The offer. Its percentage is what the page displays and what checkout
  -- takes off. NULL = the page records attribution but offers nothing.
  discount_code_id  UUID REFERENCES discount_codes(id) ON DELETE SET NULL,
  active            BOOLEAN NOT NULL DEFAULT true,
  notes             TEXT,
  created_by        UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_landing_pages_code ON landing_pages (discount_code_id);

COMMENT ON TABLE landing_pages IS
  'Off-site landing pages that link here with ?lp=<slug>. Each can carry a discount code that checkout applies automatically.';

-- Service role only: the public read (GET /api/landing/<slug>) goes through an
-- API route that chooses exactly which fields leave the building.
ALTER TABLE landing_pages ENABLE ROW LEVEL SECURITY;

-- 3. Which landing page brought each visitor -----------------------------
ALTER TABLE visitor_attribution
  ADD COLUMN IF NOT EXISTS first_landing_page TEXT,
  ADD COLUMN IF NOT EXISTS last_landing_page  TEXT;

CREATE INDEX IF NOT EXISTS idx_visitor_attr_first_lp
  ON visitor_attribution (first_landing_page) WHERE first_landing_page IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_visitor_attr_last_lp
  ON visitor_attribution (last_landing_page) WHERE last_landing_page IS NOT NULL;

-- 4. Frozen onto the customer when they sign up -------------------------
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS attribution_landing_page TEXT;

-- 5. Frozen onto every hosted order at hand-off -------------------------
ALTER TABLE puramass_orders
  ADD COLUMN IF NOT EXISTS landing_page TEXT;

CREATE INDEX IF NOT EXISTS idx_puramass_orders_landing_page
  ON puramass_orders (landing_page, created_at DESC) WHERE landing_page IS NOT NULL;

COMMENT ON COLUMN puramass_orders.landing_page IS
  'Slug of the landing page (landing_pages.slug) that sent this buyer, if any.';
