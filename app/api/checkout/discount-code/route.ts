import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import { describeDiscount, lookupDiscountCode } from '@/lib/affiliate/discount-codes';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Tighter than the general budget: this is the endpoint someone would use to
// guess codes.
const LIMIT = { max: 15, windowMs: 60_000 };

/**
 * POST /api/checkout/discount-code — preview a discount code for the checkout.
 *
 * Display only. `/api/checkout/puramass` looks the code up again against the
 * catalog-priced cart and decides the money itself, so the subtotal sent here
 * only affects what the buyer is shown.
 *
 * The response never names the affiliate a code belongs to.
 *
 * It does say which products the code excludes and whether it is for first
 * orders only, so the checkout can take the saving off the right lines and say
 * why a line is not discounted.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`discount-code:${ip}`, LIMIT);
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: 'Too many attempts. Please wait a moment.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    );
  }

  const body = await req.json().catch(() => ({}));
  const subtotal = Number(body?.subtotal);

  let customerId: string | null = null;
  let email: string | null = null;
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (token) {
    try {
      const { data: { user } } = await db.auth.getUser(token);
      customerId = user?.id ?? null;
      email = user?.email ?? null;
    } catch {
      customerId = null;
    }
  }

  // The cart, as `{ productId, amount }` list totals, so a code that excludes
  // products is measured against what it applies to. Optional — without it the
  // whole subtotal counts, and the hand-off measures it properly either way.
  const lines = Array.isArray(body?.items)
    ? (body.items as any[])
        .map((l) => ({ productId: String(l?.productId ?? ''), amount: Number(l?.amount) }))
        .filter((l) => l.productId && Number.isFinite(l.amount) && l.amount >= 0)
    : undefined;

  // A guest's email is deliberately NOT taken from the body: this endpoint
  // would then answer "has this address ordered before?" for anyone who asked.
  // A signed-in buyer is checked against their own account and email here; a
  // guest's first-order status is checked at hand-off, with the email they pay
  // with.
  const result = await lookupDiscountCode(db, body?.code, {
    subtotal: Number.isFinite(subtotal) ? subtotal : 0,
    customerId,
    email,
    lines,
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.message });
  }

  return NextResponse.json({
    ok: true,
    code: result.code.code,
    percent: result.percent,
    discount_type: result.code.discount_type,
    discount_value: Number(result.code.discount_value),
    description: describeDiscount(result.code),
    first_order_only: result.code.first_order_only,
    excluded_product_ids: result.code.excluded_product_ids,
  });
}
