/**
 * The admin customer directory — one list that merges two very different
 * populations:
 *
 *   1. **Account customers** — rows in `customers`. Full profile, auth-backed,
 *      everything the admin surfaces can act on.
 *   2. **Stealth Health buyers** — people who only ever bought through the Stealth Health
 *      (Stealth Health) hosted checkout and never registered here. All we know
 *      about them is what the partner reported on the order payload: name,
 *      email, phone, and a shipping address. There is no account, no login, no
 *      currency preference, no activity trail.
 *
 * The two are deliberately NOT normalised into one shape and pretended to be
 * equivalent — the UI leans on `source` to draw a hard visual line, and every
 * field a Stealth Health buyer can't have is explicitly `null` rather than faked.
 *
 * SERVER ONLY: `puramass_orders` is service-role-locked, so everything here
 * runs behind an admin-gated route with the service key.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingColumnError } from '@/lib/payments/puramass-columns';
import { toShippingAddress } from '@/lib/payments/puramass-address';
import type { Lead } from '@/lib/admin/customer-leads';
import type { NudgeSummary } from '@/lib/customer/audience';
import { normalizeEmail, puramassId } from './customer-id';

/** Where a directory row came from. */
export type CustomerSource = 'account' | 'puramass';

/** A Stealth Health hand-off, trimmed to what the customer surfaces need. */
export interface PuramassOrderLite {
  id: string;
  partner_reference: string;
  transaction_id: string | null;
  payment_link: string | null;
  status: string;
  subtotal_cents: number | null;
  currency: string | null;
  customer_id: string | null;
  customer_email: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  shipping_address: unknown;
  items: { sku?: string; quantity?: number }[];
  invoice_id: string | null;
  paid_at: string | null;
  created_at: string;
}

/** Aggregated Stealth Health activity for one email address. */
export interface PuramassProfile {
  email: string;
  name: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  orders: PuramassOrderLite[];
  orderCount: number;
  paidCount: number;
  /** Sum of `subtotal_cents` across PAID orders only. */
  paidCents: number;
  firstOrderAt: string;
  lastOrderAt: string;
  lastPaidAt: string | null;
  /** The account this ledger row is linked to, when Stealth Health hand-off had one. */
  customerId: string | null;
}

export interface DirectoryRow {
  id: string;
  source: CustomerSource;
  first_name: string | null;
  last_name: string | null;
  email: string;
  phone: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  role: string | null;
  /** Account creation date, or the first Stealth Health order date for a buyer. */
  created_at: string;
  last_login_at: string | null;
  preferred_currency: string | null;
  active: boolean;
  claimed_by_id: string | null;
  claimed_by_name: string | null;
  affiliate_id: string | null;
  has_completed_first_order: boolean;
  /** Claim + lead state, or null when nobody has touched this person yet. */
  lead: Lead | null;
  /** Billable invoices + orders + paid Stealth Health hand-offs, deduped. */
  purchases: number;
  /** Saved drop-ship recipients in this customer's address book. */
  clients: number;
  purchase_breakdown: { invoices: number; orders: number; puramass: number };
  /** Stealth Health activity attached to this person (either source). */
  puramass_orders: number;
  puramass_paid_orders: number;
  puramass_paid_cents: number;
  puramass_last_order_at: string | null;
  /**
   * The last outreach email this person was sent, or null when the log has
   * none for them. Filled in by the directory route — the outreach log is
   * service-role only and is read for the admin view alone.
   */
  nudge: NudgeSummary | null;
}

/**
 * The account-customer fields every customer surface reads.
 *
 * These arrive from a stack of migrations run at different times, and naming a
 * column the database doesn't have yet fails the WHOLE query — one un-run
 * migration would take the customer list down entirely. So the query selects
 * `*` and this list projects the result: a column that isn't there yet simply
 * comes back `null`, and the response shape never changes.
 *
 * (`registration-alerts-migration.sql` adds contact_consent + claimed_by_*;
 * `currency-support-migration.sql` adds preferred_currency;
 * `affiliate-program-migration.sql` adds affiliate_id.)
 */
export const DIRECTORY_CUSTOMER_FIELDS = [
  'id',
  'first_name',
  'last_name',
  'email',
  'phone',
  'shipping_address',
  'shipping_city',
  'shipping_state',
  'shipping_postal_code',
  'shipping_country',
  'role',
  'is_admin',
  'active',
  'preferred_currency',
  'affiliate_id',
  'created_at',
  'last_login_at',
  'has_completed_first_order',
  'contact_consent',
  'claimed_by_id',
  'claimed_by_email',
  'claimed_by_name',
  'claimed_at',
  'allow_pickup',
  'allow_shipping',
  'email_verified',
  // marketing-attribution-migration.sql — how this customer was acquired.
  'attribution_channel',
  'attribution_campaign',
  // landing-pages-migration.sql — the landing page that won them, if any.
  'attribution_landing_page',
] as const;

/**
 * Narrow a raw `customers` row to the fields above.
 *
 * Doubles as the security boundary on any route that selects `*`: the row
 * carries `password_hash` and `wallet_address`, and neither is on the list, so
 * neither can reach the browser.
 */
export function projectCustomer(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of DIRECTORY_CUSTOMER_FIELDS) {
    out[field] = row?.[field] ?? null;
  }
  return out;
}

const LEDGER_COLUMNS =
  'id, partner_reference, transaction_id, payment_link, status, subtotal_cents, ' +
  'currency, customer_id, customer_email, customer_name, customer_phone, ' +
  'shipping_address, items, invoice_id, paid_at, created_at';

// Same list minus everything puramass-shipping-address-migration.sql adds, so
// the directory still builds if that migration isn't visible to PostgREST yet.
const LEDGER_COLUMNS_LEGACY =
  'id, partner_reference, transaction_id, payment_link, status, subtotal_cents, ' +
  'currency, customer_id, customer_email, items, invoice_id, paid_at, created_at';

// How a person is addressed lives in a client-safe module, so an admin screen
// can build a `pm:` id without importing this service-role reader. Re-exported
// here because every existing consumer imports them from the directory.
export {
  normalizeEmail,
  PURAMASS_ID_PREFIX,
  puramassId,
  isPuramassId,
  emailFromPuramassId,
  outreachIdFor,
} from './customer-id';

function asItems(raw: unknown): { sku?: string; quantity?: number }[] {
  return Array.isArray(raw) ? (raw as { sku?: string; quantity?: number }[]) : [];
}

/**
 * Read the Stealth Health hand-off ledger, optionally narrowed to one email and/or a
 * set of statuses. Returns `[]` (never throws) when the table or its address
 * columns are unavailable — a missing Stealth Health integration must not break the
 * page.
 */
export async function fetchPuramassLedger(
  db: SupabaseClient,
  opts: { email?: string; limit?: number; statuses?: readonly string[] } = {},
): Promise<PuramassOrderLite[]> {
  const limit = opts.limit ?? 5000;

  // `ilike` treats `_` and `%` as wildcards and emails legitimately contain
  // `_`, so the database filter is only ever a coarse superset — the exact
  // match is re-applied in JS below. (A wildcard can over-match, never
  // under-match, so nothing is lost by narrowing first.)
  const run = async (columns: string) => {
    let q = db
      .from('puramass_orders')
      .select(columns)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (opts.email) q = q.ilike('customer_email', opts.email);
    // Narrowing in the database rather than in JS keeps a "who has an abandoned
    // cart?" lookup off the whole ledger, which grows without bound.
    if (opts.statuses && opts.statuses.length > 0) q = q.in('status', [...opts.statuses]);
    return q;
  };

  let { data, error } = await run(LEDGER_COLUMNS);
  if (error && isMissingColumnError(error)) {
    ({ data, error } = await run(LEDGER_COLUMNS_LEGACY));
  }
  if (error) {
    console.error('[customer-directory] puramass ledger read failed:', error.message);
    return [];
  }

  const wanted = opts.email ? normalizeEmail(opts.email) : null;
  const rows = ((data ?? []) as any[]).filter(
    (r) => !wanted || normalizeEmail(r.customer_email) === wanted,
  );

  return rows.map((r) => ({
    id: r.id,
    partner_reference: r.partner_reference,
    transaction_id: r.transaction_id ?? null,
    payment_link: r.payment_link ?? null,
    status: r.status,
    subtotal_cents: r.subtotal_cents ?? null,
    currency: r.currency ?? null,
    customer_id: r.customer_id ?? null,
    customer_email: r.customer_email ?? null,
    customer_name: r.customer_name ?? null,
    customer_phone: r.customer_phone ?? null,
    shipping_address: r.shipping_address ?? null,
    items: asItems(r.items),
    invoice_id: r.invoice_id ?? null,
    paid_at: r.paid_at ?? null,
    created_at: r.created_at,
  }));
}

/**
 * Count each customer's saved ships-to clients (their drop-ship address book).
 *
 * Returns `new Map()` (never throws) when `customer_clients` isn't there yet —
 * the table arrives with invoice-spec-integration-migration.sql, and a database
 * that predates it must still get a working customer list, just with every row
 * reading as zero clients.
 */
export async function fetchClientCounts(
  db: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const { data, error } = await db
    .from('customer_clients')
    .select('customer_id')
    .limit(opts.limit ?? 20000);
  if (error) {
    console.error('[customer-directory] client count read failed:', error.message);
    return counts;
  }
  for (const row of (data ?? []) as { customer_id: string | null }[]) {
    if (!row.customer_id) continue;
    counts.set(row.customer_id, (counts.get(row.customer_id) ?? 0) + 1);
  }
  return counts;
}

/**
 * Fold a ledger into one profile per email address.
 *
 * Name/phone/address are taken from the most recent order that actually
 * carries them — Stealth Health fills those in progressively (the address often
 * arrives a poll or two after the hand-off), so the newest row is not
 * necessarily the most complete one.
 */
export function groupPuramassByEmail(
  orders: PuramassOrderLite[],
): Map<string, PuramassProfile> {
  const byEmail = new Map<string, PuramassProfile>();

  // Oldest-first, so "first order" falls out naturally and later orders
  // overwrite earlier contact details with fresher ones.
  const chronological = [...orders].sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
  );

  for (const order of chronological) {
    const email = normalizeEmail(order.customer_email);
    if (!email) continue;

    const addr = toShippingAddress(order.shipping_address);
    const existing = byEmail.get(email);
    const paid = order.status === 'paid';

    if (!existing) {
      byEmail.set(email, {
        email,
        name: order.customer_name || null,
        phone: order.customer_phone || null,
        city: addr?.city || null,
        state: addr?.state || null,
        country: addr?.country || null,
        orders: [order],
        orderCount: 1,
        paidCount: paid ? 1 : 0,
        paidCents: paid ? order.subtotal_cents ?? 0 : 0,
        firstOrderAt: order.created_at,
        lastOrderAt: order.created_at,
        lastPaidAt: paid ? order.paid_at ?? order.created_at : null,
        customerId: order.customer_id,
      });
      continue;
    }

    existing.orders.push(order);
    existing.orderCount += 1;
    if (paid) {
      existing.paidCount += 1;
      existing.paidCents += order.subtotal_cents ?? 0;
      existing.lastPaidAt = order.paid_at ?? order.created_at;
    }
    existing.lastOrderAt = order.created_at;
    // Only ever upgrade a missing field — never blank one we already have.
    if (order.customer_name) existing.name = order.customer_name;
    if (order.customer_phone) existing.phone = order.customer_phone;
    if (addr?.city) existing.city = addr.city;
    if (addr?.state) existing.state = addr.state;
    if (addr?.country) existing.country = addr.country;
    if (order.customer_id) existing.customerId = order.customer_id;
  }

  // Newest-first inside each profile, which is how every UI lists them.
  for (const profile of byEmail.values()) {
    profile.orders.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  return byEmail;
}

/** Split "Jordan Grosman" into first/last, tolerating one-word names. */
export function splitName(full: string | null): { first: string | null; last: string | null } {
  const parts = String(full ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

/** Build one Stealth Health-only directory row from a folded profile. */
export function puramassDirectoryRow(profile: PuramassProfile): DirectoryRow {
  const { first, last } = splitName(profile.name);
  return {
    id: puramassId(profile.email),
    source: 'puramass',
    first_name: first,
    last_name: last,
    email: profile.email,
    phone: profile.phone,
    city: profile.city,
    state: profile.state,
    country: profile.country,
    // No account, so no role. The UI shows a Stealth Health badge instead.
    role: null,
    created_at: profile.firstOrderAt,
    last_login_at: null,
    // Stealth Health prices in USD; that's the only currency signal we have.
    preferred_currency: 'USD',
    active: true,
    claimed_by_id: null,
    claimed_by_name: null,
    affiliate_id: null,
    has_completed_first_order: profile.paidCount > 0,
    // Filled in by the directory route, which is the only place that has the
    // lead records and invoice/order tallies to hand.
    lead: null,
    purchases: 0,
    purchase_breakdown: { invoices: 0, orders: 0, puramass: 0 },
    // A ships-to-client address book hangs off an account; a Stealth Health-only
    // buyer has no account row for one to belong to.
    clients: 0,
    puramass_orders: profile.orderCount,
    puramass_paid_orders: profile.paidCount,
    puramass_paid_cents: profile.paidCents,
    puramass_last_order_at: profile.lastOrderAt,
    // Same as `lead` above: the route holds the outreach log, not this builder.
    nudge: null,
  };
}
