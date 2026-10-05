-- ============================================================
-- Paid-order confirmation email — sent once, visible to admins
-- ============================================================
--
-- When an order is paid the buyer gets one "Order Confirmed" email
-- (lib/order-confirmation.ts). Paid signals repeat — Stealth Health webhook
-- retries, the poller, an admin marking the invoice paid — so the send first
-- claims the row by stamping `confirmation_email_sent_at` (NULL → now()) and
-- only the caller that won the claim sends. A failed send clears it again so
-- the next signal retries.
--
-- Every attempt is logged to fulfillment_email_log with
-- kind = 'order_confirmation'; the admin order / invoice / customer screens
-- read that log for the sent / not sent / failed status and send history.
--
-- Idempotent: safe to re-run. Until this has run the app sends NOTHING
-- automatically (it detects the missing column and logs a warning); the
-- admin's manual Send still works.
--
-- Run this in the Supabase SQL editor (same as every other *-migration.sql).

ALTER TABLE orders          ADD COLUMN IF NOT EXISTS confirmation_email_sent_at TIMESTAMPTZ;
ALTER TABLE puramass_orders ADD COLUMN IF NOT EXISTS confirmation_email_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN orders.confirmation_email_sent_at IS
  'When the paid-order confirmation email went out. NULL = not sent yet; set before sending so it goes out once.';
COMMENT ON COLUMN puramass_orders.confirmation_email_sent_at IS
  'When the paid-order confirmation email went out. NULL = not sent yet; set before sending so it goes out once.';

-- ------------------------------------------------------------
-- Backfill: stamp everything ALREADY paid, so switching this on doesn't email
-- past buyers the next time a webhook, poll or admin touches their order.
-- ------------------------------------------------------------

-- Storefront orders past "awaiting payment" (pending / received).
UPDATE orders SET confirmation_email_sent_at = now()
 WHERE confirmation_email_sent_at IS NULL
   AND status NOT IN ('pending', 'received');

-- …or whose invoice is already paid.
UPDATE orders o SET confirmation_email_sent_at = now()
  FROM invoices i
 WHERE i.order_id = o.id
   AND i.status = 'paid'
   AND o.confirmation_email_sent_at IS NULL;

-- Stealth Health hand-offs that are paid. NOT "has an invoice": hand-offs get
-- their invoice at checkout (pending_payment), so an unpaid one must stay
-- unstamped to be confirmed when it is paid.
UPDATE puramass_orders SET confirmation_email_sent_at = now()
 WHERE confirmation_email_sent_at IS NULL
   AND status = 'paid';

UPDATE puramass_orders p SET confirmation_email_sent_at = now()
  FROM invoices i
 WHERE i.id = p.invoice_id
   AND i.status = 'paid'
   AND p.confirmation_email_sent_at IS NULL;

-- ------------------------------------------------------------
-- fulfillment_email_log.kind must accept 'order_confirmation'.
-- An older migration created the table with
--   CHECK (kind IN ('packed', 'shipped', …));
-- Supabase reports (doesn't throw) a rejected insert, so the email would go
-- out while the admin history stayed empty. Drop any CHECK naming `kind`; the
-- app is the only writer.
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

-- The admin screens look the history up by order and by invoice.
CREATE INDEX IF NOT EXISTS idx_fulfillment_email_log_kind_order
  ON fulfillment_email_log (kind, order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fulfillment_email_log_kind_invoice
  ON fulfillment_email_log (kind, invoice_id) WHERE invoice_id IS NOT NULL;

-- Make PostgREST pick the new columns up immediately.
NOTIFY pgrst, 'reload schema';
