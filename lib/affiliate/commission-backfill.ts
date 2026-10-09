/**
 * Book affiliate commissions that a paid hosted (Stealth Health) sale should
 * have earned but never did.
 *
 * `recordAffiliateCommission` runs on every webhook/poll pass of a paid order,
 * but the poller stops revisiting an order once it has seen `paid`. So a sale
 * whose attribution failed at the time — most often a referral link carrying
 * an affiliate's discount code, which the resolver used not to recognise —
 * stays uncredited for good. This re-runs the same recorder,
 * with the same inputs the payment pass used, for one invoice or for every
 * paid sale without a commission.
 *
 * Safe to repeat: the recorder is idempotent on `commissions.invoice_id`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { recordAffiliateCommission, type RecordCommissionResult } from './commission';

type Row = Record<string, any>;

export type CreditHostedSaleResult =
  | RecordCommissionResult
  | { recorded: false; reason: 'not-hosted' | 'not-paid' };

const LEDGER_COLUMNS = 'id, invoice_id, customer_id, subtotal_cents, referral_code, discount_code_id';

function creditFromLedger(db: SupabaseClient, ledger: Row): Promise<RecordCommissionResult> {
  return recordAffiliateCommission(db, {
    invoiceId: String(ledger.invoice_id),
    subtotalCents: typeof ledger.subtotal_cents === 'number' ? ledger.subtotal_cents : null,
    customerId: ledger.customer_id ?? null,
    referralCode: ledger.referral_code ?? null,
    discountCodeId: ledger.discount_code_id ?? null,
  });
}

/** Credit the affiliate on one paid hosted invoice, if it earns one. */
export async function creditHostedSale(
  db: SupabaseClient,
  invoiceId: string,
): Promise<CreditHostedSaleResult> {
  const [{ data: invoice }, { data: ledger }] = await Promise.all([
    db.from('invoices').select('id, status').eq('id', invoiceId).maybeSingle(),
    db.from('puramass_orders').select(LEDGER_COLUMNS).eq('invoice_id', invoiceId).limit(1).maybeSingle(),
  ]);
  if (!ledger) return { recorded: false, reason: 'not-hosted' };
  if (!invoice || invoice.status !== 'paid') return { recorded: false, reason: 'not-paid' };
  return creditFromLedger(db, ledger as Row);
}

export interface BackfillSummary {
  /** Paid hosted sales with no commission that were looked at. */
  checked: number;
  /** Commissions booked by this run. */
  recorded: number;
  /** Sum of the commissions booked, CAD. */
  amount: number;
  /** Sales that credit nobody (no affiliate behind any code). */
  unattributed: number;
  /** Sales that hit an error; see the server log. */
  failed: number;
}

const CHUNK = 150;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Every paid hosted sale (newest first, up to `limit`) with no commission row,
 * run back through the recorder.
 */
export async function backfillHostedCommissions(
  db: SupabaseClient,
  { limit = 500 }: { limit?: number } = {},
): Promise<BackfillSummary> {
  const summary: BackfillSummary = { checked: 0, recorded: 0, amount: 0, unattributed: 0, failed: 0 };

  const { data: rows, error } = await db
    .from('puramass_orders')
    .select(LEDGER_COLUMNS)
    .eq('status', 'paid')
    .not('invoice_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Could not read paid orders: ${error.message}`);
  const ledgers = (rows ?? []) as Row[];
  if (ledgers.length === 0) return summary;

  // Drop the ones already credited and the ones whose invoice is no longer
  // paid (cancelled or refunded since).
  const invoiceIds = [...new Set(ledgers.map((l) => String(l.invoice_id)))];
  const credited = new Set<string>();
  const paid = new Set<string>();
  for (const ids of chunks(invoiceIds, CHUNK)) {
    const [{ data: comms, error: cErr }, { data: invs, error: iErr }] = await Promise.all([
      db.from('commissions').select('invoice_id').in('invoice_id', ids),
      db.from('invoices').select('id, status').in('id', ids),
    ]);
    if (cErr) throw new Error(`Could not read commissions: ${cErr.message}`);
    if (iErr) throw new Error(`Could not read invoices: ${iErr.message}`);
    for (const c of (comms ?? []) as Row[]) credited.add(String(c.invoice_id));
    for (const i of (invs ?? []) as Row[]) if (i.status === 'paid') paid.add(String(i.id));
  }

  const seen = new Set<string>();
  const todo = ledgers.filter((l) => {
    const id = String(l.invoice_id);
    if (seen.has(id) || credited.has(id) || !paid.has(id)) return false;
    seen.add(id);
    return true;
  });
  summary.checked = todo.length;

  // A few at a time: each one is a handful of small reads and one insert.
  for (const batch of chunks(todo, 8)) {
    const results = await Promise.all(batch.map((l) => creditFromLedger(db, l)));
    for (const res of results) {
      if (res.recorded) {
        summary.recorded += 1;
        summary.amount += res.amount;
      } else if (res.reason === 'error') summary.failed += 1;
      else if (res.reason === 'no-attribution') summary.unattributed += 1;
    }
  }
  summary.amount = Math.round((summary.amount + Number.EPSILON) * 100) / 100;
  return summary;
}
