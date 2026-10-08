import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import type { UserRole } from '@/lib/permissions';
import { fetchLeads, type Lead } from '@/lib/admin/customer-leads';
import { loadAffiliateReferrals } from '@/lib/admin/affiliate-referrals';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/** PostgREST caps an unbounded select at 1000 rows; ask for more explicitly. */
const ROW_LIMIT = 20000;

async function verifyStaff(req: NextRequest): Promise<boolean> {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return false;
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return false;
  const { data } = await db.from('customers').select('role').eq('id', user.id).single();
  const role = (data?.role ?? 'customer') as UserRole;
  return role === 'admin' || role === 'assistant';
}

export interface AffiliateDirectoryRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  wallet_address: string | null;
  active: boolean;
  created_at: string | null;
  commission_rate: number | null;
  /** The affiliate's active referral code, and how many times it's been used. */
  referral_code: string | null;
  referral_uses: number;
  /** Every code they hold, not just the active one. */
  code_count: number;
  total_earnings: number;
  pending_earnings: number;
  paid_earnings: number;
  commission_count: number;
  /**
   * Customers this affiliate brought in — bound to them, or credited through a
   * commissioned sale — and what those customers have spent. The affiliate's
   * own account is never one of them.
   */
  bound_customers: number;
  customer_revenue: number;
  last_commission_at: string | null;
  lead: Lead | null;
}

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * GET /api/admin/affiliates/directory
 *
 * Everything the affiliates desk shows, in one call: profile, referral code and
 * its usage, earnings split paid/pending, the customers bound to them and what
 * those customers have spent, and the lead record (who has claimed them, how
 * the relationship is going).
 *
 * Replaces the page's previous three calls — one of which ran a referral-code
 * and a commissions query PER AFFILIATE. Everything here is batched: five
 * queries plus a handful of batched order/invoice reads, regardless of how
 * many affiliates there are.
 */
export async function GET(req: NextRequest) {
  if (!(await verifyStaff(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const { data: affiliates, error } = await db
    .from('affiliates')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(ROW_LIMIT);

  if (error) {
    console.error('[affiliates/directory] affiliate read failed:', error);
    return NextResponse.json(
      { error: `Could not load affiliates: ${error.message}` },
      { status: 500 },
    );
  }

  const [codesRes, commissionsRes, boundRes, leadData] = await Promise.all([
    db.from('referral_codes').select('affiliate_id, code, active, uses_count').limit(ROW_LIMIT),
    db
      .from('commissions')
      .select('affiliate_id, order_id, invoice_id, amount, status, created_at')
      .limit(ROW_LIMIT),
    db
      .from('customers')
      .select('id, affiliate_id, email, first_name, last_name, created_at, has_completed_first_order')
      .not('affiliate_id', 'is', null)
      .limit(ROW_LIMIT),
    fetchLeads(db, { scope: 'affiliate' }),
  ]);

  if (codesRes.error) console.error('[affiliates/directory] codes:', codesRes.error.message);
  if (commissionsRes.error) console.error('[affiliates/directory] commissions:', commissionsRes.error.message);

  // --- referral codes -----------------------------------------------------
  // The active code is the one shown; uses are summed across every code, since
  // a retired code's referrals still happened.
  const codeInfo = new Map<string, { code: string | null; uses: number; count: number }>();
  for (const c of (codesRes.data ?? []) as any[]) {
    const entry = codeInfo.get(c.affiliate_id) ?? { code: null, uses: 0, count: 0 };
    entry.uses += num(c.uses_count);
    entry.count += 1;
    if (c.active && !entry.code) entry.code = c.code;
    codeInfo.set(c.affiliate_id, entry);
  }

  // --- commissions --------------------------------------------------------
  const commissionInfo = new Map<
    string,
    { pending: number; paid: number; count: number; lastAt: string | null }
  >();
  for (const c of (commissionsRes.data ?? []) as any[]) {
    const entry =
      commissionInfo.get(c.affiliate_id) ?? { pending: 0, paid: 0, count: 0, lastAt: null };
    const amount = num(c.amount);
    if (String(c.status).toLowerCase() === 'paid') entry.paid += amount;
    else entry.pending += amount;
    entry.count += 1;
    if (c.created_at && (!entry.lastAt || c.created_at > entry.lastAt)) entry.lastAt = c.created_at;
    commissionInfo.set(c.affiliate_id, entry);
  }

  // --- referred customers and their revenue -----------------------------
  // Bound customers AND buyers credited through a commission, with their
  // orders and paid invoices — a hosted sale is an invoice, never an order.
  const referrals = await loadAffiliateReferrals(db, (affiliates ?? []) as any[], {
    boundCustomers: (boundRes.data ?? []) as any[],
    commissions: (commissionsRes.data ?? []) as any[],
  });

  const rows: AffiliateDirectoryRow[] = ((affiliates ?? []) as any[]).map((a) => {
    const email = String(a.email ?? '').trim().toLowerCase();
    const codes = codeInfo.get(a.id) ?? { code: null, uses: 0, count: 0 };
    const comm = commissionInfo.get(a.id) ?? { pending: 0, paid: 0, count: 0, lastAt: null };
    const referred = referrals.get(a.id);

    return {
      id: a.id,
      first_name: a.first_name ?? null,
      last_name: a.last_name ?? null,
      email: a.email,
      wallet_address: a.wallet_address ?? null,
      active: a.active !== false,
      created_at: a.created_at ?? null,
      commission_rate: a.commission_rate != null ? num(a.commission_rate) : null,
      referral_code: codes.code,
      referral_uses: codes.uses,
      code_count: codes.count,
      total_earnings: round2(num(a.total_earnings)),
      pending_earnings: round2(comm.pending),
      paid_earnings: round2(comm.paid),
      commission_count: comm.count,
      bound_customers: referred?.customers.length ?? 0,
      customer_revenue: referred?.revenue ?? 0,
      last_commission_at: comm.lastAt,
      lead: leadData.leads.get(email) ?? null,
    };
  });

  return NextResponse.json({
    affiliates: rows,
    counts: {
      all: rows.length,
      active: rows.filter((r) => r.active).length,
      inactive: rows.filter((r) => !r.active).length,
      claimed: rows.filter((r) => r.lead?.claimed_by_id).length,
      unclaimed: rows.filter((r) => !r.lead?.claimed_by_id).length,
    },
    // False until customer-crm-migration.sql runs; the UI then explains why
    // everyone reads as unclaimed rather than implying nobody has claimed one.
    leadsAvailable: leadData.available,
  });
}
