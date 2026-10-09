import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { logAuditServer } from '@/lib/admin/audit';
import { resolveStaffCaller } from '@/lib/affiliate/route-auth';
import { backfillHostedCommissions } from '@/lib/affiliate/commission-backfill';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export const maxDuration = 60;

/**
 * POST /api/admin/commissions/backfill — run every paid hosted sale that has
 * no affiliate commission back through the recorder, booking the ones that
 * should have earned one. Admin only; safe to repeat.
 */
export async function POST(req: NextRequest) {
  const caller = await resolveStaffCaller(db, req);
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });

  try {
    const summary = await backfillHostedCommissions(db);
    if (summary.recorded > 0) {
      await logAuditServer(
        db,
        { actor_id: caller.staff.id, actor_email: caller.staff.email },
        { action: 'commission.backfilled', entity_type: 'commission', entity_id: null },
      );
    }
    return NextResponse.json(summary);
  } catch (err) {
    console.error('[admin/commissions] backfill failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Backfill failed' },
      { status: 500 },
    );
  }
}
