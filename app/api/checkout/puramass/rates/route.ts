import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit, getClientIp, RATE_LIMITS } from '@/lib/rate-limit';
import { quoteHostedRates } from '@/lib/payments/puramass-rates-server';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * POST /api/checkout/puramass/rates — live courier options for the hosted
 * checkout screen.
 *
 * The admin-side twin of this is /api/admin/invoices/shipping-readiness, which
 * quotes Easyship for an invoice. This is the buyer-facing version: given the
 * address they just typed and how many vials are in the cart, return the
 * fastest handful of UPS / Canada Post services, each priced with the
 * admin's processing fee already folded in.
 *
 * Read-only — it creates no shipment and no order. The amounts it returns are
 * NOT trusted at hand-off either: /api/checkout/puramass re-quotes through the
 * same helper and matches on `courier_id`, so a price edited in the browser
 * never reaches Stealth Health.
 *
 * Body: { vials: number, destination: { country, postal_code, city, state? } }
 * Response: { live: boolean, rates: HostedShippingRate[], note: string | null }
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`puramass-rates:${ip}`, RATE_LIMITS.general);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const dest = (body?.destination ?? {}) as Record<string, unknown>;
  const country = String(dest.country ?? '').trim().toUpperCase();
  const postal = String(dest.postal_code ?? '').trim();
  const city = String(dest.city ?? '').trim();
  const state = String(dest.state ?? '').trim();
  if (!country || !postal || !city) {
    return NextResponse.json(
      { error: 'Enter a full address to see shipping options.' },
      { status: 400 },
    );
  }

  const quote = await quoteHostedRates(
    db,
    { country, postal_code: postal, city, state },
    Number(body?.vials),
  );
  return NextResponse.json(quote);
}
