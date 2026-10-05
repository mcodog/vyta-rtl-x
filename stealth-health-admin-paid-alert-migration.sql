-- ============================================================
-- Stealth Health — admin "new order paid" email, sent once per order
-- ============================================================
--
-- When a Stealth Health order is paid, the Admin Email Notifications list
-- (Admin → Settings) gets one "New order: …" email
-- (lib/admin/stealth-health-paid-alert.ts). It goes out on whichever paid
-- signal comes first — the payment webhook, the poller, an admin refresh, or
-- an admin marking the invoice paid / recording the payment that settles it.
--
-- Paid signals repeat, so the send first claims the hand-off row by stamping
-- `admin_paid_alert_sent_at` (NULL → now()); only the caller that won the claim
-- sends. A failed send clears it again so the next signal retries. Every
-- attempt is logged to fulfillment_email_log with kind = 'admin_paid_alert'.
--
-- Idempotent: safe to re-run. Until this has run the alert still goes out, but
-- only on the webhook / admin action that saw the invoice turn paid, with no
-- retry if that one send fails.
--
-- Run this in the Supabase SQL editor (same as every other *-migration.sql).

ALTER TABLE puramass_orders ADD COLUMN IF NOT EXISTS admin_paid_alert_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN puramass_orders.admin_paid_alert_sent_at IS
  'When the admin "new order paid" email went out. NULL = not sent yet; set before sending so it goes out once.';

-- ------------------------------------------------------------
-- Backfill: stamp every hand-off that is ALREADY paid, so switching this on
-- doesn't re-alert the admins about past orders the next time a webhook, poll
-- or admin touches them. Unpaid hand-offs stay NULL so they alert when paid.
-- ------------------------------------------------------------

UPDATE puramass_orders SET admin_paid_alert_sent_at = now()
 WHERE admin_paid_alert_sent_at IS NULL
   AND status = 'paid';

UPDATE puramass_orders p SET admin_paid_alert_sent_at = now()
  FROM invoices i
 WHERE i.id = p.invoice_id
   AND i.status = 'paid'
   AND p.admin_paid_alert_sent_at IS NULL;

-- ------------------------------------------------------------
-- fulfillment_email_log.kind must accept 'admin_paid_alert'. Drop any CHECK
-- naming `kind` (order-confirmation-email-migration.sql does the same; the app
-- is the only writer). A rejected log insert never blocks the email itself.
-- ------------------------------------------------------------
DO $$
DECLARE c record;
BEGIN
  IF to_regclass('public.fulfillment_email_log') IS NULL THEN
    RETURN;
  END IF;
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.fulfillment_email_log'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%kind%'
  LOOP
    EXECUTE format('ALTER TABLE public.fulfillment_email_log DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

-- Make PostgREST pick the new column up immediately.
NOTIFY pgrst, 'reload schema';
