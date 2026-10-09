import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { callerCanWrite, getInvoiceCaller } from '@/lib/admin/invoice-access';
import { logAuditServer } from '@/lib/admin/audit';
import { creditHostedSale } from '@/lib/affiliate/commission-backfill';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const REASONS: Record<string, string> = {
  'not-hosted': 'Only Stealth Health sales earn affiliate commission.',
  'not-paid': 'The invoice is not paid.',
  'no-attribution': 'No active affiliate is behind this sale’s codes.',
  'no-base': 'Stealth Health reported no subtotal for this sale.',
  'already-recorded': 'A commission is already recorded for this invoice.',
  error: 'Could not record the commission.',
};

/**
 * POST /api/admin/invoices/[id]/commission — book the affiliate commission a
 * paid hosted sale missed, with the same rules the payment pass uses (see
 * lib/affiliate/commission-backfill.ts). Admin only; idempotent.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const caller = await getInvoiceCaller(db, req);
  if (!caller.ok || !callerCanWrite(caller.role)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const res = await creditHostedSale(db, params.id);
  if (!res.recorded) {
    const status = res.reason === 'error' ? 500 : res.reason === 'already-recorded' ? 409 : 422;
    return NextResponse.json({ error: REASONS[res.reason], reason: res.reason }, { status });
  }

  await logAuditServer(
    db,
    { actor_id: caller.actor_id, actor_email: caller.actor_email },
    { action: 'commission.backfilled', entity_type: 'commission', entity_id: res.commissionId },
  );
  return NextResponse.json({ commissionId: res.commissionId, amount: res.amount });
}
