-- New York business dates
--
-- invoices.issue_date (and stealth_health_invoices.issue_date) defaulted to
-- CURRENT_DATE, which Supabase evaluates in UTC. Anything created after
-- 8pm New York time (7pm in winter) was stamped with the next day.
--
-- The app now sends issue_date explicitly; this makes the database default
-- agree, and corrects existing invoices that took the UTC default.
--
-- Safe to run more than once.

ALTER TABLE invoices
  ALTER COLUMN issue_date SET DEFAULT (now() AT TIME ZONE 'America/New_York')::date;

DO $$
BEGIN
  IF to_regclass('public.stealth_health_invoices') IS NOT NULL THEN
    ALTER TABLE stealth_health_invoices
      ALTER COLUMN issue_date SET DEFAULT (now() AT TIME ZONE 'America/New_York')::date;
  END IF;
END $$;

-- Backfill: only rows whose issue_date is exactly the UTC day of created_at
-- (i.e. it came from the old default) and that day differs from the New York
-- day. Dates someone set by hand are left alone.
UPDATE invoices
SET issue_date = (created_at AT TIME ZONE 'America/New_York')::date
WHERE created_at IS NOT NULL
  AND issue_date = (created_at AT TIME ZONE 'UTC')::date
  AND issue_date <> (created_at AT TIME ZONE 'America/New_York')::date;
