import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { logAuditServer } from '@/lib/admin/audit';
import { resolveStaffCaller } from '@/lib/affiliate/route-auth';
import { loadCommissionLedger } from '@/lib/admin/commission-ledger';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/admin/commissions — every affiliate and sales-person commission,
 * with its recipient and the invoice/order it came from. Staff.
 *
 * Read with the service role: the browser read this desk used before could
 * come back empty under RLS while the affiliates directory showed money owed.
 *
 * `?summary=1` returns only { pending, paid } totals, for the admin home.
 */
export async function GET(req: NextRequest) {
  const caller = await resolveStaffCaller(db, req, { allowAssistant: true });
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });

  if (new URL(req.url).searchParams.get('summary')) {
    const [aff, sales] = await Promise.all([
      db.from('commissions').select('amount, status').limit(20000),
      db.from('sales_commissions').select('amount, status').limit(20000),
    ]);
    let pending = 0;
    let paid = 0;
    for (const c of [...(aff.data ?? []), ...(sales.data ?? [])] as { amount: unknown; status: unknown }[]) {
      const amount = Number(c.amount) || 0;
      const status = String(c.status ?? '').toLowerCase();
      if (status === 'pending') pending += amount;
      else if (status === 'paid') paid += amount;
    }
    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    return NextResponse.json({ pending: round2(pending), paid: round2(paid) });
  }

  const ledger = await loadCommissionLedger(db);
  return NextResponse.json(ledger);
}

/**
 * POST /api/admin/commissions — mark pending commissions paid. Admin only.
 *
 * Body: { source: 'affiliate' | 'sales', ids: string[] }. Only rows still
 * pending are touched, so a double click can't re-stamp paid_at.
 * For an affiliate payout with a method and reference, use the Payouts panel
 * on the affiliate's profile instead — that keeps the payout ledger whole.
 */
export async function POST(req: NextRequest) {
  const caller = await resolveStaffCaller(db, req);
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });

  const body = (await req.json().catch(() => ({}))) ?? {};
  const source = body.source === 'sales' ? 'sales' : body.source === 'affiliate' ? 'affiliate' : null;
  const ids: string[] = Array.isArray(body.ids)
    ? body.ids.filter((x: unknown): x is string => typeof x === 'string')
    : [];
  if (!source || ids.length === 0) {
    return NextResponse.json({ error: 'source and ids are required' }, { status: 400 });
  }

  const table = source === 'affiliate' ? 'commissions' : 'sales_commissions';
  const { data, error } = await db
    .from(table)
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .in('id', ids)
    .eq('status', 'pending')
    .select('id');

  if (error) {
    console.error('[admin/commissions] mark paid failed:', error);
    return NextResponse.json({ error: 'Failed to update commissions' }, { status: 500 });
  }

  const actor = { actor_id: caller.staff.id, actor_email: caller.staff.email };
  await Promise.all(
    (data ?? []).map((row) =>
      logAuditServer(db, actor, {
        action: source === 'affiliate' ? 'commission.marked_paid' : 'sales_commission.marked_paid',
        entity_type: source === 'affiliate' ? 'commission' : 'sales_commission',
        entity_id: row.id,
      }),
    ),
  );

  return NextResponse.json({ updated: (data ?? []).length });
}
