import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  sendOrderConfirmation,
  sendShippingNotification,
  sendCustomerWelcome,
  sendAffiliateWelcome,
} from '@/lib/email';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';

// Service-role client, used ONLY to verify that the recipient is a real party
// in the system before sending (never to return data).
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// This route sends branded transactional mail. It used to be a fully open
// relay: no auth, no rate limit, and both the recipient and the visible content
// came straight from the request body — so anyone could send authentic-looking
// "VYTA" email to any address (phishing / spam / reputation damage). It is
// now (1) rate limited per IP and (2) gated so the recipient must actually be a
// real party for the referenced resource: order emails require the order number
// and that the address matches that order's email; welcome emails require the
// address to belong to a known customer or affiliate.
export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  const rl = checkRateLimit(`email:${ip}`, { max: 10, windowMs: 60_000 });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many requests. Try again in ${rl.retryAfter}s.` },
      { status: 429 },
    );
  }

  try {
    const body = await request.json();
    const { type, ...data } = body;

    if (!type) {
      return NextResponse.json({ error: 'Missing email type' }, { status: 400 });
    }

    const to = String(data.to ?? '').trim().toLowerCase();
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return NextResponse.json({ error: 'Valid recipient required' }, { status: 400 });
    }

    // Recipient must be a legitimate party for the referenced resource.
    let allowed = false;
    if (type === 'order_confirmation' || type === 'shipping_notification') {
      const orderNumber = String(data.orderNumber ?? '').trim();
      if (orderNumber) {
        const { data: order } = await db
          .from('orders')
          .select('email')
          .eq('order_number', orderNumber)
          .maybeSingle();
        allowed = !!order && String(order.email ?? '').trim().toLowerCase() === to;
      }
    } else if (type === 'customer_welcome' || type === 'affiliate_welcome') {
      const [{ data: cust }, { data: aff }] = await Promise.all([
        db.from('customers').select('id').eq('email', to).maybeSingle(),
        db.from('affiliates').select('id').eq('email', to).maybeSingle(),
      ]);
      allowed = !!cust || !!aff;
    } else {
      return NextResponse.json({ error: `Unknown email type: ${type}` }, { status: 400 });
    }

    if (!allowed) {
      // Uniform response — don't reveal whether the resource/recipient exists.
      return NextResponse.json({ error: 'Recipient not permitted' }, { status: 403 });
    }

    let result;
    switch (type) {
      case 'order_confirmation': {
        // Links and images in this email are built server-side only; never
        // take them from the request body.
        const { viewOrderUrl: _url, ...rest } = data;
        result = await sendOrderConfirmation({
          ...rest,
          items: (Array.isArray(rest.items) ? rest.items : []).map(
            ({ imageUrl: _img, ...item }: Record<string, unknown>) => item,
          ),
        });
        break;
      }
      case 'shipping_notification':
        result = await sendShippingNotification(data);
        break;
      case 'customer_welcome':
        result = await sendCustomerWelcome(data);
        break;
      case 'affiliate_welcome':
        result = await sendAffiliateWelcome(data);
        break;
    }

    if (!result?.success) {
      return NextResponse.json({ error: result?.error ?? 'Failed to send' }, { status: 500 });
    }

    return NextResponse.json({ success: true, id: result.id });
  } catch (error: any) {
    console.error('Email API error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to send email' },
      { status: 500 },
    );
  }
}
