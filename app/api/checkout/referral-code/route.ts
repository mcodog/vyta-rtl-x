import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import { resolveReferralCodeOwner } from '@/lib/affiliate/commission';
import { isValidReferralCodeFormat, normalizeReferralCode } from '@/lib/affiliate/utils';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Same budget as the discount-code preview: this is where someone would guess.
const LIMIT = { max: 15, windowMs: 60_000 };

/**
 * POST /api/checkout/referral-code — does this affiliate code match anyone?
 *
 * Answered with exactly the rules the paid sale is credited by
 * (`resolveReferralCodeOwner`), so "matched" at checkout means the affiliate
 * will be credited. Like the discount-code preview, the response never names
 * the affiliate.
 *
 * Body: { code }. Returns { match, code } — `code` normalized.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`referral-code:${ip}`, LIMIT);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many attempts. Please wait a moment.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    );
  }

  const body = await req.json().catch(() => ({}));
  const code = normalizeReferralCode(typeof body?.code === 'string' ? body.code : '');
  if (!isValidReferralCodeFormat(code)) {
    return NextResponse.json({ match: false, code });
  }

  const owner = await resolveReferralCodeOwner(db, code);
  return NextResponse.json({ match: !!owner, code });
}
