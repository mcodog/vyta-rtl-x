import { NextRequest, NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import {
  isPuramassConfigured,
  fetchPuramassOrderStatus,
  PuramassApiError,
} from '@/lib/payments/puramass';
import { applyPuramassStatus, type PuramassLedgerOrder } from '@/lib/payments/puramass-poll';
import { isMissingColumnError } from '@/lib/payments/puramass-columns';
import {
  expireStealthHealthInvoices,
  healStealthHealthPaidOrders,
} from '@/lib/payments/puramass-fulfillment';

/**
 * GET /api/cron/puramass-poll
 *
 * Pull-based payment confirmation for Stealth Health hosted-checkout
 * orders — the fallback for when the portal's webhook isn't delivered to this
 * project. One iteration of the manual "Refresh" action, on a timer.
 *
 * For each local order still `payment_pending` and within the 7-day link window
 * (+6h grace), read `GET /partner/store/orders/{transaction_id}` and apply the
 * result idempotently. Orders past the window are swept to `expired`. Paid
 * orders whose invoice or stock step failed are retried
 * (`healStealthHealthPaidOrders`).
 *
 * Authenticated with CRON_SECRET (same as the other /api/cron/* jobs), scheduled
 * via Supabase pg_cron — see supabase-cron-puramass-poll.sql.
 */

const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;
const GRACE_MS = 6 * 3600 * 1000; // clock-skew / just-in-time payment grace
const CONCURRENCY = 8;
const MAX_PER_RUN = 200;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function GET(req: NextRequest) {
  // Dedicated secret for this job, so it can be rotated independently of the
  // shared CRON_SECRET used by the other cron jobs. Falls back to CRON_SECRET
  // when PURAMASS_CRON_SECRET isn't set. Fails closed if neither is configured.
  const cronSecret = process.env.PURAMASS_CRON_SECRET || process.env.CRON_SECRET;
  // Accept the secret through THREE channels, because some proxy/edge layers
  // strip or reserve the `Authorization` header (which made this endpoint 401
  // even with the correct secret). Priority: custom header → query param →
  // Authorization bearer. Custom header is preferred (not logged in URLs).
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const headerKey = req.headers.get('x-cron-key') || '';
  const queryKey = req.nextUrl.searchParams.get('key') || '';
  const provided = headerKey || queryKey || bearer;
  if (!cronSecret || provided !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isPuramassConfigured()) {
    return NextResponse.json({ skipped: 'not_configured' });
  }

  const db = getSupabase();
  const now = Date.now();
  const windowStart = new Date(now - SEVEN_DAYS_MS - GRACE_MS).toISOString();

  // 1. Expiry sweep — pending orders past the link window become `expired`.
  let expired = 0;
  {
    const { data: sweptRows } = await db
      .from('puramass_orders')
      .update({ status: 'expired' })
      .eq('status', 'payment_pending')
      .lt('created_at', windowStart)
      .select('id, invoice_id');
    expired = sweptRows?.length ?? 0;
    await expireStealthHealthInvoices(db, (sweptRows ?? []).map((r: any) => r.invoice_id));
  }

  // 1b. Self-heal — paid orders whose invoice flip or stock decrement failed
  //     on an earlier pass. Runs before the poll so a rate-limit back-off
  //     below never skips it.
  const healed = await healStealthHealthPaidOrders(db);

  // 2. Poll set — still pending, within the window, has a transaction id.
  const pollQuery = (columns: string) =>
    db
      .from('puramass_orders')
      .select(columns)
      .eq('status', 'payment_pending')
      .gte('created_at', windowStart)
      .not('transaction_id', 'is', null)
      .order('created_at', { ascending: true })
      .limit(MAX_PER_RUN);

  let { data: pending, error } = await pollQuery(
    'id, status, transaction_id, customer_id, customer_email, customer_name, customer_phone, items, subtotal_cents, invoice_id, referral_code, currency, shipping_total_cents, shipping_courier_id, shipping_address, shipping_address_source, created_at',
  );

  // Shipping columns not there yet — drop just those, keeping the address ones.
  if (error && isMissingColumnError(error)) {
    console.warn('[puramass-poll] shipping columns unavailable, polling without them');
    ({ data: pending, error } = await pollQuery(
      'id, status, transaction_id, customer_id, customer_email, customer_name, customer_phone, items, subtotal_cents, invoice_id, referral_code, currency, shipping_address, shipping_address_source, created_at',
    ));
  }

  // Confirming payment must not depend on the address columns existing yet.
  if (error && isMissingColumnError(error)) {
    console.warn('[puramass-poll] address columns unavailable, polling without them');
    ({ data: pending, error } = await pollQuery(
      'id, status, transaction_id, customer_id, customer_email, items, subtotal_cents, invoice_id, referral_code, currency, created_at',
    ));
  }

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const orders = (pending ?? []) as unknown as PuramassLedgerOrder[];
  let polled = 0;
  let paid = 0;
  let cancelled = 0;
  let errors = 0;
  let rateLimited = false;

  for (const group of chunk(orders, CONCURRENCY)) {
    if (rateLimited) break; // back off on 429 — next run retries
    await Promise.all(
      group.map(async (order) => {
        if (!order.transaction_id) return;
        try {
          const remote = await fetchPuramassOrderStatus(order.transaction_id);
          polled += 1;
          const res = await applyPuramassStatus(db, order, remote);
          if (res.changed) {
            if (res.status === 'paid') paid += 1;
            else if (res.status === 'cancelled') cancelled += 1;
            else if (res.status === 'expired') expired += 1;
            console.log(
              `[puramass-poll] ${order.transaction_id}: ${order.status} → ${res.status}` +
                (res.materialized ? ' (fulfillment invoice created)' : ''),
            );
          }
        } catch (err) {
          errors += 1;
          if (err instanceof PuramassApiError && err.status === 429) {
            rateLimited = true;
          } else {
            console.error(`[puramass-poll] ${order.transaction_id} failed:`, err);
          }
        }
      }),
    );
  }

  return NextResponse.json({
    polled,
    paid,
    expired,
    cancelled,
    errors,
    rate_limited: rateLimited,
    pending_total: orders.length,
    healed_invoices: healed.rematerialized,
    healed_stock: healed.stockTaken,
  });
}
