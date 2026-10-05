/**
 * The "View Order Details" link in the order confirmation email.
 *
 * Viewing an order needs an account. The button goes to /login (or /signup
 * when the address has no account yet) with `redirect` set to the order page,
 * so the buyer signs in or registers first and then lands on their order.
 *
 * Stealth Health buyers often check out as guests, so the order isn't linked
 * to any account. The order page URL therefore carries a claim token: an HMAC
 * of the order id and the address the confirmation went to. Signed in, the
 * page hands it to POST /api/customer/orders/[id]/claim, which links the
 * order to the account only if the token is valid AND the account's email is
 * that same address — so neither a forwarded email nor a guessed id can pull
 * someone else's order into another account.
 *
 * Server-only (node:crypto + the signing secret).
 */
import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

function secret(): string {
  const s = process.env.ORDER_LINK_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!s) throw new Error('ORDER_LINK_SECRET (or SUPABASE_SERVICE_ROLE_KEY) is not set');
  return s;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Claim token for one order and the address it was emailed to. */
export function signOrderClaim(orderId: string, email: string): string {
  return crypto
    .createHmac('sha256', secret())
    .update(`order-claim:v1:${orderId}:${normalizeEmail(email)}`, 'utf8')
    .digest('base64url');
}

/** Constant-time check of a claim token against the signed-in account's email. */
export function verifyOrderClaim(orderId: string, email: string, token: string): boolean {
  if (!token || !email) return false;
  const expected = Buffer.from(signOrderClaim(orderId, email));
  const provided = Buffer.from(token);
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

/** The customer order page, with the claim token for a guest order. */
export function orderPagePath(orderId: string, email: string): string {
  return `/account/orders/${encodeURIComponent(orderId)}?claim=${signOrderClaim(orderId, email)}`;
}

/**
 * The button target: sign in (existing account) or sign up (none yet), then
 * land on the order page. The email is prefilled on either form.
 */
export async function buildViewOrderUrl(
  db: SupabaseClient,
  siteUrl: string,
  orderId: string,
  email: string,
): Promise<string> {
  const normalized = normalizeEmail(email);
  let hasAccount = true; // on a lookup failure, sign-in is the safer default
  try {
    const { data, error } = await db
      .from('customers')
      .select('id')
      .ilike('email', normalized)
      .limit(1);
    if (!error) hasAccount = (data ?? []).length > 0;
  } catch {
    /* keep the default */
  }
  const params = new URLSearchParams({
    redirect: orderPagePath(orderId, normalized),
    email: normalized,
  });
  return `${siteUrl.replace(/\/$/, '')}/${hasAccount ? 'login' : 'signup'}?${params.toString()}`;
}
