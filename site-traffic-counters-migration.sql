-- ============================================================
-- Site traffic: a daily visitor count that does not depend on the cookie banner
-- ============================================================
--
-- Admin → Analytics counted visitors from `customer_activity`. An anonymous
-- visitor is only written there after they press Accept on the consent banner
-- (see MARKETING_ATTRIBUTION.md, "Consent"), and most real visitors never
-- touch the banner — so the Visitors figure missed nearly everyone.
--
-- This adds one plain TALLY per day instead: "N browsers visited the store
-- today". It carries no visitor id, no cookie value, no IP and no email, so
-- there is nothing personal in it to consent to and it counts everyone. Same
-- idea as landing-page-counters-migration.sql, for the whole site.
--
--   visitors — distinct browsers that opened the storefront that day. The
--              browser remembers only the date it was last counted (in local
--              storage) so it is counted once per day.
--
-- The day is the UTC date, matching how the analytics report buckets days.
--
-- Idempotent: safe to re-run. Until this runs, the report keeps counting
-- visitors the old way (consented visitors only).
--
-- Run this in the Supabase SQL editor (same as every other *-migration.sql).

CREATE TABLE IF NOT EXISTS site_traffic_daily (
  day       DATE PRIMARY KEY,
  visitors  INTEGER NOT NULL DEFAULT 0
);

COMMENT ON TABLE site_traffic_daily IS
  'Anonymous daily tally of storefront visitors. No identifiers.';

-- Service role only; written through site_traffic_bump below.
ALTER TABLE site_traffic_daily ENABLE ROW LEVEL SECURITY;

-- Add one visitor to today's tally in one statement, so two visits at the same
-- instant cannot overwrite each other's count. Takes no arguments, so a caller
-- cannot inflate the figure by more than one per call.
CREATE OR REPLACE FUNCTION site_traffic_bump() RETURNS VOID
LANGUAGE sql
AS $$
  INSERT INTO site_traffic_daily (day, visitors)
  VALUES ((now() AT TIME ZONE 'UTC')::date, 1)
  ON CONFLICT (day) DO UPDATE SET visitors = site_traffic_daily.visitors + 1;
$$;

-- Only the server calls it. Without this the public anon key could.
REVOKE ALL ON FUNCTION site_traffic_bump() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION site_traffic_bump() FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION site_traffic_bump() FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION site_traffic_bump() TO service_role;
  END IF;
END $$;
