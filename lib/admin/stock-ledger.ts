/**
 * The stock ledger: every change to `products.stock_quantity`, who or what
 * made it, and what it points back to.
 *
 * Rows live in `product_history` (change_type 'stock', field 'stock_quantity').
 * They are written by:
 *   • set_product_stock()            — a manual edit in the admin; records who.
 *   • adjust/restore_stock_for_*()   — automatic moves; point at the invoice,
 *     receive_po_items() …             order or purchase order that caused them.
 *   • the products_stock_ledger trigger — anything else, as source 'untracked'.
 * See stock-ledger-migration.sql.
 *
 * Server-only helpers take the service-role client as `db`. Nothing here
 * throws on a database error; callers get an error value instead.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export type StockEntryKind = 'manual' | 'automatic' | 'untracked';

/** Sources where a person typed the new number in. */
export const MANUAL_STOCK_SOURCES = ['admin_edit', 'csv_import'] as const;

export const STOCK_SOURCE_LABELS: Record<string, string> = {
  admin_edit: 'Manual edit',
  csv_import: 'CSV import',
  invoice_paid: 'Invoice paid',
  invoice_cancel: 'Invoice cancelled',
  order_confirmed: 'Order confirmed',
  order_cancelled: 'Order cancelled',
  po_receipt: 'Purchase order received',
  untracked: 'Outside the admin',
};

export function stockSourceLabel(source: string): string {
  return STOCK_SOURCE_LABELS[source] ?? source.replace(/_/g, ' ');
}

export function stockEntryKind(source: string): StockEntryKind {
  if (source === 'untracked') return 'untracked';
  return (MANUAL_STOCK_SOURCES as readonly string[]).includes(source) ? 'manual' : 'automatic';
}

/** PostgREST / Postgres "that function doesn't exist (with those arguments)". */
export function isMissingFunctionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string };
  if (e.code === 'PGRST202' || e.code === '42883') return true;
  return /could not find the function|function .* does not exist/i.test(e.message ?? '');
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type SetStockResult =
  | { ok: true }
  | { ok: false; unsupported: true }
  | { ok: false; unsupported: false; error: string };

/**
 * Set a product's stock and record who did it, in one transaction.
 * `unsupported` means stock-ledger-migration.sql has not run — the caller
 * falls back to its old write-then-log path.
 */
export async function setProductStock(
  db: SupabaseClient,
  args: {
    productId: string;
    quantity: number;
    actorId: string | null;
    actorEmail: string | null;
    source?: string;
    note?: string | null;
  },
): Promise<SetStockResult> {
  try {
    const { error } = await db.rpc('set_product_stock', {
      p_product_id: args.productId,
      p_new_qty: args.quantity,
      p_actor_id: args.actorId,
      p_actor_email: args.actorEmail,
      p_source: args.source ?? 'admin_edit',
      p_note: args.note ?? null,
    });
    if (!error) return { ok: true };
    if (isMissingFunctionError(error)) return { ok: false, unsupported: true };
    return { ok: false, unsupported: false, error: error.message };
  } catch (err) {
    return { ok: false, unsupported: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Take a paid invoice's stock. Idempotent in the database (invoices.stock_adjusted).
 * Falls back to the single-argument RPC for a database that predates
 * product-history-migration.sql, rather than taking no stock at all.
 */
export async function adjustInvoiceStock(
  db: SupabaseClient,
  invoiceId: string,
  actorEmail: string | null,
): Promise<{ ok: boolean; error?: string }> {
  try {
    let { error } = await db.rpc('adjust_stock_for_invoice', {
      p_invoice_id: invoiceId,
      p_actor_email: actorEmail,
    });
    if (error && isMissingFunctionError(error)) {
      ({ error } = await db.rpc('adjust_stock_for_invoice', { p_invoice_id: invoiceId }));
    }
    return error ? { ok: false, error: error.message } : { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Invoice lines that took no stock
// ---------------------------------------------------------------------------

/**
 * Read the product and pack size out of a Stealth Health line description.
 * Hand-off lines read "Name — Pack of 5" / "Name — Single vial"; lines built
 * from the partner's own payload may end in "(Single Vial)".
 */
export function parseLineDescription(description: string): {
  name: string;
  vialsPerUnit: number | null;
} {
  const text = (description ?? '').trim();
  const pack = /^(.*?)\s+[—–-]\s+pack of\s+(\d+)\s*$/i.exec(text);
  if (pack) return { name: pack[1].trim(), vialsPerUnit: Math.max(1, Number(pack[2]) || 1) };
  const single = /^(.*?)\s+[—–-]\s+single vial\s*$/i.exec(text);
  if (single) return { name: single[1].trim(), vialsPerUnit: 1 };
  const legacySingle = /^(.*?)\s*\(\s*single\s+vial\s*\)\s*$/i.exec(text);
  if (legacySingle) return { name: legacySingle[1].trim(), vialsPerUnit: 1 };
  return { name: text, vialsPerUnit: null };
}

export interface LinkableProduct {
  id: string;
  name: string;
  puramass_sku?: string | null;
  puramass_sku_vial?: string | null;
}

/** Best guess at the product and pack size behind an unlinked invoice line. */
export function guessLineProduct(
  description: string,
  products: LinkableProduct[],
): { productId: string | null; vialsPerUnit: number | null } {
  const { name, vialsPerUnit } = parseLineDescription(description);
  const wanted = name.toLowerCase();
  if (!wanted) return { productId: null, vialsPerUnit };

  const byName = products.find((p) => (p.name ?? '').trim().toLowerCase() === wanted);
  if (byName) return { productId: byName.id, vialsPerUnit };

  // A legacy line may carry the partner SKU as its description.
  const byVialSku = products.find((p) => (p.puramass_sku_vial ?? '').trim().toLowerCase() === wanted);
  if (byVialSku) return { productId: byVialSku.id, vialsPerUnit: 1 };
  const byCaseSku = products.find((p) => (p.puramass_sku ?? '').trim().toLowerCase() === wanted);
  if (byCaseSku) return { productId: byCaseSku.id, vialsPerUnit };

  return { productId: null, vialsPerUnit };
}

export interface UnstockedLine {
  id: string;
  description: string;
  qty: number;
  price_type: string | null;
  guess_product_id: string | null;
  guess_vials_per_unit: number | null;
}

export interface UnstockedInvoice {
  id: string;
  invoice_number: string | null;
  created_at: string;
  customer_name: string | null;
  customer_email: string | null;
  fulfillment_status: string | null;
  /** The invoice's stock pass never ran (or failed). */
  stock_pending: boolean;
  /** Lines paid with no product attached, so they took no stock. */
  unlinked_lines: UnstockedLine[];
}

/**
 * Paid Stealth Health invoices whose stock was not (fully) taken: the stock
 * pass never ran, or some lines carry no product. Every Stealth Health line
 * is a product, so an unlinked one is always a gap.
 */
export async function findUnstockedInvoices(
  db: SupabaseClient,
  opts: { days?: number } = {},
): Promise<{ invoices: UnstockedInvoice[]; error?: string }> {
  const since = new Date(Date.now() - (opts.days ?? 90) * 86_400_000).toISOString();
  const { data, error } = await db
    .from('invoices')
    .select(
      'id, invoice_number, created_at, customer_name, customer_email, fulfillment_status, stock_adjusted, ' +
        'lines:invoice_line_items (id, product_id, description, qty, price_type)',
    )
    .eq('source', 'stealth_health')
    .eq('status', 'paid')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return { invoices: [], error: error.message };

  const rows = (data ?? []) as any[];
  const needsProducts = rows.some((r) => (r.lines ?? []).some((l: any) => !l.product_id));
  let products: LinkableProduct[] = [];
  if (needsProducts) {
    const { data: prods } = await db
      .from('products')
      .select('id, name, puramass_sku, puramass_sku_vial');
    products = (prods ?? []) as LinkableProduct[];
    if (products.length === 0) {
      // Before the Stealth Health SKU columns exist, match on name alone.
      const { data: plain } = await db.from('products').select('id, name');
      products = (plain ?? []) as LinkableProduct[];
    }
  }

  const invoices: UnstockedInvoice[] = [];
  for (const r of rows) {
    const unlinked: UnstockedLine[] = ((r.lines ?? []) as any[])
      .filter((l) => !l.product_id)
      .map((l) => {
        const guess = guessLineProduct(String(l.description ?? ''), products);
        return {
          id: String(l.id),
          description: String(l.description ?? ''),
          qty: Number(l.qty) || 0,
          price_type: l.price_type ?? null,
          guess_product_id: guess.productId,
          guess_vials_per_unit: guess.vialsPerUnit,
        };
      });
    const stockPending = r.stock_adjusted === false;
    if (!stockPending && unlinked.length === 0) continue;
    invoices.push({
      id: String(r.id),
      invoice_number: r.invoice_number ?? null,
      created_at: String(r.created_at),
      customer_name: r.customer_name ?? null,
      customer_email: r.customer_email ?? null,
      fulfillment_status: r.fulfillment_status ?? null,
      stock_pending: stockPending,
      unlinked_lines: unlinked,
    });
  }
  return { invoices };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface StockLedgerReference {
  type: string;
  id: string;
  label: string;
  href: string | null;
}

export interface StockLedgerEntry {
  id: string;
  created_at: string;
  product_id: string;
  product_name: string | null;
  product_sku: string | null;
  old_qty: number | null;
  new_qty: number | null;
  delta: number | null;
  source: string;
  source_label: string;
  kind: StockEntryKind;
  actor_email: string | null;
  note: string | null;
  reference: StockLedgerReference | null;
}

export interface StockLedgerFilters {
  /** Inclusive YYYY-MM-DD. */
  from?: string | null;
  to?: string | null;
  productId?: string | null;
  /** Product name / SKU substring. */
  search?: string | null;
  kind?: StockEntryKind | 'all' | null;
  limit?: number;
  offset?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toQty(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** PostgREST `in` list literal for text values. */
function inList(values: readonly string[]): string {
  return `(${values.map((v) => `"${v}"`).join(',')})`;
}

export async function listStockLedger(
  db: SupabaseClient,
  filters: StockLedgerFilters = {},
): Promise<{ entries: StockLedgerEntry[]; total: number; error?: string }> {
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);

  let productIds: string[] | null = filters.productId && UUID_RE.test(filters.productId)
    ? [filters.productId]
    : null;

  const search = (filters.search ?? '').trim();
  if (search && !productIds) {
    const term = search.replace(/[%,()]/g, ' ').trim();
    const { data: matches } = await db
      .from('products')
      .select('id')
      .or(`name.ilike.%${term}%,sku.ilike.%${term}%,slug.ilike.%${term}%`)
      .limit(200);
    productIds = ((matches ?? []) as any[]).map((p) => String(p.id));
    if (productIds.length === 0) return { entries: [], total: 0 };
  }

  let q = db
    .from('product_history')
    .select(
      'id, created_at, product_id, old_value, new_value, source, reference_type, reference_id, note, actor_email, ' +
        'product:products (id, name, sku)',
      { count: 'exact' },
    )
    .eq('change_type', 'stock')
    .eq('field', 'stock_quantity');

  if (productIds) q = q.in('product_id', productIds);
  if (filters.from && DATE_RE.test(filters.from)) {
    q = q.gte('created_at', new Date(`${filters.from}T00:00:00`).toISOString());
  }
  if (filters.to && DATE_RE.test(filters.to)) {
    const end = new Date(`${filters.to}T00:00:00`);
    end.setDate(end.getDate() + 1);
    q = q.lt('created_at', end.toISOString());
  }
  if (filters.kind === 'manual') q = q.in('source', [...MANUAL_STOCK_SOURCES]);
  else if (filters.kind === 'untracked') q = q.eq('source', 'untracked');
  else if (filters.kind === 'automatic') {
    q = q.not('source', 'in', inList([...MANUAL_STOCK_SOURCES, 'untracked']));
  }

  const { data, error, count } = await q
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return { entries: [], total: 0, error: error.message };

  const rows = (data ?? []) as any[];
  const refs = await resolveReferences(db, rows);

  const entries = rows.map((r): StockLedgerEntry => {
    const product = Array.isArray(r.product) ? r.product[0] : r.product;
    const oldQty = toQty(r.old_value);
    const newQty = toQty(r.new_value);
    const source = String(r.source ?? '');
    return {
      id: String(r.id),
      created_at: String(r.created_at),
      product_id: String(r.product_id),
      product_name: product?.name ?? null,
      product_sku: product?.sku ?? null,
      old_qty: oldQty,
      new_qty: newQty,
      delta: newQty !== null ? newQty - (oldQty ?? 0) : null,
      source,
      source_label: stockSourceLabel(source),
      kind: stockEntryKind(source),
      actor_email: r.actor_email ?? null,
      note: r.note ?? null,
      reference:
        r.reference_type && r.reference_id
          ? refs.get(`${r.reference_type}:${r.reference_id}`) ?? {
              type: String(r.reference_type),
              id: String(r.reference_id),
              label: `${r.reference_type} ${String(r.reference_id).slice(0, 8)}`,
              href: null,
            }
          : null,
    };
  });

  return { entries, total: count ?? entries.length };
}

/** Human labels and admin links for the invoices / orders / POs rows point at. */
async function resolveReferences(
  db: SupabaseClient,
  rows: any[],
): Promise<Map<string, StockLedgerReference>> {
  const out = new Map<string, StockLedgerReference>();
  const idsOf = (type: string) => [
    ...new Set(
      rows
        .filter((r) => r.reference_type === type && UUID_RE.test(String(r.reference_id ?? '')))
        .map((r) => String(r.reference_id)),
    ),
  ];

  const invoiceIds = idsOf('invoice');
  const orderIds = idsOf('order');
  const receiptIds = idsOf('purchase_order_receipt');
  const poIds = new Set(idsOf('purchase_order'));

  const [invoices, orders, receipts] = await Promise.all([
    invoiceIds.length
      ? db.from('invoices').select('id, invoice_number, source').in('id', invoiceIds)
      : Promise.resolve({ data: [] as any[] }),
    orderIds.length
      ? db.from('orders').select('id, order_number').in('id', orderIds)
      : Promise.resolve({ data: [] as any[] }),
    receiptIds.length
      ? db.from('purchase_order_receipts').select('id, purchase_order_id').in('id', receiptIds)
      : Promise.resolve({ data: [] as any[] }),
  ]);

  for (const inv of (invoices.data ?? []) as any[]) {
    const number = inv.invoice_number ? `Invoice ${inv.invoice_number}` : 'Invoice';
    out.set(`invoice:${inv.id}`, {
      type: 'invoice',
      id: String(inv.id),
      label: inv.source === 'stealth_health' ? `${number} (Stealth Health)` : number,
      href: `/admin/invoices/${inv.id}`,
    });
  }
  for (const o of (orders.data ?? []) as any[]) {
    out.set(`order:${o.id}`, {
      type: 'order',
      id: String(o.id),
      label: o.order_number ? `Order ${o.order_number}` : 'Order',
      href: `/admin/orders/${o.id}`,
    });
  }
  const receiptPo = new Map<string, string>();
  for (const rc of (receipts.data ?? []) as any[]) {
    if (rc.purchase_order_id) {
      receiptPo.set(String(rc.id), String(rc.purchase_order_id));
      poIds.add(String(rc.purchase_order_id));
    }
  }
  if (poIds.size) {
    const { data: pos } = await db
      .from('purchase_orders')
      .select('id, po_number')
      .in('id', [...poIds]);
    const poNumber = new Map(((pos ?? []) as any[]).map((p) => [String(p.id), p.po_number as string | null]));
    for (const id of poIds) {
      out.set(`purchase_order:${id}`, {
        type: 'purchase_order',
        id,
        label: poNumber.get(id) ? `PO ${poNumber.get(id)}` : 'Purchase order',
        href: `/admin/purchase-orders/${id}`,
      });
    }
    for (const [receiptId, poId] of receiptPo) {
      out.set(`purchase_order_receipt:${receiptId}`, {
        type: 'purchase_order_receipt',
        id: receiptId,
        label: poNumber.get(poId) ? `PO ${poNumber.get(poId)} (receipt)` : 'Purchase order receipt',
        href: `/admin/purchase-orders/${poId}`,
      });
    }
  }
  return out;
}
