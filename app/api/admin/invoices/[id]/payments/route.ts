import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { logAuditServer } from '@/lib/admin/audit';
import { checkLowStockForProducts } from '@/lib/admin/low-stock';
import { adjustInvoiceStock } from '@/lib/admin/stock-ledger';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function verifyAdmin(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return { ok: false, userId: null as string | null, actor_email: null as string | null };
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return { ok: false, userId: null, actor_email: null };
  const { data } = await db.from('customers').select('id, email, role').eq('id', user.id).single();
  return { ok: data?.role === 'admin', userId: user.id, actor_email: data?.email ?? user.email ?? null };
}

/** Decrement stock once when an invoice becomes paid, then re-check low stock. */
async function settlePaidStock(invoiceId: string, actorEmail: string | null) {
  const stock = await adjustInvoiceStock(db, invoiceId, actorEmail);
  if (!stock.ok) console.error('adjust_stock_for_invoice failed:', stock.error);
  const { data: lines } = await db
    .from('invoice_line_items')
    .select('product_id')
    .eq('invoice_id', invoiceId);
  const productIds = (lines ?? []).map((l: any) => l.product_id).filter(Boolean);
  if (productIds.length) await checkLowStockForProducts(db, productIds);
}

// POST /api/admin/invoices/[id]/payments
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { ok, userId, actor_email } = await verifyAdmin(req);
  if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const body = await req.json();
  const { amount, method, reference_note } = body;
  const amt = Number(amount);

  if (!amt || amt <= 0) {
    return NextResponse.json({ error: 'Amount must be positive' }, { status: 400 });
  }
  if (!['card', 'cash', 'other'].includes(method)) {
    return NextResponse.json({ error: 'Invalid payment method' }, { status: 400 });
  }

  const { data: invoice, error: invErr } = await db
    .from('invoices')
    .select('total, status')
    .eq('id', params.id)
    .single();

  if (invErr || !invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  }

  // Guard against overpayment (allow a tiny rounding tolerance).
  const { data: prior } = await db
    .from('payments')
    .select('amount')
    .eq('invoice_id', params.id);
  const priorPaid = (prior ?? []).reduce((s, p) => s + Number(p.amount), 0);
  const invoiceTotal = Number(invoice.total);
  const amountDue = invoiceTotal - priorPaid;
  if (amt > amountDue + 0.001) {
    return NextResponse.json(
      { error: `Payment exceeds amount due ($${Math.max(0, amountDue).toFixed(2)})` },
      { status: 400 },
    );
  }

  const { error: pmtErr } = await db.from('payments').insert({
    invoice_id: params.id,
    amount: amt,
    method,
    reference_note: reference_note ?? null,
    recorded_by: userId,
  });
  if (pmtErr) return NextResponse.json({ error: pmtErr.message }, { status: 500 });

  const totalPaid = priorPaid + amt;
  const wasPaid = invoice.status === 'paid';

  let newStatus: string;
  if (totalPaid >= invoiceTotal - 0.001) newStatus = 'paid';
  else if (totalPaid > 0) newStatus = 'partial';
  else newStatus = invoice.status;

  await db
    .from('invoices')
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq('id', params.id);

  // First transition into `paid` decrements stock (idempotent in the DB).
  if (newStatus === 'paid' && !wasPaid) {
    await settlePaidStock(params.id, actor_email);
  }

  await logAuditServer(db, { actor_id: userId, actor_email }, {
    action: 'invoice.payment_recorded',
    entity_type: 'invoice',
    entity_id: params.id,
  });

  return NextResponse.json({ success: true, new_status: newStatus, total_paid: totalPaid });
}
