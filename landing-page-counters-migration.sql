-- ============================================================
-- Landing pages: traffic counters that do not depend on the cookie banner
-- ============================================================
--
-- The first version of Admin → Landing Pages counted visitors from
-- `visitor_attribution`. That table only records an anonymous visitor after
-- they press Accept on the consent banner (see MARKETING_ATTRIBUTION.md,
-- "Consent"), so most real landing traffic — and every fresh incognito test —
-- never appeared.
--
-- This adds plain daily TALLIES per landing page instead. They carry no
-- visitor id, no cookie value, no IP and no email: just "N views, N clicks
-- through, N new browsers on this page today". There is nothing personal in
-- them to consent to, so they count everyone.
--
--   views     — the landing page was loaded (it read its offer from
--               GET /api/landing/<slug>)
--   arrivals  — someone clicked through and arrived on vytabio.com with
--               ?lp=<slug> (once per browser tab session)
--   visitors  — of those, the first arrival from that browser (a unique
--               visitor)
--
-- The rest of the report reads records the store keeps for every customer
-- regardless of consent: sign-ups from `customers.attribution_landing_page`,
-- checkouts and orders from `puramass_orders.landing_page`.
--
-- Idempotent: safe to re-run. Needs landing-pages-migration.sql first.
-- Until this runs, the report shows "—" for the three traffic columns and
-- everything else keeps working.
--
-- Run this in the Supabase SQL editor (same as every other *-migration.sql).

CREATE TABLE IF NOT EXISTS landing_page_daily (
  slug      TEXT NOT NULL,
  -- The business day, in the store's own time zone.
  day       DATE NOT NULL,
  views     INTEGER NOT NULL DEFAULT 0,
  arrivals  INTEGER NOT NULL DEFAULT 0,
  visitors  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (slug, day)
);

COMMENT ON TABLE landing_page_daily IS
  'Anonymous daily tallies per landing page: views, click-throughs, unique visitors. No identifiers.';

-- Service role only; written through landing_page_bump below.
ALTER TABLE landing_page_daily ENABLE ROW LEVEL SECURITY;

-- Add to today's tallies in one statement, so two visits at the same instant
-- cannot overwrite each other's count. Each call adds at most one of each —
-- an API route cannot inflate a page by passing a large number — and only for
-- a slug that exists, so junk slugs cannot fill the table.
CREATE OR REPLACE FUNCTION landing_page_bump(
  p_slug TEXT,
  p_views INTEGER DEFAULT 0,
  p_arrivals INTEGER DEFAULT 0,
  p_visitors INTEGER DEFAULT 0
) RETURNS VOID
LANGUAGE sql
AS $$
  INSERT INTO landing_page_daily (slug, day, views, arrivals, visitors)
  SELECT
    p_slug,
    (now() AT TIME ZONE 'America/Toronto')::date,
    LEAST(GREATEST(COALESCE(p_views, 0), 0), 1),
    LEAST(GREATEST(COALESCE(p_arrivals, 0), 0), 1),
    LEAST(GREATEST(COALESCE(p_visitors, 0), 0), 1)
  WHERE EXISTS (SELECT 1 FROM landing_pages WHERE slug = p_slug)
  ON CONFLICT (slug, day) DO UPDATE SET
    views    = landing_page_daily.views    + EXCLUDED.views,
    arrivals = landing_page_daily.arrivals + EXCLUDED.arrivals,
    visitors = landing_page_daily.visitors + EXCLUDED.visitors;
$$;

-- Only the server calls it. Without this the public anon key could.
REVOKE ALL ON FUNCTION landing_page_bump(TEXT, INTEGER, INTEGER, INTEGER) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION landing_page_bump(TEXT, INTEGER, INTEGER, INTEGER) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION landing_page_bump(TEXT, INTEGER, INTEGER, INTEGER) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION landing_page_bump(TEXT, INTEGER, INTEGER, INTEGER) TO service_role;
  END IF;
END $$;

-- The report looks sign-ups up by landing page.
CREATE INDEX IF NOT EXISTS idx_customers_attribution_landing_page
  ON customers (attribution_landing_page, created_at DESC)
  WHERE attribution_landing_page IS NOT NULL;
