import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyOrderClaim } from '@/lib/customer/order-link';

// Service-role client: the checks below are what stand between a token and
// someone else's order — keep them strict.
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/customer/orders/[id]/claim   body: { token }
 *
 * Links a guest order to the signed-in customer, from the "View Order
 * Details" link in their order confirmation email (lib/customer/order-link.ts).
 * Requires all of:
 *   • a valid Supabase session (Bearer),
 *   • a claim token signed for this order AND this account's email address,
 *   • the order not already belonging to a different account.
 * Works for Stealth Health orders (the invoice and its hand-off row) and
 * storefront `orders`. Idempotent; responds `{ linked: true }` when the order
 * is (now) the caller's.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const bearer = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!bearer) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { data: { user } } = await db.auth.getUser(bearer);
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const token = typeof body?.token === 'string' ? body.token : '';
  if (!UUID_RE.test(id) || !verifyOrderClaim(id, user.email, token)) {
    // Same answer for "bad token" and "wrong account": the link was sent to a
    // different address than the one signed in.
    return NextResponse.json(
      { error: 'This order link was sent to a different email address than the one you are signed in with.' },
      { status: 403 },
    );
  }

  // The claim links to the `customers` row, which shares the auth user's id.
  const { data: customer } = await db.from('customers').select('id').eq('id', user.id).maybeSingle();
  if (!customer) {
    return NextResponse.json({ error: 'Finish setting up your account, then try again.' }, { status: 409 });
  }

  try {
    // Stealth Health: the invoice is what the account pages read.
    const { data: invoice } = await db
      .from('invoices')
      .select('id, customer_id')
      .eq('id', id)
      .eq('source', 'stealth_health')
      .maybeSingle();
    if (invoice) {
      if (invoice.customer_id && invoice.customer_id !== user.id) {
        return NextResponse.json({ error: 'This order belongs to another account.' }, { status: 409 });
      }
      if (!invoice.customer_id) {
        await db.from('invoices').update({ customer_id: user.id }).eq('id', id).is('customer_id', null);
        await db
          .from('puramass_orders')
          .update({ customer_id: user.id })
          .eq('invoice_id', id)
          .is('customer_id', null);
      }
      return NextResponse.json({ linked: true });
    }

    const { data: order } = await db.from('orders').select('id, customer_id').eq('id', id).maybeSingle();
    if (order) {
      if (order.customer_id && order.customer_id !== user.id) {
        return NextResponse.json({ error: 'This order belongs to another account.' }, { status: 409 });
      }
      if (!order.customer_id) {
        await db.from('orders').update({ customer_id: user.id }).eq('id', id).is('customer_id', null);
      }
      return NextResponse.json({ linked: true });
    }

    return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  } catch (err) {
    console.error('[order-claim] failed:', err);
    return NextResponse.json({ error: 'Could not link this order. Please try again.' }, { status: 500 });
  }
}
