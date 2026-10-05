import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  emailFromPuramassId,
  fetchPuramassLedger,
  groupPuramassByEmail,
  isPuramassId,
  normalizeEmail,
  projectCustomer,
  splitName,
  type PuramassOrderLite,
} from '@/lib/admin/customer-directory';
import { toShippingAddress } from '@/lib/payments/puramass-address';
import { fetchLead, type Lead } from '@/lib/admin/customer-leads';
import { fetchEmailHistory } from '@/lib/admin/crm-actions';
import {
  confirmationSummariesByInvoice,
  confirmationSummariesByOrder,
} from '@/lib/order-confirmation';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function verifyAdmin(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return { ok: false };
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return { ok: false };
  const { data } = await db.from('customers').select('role').eq('id', user.id).single();
  const ok = data?.role === 'admin' || data?.role === 'assistant';
  return { ok };
}

/** `decodeURIComponent` that returns its input instead of throwing. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

interface Agg {
  key: string;
  label: string;
  productId: string | null;
  count: number;
  lastAt: string;
  lastQuantity?: number;
}

/** One product this customer has actually bought, across every channel. */
interface ProductPurchase {
  key: string;
  name: string;
  /** Units bought (vials/packs — whatever the line counted). */
  quantity: number;
  /** Spend on this product, keyed by currency (never converted). */
  spend: Record<string, number>;
  orders: number;
  firstAt: string;
  lastAt: string;
  channels: string[];
}

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

/** Fold purchases into one row per product name (case/space-insensitive key). */
class PurchaseTally {
  private map = new Map<string, ProductPurchase>();

  add(input: {
    name: string;
    quantity: number;
    amount: number;
    currency: string;
    at: string;
    channel: string;
  }) {
    const name = input.name.trim() || 'Unnamed product';
    const key = name.toLowerCase().replace(/\s+/g, ' ');
    const currency = (input.currency || 'CAD').toUpperCase();
    const existing = this.map.get(key);

    if (!existing) {
      this.map.set(key, {
        key,
        name,
        quantity: input.quantity,
        spend: { [currency]: +input.amount.toFixed(2) },
        orders: 1,
        firstAt: input.at,
        lastAt: input.at,
        channels: [input.channel],
      });
      return;
    }

    existing.quantity += input.quantity;
    existing.spend[currency] = +((existing.spend[currency] ?? 0) + input.amount).toFixed(2);
    existing.orders += 1;
    if (input.at < existing.firstAt) existing.firstAt = input.at;
    if (input.at > existing.lastAt) existing.lastAt = input.at;
    if (!existing.channels.includes(input.channel)) existing.channels.push(input.channel);
  }

  /** Biggest buy first — that's the order the chart reads best in. */
  result(): ProductPurchase[] {
    return [...this.map.values()].sort((a, b) => b.quantity - a.quantity);
  }
}

/** Human names for Stealth Health SKUs, via the products SKU mapping. */
async function skuNames(skus: string[]): Promise<Record<string, string>> {
  // SKUs come from partner JSON — anything with a comma, paren or quote would
  // break out of the `in.(…)` list, so those rows are simply not looked up.
  const wanted = [...new Set(skus.filter((s) => s && /^[\w.-]+$/.test(s)))];
  if (wanted.length === 0) return {};
  const { data } = await db
    .from('products')
    .select('name, strength, puramass_sku, puramass_sku_vial')
    .or(
      `puramass_sku.in.(${wanted.join(',')}),puramass_sku_vial.in.(${wanted.join(',')})`,
    );
  const out: Record<string, string> = {};
  for (const p of (data ?? []) as any[]) {
    const label = [p.name, p.strength].filter(Boolean).join(' ');
    if (p.puramass_sku && wanted.includes(p.puramass_sku)) out[p.puramass_sku] = label;
    if (p.puramass_sku_vial && wanted.includes(p.puramass_sku_vial)) {
      out[p.puramass_sku_vial] = `${label} (vial)`;
    }
  }
  return out;
}

/**
 * GET /api/admin/customers/[id]/insights
 *
 * Everything the admin customer page shows, in one call:
 *   • profile + claim state
 *   • lifetime stats (spend per currency, order counts, first/last order)
 *   • native orders, invoices, and Stealth Health hand-offs
 *   • what they've actually bought, aggregated per product
 *   • the browsing trail (searches / views / cart adds)
 *
 * `id` is either a customer UUID or the synthetic `pm:<email>` id of a
 * Stealth Health-only buyer, who has no account row. For those, most of the payload
 * is legitimately empty — the page says so rather than pretending otherwise.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { ok } = await verifyAdmin(req);
  if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  // Next already decodes the segment; a stray `%` in an email would make a
  // second decode throw, so it's attempted and ignored on failure.
  const rawId = safeDecode(params.id);
  return isPuramassId(rawId)
    ? puramassOnlyInsights(emailFromPuramassId(rawId))
    : accountInsights(rawId);
}

/** One page visit, for the journey timeline. */
interface PageVisit {
  path: string;
  title: string | null;
  at: string;
}

/* ------------------------------------------------------------------ */
/* Account customers                                                   */
/* ------------------------------------------------------------------ */

async function accountInsights(id: string) {
  // `*` + projectCustomer: tolerant of migrations that haven't run yet, and
  // password_hash / wallet_address never make it into the response.
  const { data: row, error } = await db
    .from('customers')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const customer = projectCustomer(row as Record<string, unknown>);

  const email = normalizeEmail((customer as any).email);
  // PostgREST `or` values can't carry commas/parens unescaped. An address with
  // one is not a real address, so stripping them is safe and keeps the filter
  // from breaking out of its own expression.
  const safeEmail = email.replace(/[,()]/g, '');
  const nativeCurrency = ((customer as any).preferred_currency ?? 'CAD').toUpperCase();

  const [ordersRes, invoicesRes, activityRes, ledger] = await Promise.all([
    db
      .from('orders')
      .select('*')
      .eq('customer_id', id)
      .order('created_at', { ascending: false }),
    // Invoices linked by account OR by email — plenty of invoices were raised
    // against an email before the account existed.
    db
      .from('invoices')
      .select('*')
      .or(`customer_id.eq.${id},customer_email.ilike.${safeEmail}`)
      .order('created_at', { ascending: false }),
    // `*` so the page columns are picked up where customer-crm-migration.sql
    // has run, and the query still succeeds where it hasn't.
    db
      .from('customer_activity')
      .select('*')
      .eq('customer_id', id)
      .order('created_at', { ascending: false })
      .limit(1000),
    fetchPuramassLedger(db, { email }),
  ]);

  const [leadResult, emailResult] = await Promise.all([
    fetchLead(db, email, 'customer'),
    fetchEmailHistory(db, email, 'customer'),
  ]);

  if (ordersRes.error) console.error('[insights] orders read failed:', ordersRes.error.message);
  if (invoicesRes.error) console.error('[insights] invoices read failed:', invoicesRes.error.message);

  const orders = (ordersRes.data ?? []) as any[];
  // `ilike` above is a coarse prefilter — `_` is a LIKE wildcard and an
  // ordinary character in an email, so the exact match is re-applied here.
  const invoices = ((invoicesRes.data ?? []) as any[]).filter(
    (i) => i.customer_id === id || normalizeEmail(i.customer_email) === email,
  );
  const puramassOrders = ledger;

  const payload = await buildPurchaseData({
    orders,
    invoices,
    puramassOrders,
    nativeCurrency,
  });

  return NextResponse.json({
    source: 'account',
    customer,
    lead: withLegacyClaim(leadResult.lead, row as Record<string, any>),
    emails: emailResult.emails,
    // What this database can actually do. `registration-alerts-migration.sql`
    // adds the claim columns and the customer_activity table; until it runs,
    // the page hides those sections instead of offering an action that 500s.
    capabilities: {
      // Claiming and lead triage need customer_leads (customer-crm-migration).
      claims: leadResult.available,
      activity: !activityRes.error,
      emailLog: emailResult.available,
    },
    hasCheckedOut:
      Boolean((customer as any).has_completed_first_order) ||
      orders.length > 0 ||
      payload.paidInvoices > 0,
    ...payload,
    ...aggregateActivity(activityRes.data ?? []),
  });
}

/**
 * Surface a claim recorded on `customers` before leads got their own table.
 * Nothing writes there any more, so this only fills a gap the new table has
 * not been given a row for yet.
 */
function withLegacyClaim(lead: Lead, row: Record<string, any>): Lead {
  if (lead.claimed_by_id || !row?.claimed_by_id) return lead;
  return {
    ...lead,
    claimed_by_id: row.claimed_by_id,
    claimed_by_email: row.claimed_by_email ?? null,
    claimed_by_name: row.claimed_by_name ?? null,
    claimed_at: row.claimed_at ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Stealth Health-only buyers                                                */
/* ------------------------------------------------------------------ */

async function puramassOnlyInsights(email: string) {
  if (!email) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const ledger = await fetchPuramassLedger(db, { email });
  const profile = groupPuramassByEmail(ledger).get(email);
  if (!profile) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // The paid hand-offs materialise into invoices; pull those so the page can
  // show real line items and totals rather than just SKUs.
  const { data: invoiceRows } = await db
    .from('invoices')
    .select('*')
    .ilike('customer_email', email)
    .order('created_at', { ascending: false });

  const invoices = ((invoiceRows ?? []) as any[]).filter(
    (i) => normalizeEmail(i.customer_email) === email,
  );
  const [leadResult, emailResult] = await Promise.all([
    fetchLead(db, email, 'customer'),
    fetchEmailHistory(db, email, 'customer'),
  ]);
  const { first, last } = splitName(profile.name);
  const address = toShippingAddress(profile.orders.find((o) => o.shipping_address)?.shipping_address);

  const payload = await buildPurchaseData({
    orders: [],
    invoices,
    puramassOrders: profile.orders,
    nativeCurrency: 'USD',
  });

  return NextResponse.json({
    source: 'puramass',
    lead: leadResult.lead,
    emails: emailResult.emails,
    capabilities: {
      // Claims work here too — lead records are keyed by email, not account.
      claims: leadResult.available,
      // No account means no signed-in browsing to record, ever.
      activity: false,
      emailLog: emailResult.available,
    },
    customer: {
      // Synthetic — there is no `customers` row behind this person.
      id: `pm:${email}`,
      first_name: first,
      last_name: last,
      email,
      phone: profile.phone,
      shipping_address: address?.address ?? null,
      shipping_city: address?.city ?? null,
      shipping_state: address?.state ?? null,
      shipping_postal_code: address?.zip ?? null,
      shipping_country: address?.country ?? null,
      preferred_currency: 'USD',
      role: null,
      active: true,
      created_at: profile.firstOrderAt,
      last_login_at: null,
      email_verified: false,
      has_completed_first_order: profile.paidCount > 0,
      contact_consent: false,
      claimed_by_id: null,
      claimed_by_email: null,
      claimed_by_name: null,
      claimed_at: null,
      allow_pickup: false,
      allow_shipping: true,
      affiliate_id: null,
    },
    hasCheckedOut: profile.paidCount > 0,
    ...payload,
    // No account means no signed-in browsing trail to show.
    searches: [],
    views: [],
    cart: [],
    pages: [],
    journey: [],
  });
}

/* ------------------------------------------------------------------ */
/* Shared: orders/invoices/Stealth Health → stats + product tally            */
/* ------------------------------------------------------------------ */

async function buildPurchaseData({
  orders,
  invoices,
  puramassOrders,
  nativeCurrency,
}: {
  orders: any[];
  invoices: any[];
  puramassOrders: PuramassOrderLite[];
  nativeCurrency: string;
}) {
  const tally = new PurchaseTally();

  // 1. Native orders — items live on the row as JSONB.
  for (const o of orders) {
    const items = Array.isArray(o.items) ? o.items : [];
    for (const it of items) {
      const qty = Math.max(1, Math.round(num(it.quantity) || 1));
      const unit = num(it.price ?? it.price_at_time ?? it.unit_price);
      tally.add({
        name: [it.name ?? it.product_name, it.strength].filter(Boolean).join(' '),
        quantity: qty,
        amount: unit * qty,
        currency: nativeCurrency,
        at: o.created_at,
        channel: 'order',
      });
    }
  }

  // 2. Invoices — line items are a separate table. Drafts are excluded: they
  //    aren't money the customer has committed to, and neither are unpaid
  //    Stealth Health hand-offs (pending payment, or lapsed).
  const UNBILLABLE = new Set(['draft', 'void', 'pending_payment', 'expired']);
  const billableInvoices = invoices.filter((i) => !UNBILLABLE.has(i.status));
  const invoiceIds = billableInvoices.map((i) => i.id);
  let lineItems: any[] = [];
  if (invoiceIds.length > 0) {
    const { data } = await db
      .from('invoice_line_items')
      .select('invoice_id, description, qty, unit_price, line_total, product_id')
      .in('invoice_id', invoiceIds);
    lineItems = data ?? [];
  }
  const invoiceById = new Map(billableInvoices.map((i) => [i.id, i]));
  for (const li of lineItems) {
    const inv = invoiceById.get(li.invoice_id);
    if (!inv) continue;
    tally.add({
      name: li.description ?? 'Unnamed line',
      quantity: Math.max(1, Math.round(num(li.qty) || 1)),
      amount: num(li.line_total),
      currency: (inv.currency ?? nativeCurrency).toUpperCase(),
      at: inv.created_at,
      channel: inv.source === 'stealth_health' ? 'puramass' : 'invoice',
    });
  }

  // 3. Stealth Health hand-offs that never became an invoice (unpaid, expired, or
  //    not yet materialised). Only SKUs and quantities exist for those, so the
  //    SKU is resolved to a product name and the spend is left at zero —
  //    counting an unpaid hand-off as revenue would be a lie.
  //    Hand-offs are now invoiced before payment, so "no billable invoice" —
  //    not "no invoice" — is what makes one an orphan here.
  const billableIds = new Set(billableInvoices.map((i) => i.id));
  const orphanPuramass = puramassOrders.filter(
    (p) => !p.invoice_id || !billableIds.has(p.invoice_id),
  );
  const skuMap = await skuNames(orphanPuramass.flatMap((p) => p.items.map((i) => i.sku ?? '')));
  for (const p of orphanPuramass) {
    for (const it of p.items) {
      const sku = it.sku ?? '';
      tally.add({
        name: skuMap[sku] ?? sku ?? 'Stealth Health item',
        quantity: Math.max(1, Math.round(num(it.quantity) || 1)),
        amount: 0,
        currency: (p.currency ?? 'USD').toUpperCase(),
        at: p.created_at,
        channel: 'puramass',
      });
    }
  }

  // Lifetime spend, per currency, never converted between them.
  const spendByCurrency: Record<string, number> = {};
  const addSpend = (currency: string, amount: number) => {
    const key = (currency || nativeCurrency).toUpperCase();
    spendByCurrency[key] = +((spendByCurrency[key] ?? 0) + amount).toFixed(2);
  };

  const paidOrderStatuses = new Set(['paid', 'confirmed', 'processing', 'shipped', 'delivered', 'completed']);
  const revenueOrders = orders.filter(
    (o) => paidOrderStatuses.has(String(o.status).toLowerCase()) && !o.refunded_at,
  );
  for (const o of revenueOrders) addSpend(nativeCurrency, num(o.total));

  // What was actually received against each invoice. A 'partial' invoice has
  // some of its total paid and the rest outstanding — counting the whole total
  // as both (the naive read of the status) would double-report it.
  const paidByInvoice = new Map<string, number>();
  if (invoiceIds.length > 0) {
    const { data: payments } = await db
      .from('payments')
      .select('invoice_id, amount')
      .in('invoice_id', invoiceIds);
    for (const p of (payments ?? []) as any[]) {
      paidByInvoice.set(p.invoice_id, (paidByInvoice.get(p.invoice_id) ?? 0) + num(p.amount));
    }
  }

  const outstanding: Record<string, number> = {};
  const paidInvoices: any[] = [];
  for (const i of billableInvoices) {
    const total = num(i.total);
    const status = String(i.status).toLowerCase();
    // A 'paid' invoice counts in full even when no payment rows were recorded
    // (plenty of historical invoices were marked paid by hand).
    const received =
      status === 'paid' ? total : Math.min(total, paidByInvoice.get(i.id) ?? 0);

    if (received > 0) {
      addSpend(i.currency ?? nativeCurrency, received);
      paidInvoices.push(i);
    }
    const due = +(total - received).toFixed(2);
    if (due > 0) {
      const key = (i.currency ?? nativeCurrency).toUpperCase();
      outstanding[key] = +((outstanding[key] ?? 0) + due).toFixed(2);
    }
  }

  // First / last purchase across every channel.
  const purchaseDates = [
    ...revenueOrders.map((o) => o.created_at),
    ...paidInvoices.map((i) => i.created_at),
    ...puramassOrders.filter((p) => p.status === 'paid').map((p) => p.paid_at ?? p.created_at),
  ]
    .filter(Boolean)
    .sort();

  const paidPuramass = puramassOrders.filter((p) => p.status === 'paid');

  // Order-confirmation email state per row, for the tables' Confirmation
  // column. Stealth Health hand-offs log against their invoice.
  const [confirmByOrder, confirmByInvoice] = await Promise.all([
    confirmationSummariesByOrder(db, orders.map((o) => o.id)),
    confirmationSummariesByInvoice(db, puramassOrders.map((p) => p.invoice_id)),
  ]);

  return {
    orders: orders.map((o) => ({ ...o, confirmation: confirmByOrder[o.id] ?? null })),
    invoices,
    puramassOrders: puramassOrders.map((p) => ({
      ...p,
      confirmation: p.invoice_id ? confirmByInvoice[p.invoice_id] ?? null : null,
    })),
    products: tally.result(),
    paidInvoices: paidInvoices.length,
    stats: {
      orderCount: orders.length,
      invoiceCount: billableInvoices.length,
      puramassCount: puramassOrders.length,
      puramassPaidCount: paidPuramass.length,
      /** Orders/invoices that actually represent money received. */
      purchaseCount: revenueOrders.length + paidInvoices.length,
      spendByCurrency,
      outstandingByCurrency: outstanding,
      firstPurchaseAt: purchaseDates[0] ?? null,
      lastPurchaseAt: purchaseDates[purchaseDates.length - 1] ?? null,
      distinctProducts: tally.result().length,
      unitsBought: tally.result().reduce((sum, p) => sum + p.quantity, 0),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Browsing activity                                                   */
/* ------------------------------------------------------------------ */

function aggregateActivity(rows: any[]) {
  const aggregate = (
    type: 'search' | 'view' | 'cart' | 'page',
    keyOf: (r: any) => string,
    labelOf: (r: any) => string,
  ): Agg[] => {
    const map = new Map<string, Agg>();
    for (const r of rows) {
      if (r.activity_type !== type) continue;
      const key = keyOf(r);
      if (!key) continue;
      const existing = map.get(key);
      if (existing) {
        existing.count += 1;
        // rows are newest-first, so the first-seen created_at is the latest
      } else {
        map.set(key, {
          key,
          label: labelOf(r),
          productId: r.product_id ?? null,
          count: 1,
          lastAt: r.created_at,
          lastQuantity: type === 'cart' ? (r.quantity ?? 1) : undefined,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
  };

  // Pages, two ways: folded per path (which pages pull them in) and as a raw
  // most-recent-first timeline (what they actually did last visit).
  const pages = aggregate(
    'page',
    (r) => String(r.page_path ?? ''),
    (r) => String(r.page_title || r.page_path || 'Untitled page'),
  );
  const journey: PageVisit[] = rows
    .filter((r) => r.activity_type === 'page' && r.page_path)
    .slice(0, 60)
    .map((r) => ({
      path: String(r.page_path),
      title: r.page_title ? String(r.page_title) : null,
      at: r.created_at,
    }));

  return {
    pages,
    journey,
    searches: aggregate(
      'search',
      (r) => String(r.search_query ?? '').toLowerCase(),
      (r) => String(r.search_query ?? ''),
    ),
    views: aggregate(
      'view',
      (r) => r.product_id || r.product_name || '',
      (r) => String(r.product_name ?? 'Unknown product'),
    ),
    cart: aggregate(
      'cart',
      (r) => r.product_id || r.product_name || '',
      (r) => String(r.product_name ?? 'Unknown product'),
    ),
  };
}
