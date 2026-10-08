/**
 * The commission ledger the admin commissions desk and its printed reports
 * read: every affiliate and sales-person commission, with who earns it and
 * the invoice (or order) it was earned on.
 *
 * Server-side only — it needs the service-role client. The desk used to read
 * `commissions` straight from the browser with embedded joins, which RLS and
 * PostgREST relationship hints can silently turn into an empty list (the
 * affiliates directory showed money owed while this desk said $0). Everything
 * here is plain column selects plus batched `.in()` lookups, the same shape the
 * affiliates directory uses, so the two always agree.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeCommissionRate } from '@/lib/affiliate/commission';

export type CommissionSource = 'affiliate' | 'sales';

export interface LedgerCommission {
  id: string;
  source: CommissionSource;
  /** `${source}:${recipient id}` — matches LedgerRecipient.key. */
  recipient_key: string;
  status: string;
  amount: number;
  /** What the commission was calculated on. */
  base: number;
  /** As a percentage, e.g. 10 for 10%. */
  rate: number;
  created_at: string;
  paid_at: string | null;
  invoice_id: string | null;
  invoice_number: string | null;
  order_id: string | null;
  order_number: string | null;
  /**
   * Who bought. Falls back through the customer account, the invoice's
   * snapshot, the hosted-checkout ledger and the order's shipping address, so
   * guest checkouts (no account) still show a name or at least an email.
   */
  customer_name: string | null;
  customer_email: string | null;
  /** No customer account behind the sale — a guest checkout. */
  customer_is_guest: boolean;
}

export interface LedgerRecipient {
  key: string;
  source: CommissionSource;
  id: string;
  name: string;
  email: string;
  referral_code: string | null;
  /** Admin page for this recipient's profile. */
  profile_href: string;
}

/** PostgREST caps an unbounded select at 1000 rows; ask for more explicitly. */
const ROW_LIMIT = 20000;
/** Keeps `.in()` URLs well under the request-line limit. */
const IN_CHUNK = 200;

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const fullName = (r: { first_name?: string | null; last_name?: string | null } | null | undefined) =>
  `${r?.first_name ?? ''} ${r?.last_name ?? ''}`.trim();

/** Sales rates are stored as a percentage; tolerate a stray fraction. */
function salesRatePercent(raw: unknown): number {
  const n = num(raw);
  return round2(n > 0 && n <= 1 ? n * 100 : n);
}

type Row = Record<string, any>;

async function selectIn(
  db: SupabaseClient,
  table: string,
  columns: string,
  column: string,
  ids: string[],
): Promise<Row[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out: Row[] = [];
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const { data, error } = await db
      .from(table)
      .select(columns)
      .in(column, unique.slice(i, i + IN_CHUNK))
      .limit(ROW_LIMIT);
    if (error) console.error(`[commission-ledger] ${table}:`, error.message);
    out.push(...((data ?? []) as unknown as Row[]));
  }
  return out;
}

const INVOICE_COLS = 'id, invoice_number, order_id, customer_id, customer_name, customer_email';

const clean = (v: unknown): string | null => {
  const t = typeof v === 'string' ? v.trim() : '';
  return t ? t : null;
};

/**
 * Buyer details from the hosted-checkout ledger, keyed by invoice id. A
 * PuraMass guest has no customer account; this is where their name lives.
 * `customer_name` arrived in a later migration, so retry without it.
 */
async function loadHostedBuyers(db: SupabaseClient, invoiceIds: string[]): Promise<Map<string, Row>> {
  const out = new Map<string, Row>();
  const unique = [...new Set(invoiceIds.filter(Boolean))];
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const chunk = unique.slice(i, i + IN_CHUNK);
    let res = await db
      .from('puramass_orders')
      .select('invoice_id, customer_name, customer_email')
      .in('invoice_id', chunk)
      .limit(ROW_LIMIT);
    if (res.error) {
      res = (await db
        .from('puramass_orders')
        .select('invoice_id, customer_email')
        .in('invoice_id', chunk)
        .limit(ROW_LIMIT)) as typeof res;
    }
    if (res.error) {
      console.error('[commission-ledger] puramass_orders:', res.error.message);
      continue;
    }
    for (const r of (res.data ?? []) as Row[]) if (r.invoice_id && !out.has(r.invoice_id)) out.set(r.invoice_id, r);
  }
  return out;
}

/** Name from a shipping-address blob, whichever key style it was saved with. */
function addressName(addr: unknown): string | null {
  if (!addr || typeof addr !== 'object') return null;
  const a = addr as Row;
  return (
    clean(`${a.firstName ?? a.first_name ?? ''} ${a.lastName ?? a.last_name ?? ''}`) ??
    clean(a.name) ??
    clean(a.full_name) ??
    clean(a.fullName)
  );
}

/**
 * Best available name and email for a sale's buyer: the customer account,
 * then the invoice's snapshot, then the hosted-checkout ledger, then the
 * order's shipping address. A sale with no account is a guest checkout.
 */
export function resolveBuyer(src: {
  account: Row | null;
  invoice: Row | null;
  hosted: Row | null;
  order: Row | null;
}): Pick<LedgerCommission, 'customer_name' | 'customer_email' | 'customer_is_guest'> {
  const { account, invoice, hosted, order } = src;
  const ship = order?.shipping_address && typeof order.shipping_address === 'object' ? (order.shipping_address as Row) : null;
  const name =
    (account ? clean(fullName(account)) : null) ??
    clean(invoice?.customer_name) ??
    clean(hosted?.customer_name) ??
    addressName(ship);
  const email =
    clean(account?.email) ??
    clean(invoice?.customer_email) ??
    clean(hosted?.customer_email) ??
    clean(order?.email) ??
    clean(ship?.email);
  return {
    customer_name: name,
    customer_email: email,
    customer_is_guest: !account && !!(invoice || order),
  };
}

export async function loadCommissionLedger(
  db: SupabaseClient,
  opts: { source?: CommissionSource; recipientId?: string } = {},
): Promise<{ recipients: LedgerRecipient[]; commissions: LedgerCommission[] }> {
  const wantAffiliate = opts.source !== 'sales';
  const wantSales = opts.source !== 'affiliate';

  const affQuery = () => {
    let q = db
      .from('commissions')
      .select('id, affiliate_id, order_id, invoice_id, amount, order_total, commission_rate, status, paid_at, created_at')
      .order('created_at', { ascending: false })
      .limit(ROW_LIMIT);
    if (opts.recipientId) q = q.eq('affiliate_id', opts.recipientId);
    return q;
  };
  const salesQuery = () => {
    let q = db
      .from('sales_commissions')
      .select('id, sales_person_id, invoice_id, amount, invoice_total, commission_rate, status, paid_at, created_at')
      .order('created_at', { ascending: false })
      .limit(ROW_LIMIT);
    if (opts.recipientId) q = q.eq('sales_person_id', opts.recipientId);
    return q;
  };

  const read = async (query: PromiseLike<{ data: unknown; error: { message: string } | null }>, label: string) => {
    const { data, error } = await query;
    if (error) console.error(`[commission-ledger] ${label}:`, error.message);
    return ((data ?? []) as unknown) as Row[];
  };
  const [affRows, salesRows] = await Promise.all([
    wantAffiliate ? read(affQuery(), 'commissions') : Promise.resolve([] as Row[]),
    wantSales ? read(salesQuery(), 'sales_commissions') : Promise.resolve([] as Row[]),
  ]);

  // --- references: invoices and orders --------------------------------
  const orderIds = affRows.map((c) => c.order_id).filter(Boolean) as string[];
  const directInvoiceIds = [
    ...affRows.map((c) => c.invoice_id),
    ...salesRows.map((c) => c.invoice_id),
  ].filter(Boolean) as string[];

  const [orders, invoicesById, invoicesByOrder] = await Promise.all([
    selectIn(db, 'orders', 'id, order_number, customer_id, email, shipping_address', 'id', orderIds),
    selectIn(db, 'invoices', INVOICE_COLS, 'id', directInvoiceIds),
    // A storefront order usually has an invoice too; prefer linking to it.
    selectIn(db, 'invoices', INVOICE_COLS, 'order_id', orderIds),
  ]);
  const orderMap = new Map(orders.map((o) => [o.id, o]));
  const invoiceMap = new Map(invoicesById.map((i) => [i.id, i]));
  const invoiceForOrder = new Map<string, any>();
  for (const inv of invoicesByOrder) {
    if (inv.order_id && !invoiceForOrder.has(inv.order_id)) invoiceForOrder.set(inv.order_id, inv);
  }

  // --- recipients ------------------------------------------------------
  const affiliateIds = affRows.map((c) => c.affiliate_id) as string[];
  const salesPersonIds = salesRows.map((c) => c.sales_person_id) as string[];
  const [affiliates, salesPersons, codes] = await Promise.all([
    selectIn(db, 'affiliates', 'id, first_name, last_name, email', 'id', affiliateIds),
    selectIn(db, 'sales_persons', 'id, first_name, last_name, email, user_id', 'id', salesPersonIds),
    selectIn(db, 'referral_codes', 'affiliate_id, code, active', 'affiliate_id', affiliateIds),
  ]);
  const activeCode = new Map<string, string>();
  for (const c of codes) if (c.active && !activeCode.has(c.affiliate_id)) activeCode.set(c.affiliate_id, c.code);

  // A sales person linked to an affiliate account opens that affiliate's profile.
  const linkedAffiliateIds = salesPersons.map((s) => s.user_id).filter(Boolean) as string[];
  const linkedAffiliates = await selectIn(db, 'affiliates', 'id', 'id', linkedAffiliateIds);
  const linkedAffiliateSet = new Set(linkedAffiliates.map((a) => a.id));

  // --- customers (who bought) -----------------------------------------
  const customerIds = [
    ...orders.map((o) => o.customer_id),
    ...invoicesById.map((i) => i.customer_id),
    ...invoicesByOrder.map((i) => i.customer_id),
  ].filter(Boolean) as string[];
  const allInvoiceIds = [...invoicesById, ...invoicesByOrder].map((i) => i.id) as string[];
  const [customers, hosted] = await Promise.all([
    selectIn(db, 'customers', 'id, first_name, last_name, email', 'id', customerIds),
    loadHostedBuyers(db, allInvoiceIds),
  ]);
  const customerById = new Map(customers.map((c) => [c.id, c]));

  const buyerFor = (invoice: Row | null | undefined, order: Row | null | undefined) =>
    resolveBuyer({
      account: customerById.get(invoice?.customer_id ?? order?.customer_id) ?? null,
      invoice: invoice ?? null,
      hosted: invoice?.id ? hosted.get(invoice.id) ?? null : null,
      order: order ?? null,
    });

  const recipients = new Map<string, LedgerRecipient>();
  for (const a of affiliates) {
    const key = `affiliate:${a.id}`;
    recipients.set(key, {
      key,
      source: 'affiliate',
      id: a.id,
      name: fullName(a) || a.email || 'Unknown affiliate',
      email: a.email ?? '',
      referral_code: activeCode.get(a.id) ?? null,
      profile_href: `/admin/affiliates/${a.id}`,
    });
  }
  for (const s of salesPersons) {
    const key = `sales:${s.id}`;
    recipients.set(key, {
      key,
      source: 'sales',
      id: s.id,
      name: fullName(s) || s.email || 'Unknown sales person',
      email: s.email ?? '',
      referral_code: null,
      profile_href:
        s.user_id && linkedAffiliateSet.has(s.user_id)
          ? `/admin/affiliates/${s.user_id}`
          : '/admin/sales-persons',
    });
  }

  const commissions: LedgerCommission[] = [];

  for (const c of affRows) {
    const key = `affiliate:${c.affiliate_id}`;
    if (!recipients.has(key)) {
      recipients.set(key, {
        key,
        source: 'affiliate',
        id: c.affiliate_id,
        name: 'Deleted affiliate',
        email: '',
        referral_code: null,
        profile_href: `/admin/affiliates/${c.affiliate_id}`,
      });
    }
    const order = c.order_id ? orderMap.get(c.order_id) : null;
    const invoice = c.invoice_id
      ? invoiceMap.get(c.invoice_id)
      : c.order_id
        ? invoiceForOrder.get(c.order_id)
        : null;
    const buyer = buyerFor(invoice, order);
    commissions.push({
      id: c.id,
      source: 'affiliate',
      recipient_key: key,
      status: String(c.status ?? 'pending').toLowerCase(),
      amount: round2(num(c.amount)),
      base: round2(num(c.order_total)),
      rate: round2(normalizeCommissionRate(c.commission_rate) * 100),
      created_at: c.created_at,
      paid_at: c.paid_at ?? null,
      invoice_id: invoice?.id ?? c.invoice_id ?? null,
      invoice_number: invoice?.invoice_number ?? null,
      order_id: c.order_id ?? null,
      order_number: order?.order_number ?? null,
      ...buyer,
    });
  }

  for (const c of salesRows) {
    const key = `sales:${c.sales_person_id}`;
    if (!recipients.has(key)) {
      recipients.set(key, {
        key,
        source: 'sales',
        id: c.sales_person_id,
        name: 'Deleted sales person',
        email: '',
        referral_code: null,
        profile_href: '/admin/sales-persons',
      });
    }
    const invoice = c.invoice_id ? invoiceMap.get(c.invoice_id) : null;
    commissions.push({
      id: c.id,
      source: 'sales',
      recipient_key: key,
      status: String(c.status ?? 'pending').toLowerCase(),
      amount: round2(num(c.amount)),
      base: round2(num(c.invoice_total)),
      rate: salesRatePercent(c.commission_rate),
      created_at: c.created_at,
      paid_at: c.paid_at ?? null,
      invoice_id: c.invoice_id ?? null,
      invoice_number: invoice?.invoice_number ?? null,
      order_id: null,
      order_number: null,
      ...buyerFor(invoice, null),
    });
  }

  commissions.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return { recipients: [...recipients.values()], commissions };
}

/** The reference shown for a commission: invoice number, else order number, else a short id. */
export function commissionReference(c: LedgerCommission): string {
  if (c.invoice_number) return c.invoice_number;
  if (c.order_number) return c.order_number;
  const id = c.invoice_id ?? c.order_id;
  return id ? id.slice(0, 8) : '—';
}
