import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { logAuditServer } from '@/lib/admin/audit';
import {
  getConfirmationStatus,
  sendConfirmationManually,
  type ConfirmationTargetInput,
} from '@/lib/order-confirmation';

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

/** First of orderId / invoiceId / puramassOrderId that is a UUID. */
function parseTarget(source: { get(key: string): unknown }): ConfirmationTargetInput | null {
  const pick = (key: string) => {
    const v = source.get(key);
    return typeof v === 'string' && UUID_RE.test(v.trim()) ? v.trim() : null;
  };
  const orderId = pick('orderId');
  if (orderId) return { orderId };
  const invoiceId = pick('invoiceId');
  if (invoiceId) return { invoiceId };
  const puramassOrderId = pick('puramassOrderId');
  if (puramassOrderId) return { puramassOrderId };
  return null;
}

const BAD_TARGET = { error: 'Pass orderId, invoiceId or puramassOrderId.' };

// GET /api/admin/confirmation-email?orderId=… | invoiceId=… | puramassOrderId=…
// Whether the paid-order confirmation went out, its send history, and whether
// it can be sent now. `applicable: false` for a manual invoice with no order.
export async function GET(req: NextRequest) {
  const { ok } = await verifyStaff(req);
  if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const target = parseTarget(req.nextUrl.searchParams);
  if (!target) return NextResponse.json(BAD_TARGET, { status: 400 });

  try {
    const status = await getConfirmationStatus(db, target);
    if (!status) return NextResponse.json({ applicable: false });
    return NextResponse.json({ applicable: true, ...status });
  } catch (err: any) {
    console.error('[confirmation-email] status failed:', err);
    return NextResponse.json({ error: err?.message ?? 'Failed to load status' }, { status: 500 });
  }
}

// POST /api/admin/confirmation-email  { orderId | invoiceId | puramassOrderId }
// Send (or resend) the confirmation now. Admin only, like the other order and
// invoice writes; assistants see the status read-only.
export async function POST(req: NextRequest) {
  const { ok, role, actor_id, actor_email } = await verifyStaff(req);
  if (!ok || role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* empty body → bad target below */
  }
  const target = parseTarget({ get: (key: string) => body?.[key] });
  if (!target) return NextResponse.json(BAD_TARGET, { status: 400 });

  try {
    const res = await sendConfirmationManually(db, target, { id: actor_id, email: actor_email });
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });

    const [entity_type, entity_id] =
      'orderId' in target
        ? ['order', target.orderId]
        : 'invoiceId' in target
          ? ['invoice', target.invoiceId]
          : ['puramass_order', target.puramassOrderId];
    await logAuditServer(db, { actor_id, actor_email }, {
      action: 'order.confirmation_email_sent',
      entity_type,
      entity_id,
    });

    return NextResponse.json({ success: true, to: res.to, sent_at: res.sentAt });
  } catch (err: any) {
    console.error('[confirmation-email] send failed:', err);
    return NextResponse.json({ error: err?.message ?? 'The email could not be sent.' }, { status: 500 });
  }
}
