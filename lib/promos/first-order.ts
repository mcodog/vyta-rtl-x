/**
 * Has this customer already used their welcome discount?
 *
 * The paid-ads offer (lib/promos/ad-discount.ts) is a WELCOME discount: it
 * applies to a buyer's first order and not to the ones after it. That makes
 * "is this their first order?" a money decision, so it is answered here, once,
 * server-side — and both the storefront (`/api/promos/first-order`, read by
 * `PromosContext`) and the hand-off itself (`/api/checkout/puramass`) call this
 * same function. The strip under the nav bar and the prices actually charged
 * therefore cannot drift into disagreeing about who is still a first-time buyer.
 *
 * ## What counts as having ordered
 *
 * Two records, because the store has two checkouts and a buyer may have used
 * either:
 *
 *   • `customers.has_completed_first_order` — flipped when a LEGACY order is
 *     paid or confirmed (`/api/orders/check-payment`, the admin status route).
 *     The hosted checkout never writes it, so it alone is not enough.
 *   • a row in `puramass_orders` for this customer in a status that consumes
 *     the offer — see below. This is what covers the hosted checkout, whose
 *     ledger row IS the record of the order.
 *
 * ## Why a pending hand-off consumes it
 *
 * `payment_pending` counts, not just `paid`. The discount is applied at
 * hand-off — before anything is paid — so counting only `paid` would let
 * someone hand off ten discounted checkouts before settling any of them and
 * pay 25% under list on all ten. Counting the pending row closes that.
 *
 * It is not a one-way door: an unpaid hand-off becomes `expired` (or
 * `cancelled`) once `lib/payments/puramass-poll.ts` catches up with it, and
 * those statuses are NOT in the list — so a buyer who simply abandoned a
 * checkout gets their welcome offer back rather than losing it to a link they
 * never used.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Hosted-order statuses that use up the welcome discount.
 *
 * `expired` and `cancelled` are deliberately absent: an abandoned checkout is
 * not an order, and the offer returns when the link dies.
 */
export const WELCOME_DISCOUNT_CONSUMING_STATUSES = [
  'paid',
  'payment_pending',
] as const;

/**
 * True when `customerId` has not ordered yet and so still has the welcome
 * discount available.
 *
 * Fails CLOSED: a signed-out visitor, or a read that errors, returns false.
 * This gates money, and the rest of the promo does the same (see
 * `DEFAULT_AD_DISCOUNT`) — an install that cannot answer the question should
 * discount nothing rather than discount every order of every repeat buyer.
 */
export async function isCustomerFirstOrder(
  db: SupabaseClient<any, any, any>,
  customerId: string | null | undefined,
): Promise<boolean> {
  if (!customerId) return false;

  // 1. The legacy flag — set once a non-hosted order is paid or confirmed.
  try {
    const { data, error } = await db
      .from('customers')
      .select('has_completed_first_order')
      .eq('id', customerId)
      .maybeSingle();
    if (error) return false;
    if (data?.has_completed_first_order) return false;
  } catch {
    return false;
  }

  // 2. A hosted hand-off that is paid, or still live and awaiting payment.
  try {
    const { count, error } = await db
      .from('puramass_orders')
      .select('id', { count: 'exact', head: true })
      .eq('customer_id', customerId)
      .in('status', [...WELCOME_DISCOUNT_CONSUMING_STATUSES]);
    if (error) return false;
    if ((count ?? 0) > 0) return false;
  } catch {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// First order by customer id OR email — for first-order-only discount codes
// ---------------------------------------------------------------------------

/**
 * Where a buyer stands with a first-order-only offer.
 *
 *   first    — no paid order on record: the offer is theirs.
 *   ordered  — a paid order (hosted, or legacy by flag or email) exists.
 *   unknown  — no identity to check, or a read failed. Callers that decide
 *              money treat this as "not first" (fail closed).
 *
 * An unpaid hosted checkout (`payment_pending`) does NOT hold the offer here.
 * It used to, and it refused buyers their code on a checkout they had only
 * just started: the hand-off writes its pending row before the buyer reaches
 * the payment page, so going back to change the cart — or a second attempt
 * after a failed card — found that row and was turned away. Those rows also
 * stay pending until the poller hears the link expired, which can be days.
 * A first-order code is redeemed by paying, so only a paid order uses it up.
 */
export type FirstOrderStatus = 'first' | 'ordered' | 'unknown';

/**
 * Legacy (pre-hosted-checkout) order statuses that mean the order went
 * through. `payment_confirmed_at` is checked as well, for crypto orders.
 */
const LEGACY_COMPLETED_STATUSES = ['confirmed', 'paid', 'processing', 'shipped', 'delivered', 'completed'];

/** Lower-cased, trimmed, or null when it is not plausibly an email. */
export function normalizeOrderEmail(raw: unknown): string | null {
  const email = String(raw ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/**
 * Escape `%`, `_` and `\` so an email can be matched with ILIKE as a literal.
 * Emails routinely contain `_`, which ILIKE would otherwise read as "any one
 * character" — a false match there would refuse a genuine first-time buyer.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Has this buyer ordered before? Checked against every record a past order
 * could have left, by customer id AND by email, because a first-order-only
 * code is also offered to guests — and a guest's history is only findable by
 * the email they check out with:
 *
 *   • `customers.has_completed_first_order`, on their own row and on any
 *     account registered to the same email;
 *   • paid hosted orders (`puramass_orders`) under their customer id or
 *     email (an unpaid one does not count — see `FirstOrderStatus`);
 *   • legacy orders (`orders`) placed with the same email.
 *
 * Emails are matched case-insensitively: the hosted ledger stores the address
 * as it was typed.
 */
export async function firstOrderStatus(
  db: SupabaseClient<any, any, any>,
  identity: { customerId?: string | null; email?: string | null },
): Promise<FirstOrderStatus> {
  const customerId = identity.customerId || null;
  const email = normalizeOrderEmail(identity.email);
  if (!customerId && !email) return 'unknown';
  const pattern = email ? escapeLike(email) : null;
  const paid = ['paid'];

  try {
    const reads = await Promise.all([
      customerId
        ? db.from('customers').select('has_completed_first_order').eq('id', customerId).maybeSingle()
        : null,
      pattern
        ? db.from('customers').select('has_completed_first_order').ilike('email', pattern).limit(5)
        : null,
      customerId
        ? db.from('puramass_orders').select('status').eq('customer_id', customerId).in('status', paid).limit(20)
        : null,
      pattern
        ? db.from('puramass_orders').select('status').ilike('customer_email', pattern).in('status', paid).limit(20)
        : null,
      pattern
        ? db
            .from('orders')
            .select('status, payment_confirmed_at')
            .ilike('email', pattern)
            .limit(20)
        : null,
    ]);

    // Any read that errored makes the answer unknown — never a guess.
    if (reads.some((r: any) => r && r.error)) return 'unknown';
    const [byId, byEmail, hostedById, hostedByEmail, legacy] = reads as any[];

    const rows = (r: any): any[] => (r ? (Array.isArray(r.data) ? r.data : r.data ? [r.data] : []) : []);

    if (rows(byId).some((c) => c.has_completed_first_order)) return 'ordered';
    if (rows(byEmail).some((c) => c.has_completed_first_order)) return 'ordered';
    if (
      rows(legacy).some(
        (o) => !!o.payment_confirmed_at || LEGACY_COMPLETED_STATUSES.includes(String(o.status)),
      )
    ) {
      return 'ordered';
    }

    const hosted = [...rows(hostedById), ...rows(hostedByEmail)];
    if (hosted.some((o) => o.status === 'paid')) return 'ordered';
    return 'first';
  } catch {
    return 'unknown';
  }
}
