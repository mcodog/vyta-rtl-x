/**
 * Who an affiliate actually brought in, and what those people spent.
 *
 * The affiliates desk used to answer this from `customers.affiliate_id` and the
 * `orders` table alone, which got both numbers wrong:
 *
 *   • Every affiliate's own customer account is bound to themselves (the
 *     create and approve routes write `customers.affiliate_id = id`), so each
 *     affiliate started at "1 customer" — themselves.
 *   • A hosted (Stealth Health) sale is an INVOICE, never an `orders` row, and
 *     a referral-code or discount-code buyer is never bound. So an affiliate
 *     with paid referral sales still read "no sales yet".
 *
 * Here a referred customer is anyone bound to the affiliate (other than the
 * affiliate) plus anyone whose purchase earned them a commission, and sales
 * are those people's non-cancelled orders and paid invoices plus every
 * commissioned sale — each order or invoice counted once.
 *
 * `buildAffiliateReferrals` is pure (unit-tested); `loadAffiliateReferrals`
 * reads the rows it needs with the service-role client.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, any>;

export interface ReferredCustomer {
  /** Stable key: the customer id, or `email:<address>` for a guest buyer. */
  key: string;
  /** The customer account, when there is one. */
  id: string | null;
  name: string;
  email: string | null;
  /** When they signed up, or first bought when they have no account. */
  created_at: string | null;
  /** Bound to the affiliate (rather than only credited through a sale). */
  bound: boolean;
  has_ordered: boolean;
  orders: number;
  revenue: number;
}

export interface ReferredProduct {
  key: string;
  name: string;
  quantity: number;
  revenue: number;
  orders: number;
  lastAt: string;
}

export interface AffiliateReferrals {
  customers: ReferredCustomer[];
  /** Sum of every counted order and invoice total. */
  revenue: number;
  /** Number of counted orders and invoices. */
  sales: number;
  products: ReferredProduct[];
}

export interface ReferralsInput {
  affiliates: Row[];
  /** `customers` rows with an affiliate_id. */
  boundCustomers: Row[];
  /** `commissions` rows: affiliate_id, order_id, invoice_id. */
  commissions: Row[];
  /** Orders by bound customers and commissioned orders. Needs id, customer_id, total, status, created_at; items for products. */
  orders: Row[];
  /** Invoices by bound customers and commissioned invoices. Needs id, customer_id, customer_email, customer_name, order_id, total, status, created_at. */
  invoices: Row[];
  /** `invoice_line_items` for the invoices above, for products. Optional. */
  invoiceLines?: Row[];
}

/** Orders that never turned into a sale. */
const DEAD_ORDER = new Set(['cancelled', 'canceled', 'refunded', 'failed']);
/** Invoices that never turned into a sale. */
const DEAD_INVOICE = new Set(['cancelled', 'canceled', 'void', 'voided', 'expired', 'refunded', 'draft']);

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function lower(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null;
}

function status(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

function earlier(a: string | null, b: unknown): string | null {
  if (typeof b !== 'string' || !b) return a;
  return !a || b < a ? b : a;
}

interface Sale {
  customerId: string | null;
  email: string | null;
  name: string | null;
  total: number;
  createdAt: string | null;
  items: Array<{ label: string; qty: number; unit: number }>;
}

function orderItems(o: Row): Sale['items'] {
  return (Array.isArray(o.items) ? o.items : []).flatMap((it: Row) => {
    const label = [it?.name ?? it?.product_name, it?.strength].filter(Boolean).join(' ').trim();
    if (!label) return [];
    return [{
      label,
      qty: Math.max(1, Math.round(num(it.quantity) || 1)),
      unit: num(it.price ?? it.price_at_time ?? it.unit_price),
    }];
  });
}

export function buildAffiliateReferrals(input: ReferralsInput): Map<string, AffiliateReferrals> {
  const ordersById = new Map<string, Row>();
  for (const o of input.orders) if (o?.id) ordersById.set(String(o.id), o);
  const invoicesById = new Map<string, Row>();
  for (const i of input.invoices) if (i?.id) invoicesById.set(String(i.id), i);

  const linesByInvoice = new Map<string, Sale['items']>();
  for (const l of input.invoiceLines ?? []) {
    const label = String(l?.description ?? '').trim();
    if (!label || !l.invoice_id) continue;
    const list = linesByInvoice.get(String(l.invoice_id)) ?? [];
    list.push({ label, qty: Math.max(1, Math.round(num(l.qty) || 1)), unit: num(l.unit_price) });
    linesByInvoice.set(String(l.invoice_id), list);
  }

  const ordersByCustomer = new Map<string, Row[]>();
  for (const o of input.orders) {
    if (!o?.customer_id) continue;
    const list = ordersByCustomer.get(o.customer_id) ?? [];
    list.push(o);
    ordersByCustomer.set(o.customer_id, list);
  }
  const invoicesByCustomer = new Map<string, Row[]>();
  for (const i of input.invoices) {
    if (!i?.customer_id) continue;
    const list = invoicesByCustomer.get(i.customer_id) ?? [];
    list.push(i);
    invoicesByCustomer.set(i.customer_id, list);
  }

  const boundBy = new Map<string, Row[]>();
  for (const c of input.boundCustomers) {
    if (!c?.affiliate_id) continue;
    const list = boundBy.get(c.affiliate_id) ?? [];
    list.push(c);
    boundBy.set(c.affiliate_id, list);
  }
  const commissionsBy = new Map<string, Row[]>();
  for (const c of input.commissions) {
    if (!c?.affiliate_id) continue;
    const list = commissionsBy.get(c.affiliate_id) ?? [];
    list.push(c);
    commissionsBy.set(c.affiliate_id, list);
  }

  const out = new Map<string, AffiliateReferrals>();
  for (const a of input.affiliates) {
    const affiliateId = String(a.id);
    const selfEmail = lower(a.email);
    const isSelf = (id: unknown, email: unknown) =>
      id === affiliateId || (!!selfEmail && lower(email) === selfEmail);

    const customers = new Map<string, ReferredCustomer>();
    const keyByEmail = new Map<string, string>();

    // Bound customers first, so a sale by one lands on their row.
    for (const c of boundBy.get(affiliateId) ?? []) {
      if (isSelf(c.id, c.email)) continue;
      const email = lower(c.email);
      customers.set(c.id, {
        key: c.id,
        id: c.id,
        name: `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || c.email || 'Customer',
        email: c.email ?? null,
        created_at: c.created_at ?? null,
        bound: true,
        has_ordered: Boolean(c.has_completed_first_order),
        orders: 0,
        revenue: 0,
      });
      if (email) keyByEmail.set(email, c.id);
    }

    // Every sale credited to this affiliate, each order and invoice once.
    const sales = new Map<string, Sale>();
    const countedOrders = new Set<string>();
    const addOrder = (o: Row) => {
      const id = String(o.id);
      if (countedOrders.has(id) || DEAD_ORDER.has(status(o.status))) return;
      countedOrders.add(id);
      sales.set(`order:${id}`, {
        customerId: o.customer_id ?? null,
        email: lower(o.customer_email ?? o.email),
        name: o.customer_name ?? null,
        total: num(o.total),
        createdAt: o.created_at ?? null,
        items: orderItems(o),
      });
    };
    const addInvoice = (i: Row) => {
      const id = String(i.id);
      if (sales.has(`invoice:${id}`) || DEAD_INVOICE.has(status(i.status))) return;
      // An invoice raised for an order is the same sale as that order.
      if (i.order_id && countedOrders.has(String(i.order_id))) return;
      sales.set(`invoice:${id}`, {
        customerId: i.customer_id ?? null,
        email: lower(i.customer_email),
        name: i.customer_name ?? null,
        total: num(i.total),
        createdAt: i.created_at ?? null,
        items: linesByInvoice.get(id) ?? [],
      });
    };

    const commissions = commissionsBy.get(affiliateId) ?? [];
    for (const c of commissions) {
      const o = c.order_id ? ordersById.get(String(c.order_id)) : undefined;
      if (o) addOrder(o);
    }
    for (const c of customers.values()) {
      for (const o of ordersByCustomer.get(c.id!) ?? []) addOrder(o);
    }
    for (const c of commissions) {
      const i = c.invoice_id ? invoicesById.get(String(c.invoice_id)) : undefined;
      if (i) addInvoice(i);
    }
    for (const c of customers.values()) {
      // Only a paid invoice is a sale; a bound customer's open one isn't yet.
      for (const i of invoicesByCustomer.get(c.id!) ?? []) {
        if (status(i.status) === 'paid') addInvoice(i);
      }
    }

    // Attach each sale to its buyer, adding buyers who were never bound.
    const products = new Map<string, ReferredProduct>();
    let revenue = 0;
    for (const [saleKey, s] of sales) {
      if (isSelf(s.customerId, s.email)) continue;
      const key =
        (s.customerId && customers.has(s.customerId) ? s.customerId : null) ??
        (s.email ? keyByEmail.get(s.email) : null) ??
        s.customerId ??
        (s.email ? `email:${s.email}` : `sale:${saleKey}`);
      const entry = customers.get(key) ?? {
        key,
        id: s.customerId,
        name: s.name?.trim() || s.email || 'Guest',
        email: s.email,
        created_at: null,
        bound: false,
        has_ordered: true,
        orders: 0,
        revenue: 0,
      };
      if (!entry.bound) entry.created_at = earlier(entry.created_at, s.createdAt);
      entry.orders += 1;
      entry.revenue += s.total;
      entry.has_ordered = true;
      customers.set(key, entry);
      if (s.email && !keyByEmail.has(s.email)) keyByEmail.set(s.email, key);
      revenue += s.total;

      for (const it of s.items) {
        const pkey = it.label.toLowerCase().replace(/\s+/g, ' ');
        const bucket = products.get(pkey) ?? {
          key: pkey, name: it.label, quantity: 0, revenue: 0, orders: 0, lastAt: s.createdAt ?? '',
        };
        bucket.quantity += it.qty;
        bucket.revenue += it.unit * it.qty;
        bucket.orders += 1;
        if (s.createdAt && s.createdAt > bucket.lastAt) bucket.lastAt = s.createdAt;
        products.set(pkey, bucket);
      }
    }

    const list = [...customers.values()]
      .map((c) => ({ ...c, revenue: round2(c.revenue) }))
      .sort((x, y) => String(y.created_at ?? '').localeCompare(String(x.created_at ?? '')));

    out.set(affiliateId, {
      customers: list,
      revenue: round2(revenue),
      sales: [...sales.values()].filter((s) => !isSelf(s.customerId, s.email)).length,
      products: [...products.values()]
        .map((p) => ({ ...p, revenue: round2(p.revenue) }))
        .sort((x, y) => y.quantity - x.quantity),
    });
  }
  return out;
}

/** PostgREST puts `.in()` lists in the URL; keep each request's list short. */
const CHUNK = 150;
const ROW_LIMIT = 20000;

async function selectIn(
  db: SupabaseClient,
  table: string,
  select: string,
  column: string,
  ids: string[],
): Promise<Row[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out: Row[] = [];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const { data, error } = await db
      .from(table)
      .select(select)
      .in(column, unique.slice(i, i + CHUNK))
      .limit(ROW_LIMIT);
    if (error) {
      console.error(`[affiliate-referrals] ${table}.${column}:`, error.message);
      continue;
    }
    out.push(...((data ?? []) as unknown as Row[]));
  }
  return out;
}

/**
 * Read what `buildAffiliateReferrals` needs. `affiliates` scopes the read: one
 * affiliate for the profile, all of them for the desk. Pass the bound customers
 * and commissions when the caller has already read them.
 */
export async function loadAffiliateReferrals(
  db: SupabaseClient,
  affiliates: Row[],
  opts: {
    boundCustomers?: Row[];
    commissions?: Row[];
    /** Read order items and invoice lines too, for "what they buy". */
    withProducts?: boolean;
  } = {},
): Promise<Map<string, AffiliateReferrals>> {
  const ids = affiliates.map((a) => String(a.id));
  const single = ids.length === 1;

  const boundCustomers =
    opts.boundCustomers ??
    ((single
      ? (await db
          .from('customers')
          .select('id, affiliate_id, first_name, last_name, email, created_at, has_completed_first_order')
          .eq('affiliate_id', ids[0])
          .limit(ROW_LIMIT)).data
      : (await db
          .from('customers')
          .select('id, affiliate_id, first_name, last_name, email, created_at, has_completed_first_order')
          .not('affiliate_id', 'is', null)
          .limit(ROW_LIMIT)).data) ?? []) as Row[];

  const commissions =
    opts.commissions ??
    ((single
      ? (await db.from('commissions').select('affiliate_id, order_id, invoice_id').eq('affiliate_id', ids[0]).limit(ROW_LIMIT)).data
      : (await db.from('commissions').select('affiliate_id, order_id, invoice_id').limit(ROW_LIMIT)).data) ?? []) as Row[];

  const affiliateIds = new Set(ids);
  const boundIds = boundCustomers
    .filter((c) => c.affiliate_id && affiliateIds.has(c.affiliate_id) && c.id !== c.affiliate_id)
    .map((c) => String(c.id));
  const mine = commissions.filter((c) => affiliateIds.has(c.affiliate_id));
  const orderIds = mine.map((c) => c.order_id).filter(Boolean) as string[];
  const invoiceIds = mine.map((c) => c.invoice_id).filter(Boolean) as string[];

  const orderCols = `id, customer_id, total, status, created_at${opts.withProducts ? ', items' : ''}`;
  const invoiceCols = 'id, customer_id, customer_email, customer_name, order_id, total, status, created_at';
  const [ordersByCustomer, ordersById, invoicesByCustomer, invoicesById] = await Promise.all([
    selectIn(db, 'orders', orderCols, 'customer_id', boundIds),
    selectIn(db, 'orders', orderCols, 'id', orderIds),
    selectIn(db, 'invoices', invoiceCols, 'customer_id', boundIds),
    selectIn(db, 'invoices', invoiceCols, 'id', invoiceIds),
  ]);
  const invoices = [...invoicesByCustomer, ...invoicesById];

  const invoiceLines = opts.withProducts
    ? await selectIn(
        db,
        'invoice_line_items',
        'invoice_id, description, qty, unit_price',
        'invoice_id',
        invoices.map((i) => String(i.id)),
      )
    : [];

  return buildAffiliateReferrals({
    affiliates,
    boundCustomers,
    commissions,
    orders: [...ordersByCustomer, ...ordersById],
    invoices,
    invoiceLines,
  });
}
