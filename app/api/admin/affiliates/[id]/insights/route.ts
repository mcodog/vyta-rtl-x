import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { fetchEmailHistory, verifyCrmActor } from '@/lib/admin/crm-actions';
import { fetchLead } from '@/lib/admin/customer-leads';
import { loadAffiliateReferrals } from '@/lib/admin/affiliate-referrals';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const ROW_LIMIT = 5000;

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** YYYY-MM, for bucketing earnings into months. */
const monthKey = (iso: string): string => String(iso ?? '').slice(0, 7);

/**
 * GET /api/admin/affiliates/[id]/insights
 *
 * Everything the affiliate profile shows, in one call:
 *   • profile + the linked customer account, when there is one
 *   • lifetime performance: earnings paid vs pending, referrals, referred
 *     customers and what those customers have spent
 *   • every referral code they hold
 *   • their commission history, and earnings bucketed by month for the chart
 *   • the customers they brought in — bound to them or credited through a
 *     commissioned sale — with each one's spend
 *   • what those referrals actually buy, so you know what to tell them to push
 *   • the affiliate's own browsing journey, when they have a site account
 *   • the lead record and the outreach emails sent to them
 *
 * Read access is admin/assistant — the same people who work the desk.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const actor = await verifyCrmActor(db, req);
  if (!actor) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const id = params.id;
  const { data: affiliate, error } = await db
    .from('affiliates')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!affiliate) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const email = String((affiliate as any).email ?? '').trim().toLowerCase();

  const [codesRes, commissionsRes, boundRes, accountRes, leadResult, emailResult, activityRes] =
    await Promise.all([
      db
        .from('referral_codes')
        .select('id, code, active, uses_count, created_at')
        .eq('affiliate_id', id)
        .order('created_at', { ascending: false })
        .limit(ROW_LIMIT),
      db
        .from('commissions')
        .select('id, order_id, invoice_id, amount, order_total, commission_rate, status, paid_at, created_at')
        .eq('affiliate_id', id)
        .order('created_at', { ascending: false })
        .limit(ROW_LIMIT),
      db
        .from('customers')
        .select('id, affiliate_id, first_name, last_name, email, created_at, has_completed_first_order')
        .eq('affiliate_id', id)
        .order('created_at', { ascending: false })
        .limit(ROW_LIMIT),
      // The affiliate's own customer account, when one exists. Created with the
      // same id by the affiliate-create route; matched on email as a fallback.
      db
        .from('customers')
        .select('id, role, active, last_login_at, phone, preferred_currency')
        .eq('id', id)
        .maybeSingle(),
      fetchLead(db, email, 'affiliate'),
      fetchEmailHistory(db, email, 'affiliate'),
      // What the affiliate themselves is looking at on the site. Keyed on the
      // affiliate id because the create route writes `customers.id =
      // affiliates.id`; an affiliate seeded without an account simply has none.
      db
        .from('customer_activity')
        .select('*')
        .eq('customer_id', id)
        .order('created_at', { ascending: false })
        .limit(1000),
    ]);

  if (commissionsRes.error) {
    console.error('[affiliate-insights] commissions:', commissionsRes.error.message);
  }

  const codes = (codesRes.data ?? []) as any[];
  const commissions = (commissionsRes.data ?? []) as any[];
  const boundCustomers = (boundRes.data ?? []) as any[];

  // --- who they brought in, and what those people spent ----------------
  // Bound customers plus buyers credited through a commission (a referral- or
  // discount-code buyer is never bound), across orders AND invoices — a hosted
  // sale is an invoice. The affiliate's own account, bound to itself, is not a
  // referral.
  const referred = (
    await loadAffiliateReferrals(db, [affiliate as any], {
      boundCustomers,
      commissions: commissions.map((c) => ({ ...c, affiliate_id: id })),
      withProducts: true,
    })
  ).get(id) ?? { customers: [], revenue: 0, sales: 0, products: [] };

  const customers = referred.customers;

  // --- earnings ----------------------------------------------------------
  let pending = 0;
  let paid = 0;
  const byMonth = new Map<string, { earned: number; count: number }>();
  for (const c of commissions) {
    const amount = num(c.amount);
    if (String(c.status).toLowerCase() === 'paid') paid += amount;
    else pending += amount;

    const key = monthKey(c.created_at);
    if (!key) continue;
    const bucket = byMonth.get(key) ?? { earned: 0, count: 0 };
    bucket.earned += amount;
    bucket.count += 1;
    byMonth.set(key, bucket);
  }

  // Oldest-first, which is the direction the chart reads.
  const earningsByMonth = [...byMonth.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([month, v]) => ({ month, earned: round2(v.earned), count: v.count }));

  const customerRevenue = referred.revenue;
  // Biggest seller first — the order the chart reads best in.
  const products = referred.products;

  // --- the affiliate's own site journey ----------------------------------
  const activity = (activityRes.data ?? []) as any[];
  const pageCounts = new Map<string, { key: string; label: string; count: number; lastAt: string }>();
  for (const r of activity) {
    if (r.activity_type !== 'page' || !r.page_path) continue;
    const key = String(r.page_path);
    const existing = pageCounts.get(key);
    if (existing) existing.count += 1;
    // Rows are newest-first, so the first sighting carries the latest date.
    else {
      pageCounts.set(key, {
        key,
        label: String(r.page_title || r.page_path),
        count: 1,
        lastAt: r.created_at,
      });
    }
  }
  const pages = [...pageCounts.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
  const journey = activity
    .filter((r) => r.activity_type === 'page' && r.page_path)
    .slice(0, 60)
    .map((r) => ({
      path: String(r.page_path),
      title: r.page_title ? String(r.page_title) : null,
      at: r.created_at,
    }));

  return NextResponse.json({
    affiliate: {
      id: (affiliate as any).id,
      first_name: (affiliate as any).first_name ?? null,
      last_name: (affiliate as any).last_name ?? null,
      email: (affiliate as any).email,
      wallet_address: (affiliate as any).wallet_address ?? null,
      active: (affiliate as any).active !== false,
      commission_rate: (affiliate as any).commission_rate != null
        ? num((affiliate as any).commission_rate)
        : null,
      created_at: (affiliate as any).created_at ?? null,
      updated_at: (affiliate as any).updated_at ?? null,
    },
    // The affiliate's own shopping account, so the profile can link across to
    // the customer desk. Null when they were seeded without one.
    account: accountRes.data
      ? {
          id: accountRes.data.id,
          role: accountRes.data.role,
          active: accountRes.data.active,
          last_login_at: accountRes.data.last_login_at ?? null,
          phone: accountRes.data.phone ?? null,
          preferred_currency: accountRes.data.preferred_currency ?? null,
        }
      : null,
    lead: leadResult.lead,
    emails: emailResult.emails,
    capabilities: {
      claims: leadResult.available,
      emailLog: emailResult.available,
      // No account means no signed-in browsing was ever recorded for them.
      activity: Boolean(accountRes.data) && !activityRes.error,
    },
    codes: codes.map((c) => ({
      id: c.id,
      code: c.code,
      active: c.active !== false,
      uses_count: num(c.uses_count),
      created_at: c.created_at,
    })),
    commissions: commissions.slice(0, 200).map((c) => ({
      id: c.id,
      order_id: c.order_id,
      invoice_id: c.invoice_id ?? null,
      amount: round2(num(c.amount)),
      order_total: round2(num(c.order_total)),
      commission_rate: num(c.commission_rate),
      status: c.status,
      paid_at: c.paid_at,
      created_at: c.created_at,
    })),
    customers,
    products,
    pages,
    journey,
    earningsByMonth,
    stats: {
      totalEarnings: round2(num((affiliate as any).total_earnings)),
      pendingEarnings: round2(pending),
      paidEarnings: round2(paid),
      commissionCount: commissions.length,
      referralUses: codes.reduce((sum, c) => sum + num(c.uses_count), 0),
      activeCodes: codes.filter((c) => c.active !== false).length,
      boundCustomers: customers.length,
      convertedCustomers: customers.filter((c) => c.has_ordered).length,
      customerRevenue: round2(customerRevenue),
      lastCommissionAt: commissions[0]?.created_at ?? null,
    },
  });
}
