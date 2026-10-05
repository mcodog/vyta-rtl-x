import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { logAuditServer } from '@/lib/admin/audit';
import { getAdminPaidAlertStatus, sendAdminPaidAlertManually } from '@/lib/admin/stealth-health-paid-alert';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function verifyStaff(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return { ok: false, role: 'customer', actor_id: null as string | null, actor_email: null as string | null };
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return { ok: false, role: 'customer', actor_id: null, actor_email: null };
  const { data } = await db.from('customers').select('role, email').eq('id', user.id).single();
  const role = data?.role ?? 'customer';
  return {
    ok: role === 'admin' || role === 'assistant',
    role,
    actor_id: user.id as string | null,
    actor_email: (data?.email ?? user.email ?? null) as string | null,
  };
}

function invoiceIdFrom(v: unknown): string | null {
  return typeof v === 'string' && UUID_RE.test(v.trim()) ? v.trim() : null;
}

// GET /api/admin/paid-alert-email?invoiceId=…
// Whether the admin "order paid" email went out for this invoice, its send
// history and recipients. `applicable: false` for a storefront order's invoice.
export async function GET(req: NextRequest) {
  const { ok } = await verifyStaff(req);
  if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const invoiceId = invoiceIdFrom(req.nextUrl.searchParams.get('invoiceId'));
  if (!invoiceId) return NextResponse.json({ error: 'Pass invoiceId.' }, { status: 400 });

  try {
    const status = await getAdminPaidAlertStatus(db, invoiceId);
    if (!status) return NextResponse.json({ applicable: false });
    return NextResponse.json({ applicable: true, ...status });
  } catch (err: any) {
    console.error('[paid-alert-email] status failed:', err);
    return NextResponse.json({ error: err?.message ?? 'Failed to load status' }, { status: 500 });
  }
}

// POST /api/admin/paid-alert-email  { invoiceId }
// Send (or resend) it now, to the Admin Email Notifications list. Admin only;
// assistants see the status read-only. Never automatic for manual invoices.
export async function POST(req: NextRequest) {
  const { ok, role, actor_id, actor_email } = await verifyStaff(req);
  if (!ok || role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const invoiceId = invoiceIdFrom(body?.invoiceId);
  if (!invoiceId) return NextResponse.json({ error: 'Pass invoiceId.' }, { status: 400 });

  try {
    const res = await sendAdminPaidAlertManually(db, invoiceId, { id: actor_id, email: actor_email });
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });

    await logAuditServer(db, { actor_id, actor_email }, {
      action: 'invoice.admin_paid_alert_sent',
      entity_type: 'invoice',
      entity_id: invoiceId,
    });
    return NextResponse.json({ success: true, to: res.to, sent_at: res.sentAt });
  } catch (err: any) {
    console.error('[paid-alert-email] send failed:', err);
    return NextResponse.json({ error: err?.message ?? 'The email could not be sent.' }, { status: 500 });
  }
}
