import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  verifyWarehouse,
  buildNotificationPreview,
  parseShipmentDetails,
  sendFulfillmentEmail,
} from '@/lib/warehouse/server';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// There is one customer email — "Your Order Has Shipped!" — so a `kind`
// param from older clients is ignored.

// GET /api/warehouse/queue/[id]/notify?preview=1
//     [&tracking_number=&carrier=&tracking_url=&delivery_from=&delivery_to=]
// The optional shipment details are what the sender typed — previewed, not saved.
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await verifyWarehouse(db, req);
  if (!auth.authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }
  if (!auth.canSendEmails) {
    return NextResponse.json({ error: 'Forbidden (no email permission)' }, { status: 403 });
  }

  const url = new URL(req.url);
  const details = parseShipmentDetails(url.searchParams);
  const preview = await buildNotificationPreview(db, params.id, details);
  if (!preview) return NextResponse.json({ error: 'invoice not found' }, { status: 404 });
  return NextResponse.json(preview);
}

// POST /api/warehouse/queue/[id]/notify
// body: { subject?, to? (one or more addresses, this email only),
//         tracking_number?, carrier?, tracking_url?,
//         delivery_from?, delivery_to? } — the body is the branded template;
// the shipment details go into this email only (not saved).
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await verifyWarehouse(db, req);
  if (!auth.authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }
  if (!auth.canSendEmails) {
    return NextResponse.json({ error: 'Forbidden (no email permission)' }, { status: 403 });
  }

  let body: Record<string, unknown> & { subject?: string; to?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const result = await sendFulfillmentEmail(db, auth, params.id, {
    subject: body.subject,
    to: body.to,
    details: parseShipmentDetails({ get: (key: string) => body[key] }),
  });

  if (!result.ok) {
    const badInput =
      result.error === 'no recipient' || !!result.error?.startsWith('invalid recipient');
    return NextResponse.json(result, { status: badInput ? 400 : 500 });
  }
  return NextResponse.json(result);
}
