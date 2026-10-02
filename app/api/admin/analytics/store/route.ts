import { NextRequest, NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { canViewAnalytics, type UserRole } from '@/lib/permissions';
import { ADMIN_VIEW_PARAM, previewedRole } from '@/lib/admin/admin-view';
import {
  isPaidAdsScoped,
  isPaidVisitorRow,
  loadPaidVisitorScope,
  scopeToPaidAds,
  PAID_ADS_SCOPE_NOTE,
  PAID_ADS_UNAVAILABLE_NOTE,
  type PaidVisitorScope,
} from '@/lib/analytics/paid-scope';
import { normalizeCurrency, type Currency } from '@/lib/currency';
import {
  ORDER_STATUS_BUCKETS,
  STOREFRONT_PAID_STATUSES,
  puramassStatusBucket,
  storefrontStatusBucket,
  type OrderStatusBucket,
} from '@/lib/admin/order-status-buckets';
import {
  normalizeCity, normalizeCountry, normalizePostalArea, normalizeRegion,
  type NormalizedRegion,
} from '@/lib/admin/geo';
import type {
  StoreCategoryRow,
  StoreChannel,
  StoreCustomerRow,
  StoreCustomers,
  StoreDailyPoint,
  StoreLocationLevel,
  StoreLocationNode,
  StoreLocations,
  StoreProductRow,
  StoreReport,
  StoreTotals,
} from '@/lib/admin/store-analytics';

/**
 * WooCommerce-style store report: date-wise sales and orders, product- and
 * category-wise sales, a country → state → city → postal-area location tree,
 * and customer mix — for one sales channel at a time.
 *
 * Why one channel at a time: storefront orders are priced in the store's base
 * currency (CAD) while the Stealth Health hosted checkout settles in USD. A
 * single "total sales" across both would be adding two currencies together, so
 * the caller picks a channel and every figure below is in that channel's
 * currency. The `channels` block still reports both order counts so the UI can
 * show what exists without mixing money.
 *
 * Readable by admin, assistant, and the analytics/marketing role — the same
 * gate as the rest of the analytics surface (lib/permissions.canViewAnalytics).
 * The analytics role reads a narrowed version of it, in two ways:
 *
 *   • Sales are limited to orders a PAID AD won. That role is an external
 *     marketing partner, so orders, revenue, products, locations, buyers and
 *     the traffic they are divided by are all filtered to PAID_CHANNELS
 *     (lib/analytics/paid-scope.ts) at the database, before any aggregation.
 *   • Customer *identities* are withheld: it has no access to customer records
 *     anywhere else in the admin, so it gets the aggregate customer mix
 *     without the named leaderboard.
 */

export const revalidate = 30;

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Which lifecycle state an order is in is decided by
// lib/admin/order-status-buckets.ts, shared with the UI so the chart's series
// and this collector's counters cannot drift apart.

// Bounded reads: this is an analytics page, not an export.
const ROW_LIMIT = 50_000;
const ACTIVITY_LIMIT = 100_000;
// Ids travel in the query string, so every "look these up" pass is chunked.
const ID_CHUNK = 200;
const MAX_ID_CHUNKS = 25;

const MAX_PRODUCT_ROWS = 200;
const MAX_CATEGORY_ROWS = 50;
const MAX_PRODUCTS_PER_CATEGORY = 25;
const MAX_LOCATION_CHILDREN = 50;
const MAX_TOP_CUSTOMERS = 25;

// ---- small helpers ----

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pct = (a: number, b: number) => (b > 0 ? +((a / b) * 100).toFixed(1) : 0);

/** UTC day key. Daily buckets are UTC days — stated in the UI next to the chart. */
const dayKey = (ts: unknown) => String(ts ?? '').slice(0, 10);

const startISO = (day: string) => `${day}T00:00:00.000Z`;

/** Exclusive upper bound at the next UTC midnight, so `to` includes its whole day. */
function endExclusiveISO(day: string): string {
  const d = new Date(startISO(day));
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

function shiftDay(day: string, n: number): string {
  const d = new Date(startISO(day));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Inclusive day count between two YYYY-MM-DD days. */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(startISO(from));
  const b = Date.parse(startISO(to));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 1;
  return Math.max(1, Math.round((b - a) / 86_400_000) + 1);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function text(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

/** Coerce a JSONB column that may arrive as an object or as a JSON string. */
function asRecord(v: unknown): Record<string, unknown> | null {
  let value = v;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(v: unknown): Record<string, unknown>[] {
  let value = v;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  return value.filter((i): i is Record<string, unknown> => !!i && typeof i === 'object');
}

/** Split ids into query-string-sized chunks, capped so one huge range can't fan out. */
function chunkIds(ids: string[]): { chunks: string[][]; truncated: boolean } {
  const unique = [...new Set(ids.filter(Boolean))];
  const all: string[][] = [];
  for (let i = 0; i < unique.length; i += ID_CHUNK) all.push(unique.slice(i, i + ID_CHUNK));
  return { chunks: all.slice(0, MAX_ID_CHUNKS), truncated: all.length > MAX_ID_CHUNKS };
}

async function readerRole(req: NextRequest): Promise<UserRole | null> {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return null;
  const { data } = await db.from('customers').select('role').eq('id', user.id).single();
  return (data?.role as UserRole | undefined) ?? null;
}

// ---- accumulators ----

interface DayBucket {
  orders: number;
  paid: number;
  sales: number;
  items: number;
  /** One counter per outcome — see lib/admin/order-status-buckets.ts. */
  status: Record<OrderStatusBucket, number>;
  /** Cart value behind the day's pending / expired checkouts. Not revenue. */
  pendingValue: number;
  expiredValue: number;
}

function emptyStatusCounts(): Record<OrderStatusBucket, number> {
  return Object.fromEntries(
    ORDER_STATUS_BUCKETS.map((bucket) => [bucket, 0]),
  ) as Record<OrderStatusBucket, number>;
}

interface ProductBucket {
  name: string;
  sku: string | null;
  /** Catalog product id, when the line carried one — used to resolve the category. */
  productId: string | null;
  category: string | null;
  categoryName: string | null;
  items: number;
  orders: number;
  sales: number;
  customers: Set<string>;
  units: { vial: number; pack: number; other: number };
  firstSale: string | null;
  lastSale: string | null;
}

/** One node of the country → state → city → postal-area tree. */
interface PlaceNode {
  key: string;
  level: StoreLocationLevel;
  label: string;
  code: string;
  country: string | null;
  orders: number;
  items: number;
  sales: number;
  customers: Set<string>;
  children: Map<string, PlaceNode>;
}

interface CustomerBucket {
  name: string | null;
  email: string | null;
  orders: number;
  items: number;
  sales: number;
}

/** Everything one channel contributes for one time window. */
interface Slice {
  currency: Currency;
  totals: StoreTotals;
  days: Map<string, DayBucket>;
  products: Map<string, ProductBucket>;
  places: Map<string, PlaceNode>;
  customers: Map<string, CustomerBucket>;
  knownLocationOrders: number;
  unknownLocationOrders: number;
  notes: string[];
}

function emptyTotals(): StoreTotals {
  return {
    gross_sales: 0, discounts: 0, refunds: 0, shipping: 0, tax: 0,
    net_sales: 0, total_sales: 0,
    orders: 0, paid_orders: 0, refunded_orders: 0,
    pending_orders: 0, expired_orders: 0, cancelled_orders: 0, other_orders: 0,
    pending_value: 0, expired_value: 0,
    aov: 0, items_sold: 0,
    customers: 0, new_customers: 0, visitors: 0, conversion: 0,
  };
}

function emptySlice(currency: Currency): Slice {
  return {
    currency,
    totals: emptyTotals(),
    days: new Map(),
    products: new Map(),
    places: new Map(),
    customers: new Map(),
    knownLocationOrders: 0,
    unknownLocationOrders: 0,
    notes: [],
  };
}

function bumpDay(slice: Slice, day: string): DayBucket {
  let b = slice.days.get(day);
  if (!b) {
    b = {
      orders: 0, paid: 0, sales: 0, items: 0,
      status: emptyStatusCounts(), pendingValue: 0, expiredValue: 0,
    };
    slice.days.set(day, b);
  }
  return b;
}

/**
 * Record one order's outcome against the day and the range totals.
 *
 * `value` is the cart's worth, carried only for the unpaid states: what the
 * desk stands to win by chasing a pending link, and what it lost when one
 * expired. Paid money is accumulated by the callers, which know the difference
 * between gross, net and refunded.
 */
function recordStatus(
  slice: Slice, bucket: DayBucket, status: OrderStatusBucket, value: number,
) {
  const t = slice.totals;
  bucket.status[status] += 1;
  if (status === 'pending') {
    t.pending_orders += 1;
    t.pending_value += value;
    bucket.pendingValue += value;
  } else if (status === 'expired') {
    t.expired_orders += 1;
    t.expired_value += value;
    bucket.expiredValue += value;
  } else if (status === 'cancelled') {
    t.cancelled_orders += 1;
  } else if (status === 'other') {
    t.other_orders += 1;
  }
}

function bumpProduct(
  slice: Slice, key: string, name: string, sku: string | null, productId: string | null,
): ProductBucket {
  let b = slice.products.get(key);
  if (!b) {
    b = {
      name, sku, productId, category: null, categoryName: null,
      items: 0, orders: 0, sales: 0, customers: new Set(),
      units: { vial: 0, pack: 0, other: 0 },
      firstSale: null, lastSale: null,
    };
    slice.products.set(key, b);
  }
  // A later line may know the name/sku/id when the first didn't.
  if (!b.name && name) b.name = name;
  if (!b.sku && sku) b.sku = sku;
  if (!b.productId && productId) b.productId = productId;
  return b;
}

function bumpCustomer(
  slice: Slice, key: string, email: string | null,
): CustomerBucket {
  let b = slice.customers.get(key);
  if (!b) { b = { name: null, email, orders: 0, items: 0, sales: 0 }; slice.customers.set(key, b); }
  if (!b.email && email) b.email = email;
  return b;
}

// ---- location tree ----

interface PlaceStep { level: StoreLocationLevel; code: string; label: string }

/**
 * The address path for one order, deepest-known-last. A level the address
 * didn't record is skipped rather than filled with a placeholder: the node
 * carries its own `level`, so a city sitting directly under a country still
 * renders as a city and nothing is invented.
 */
function addressPath(
  address: Record<string, unknown> | null,
  fallback: { country?: unknown; state?: unknown; city?: unknown; postal?: unknown } | null,
): { country: string | null; steps: PlaceStep[] } {
  const country = normalizeCountry(address?.country) ?? normalizeCountry(fallback?.country);
  const region: NormalizedRegion | null =
    normalizeRegion(country, address?.state ?? address?.province) ??
    normalizeRegion(country, fallback?.state);
  const city = normalizeCity(address?.city) ?? normalizeCity(fallback?.city);
  const postal = normalizePostalArea(
    country,
    address?.zip ?? address?.postalCode ?? address?.postal_code ?? fallback?.postal,
  );

  const steps: PlaceStep[] = [];
  if (country) steps.push({ level: 'country', code: country, label: country });
  if (region) steps.push({ level: 'state', code: region.code, label: region.name });
  if (city) steps.push({ level: 'city', code: city.code, label: city.name });
  if (postal) steps.push({ level: 'postal', code: postal.code, label: postal.name });
  return { country, steps };
}

/**
 * Fold one paid order's destination into every level of the tree it reaches.
 * A parent's totals include its children's, so a country row is the sum of its
 * provinces whether or not the reader has expanded them.
 */
function recordLocation(
  slice: Slice,
  address: Record<string, unknown> | null,
  fallback: { country?: unknown; state?: unknown; city?: unknown; postal?: unknown } | null,
  sales: number,
  items: number,
  buyerKey: string | null,
) {
  const { country, steps } = addressPath(address, fallback);
  if (steps.length === 0) {
    slice.unknownLocationOrders += 1;
    return;
  }
  slice.knownLocationOrders += 1;

  let level = slice.places;
  let path = '';
  for (const step of steps) {
    path = path ? `${path}|${step.code}` : step.code;
    let node = level.get(step.code);
    if (!node) {
      node = {
        key: path, level: step.level, label: step.label, code: step.code, country,
        orders: 0, items: 0, sales: 0, customers: new Set(), children: new Map(),
      };
      level.set(step.code, node);
    }
    node.orders += 1;
    node.items += items;
    node.sales += sales;
    if (buyerKey) node.customers.add(buyerKey);
    level = node.children;
  }
}

// ---- storefront channel ----

const ORDER_COLUMNS =
  'id, status, total, subtotal, shipping_cost, tax_total, discount_total, discount_amount, ' +
  'refunded_at, created_at, customer_id, email, items, shipping_address, ' +
  'customers ( first_name, last_name, email, shipping_country, shipping_state, shipping_city, shipping_postal_code )';

async function collectStorefront(
  fromDay: string, toDay: string, paidOnly: boolean,
): Promise<Slice> {
  const slice = emptySlice('CAD');
  const { data, error } = await scopeToPaidAds(
    db
      .from('orders')
      .select(ORDER_COLUMNS)
      .gte('created_at', startISO(fromDay))
      .lt('created_at', endExclusiveISO(toDay))
      .limit(ROW_LIMIT),
    paidOnly,
  );

  if (error) {
    // Fails closed: a scoped read that can't apply the channel filter reports
    // nothing rather than falling back to every order.
    slice.notes.push(
      paidOnly
        ? PAID_ADS_UNAVAILABLE_NOTE
        : `Storefront orders could not be read: ${error.message}`,
    );
    return slice;
  }

  const rows = (data ?? []) as any[];
  const t = slice.totals;
  // Paid orders with no `items` JSONB — their lines live in `order_items`
  // (manually-created orders). Resolved in a second, chunked pass.
  const needsItemLookup: Array<{ id: string; day: string; buyer: string | null }> = [];

  for (const o of rows) {
    const status = String(o.status ?? '').toLowerCase();
    const day = dayKey(o.created_at);
    const bucket = bumpDay(slice, day);
    t.orders += 1;
    bucket.orders += 1;

    const outcome = storefrontStatusBucket(status, o.refunded_at);
    recordStatus(slice, bucket, outcome, num(o.total));

    // A refunded order is excluded from sales rather than subtracted from
    // them: it never contributed revenue in the first place, so subtracting it
    // as well would count the refund twice. `refunds` stays as its own figure.
    if (outcome === 'refunded') {
      t.refunded_orders += 1;
      t.refunds += num(o.total);
      continue;
    }
    if (outcome !== 'paid') continue;

    const total = num(o.total);
    const shipping = num(o.shipping_cost);
    const tax = num(o.tax_total);
    const discount = num(o.discount_total) || num(o.discount_amount);
    // `subtotal` is only populated on newer orders; older rows are reconstructed
    // from the total so their revenue isn't reported as zero.
    const subtotal = o.subtotal != null ? num(o.subtotal) : total - shipping - tax + discount;

    t.paid_orders += 1;
    t.gross_sales += subtotal;
    t.discounts += discount;
    t.shipping += shipping;
    t.tax += tax;
    t.net_sales += subtotal - discount;
    t.total_sales += total;
    bucket.paid += 1;
    bucket.sales += total;

    const buyer = buyerKeyOf(o.customer_id, o.email);
    let customer: CustomerBucket | null = null;
    if (buyer) {
      customer = bumpCustomer(slice, buyer, text(o.customers?.email) ?? text(o.email));
      customer.orders += 1;
      customer.sales += total;
      if (!customer.name) {
        customer.name = [text(o.customers?.first_name), text(o.customers?.last_name)]
          .filter(Boolean).join(' ') || null;
      }
    }

    const lines = asArray(o.items);
    // One order counts once per product, even when it carries both a vial line
    // and a case line of the same product.
    const seenProducts = new Set<string>();
    let orderItems = 0;
    if (lines.length > 0) {
      for (const line of lines) {
        const qty = Math.max(0, Math.round(num(line.quantity ?? line.qty)));
        if (qty <= 0) continue;
        const name =
          text(line.name) ?? text(line.name_snapshot) ?? text(line.product_name) ?? 'Unnamed product';
        const id = text(line.id) ?? text(line.product_id);
        const sku = text(line.sku) ?? text(line.sku_snapshot);
        const unit = num(line.price ?? line.unit_price ?? line.price_at_time);
        const productKey = id ?? `name:${name.toLowerCase()}`;
        const p = bumpProduct(slice, productKey, name, sku, id);
        p.items += qty;
        if (!seenProducts.has(productKey)) { p.orders += 1; seenProducts.add(productKey); }
        p.sales += unit * qty;
        if (buyer) p.customers.add(buyer);
        // The storefront records a cart line as a single vial or a full case.
        const kind = text(line.unit);
        if (kind === 'vial') p.units.vial += qty;
        else if (kind === 'case' || kind === 'pack' || kind === 'box') p.units.pack += qty;
        else p.units.other += qty;
        touchSaleDates(p, day);
        orderItems += qty;
      }
    } else {
      needsItemLookup.push({ id: String(o.id), day, buyer });
    }

    t.items_sold += orderItems;
    bucket.items += orderItems;
    if (customer) customer.items += orderItems;

    recordLocation(
      slice,
      asRecord(o.shipping_address),
      o.customers
        ? {
            country: o.customers.shipping_country,
            state: o.customers.shipping_state,
            city: o.customers.shipping_city,
            postal: o.customers.shipping_postal_code,
          }
        : null,
      total,
      orderItems,
      buyer,
    );
  }

  if (needsItemLookup.length > 0) {
    await attachOrderItems(db, slice, needsItemLookup);
  }

  finalizeTotals(t);
  return slice;
}

/** Stable per-buyer key: the account where there is one, else the order email. */
function buyerKeyOf(customerId: unknown, email: unknown): string | null {
  if (customerId) return String(customerId);
  const e = text(email);
  return e ? `email:${e.toLowerCase()}` : null;
}

function touchSaleDates(p: ProductBucket, day: string) {
  if (!p.firstSale || day < p.firstSale) p.firstSale = day;
  if (!p.lastSale || day > p.lastSale) p.lastSale = day;
}

/**
 * Pull line items for paid orders that carry no `items` JSONB. Best-effort: a
 * failed chunk leaves those orders counted in revenue but absent from the
 * product breakdown, which is far better than failing the whole report.
 */
async function attachOrderItems(
  client: SupabaseClient,
  slice: Slice,
  orders: Array<{ id: string; day: string; buyer: string | null }>,
) {
  const byId = new Map(orders.map((o) => [o.id, o]));
  // Product ids already counted for a given order, so a split line doesn't
  // inflate that product's order count.
  const seenPerOrder = new Map<string, Set<string>>();
  const { chunks, truncated } = chunkIds(orders.map((o) => o.id));
  if (truncated) {
    slice.notes.push('Product breakdown covers the most recent orders only — the range is very large.');
  }

  for (const chunk of chunks) {
    const { data, error } = await client
      .from('order_items')
      .select(
        'order_id, product_id, product_name, name_snapshot, sku_snapshot, quantity, price_at_time, line_total',
      )
      .in('order_id', chunk);
    if (error) {
      slice.notes.push('Some order line items could not be read.');
      break;
    }
    for (const row of (data ?? []) as any[]) {
      const qty = Math.max(0, Math.round(num(row.quantity)));
      if (qty <= 0) continue;
      const name = text(row.name_snapshot) ?? text(row.product_name) ?? 'Unnamed product';
      const id = text(row.product_id);
      const sku = text(row.sku_snapshot);
      const lineTotal = row.line_total != null ? num(row.line_total) : num(row.price_at_time) * qty;
      const order = byId.get(String(row.order_id));

      const productKey = id ?? `name:${name.toLowerCase()}`;
      const p = bumpProduct(slice, productKey, name, sku, id);
      p.items += qty;
      let seen = seenPerOrder.get(String(row.order_id));
      if (!seen) { seen = new Set(); seenPerOrder.set(String(row.order_id), seen); }
      if (!seen.has(productKey)) { p.orders += 1; seen.add(productKey); }
      p.sales += lineTotal;
      p.units.other += qty;
      if (order?.buyer) p.customers.add(order.buyer);

      slice.totals.items_sold += qty;
      if (order) {
        touchSaleDates(p, order.day);
        bumpDay(slice, order.day).items += qty;
        const customer = order.buyer ? slice.customers.get(order.buyer) : undefined;
        if (customer) customer.items += qty;
      }
    }
  }
}

// ---- hosted-checkout (Stealth Health) channel ----

async function collectPuramass(
  fromDay: string, toDay: string, paidOnly: boolean,
): Promise<Slice> {
  // `select('*')` on purpose: naming columns breaks the query on a database
  // that hasn't run the later Stealth Health migrations (address / refund columns).
  const { data, error } = await scopeToPaidAds(
    db
      .from('puramass_orders')
      .select('*')
      .gte('created_at', startISO(fromDay))
      .lt('created_at', endExclusiveISO(toDay))
      .limit(ROW_LIMIT),
    paidOnly,
  );

  const rows = (data ?? []) as any[];

  // Headline currency is whichever the paid orders actually settled in.
  const netByCurrency: Record<Currency, number> = { CAD: 0, USD: 0 };
  for (const r of rows) {
    if (String(r.status ?? '') !== 'paid') continue;
    netByCurrency[pmCurrency(r.currency)] += num(r.subtotal_cents) / 100;
  }
  const currency: Currency = netByCurrency.CAD > netByCurrency.USD ? 'CAD' : 'USD';

  const slice = emptySlice(currency);
  if (error) {
    slice.notes.push(
      paidOnly
        ? PAID_ADS_UNAVAILABLE_NOTE
        : `Hosted-checkout orders could not be read: ${error.message}`,
    );
    return slice;
  }

  const t = slice.totals;
  let otherCurrencyPaid = 0;

  for (const r of rows) {
    const status = String(r.status ?? '');
    const day = dayKey(r.paid_at ?? r.created_at);
    const bucket = bumpDay(slice, day);
    t.orders += 1;
    bucket.orders += 1;

    // A hand-off that never paid still has a cart worth: it is what the desk
    // stands to recover. Counted only in the currency the report is in, for
    // the same reason paid revenue is.
    const outcome = puramassStatusBucket(status);
    const cartValue = pmCurrency(r.currency) === currency ? num(r.subtotal_cents) / 100 : 0;
    recordStatus(slice, bucket, outcome, cartValue);

    if (outcome !== 'paid') continue;

    // A hand-off settled in the other currency is counted as an order but its
    // money is left out rather than added to a different currency's total.
    if (pmCurrency(r.currency) !== currency) {
      otherCurrencyPaid += 1;
      t.paid_orders += 1;
      bucket.paid += 1;
      continue;
    }

    const gross = num(r.subtotal_cents) / 100;
    const refund = num(r.refunded_total_cents) / 100;
    const net = Math.max(0, gross - refund);

    t.paid_orders += 1;
    t.gross_sales += gross;
    t.refunds += refund;
    t.net_sales += net;
    t.total_sales += net;
    if (refund > 0) t.refunded_orders += 1;
    bucket.paid += 1;
    bucket.sales += net;

    const buyer = buyerKeyOf(r.customer_id, r.customer_email);
    let customer: CustomerBucket | null = null;
    if (buyer) {
      customer = bumpCustomer(slice, buyer, text(r.customer_email));
      customer.orders += 1;
      customer.sales += net;
      if (!customer.name) customer.name = text(r.customer_name);
    }

    // `paid_items` is what Stealth Health charged (priced); `items` is the sku list we
    // sent at hand-off (no prices). Prefer the former.
    const paidLines = asArray(r.paid_items);
    const lines = paidLines.length > 0 ? paidLines : asArray(r.items);
    const seenProducts = new Set<string>();
    let orderItems = 0;
    for (const line of lines) {
      const qty = Math.max(0, Math.round(num(line.quantity ?? 1)));
      if (qty <= 0) continue;
      const sku = text(line.sku);
      const name = text(line.name) ?? sku ?? 'Unnamed product';
      const unit = line.unit_price_cents != null ? num(line.unit_price_cents) / 100 : 0;
      const productKey = sku ? `sku:${sku}` : `name:${name.toLowerCase()}`;
      const p = bumpProduct(slice, productKey, name, sku, null);
      p.items += qty;
      if (!seenProducts.has(productKey)) { p.orders += 1; seenProducts.add(productKey); }
      p.sales += unit * qty;
      if (buyer) p.customers.add(buyer);
      // The vial/pack split is decided by which Stealth Health SKU it is; resolved
      // against the catalog once the whole range has been read.
      p.units.other += qty;
      touchSaleDates(p, day);
      orderItems += qty;
    }
    t.items_sold += orderItems;
    bucket.items += orderItems;
    if (customer) customer.items += orderItems;

    recordLocation(slice, asRecord(r.shipping_address), null, net, orderItems, buyer);
  }

  if (otherCurrencyPaid > 0) {
    slice.notes.push(
      `${otherCurrencyPaid} paid hand-off${otherCurrencyPaid === 1 ? '' : 's'} settled in the other currency and ` +
      `${otherCurrencyPaid === 1 ? 'is' : 'are'} counted in orders but not in ${currency} revenue.`,
    );
  }

  finalizeTotals(t);
  return slice;
}

/** Stealth Health reports currency lower-cased; the hosted checkout is USD by default. */
function pmCurrency(v: unknown): Currency {
  return normalizeCurrency(String(v ?? 'usd').toUpperCase());
}

// ---- catalog enrichment (category + the Stealth Health vial/pack split) ----

/**
 * Attach the catalog category to every product bucket, and — for hosted
 * checkout, where a line is only a SKU — work out whether that SKU is the
 * single-vial or the pack listing. Best-effort: a product that can't be
 * resolved keeps its line-level name and lands under "Uncategorised".
 */
async function enrichProducts(slice: Slice, channel: StoreChannel) {
  const buckets = [...slice.products.values()];
  if (buckets.length === 0) return;

  const bySlug = new Map<string, ProductBucket[]>();
  const record = (row: any, bucket: ProductBucket, vialSku: boolean) => {
    if (row.name) bucket.name = vialSku ? `${row.name} (single vial)` : row.name;
    if (!bucket.sku && row.sku) bucket.sku = row.sku;
    const slug = text(row.category);
    if (slug) {
      bucket.category = slug;
      const list = bySlug.get(slug) ?? [];
      list.push(bucket);
      bySlug.set(slug, list);
    }
    if (channel === 'puramass') {
      const qty = bucket.units.other;
      bucket.units.other = 0;
      if (vialSku) bucket.units.vial += qty; else bucket.units.pack += qty;
    }
  };

  if (channel === 'storefront') {
    const byId = new Map(buckets.filter((b) => b.productId).map((b) => [b.productId!, b]));
    const { chunks } = chunkIds([...byId.keys()]);
    for (const chunk of chunks) {
      const { data } = await db.from('products').select('id, name, sku, category').in('id', chunk);
      for (const row of (data ?? []) as any[]) {
        const bucket = byId.get(String(row.id));
        if (bucket) record(row, bucket, false);
      }
    }
  } else {
    const bySku = new Map(buckets.filter((b) => b.sku).map((b) => [b.sku!, b]));
    const skus = [...bySku.keys()];
    if (skus.length > 0) {
      const list = skus.map((s) => `"${s.replace(/"/g, '')}"`).join(',');
      const { data } = await db
        .from('products')
        .select('name, sku, category, puramass_sku, puramass_sku_vial')
        .or(`puramass_sku.in.(${list}),puramass_sku_vial.in.(${list})`);
      for (const row of (data ?? []) as any[]) {
        const packBucket = row.puramass_sku ? bySku.get(String(row.puramass_sku)) : undefined;
        if (packBucket) record(row, packBucket, false);
        const vialBucket = row.puramass_sku_vial ? bySku.get(String(row.puramass_sku_vial)) : undefined;
        if (vialBucket) record(row, vialBucket, true);
      }
    }
  }

  // Slug → display name for the categories the products actually landed in.
  const slugs = [...bySlug.keys()];
  if (slugs.length === 0) return;
  const { data: cats } = await db
    .from('store_categories')
    .select('slug, name')
    .in('slug', slugs.slice(0, ID_CHUNK));
  const nameBySlug = new Map(
    ((cats ?? []) as any[]).map((c) => [String(c.slug), String(c.name ?? c.slug)]),
  );
  for (const [slug, list] of bySlug) {
    const label = nameBySlug.get(slug) ?? slug;
    for (const bucket of list) bucket.categoryName = label;
  }
}

// ---- customer mix ----

/**
 * Split the range's buyers into new and returning by asking whether each had a
 * paid order before the range started. Chunked and capped: past the cap the
 * split is reported as partial rather than guessed at.
 */
async function splitNewReturning(
  channel: StoreChannel, buyerIds: string[], fromDay: string, paidOnly: boolean,
): Promise<{ returning: Set<string>; truncated: boolean }> {
  const returning = new Set<string>();
  // Only account-linked buyers can be looked up; a guest email has no history.
  const accountIds = buyerIds.filter((id) => !id.startsWith('email:'));
  const { chunks, truncated } = chunkIds(accountIds);

  for (const chunk of chunks) {
    // The history lookup is scoped the same way as the range itself, so a
    // reader limited to paid-ads sales is never told about an earlier order it
    // cannot see: "returning" there means they had bought through an ad before.
    const query = scopeToPaidAds(
      channel === 'puramass'
        ? db.from('puramass_orders').select('customer_id')
            .in('customer_id', chunk).lt('created_at', startISO(fromDay)).eq('status', 'paid')
        : db.from('orders').select('customer_id')
            .in('customer_id', chunk).lt('created_at', startISO(fromDay)).in('status', STOREFRONT_PAID_STATUSES),
      paidOnly,
    );
    const { data, error } = await query.limit(ROW_LIMIT);
    if (error) return { returning, truncated: true };
    for (const row of (data ?? []) as any[]) {
      if (row.customer_id) returning.add(String(row.customer_id));
    }
  }
  return { returning, truncated };
}

async function buildCustomers(
  slice: Slice, channel: StoreChannel, fromDay: string,
  includeIdentities: boolean, paidOnly: boolean,
): Promise<StoreCustomers> {
  const entries = [...slice.customers.entries()];
  const total = entries.length;
  const { returning, truncated } = total > 0
    ? await splitNewReturning(channel, entries.map(([k]) => k), fromDay, paidOnly)
    : { returning: new Set<string>(), truncated: false };

  const returningCount = entries.filter(([k]) => returning.has(k)).length;
  const totalOrders = entries.reduce((s, [, c]) => s + c.orders, 0);
  const totalSales = entries.reduce((s, [, c]) => s + c.sales, 0);

  let top: StoreCustomerRow[] | null = null;
  if (includeIdentities) {
    top = entries
      .map(([key, c]) => ({
        key,
        name: c.name,
        email: c.email,
        orders: c.orders,
        items: c.items,
        sales: round2(c.sales),
      }))
      .sort((a, b) => b.sales - a.sales || b.orders - a.orders)
      .slice(0, MAX_TOP_CUSTOMERS);
  }

  return {
    total,
    new: Math.max(0, total - returningCount),
    returning: returningCount,
    repeat_rate: pct(returningCount, total),
    orders_per_customer: total > 0 ? +(totalOrders / total).toFixed(2) : 0,
    sales_per_customer: total > 0 ? round2(totalSales / total) : 0,
    top,
    truncated,
  };
}

// ---- shared traffic figures ----

/**
 * Shopper activity for the window: distinct visitors overall and per day, plus
 * new registrations.
 *
 * This used to count signed-in customers only, because `customer_activity` was
 * never written for anonymous visitors — it undercounted real traffic by
 * design, and the conversion rates derived from it were correspondingly
 * flattering. Since marketing-attribution-migration.sql the table also records
 * visitors who are not signed in, keyed by their visitor cookie.
 *
 * A visitor is identified by `customer_id` when we know who they are and by
 * `anonymous_id` otherwise. Signing in backfills `customer_id` onto the rows
 * recorded beforehand, so a session that starts anonymous and ends signed-in
 * collapses to one person rather than counting twice.
 */
async function collectTraffic(
  fromDay: string, toDay: string, visitorScope: PaidVisitorScope | null,
) {
  const fromISO = startISO(fromDay);
  const toISO = endExclusiveISO(toDay);
  const paidOnly = visitorScope !== null;

  const activityQuery = (columns: string) =>
    db.from('customer_activity')
      .select(columns)
      .gte('created_at', fromISO)
      .lt('created_at', toISO)
      .limit(ACTIVITY_LIMIT);

  const [activityResRaw, registrationsRes] = await Promise.all([
    activityQuery('customer_id, anonymous_id, created_at'),
    scopeToPaidAds(
      db.from('customers')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'customer')
        .gte('created_at', fromISO)
        .lt('created_at', toISO),
      paidOnly,
    ),
  ]);

  // Fall back to the signed-in-only count if the attribution migration has not
  // been applied — a missing column must not empty out the traffic panel.
  const activityRes = activityResRaw.error
    ? await activityQuery('customer_id, created_at')
    : activityResRaw;

  const perDay = new Map<string, Set<string>>();
  const all = new Set<string>();
  for (const a of (activityRes.data ?? []) as any[]) {
    // Scoped readers count only the visitors an ad won, so the conversion rate
    // divides paid-ads orders by the traffic that produced them.
    if (visitorScope && !isPaidVisitorRow(visitorScope, a)) continue;
    // Prefer the customer id, so pre-signup and post-signup rows for the same
    // person share one identity.
    const id = a.customer_id ? `c:${a.customer_id}` : a.anonymous_id ? `v:${a.anonymous_id}` : null;
    if (!id) continue;
    all.add(id);
    const key = dayKey(a.created_at);
    let s = perDay.get(key);
    if (!s) { s = new Set(); perDay.set(key, s); }
    s.add(id);
  }

  const visitorsPerDay = new Map<string, number>([...perDay].map(([d, s]) => [d, s.size]));

  // The activity log only holds anonymous visitors who accepted the cookie
  // banner, which most never do. The anonymous daily tally
  // (site-traffic-counters-migration.sql) counts every browser, so the full
  // report reads it wherever it has a day. Paid-ads readers keep the activity
  // count: a tally carries no id, so it cannot say which visitors an ad won.
  const tally = paidOnly ? null : await readSiteTraffic(fromDay, toDay);
  if (tally && tally.size > 0) {
    // A day is the larger of the two: a day before the tally existed has only
    // the activity count, and on a day it covers it is the fuller figure.
    for (const [day, n] of tally) {
      visitorsPerDay.set(day, Math.max(n, visitorsPerDay.get(day) ?? 0));
    }
    // A tally is per day, so the range total is the sum of its days — a
    // visitor who returns on three days counts three times.
    let visitors = 0;
    for (const n of visitorsPerDay.values()) visitors += n;
    return { visitors, new_customers: registrationsRes.count ?? 0, perDay: visitorsPerDay };
  }

  return {
    visitors: all.size,
    new_customers: registrationsRes.count ?? 0,
    perDay: visitorsPerDay,
  };
}

/**
 * Anonymous daily visitor tallies for the window, by day. Null when the
 * table isn't there yet, so the caller keeps the activity-based count.
 */
async function readSiteTraffic(fromDay: string, toDay: string): Promise<Map<string, number> | null> {
  const { data, error } = await db
    .from('site_traffic_daily')
    .select('day, visitors')
    .gte('day', fromDay)
    .lte('day', toDay);
  if (error) return null;
  return new Map(
    ((data ?? []) as Array<{ day: string; visitors: number }>).map((r) => [
      String(r.day).slice(0, 10),
      Number(r.visitors) || 0,
    ]),
  );
}

// ---- assembly ----

/**
 * Round the money fields and derive the average. Refunds are deliberately NOT
 * applied here: each channel already reflects its own refund rule (a storefront
 * refund excludes the order; a hosted-checkout refund reduces that order's net),
 * so subtracting again would count every refund twice. This also keeps the sum
 * of the daily series exactly equal to `total_sales`.
 */
function finalizeTotals(t: StoreTotals) {
  t.gross_sales = round2(t.gross_sales);
  t.discounts = round2(t.discounts);
  t.refunds = round2(t.refunds);
  t.shipping = round2(t.shipping);
  t.tax = round2(t.tax);
  t.net_sales = round2(t.net_sales);
  t.total_sales = round2(t.total_sales);
  t.pending_value = round2(t.pending_value);
  t.expired_value = round2(t.expired_value);
  t.aov = t.paid_orders > 0 ? round2(t.total_sales / t.paid_orders) : 0;
}

/**
 * Dense daily series: every day in the range, including the ones with no
 * orders. A gap-free axis is the whole point of a date-wise ad-comparison
 * chart — a missing day must read as zero, not as "the line jumped".
 */
function buildDaily(
  slice: Slice,
  visitorsPerDay: Map<string, number>,
  fromDay: string,
  toDay: string,
): StoreDailyPoint[] {
  const out: StoreDailyPoint[] = [];
  const total = daysBetween(fromDay, toDay);
  for (let i = 0; i < total; i++) {
    const date = shiftDay(fromDay, i);
    const b = slice.days.get(date);
    out.push({
      date,
      orders: b?.orders ?? 0,
      // `paid` and `status.paid` are the same count reached two ways; the
      // status map is the one the chart stacks, so it is the one reported.
      paid_orders: b?.status.paid ?? 0,
      pending_orders: b?.status.pending ?? 0,
      expired_orders: b?.status.expired ?? 0,
      cancelled_orders: b?.status.cancelled ?? 0,
      refunded_orders: b?.status.refunded ?? 0,
      other_orders: b?.status.other ?? 0,
      sales: round2(b?.sales ?? 0),
      pending_value: round2(b?.pendingValue ?? 0),
      expired_value: round2(b?.expiredValue ?? 0),
      items: b?.items ?? 0,
      visitors: visitorsPerDay.get(date) ?? 0,
    });
  }
  return out;
}

function toProductRow(key: string, p: ProductBucket): StoreProductRow {
  const sales = round2(p.sales);
  return {
    key,
    name: p.name,
    sku: p.sku,
    category: p.category,
    category_name: p.categoryName,
    items_sold: p.items,
    orders: p.orders,
    net_sales: sales,
    customers: p.customers.size,
    avg_price: p.items > 0 ? round2(sales / p.items) : 0,
    units: { ...p.units },
    first_sale: p.firstSale,
    last_sale: p.lastSale,
  };
}

function buildProducts(slice: Slice): StoreProductRow[] {
  return [...slice.products.entries()]
    .map(([key, p]) => toProductRow(key, p))
    .sort((a, b) => b.net_sales - a.net_sales || b.items_sold - a.items_sold)
    .slice(0, MAX_PRODUCT_ROWS);
}

/** Category rollups, each carrying its own ranked products for the expanded row. */
function buildCategories(products: StoreProductRow[]): StoreCategoryRow[] {
  const groups = new Map<string, { name: string; rows: StoreProductRow[] }>();
  for (const p of products) {
    const key = p.category ?? '__uncategorised';
    let g = groups.get(key);
    if (!g) {
      g = { name: p.category_name ?? (p.category ? p.category : 'Uncategorised'), rows: [] };
      groups.set(key, g);
    }
    g.rows.push(p);
  }

  return [...groups.entries()]
    .map(([key, g]) => {
      const rows = [...g.rows].sort((a, b) => b.net_sales - a.net_sales);
      return {
        key,
        name: g.name,
        items_sold: rows.reduce((s, r) => s + r.items_sold, 0),
        orders: rows.reduce((s, r) => s + r.orders, 0),
        net_sales: round2(rows.reduce((s, r) => s + r.net_sales, 0)),
        product_count: rows.length,
        products: rows.slice(0, MAX_PRODUCTS_PER_CATEGORY),
      };
    })
    .sort((a, b) => b.net_sales - a.net_sales)
    .slice(0, MAX_CATEGORY_ROWS);
}

function toLocationNodes(level: Map<string, PlaceNode>): StoreLocationNode[] {
  return [...level.values()]
    .map((node) => ({
      key: node.key,
      level: node.level,
      label: node.label,
      code: node.code,
      country: node.country,
      orders: node.orders,
      items: node.items,
      sales: round2(node.sales),
      customers: node.customers.size,
      children: toLocationNodes(node.children),
    }))
    .sort((a, b) => b.sales - a.sales || b.orders - a.orders)
    .slice(0, MAX_LOCATION_CHILDREN);
}

export async function GET(req: NextRequest) {
  const realRole = await readerRole(req);
  if (!realRole || !canViewAnalytics(realRole)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  // An admin previewing the analytics staff view asks for it with ?view=. It can
  // only ever NARROW what this reader is entitled to (lib/admin/admin-view.ts),
  // so every scope decision below reads the previewed role rather than the
  // account's — the preview is scoped here, at the database, not in the browser.
  const role = previewedRole(realRole, req.nextUrl.searchParams.get(ADMIN_VIEW_PARAM));
  // The analytics/marketing role cannot reach /admin/customers, so it must not
  // get customer identities through the back door of an analytics leaderboard.
  const includeIdentities = role !== 'analytics';
  // Nor may it read sales its ads did not produce: every collector below is
  // filtered to the paid channels, traffic included, so the whole report is one
  // consistent paid-ads picture. See lib/analytics/paid-scope.ts.
  const paidOnly = isPaidAdsScoped(role);
  const scope: 'paid_ads' | 'all' = paidOnly ? 'paid_ads' : 'all';
  const visitorScope = paidOnly ? await loadPaidVisitorScope(db) : null;

  const sp = req.nextUrl.searchParams;
  const from = sp.get('from') ?? '';
  const to = sp.get('to') ?? '';
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || from > to) {
    return NextResponse.json(
      { error: 'A valid from/to date range (YYYY-MM-DD) is required.' },
      { status: 400 },
    );
  }

  const requested = sp.get('channel');
  const wantsCompare = sp.get('compare') === 'previous';

  // Both channels for the main window: the selected one supplies the report,
  // the other only its order counts so the switch can show what's there.
  const [storefront, puramass, traffic] = await Promise.all([
    collectStorefront(from, to, paidOnly),
    collectPuramass(from, to, paidOnly),
    collectTraffic(from, to, visitorScope),
  ]);

  const channel: StoreChannel =
    requested === 'storefront' || requested === 'puramass'
      ? requested
      : puramass.totals.paid_orders > storefront.totals.paid_orders
        ? 'puramass'
        : 'storefront';
  const slice = channel === 'puramass' ? puramass : storefront;

  await enrichProducts(slice, channel);
  const customers = await buildCustomers(slice, channel, from, includeIdentities, paidOnly);

  slice.totals.customers = customers.total;
  slice.totals.visitors = traffic.visitors;
  slice.totals.new_customers = traffic.new_customers;
  slice.totals.conversion = pct(slice.totals.paid_orders, traffic.visitors);

  const days = daysBetween(from, to);
  let compare: { from: string; to: string } | null = null;
  let previous: StoreTotals | null = null;
  if (wantsCompare) {
    const prevTo = shiftDay(from, -1);
    const prevFrom = shiftDay(prevTo, -(days - 1));
    compare = { from: prevFrom, to: prevTo };

    const [prevSlice, prevTraffic] = await Promise.all([
      channel === 'puramass'
        ? collectPuramass(prevFrom, prevTo, paidOnly)
        : collectStorefront(prevFrom, prevTo, paidOnly),
      collectTraffic(prevFrom, prevTo, visitorScope),
    ]);
    prevSlice.totals.customers = prevSlice.customers.size;
    prevSlice.totals.visitors = prevTraffic.visitors;
    prevSlice.totals.new_customers = prevTraffic.new_customers;
    prevSlice.totals.conversion = pct(prevSlice.totals.paid_orders, prevTraffic.visitors);
    previous = prevSlice.totals;
  }

  const locations: StoreLocations = {
    tree: toLocationNodes(slice.places),
    known_orders: slice.knownLocationOrders,
    unknown_orders: slice.unknownLocationOrders,
  };

  const products = buildProducts(slice);

  // The scope note leads the list: every figure below it is a subset, and a
  // total read as the whole business would be wrong by however much organic,
  // affiliate and direct brought in.
  const notes = paidOnly ? [PAID_ADS_SCOPE_NOTE, ...slice.notes] : slice.notes;
  if (paidOnly && visitorScope && !visitorScope.available && !notes.includes(PAID_ADS_UNAVAILABLE_NOTE)) {
    notes.push(PAID_ADS_UNAVAILABLE_NOTE);
  }

  const report: StoreReport = {
    channel,
    scope,
    currency: slice.currency,
    range: { from, to, days },
    compare,
    channels: {
      storefront: {
        orders: storefront.totals.orders,
        paid_orders: storefront.totals.paid_orders,
        currency: storefront.currency,
      },
      puramass: {
        orders: puramass.totals.orders,
        paid_orders: puramass.totals.paid_orders,
        currency: puramass.currency,
      },
    },
    totals: slice.totals,
    previous,
    daily: buildDaily(slice, traffic.perDay, from, to),
    products,
    categories: buildCategories(products),
    locations,
    customers,
    notes,
  };

  return NextResponse.json({ report });
}
