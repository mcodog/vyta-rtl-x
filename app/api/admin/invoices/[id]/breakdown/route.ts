import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getInvoiceCaller } from '@/lib/admin/invoice-access';
import { loadInvoiceBreakdown } from '@/lib/admin/invoice-breakdown';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/admin/invoices/[id]/breakdown
 *
 * Price before discount, the discount and what it was, and the affiliate's
 * cut, for the invoice detail view (see lib/admin/invoice-breakdown.ts). A
 * server route because the hand-off ledger, discount codes and commissions
 * are service-role only.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const caller = await getInvoiceCaller(db, req);
  if (!caller.ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  try {
    const breakdown = await loadInvoiceBreakdown(db, params.id);
    if (!breakdown) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }
    return NextResponse.json({ breakdown });
  } catch (err) {
    console.error(`[invoice-breakdown] ${params.id} failed:`, err);
    return NextResponse.json({ error: 'Could not load the breakdown' }, { status: 500 });
  }
}
