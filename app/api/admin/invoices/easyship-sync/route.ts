import { NextRequest, NextResponse, after } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getInvoiceCaller, callerCanWrite } from '@/lib/admin/invoice-access';
import { logAuditServer } from '@/lib/admin/audit';
import { isMissingColumnError } from '@/lib/payments/puramass-columns';
import { onShipmentLabelGenerated } from '@/lib/shipping/label-generated';
import {
  listEasyshipShipments,
  type EasyshipShipmentSummary,
} from '@/lib/easyship';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

interface CandidateInvoice {
  invoice_id: string;
  invoice_number: string;
  order_id: string;
  order_number: string | null;
  customer_name: string | null;
  customer_norm: string;
}

interface PreviewMatch {
  invoice_id: string;
  invoice_number: string;
  order_id: string;
  order_number: string | null;
  customer_name: string | null;
  easyship_shipment_id: string;
  tracking_number: string | null;
  label_url: string | null;
  courier_name: string | null;
  easyship_destination_name: string | null;
  /** Multiple invoices matched this shipment (or vice versa). */
  ambiguous: boolean;
}

function normalizeName(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

async function loadCandidateInvoices(): Promise<CandidateInvoice[]> {
  // Candidate = has a linked order, not pickup, and the order does not yet
  // carry an Easyship shipment id. Newest first so if a normalized customer
  // name is ambiguous we can prefer the freshest invoice.
  const { data, error } = await db
    .from('invoices')
    .select(
      `
      id,
      invoice_number,
      order_id,
      customer_name,
      fulfillment_type,
      customers!invoices_customer_id_fkey (first_name, last_name),
      orders!invoices_order_id_fkey (id, order_number, easyship_shipment_id)
    `,
    )
    .not('order_id', 'is', null)
    .neq('fulfillment_type', 'pickup')
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);

  return (data ?? [])
    .filter(
      (r: any) =>
        r.orders && !r.orders.easyship_shipment_id && !!r.orders.id,
    )
    .map((r: any): CandidateInvoice => {
      const c = r.customers;
      const name = c
        ? `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim()
        : (r.customer_name ?? '');
      return {
        invoice_id: r.id,
        invoice_number: r.invoice_number,
        order_id: r.orders.id,
        order_number: r.orders.order_number ?? null,
        customer_name: name || null,
        customer_norm: normalizeName(name),
      };
    })
    .filter((c) => !!c.customer_norm);
}

async function preview(dateIso: string) {
  let shipments: EasyshipShipmentSummary[] = [];
  let easyshipError: string | null = null;
  try {
    shipments = await listEasyshipShipments(dateIso);
  } catch (e: any) {
    easyshipError = e?.message ?? 'Easyship error';
  }

  const invoices = await loadCandidateInvoices();

  // Bucket invoices by normalized name — the "newest wins" rule lives in the
  // ordering above, so the FIRST entry per bucket is the freshest candidate.
  const invoiceByName = new Map<string, CandidateInvoice[]>();
  for (const inv of invoices) {
    const bucket = invoiceByName.get(inv.customer_norm) ?? [];
    bucket.push(inv);
    invoiceByName.set(inv.customer_norm, bucket);
  }

  // Bucket shipments by normalized destination name — same ambiguity rule
  // applies when one customer has multiple shipments the same day.
  const shipmentByName = new Map<string, EasyshipShipmentSummary[]>();
  for (const s of shipments) {
    const key = normalizeName(s.destination_name);
    if (!key) continue;
    const bucket = shipmentByName.get(key) ?? [];
    bucket.push(s);
    shipmentByName.set(key, bucket);
  }

  const matches: PreviewMatch[] = [];
  const usedShipments = new Set<string>();
  const matchedInvoices = new Set<string>();

  for (const [key, invBucket] of invoiceByName) {
    const shipBucket = shipmentByName.get(key);
    if (!shipBucket || shipBucket.length === 0) continue;
    const inv = invBucket[0];
    const ship = shipBucket[0];
    const ambiguous = invBucket.length > 1 || shipBucket.length > 1;
    matches.push({
      invoice_id: inv.invoice_id,
      invoice_number: inv.invoice_number,
      order_id: inv.order_id,
      order_number: inv.order_number,
      customer_name: inv.customer_name,
      easyship_shipment_id: ship.easyship_shipment_id,
      tracking_number: ship.tracking_number,
      label_url: ship.label_url,
      courier_name: ship.courier_name,
      easyship_destination_name: ship.destination_name,
      ambiguous,
    });
    usedShipments.add(ship.easyship_shipment_id);
    matchedInvoices.add(inv.invoice_id);
  }

  const unmatched = shipments.filter(
    (s) => !usedShipments.has(s.easyship_shipment_id),
  );

  return {
    date: dateIso,
    fetched: shipments.length,
    easyshipError,
    matches,
    unmatched,
  };
}

// ---------------------------------------------------------------------------
// Manual matching
// ---------------------------------------------------------------------------

/**
 * A shipment date may be picked up to one day ahead of "now" so an operator
 * can widen the window for safety when local time and Easyship's UTC clock
 * disagree. Anything further out is a typo, not an intent — reject it rather
 * than silently returning an empty shipment list.
 */
const MAX_DATE_AHEAD_MS = 48 * 60 * 60 * 1000;

function parseSyncDate(raw: unknown): { iso: string } | { error: string } {
  const s = String(raw ?? '').trim();
  if (!s) return { error: 'date (ISO) is required' };
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return { error: 'invalid date' };
  if (d.getTime() > Date.now() + MAX_DATE_AHEAD_MS) {
    return { error: 'date may be at most one day ahead of today' };
  }
  return { iso: d.toISOString() };
}

/** Strip characters that would break a PostgREST `or=` filter expression. */
function sanitizeSearch(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .replace(/[%,()*\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
    .trim();
}

/**
 * Which row owns the parcel for an invoice. An invoice created from a web
 * order hangs its shipment off `orders`; a hand-written invoice and a
 * Stealth Health hand-off have no order row at all and carry the
 * shipment on `invoices` itself (easyship-invoice-shipment-migration.sql).
 * lib/shipping/auto-shipment.ts and the tracking route pick the anchor the
 * same way — order when there is one, invoice otherwise.
 */
type Anchor = 'order' | 'invoice';

interface ManualInvoiceRow {
  invoice_id: string;
  invoice_number: string;
  /** Which table this invoice's shipment lives on. */
  anchor: Anchor;
  /** Null for an invoice with no order behind it — it anchors itself. */
  order_id: string | null;
  order_number: string | null;
  customer_name: string | null;
  created_at: string | null;
  status: string | null;
  fulfillment_status: string | null;
  total: number | null;
  currency: string | null;
  /** Shipment already attached to this invoice's anchor, when there is one. */
  easyship_shipment_id: string | null;
  tracking_number: string | null;
  order_status: string | null;
}

const MANUAL_PAGE_SIZE = 10;

/**
 * Column list for the picker. `join`:
 *  - 'inner'  → only invoices that really have an order (lets us filter on
 *               `orders.easyship_shipment_id`, which needs an inner join to
 *               drop the parent row);
 *  - 'left'   → every invoice, order attached when there is one;
 *  - 'none'   → order-less invoices, where the embed would always be null.
 *
 * `withShipment` adds the invoice's own shipment block, which only exists once
 * easyship-invoice-shipment-migration.sql has run.
 */
function manualSelect(join: 'inner' | 'left' | 'none', withShipment: boolean): string {
  const cols = [
    'id',
    'invoice_number',
    'order_id',
    'customer_name',
    'created_at',
    'status',
    'fulfillment_status',
    'total',
    'currency',
    'customers!invoices_customer_id_fkey (first_name, last_name)',
  ];
  if (withShipment) cols.push('easyship_shipment_id', 'tracking_number');
  if (join !== 'none') {
    cols.push(
      `orders!invoices_order_id_fkey${join === 'inner' ? '!inner' : ''} (id, order_number, easyship_shipment_id, tracking_number, status)`,
    );
  }
  return cols.join(', ');
}

function mapManualRow(r: any): ManualInvoiceRow {
  const c = r.customers;
  const name = c
    ? `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim()
    : (r.customer_name ?? '');
  // A dangling `order_id` (order deleted out from under the invoice) reads as
  // invoice-anchored, same as the tracking route treats it.
  const order = r.orders ?? null;
  return {
    invoice_id: r.id,
    invoice_number: r.invoice_number,
    anchor: order ? 'order' : 'invoice',
    order_id: order?.id ?? null,
    order_number: order?.order_number ?? null,
    customer_name: name || r.customer_name || null,
    created_at: r.created_at ?? null,
    status: r.status ?? null,
    fulfillment_status: r.fulfillment_status ?? null,
    total: r.total ?? null,
    currency: r.currency ?? null,
    easyship_shipment_id: order
      ? (order.easyship_shipment_id ?? null)
      : (r.easyship_shipment_id ?? null),
    tracking_number: order
      ? (order.tracking_number ?? null)
      : (r.tracking_number ?? null),
    order_status: order?.status ?? null,
  };
}

/**
 * Newest first, tie-broken by id — the same total order both branch queries
 * ask Postgres for, so merging their pages can't repeat or skip a row when two
 * invoices share a `created_at`.
 */
function byNewestFirst(a: ManualInvoiceRow, b: ManualInvoiceRow): number {
  const at = a.created_at ? Date.parse(a.created_at) : 0;
  const bt = b.created_at ? Date.parse(b.created_at) : 0;
  if (at !== bt) return bt - at;
  return a.invoice_id < b.invoice_id ? 1 : a.invoice_id > b.invoice_id ? -1 : 0;
}

/** Customers whose name or email matches the picker's search box. */
async function searchCustomerIds(like: string): Promise<string[]> {
  const { data } = await db
    .from('customers')
    .select('id')
    .or(`first_name.ilike.${like},last_name.ilike.${like},email.ilike.${like}`)
    .limit(200);
  return (data ?? []).map((c: any) => c.id).filter(Boolean);
}

/**
 * One page of invoices an operator can hand-match to a shipment. Paginated
 * server-side (10 per page by default) so the dialog stays responsive even
 * with thousands of invoices on file.
 *
 * "Unlinked" has to be asked of whichever row anchors the invoice, and
 * PostgREST cannot express "the order is missing OR its shipment id is null"
 * in one query — an embedded filter only drops the parent under `!inner`,
 * which is exactly what used to hide every order-less invoice here. So the
 * two anchors are queried separately and merged.
 */
async function fetchManualPage(
  opts: { page: number; pageSize: number; search: string; includeLinked: boolean },
  withShipment: boolean,
) {
  const page = Math.max(1, Math.floor(opts.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Math.floor(opts.pageSize) || MANUAL_PAGE_SIZE));
  const from = (page - 1) * pageSize;

  const custIds = opts.search ? await searchCustomerIds(`%${opts.search}%`) : [];

  /** Filters every branch shares: not a pickup, plus the search box. */
  const shared = <T>(q: T): T => {
    let out = (q as any).neq('fulfillment_type', 'pickup');
    if (opts.search) {
      const like = `%${opts.search}%`;
      const parts = [`invoice_number.ilike.${like}`, `customer_name.ilike.${like}`];
      // Invoices bound to a customer record often leave `customer_name` null,
      // so matching customers are resolved separately and folded in here.
      if (custIds.length > 0) parts.push(`customer_id.in.(${custIds.join(',')})`);
      out = out.or(parts.join(','));
    }
    return out as T;
  };

  const finish = (invoices: ManualInvoiceRow[], total: number) => ({
    invoices,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });

  if (opts.includeLinked) {
    const { data, error, count } = await shared(
      db.from('invoices').select(manualSelect('left', withShipment), { count: 'exact' }),
    )
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = (data ?? []).map(mapManualRow);
    return finish(rows, count ?? rows.length);
  }

  // Page N of the merged list can only draw from the first N pages of either
  // stream, so taking that many from each is enough to slice it exactly.
  const take = page * pageSize;

  const orderAnchored = shared(
    db.from('invoices').select(manualSelect('inner', withShipment), { count: 'exact' }),
  )
    .is('orders.easyship_shipment_id', null)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(0, take - 1);

  let invoiceAnchoredQ = shared(
    db.from('invoices').select(manualSelect('none', withShipment), { count: 'exact' }),
  ).is('order_id', null);
  // Without the migration there is no invoice-side shipment column to filter
  // on; the rows still list, they just can't be narrowed to the unlinked ones.
  if (withShipment) invoiceAnchoredQ = invoiceAnchoredQ.is('easyship_shipment_id', null);

  const [a, b] = await Promise.all([
    orderAnchored,
    invoiceAnchoredQ
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(0, take - 1),
  ]);
  if (a.error) throw a.error;
  if (b.error) throw b.error;

  const rowsA = (a.data ?? []).map(mapManualRow);
  const rowsB = (b.data ?? []).map(mapManualRow);
  const merged = [...rowsA, ...rowsB]
    .sort(byNewestFirst)
    .slice(from, from + pageSize);

  return finish(merged, (a.count ?? rowsA.length) + (b.count ?? rowsB.length));
}

async function manualInvoices(opts: {
  page: number;
  pageSize: number;
  search: string;
  includeLinked: boolean;
}) {
  try {
    return await fetchManualPage(opts, true);
  } catch (e) {
    // A database that never ran easyship-invoice-shipment-migration.sql has no
    // shipment block on `invoices` — list without it rather than 500.
    if (isMissingColumnError(e)) return await fetchManualPage(opts, false);
    throw e;
  }
}

/**
 * How far back the hand-matcher looks for shipments. The picker has no date
 * field — an operator reaching for it is chasing a parcel they already know
 * about, and guessing its Easyship creation day was the main way to end up
 * staring at an empty list.
 */
const MANUAL_SHIPMENT_LOOKBACK_DAYS = 30;

function manualShipmentsSince(): string {
  const d = new Date(Date.now() - MANUAL_SHIPMENT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/** The order or invoice a shipment is already attached to. */
interface ShipmentOwner {
  kind: Anchor;
  id: string;
  /** Order number / invoice number — whatever an operator would recognise. */
  label: string | null;
}

/** PostgREST puts `in.(...)` in the URL, so keep each lookup well short of it. */
const IN_CHUNK = 200;

function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/**
 * The Easyship shipments an operator can pick from, annotated with the order
 * or invoice each one is already attached to so a shipment is never
 * double-bound by accident.
 */
async function manualShipments() {
  const sinceIso = manualShipmentsSince();
  let shipments: EasyshipShipmentSummary[] = [];
  let easyshipError: string | null = null;
  try {
    shipments = await listEasyshipShipments(sinceIso);
  } catch (e: any) {
    easyshipError = e?.message ?? 'Easyship error';
  }

  const ids = shipments.map((s) => s.easyship_shipment_id).filter(Boolean);
  const linked: Record<string, ShipmentOwner> = {};

  for (const part of chunk(ids, IN_CHUNK)) {
    const { data } = await db
      .from('orders')
      .select('id, order_number, easyship_shipment_id')
      .in('easyship_shipment_id', part);
    for (const o of data ?? []) {
      if (o.easyship_shipment_id) {
        linked[o.easyship_shipment_id] = {
          kind: 'order',
          id: o.id,
          label: o.order_number ?? null,
        };
      }
    }

    // Invoice-anchored shipments (no order behind them). Missing column = the
    // migration hasn't run, which just means there are none to find.
    const { data: invs, error: invErr } = await db
      .from('invoices')
      .select('id, invoice_number, easyship_shipment_id')
      .in('easyship_shipment_id', part);
    if (invErr) continue;
    for (const inv of invs ?? []) {
      if (inv.easyship_shipment_id && !linked[inv.easyship_shipment_id]) {
        linked[inv.easyship_shipment_id] = {
          kind: 'invoice',
          id: inv.id,
          label: inv.invoice_number ?? null,
        };
      }
    }
  }

  return {
    since: sinceIso,
    lookbackDays: MANUAL_SHIPMENT_LOOKBACK_DAYS,
    fetched: shipments.length,
    easyshipError,
    shipments,
    linked,
  };
}

interface ApplyEntry {
  invoice_id: string;
  /**
   * The order behind the invoice, when there is one. Omitted for an invoice
   * that anchors its own shipment (no order row) — the patch lands on
   * `invoices` instead.
   */
  order_id?: string | null;
  easyship_shipment_id: string;
  tracking_number?: string | null;
  label_url?: string | null;
  courier_name?: string | null;
  /**
   * Hand-match only: re-point an anchor that is already bound to a different
   * shipment, or already marked shipped. The auto-match flow never sets this —
   * it is the operator explicitly correcting a bad link.
   */
  override?: boolean;
}

async function apply(
  entries: ApplyEntry[],
  actor: { actor_id: string | null; actor_email: string | null },
) {
  let applied = 0;
  const failed: Array<{ invoice_id: string; error: string }> = [];
  const skipped: Array<{ invoice_id: string; reason: string }> = [];

  // Pre-load each entry's anchor so we can honor the "skip when already
  // shipped or bound elsewhere" rule without racing against the update.
  interface AnchorState {
    table: 'orders' | 'invoices';
    id: string;
    easyship_shipment_id: string | null;
    /** True when the anchor already counts as shipped or delivered. */
    shipped: boolean;
  }
  const anchors = new Map<string, AnchorState>();

  const orderIds = Array.from(
    new Set(entries.map((e) => e.order_id).filter(Boolean) as string[]),
  );
  if (orderIds.length > 0) {
    const { data } = await db
      .from('orders')
      .select('id, easyship_shipment_id, status')
      .in('id', orderIds);
    for (const o of data ?? []) {
      anchors.set(`orders:${o.id}`, {
        table: 'orders',
        id: o.id,
        easyship_shipment_id: o.easyship_shipment_id ?? null,
        shipped: o.status === 'shipped' || o.status === 'delivered',
      });
    }
  }

  // Order-less invoices anchor themselves (easyship-invoice-shipment-migration.sql).
  const selfIds = Array.from(
    new Set(entries.filter((e) => !e.order_id).map((e) => e.invoice_id)),
  );
  let selfAnchorAvailable = true;
  if (selfIds.length > 0) {
    const { data, error } = await db
      .from('invoices')
      .select('id, easyship_shipment_id, fulfillment_status')
      .in('id', selfIds);
    if (error && isMissingColumnError(error)) {
      // Migration not run: there is nowhere to write the shipment.
      selfAnchorAvailable = false;
    } else {
      for (const inv of data ?? []) {
        anchors.set(`invoices:${inv.id}`, {
          table: 'invoices',
          id: inv.id,
          easyship_shipment_id: (inv as any).easyship_shipment_id ?? null,
          shipped: (inv as any).fulfillment_status === 'shipped',
        });
      }
    }
  }

  for (const e of entries) {
    if (!e.order_id && !selfAnchorAvailable) {
      skipped.push({
        invoice_id: e.invoice_id,
        reason:
          'invoice has no order to hold the shipment — run easyship-invoice-shipment-migration.sql',
      });
      continue;
    }
    const anchor = e.order_id
      ? anchors.get(`orders:${e.order_id}`)
      : anchors.get(`invoices:${e.invoice_id}`);
    if (!anchor) {
      skipped.push({
        invoice_id: e.invoice_id,
        reason: e.order_id ? 'order not found' : 'invoice not found',
      });
      continue;
    }
    const what = anchor.table === 'orders' ? 'order' : 'invoice';
    if (
      !e.override &&
      anchor.easyship_shipment_id &&
      anchor.easyship_shipment_id !== e.easyship_shipment_id
    ) {
      skipped.push({
        invoice_id: e.invoice_id,
        reason: `${what} already bound to a different shipment`,
      });
      continue;
    }
    if (!e.override && anchor.shipped) {
      skipped.push({ invoice_id: e.invoice_id, reason: `${what} already shipped` });
      continue;
    }

    const patch: Record<string, unknown> = {
      easyship_shipment_id: e.easyship_shipment_id,
    };
    if (e.tracking_number) patch.tracking_number = e.tracking_number;
    if (e.label_url) {
      patch.label_url = e.label_url;
      patch.label_state = 'generated';
    }
    if (e.courier_name) patch.carrier = e.courier_name;

    const { error: upErr } = await db
      .from(anchor.table)
      .update(patch)
      .eq('id', anchor.id);
    if (upErr) {
      failed.push({ invoice_id: e.invoice_id, error: upErr.message });
      continue;
    }
    applied += 1;

    // Pull the full Easyship record onto the invoice; when the linked
    // shipment already has its label, that also sends the shipped email
    // (customer + admins) unless this invoice was emailed already.
    const linked = {
      kind: anchor.table === 'orders' ? ('order' as const) : ('invoice' as const),
      id: anchor.id,
    };
    after(() => onShipmentLabelGenerated(db, linked).then(() => {}));

    await logAuditServer(db, actor, {
      action: e.override ? 'invoice.easyship_manual_link' : 'invoice.easyship_sync',
      entity_type: 'invoice',
      entity_id: e.invoice_id,
    });
  }

  return { applied, failed, skipped };
}

export async function POST(req: NextRequest) {
  const caller = await getInvoiceCaller(db, req);
  // Sync writes to orders/invoices — mutation surface is admin-only, matching
  // the
  // spec's "explicitly not assistant" rule.
  if (!caller.ok || !callerCanWrite(caller.role)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (Array.isArray(body.apply)) {
    // `order_id` is optional: an invoice with no order behind it anchors the
    // shipment on its own row.
    const entries = (body.apply as any[])
      .filter((e) => e?.invoice_id && e?.easyship_shipment_id)
      .map((e) => ({
        ...e,
        order_id: e.order_id ?? null,
        override: e.override === true,
      })) as ApplyEntry[];
    if (entries.length === 0) {
      return NextResponse.json(
        { error: 'apply[] is required with { invoice_id, easyship_shipment_id }' },
        { status: 400 },
      );
    }
    try {
      const result = await apply(entries, {
        actor_id: caller.actor_id,
        actor_email: caller.actor_email,
      });
      return NextResponse.json(result);
    } catch (e: any) {
      return NextResponse.json({ error: e?.message ?? 'apply failed' }, { status: 500 });
    }
  }

  const mode = String(body.mode ?? 'preview');

  // Hand-match: one page of invoices, no Easyship call at all. Kept separate
  // from the shipment fetch so paging through invoices never re-hits Easyship.
  if (mode === 'manual-invoices') {
    try {
      const result = await manualInvoices({
        page: Number(body.page ?? 1),
        pageSize: Number(body.pageSize ?? MANUAL_PAGE_SIZE),
        search: sanitizeSearch(body.search),
        includeLinked: body.includeLinked === true,
      });
      return NextResponse.json(result);
    } catch (e: any) {
      return NextResponse.json(
        { error: e?.message ?? 'invoice lookup failed' },
        { status: 500 },
      );
    }
  }

  // Hand-match: the shipment side of the picker. No date to supply — the
  // window is a fixed lookback so an operator can't miss a parcel by guessing
  // the wrong day.
  if (mode === 'manual-shipments') {
    try {
      return NextResponse.json(await manualShipments());
    } catch (e: any) {
      return NextResponse.json(
        { error: e?.message ?? 'shipment lookup failed' },
        { status: 500 },
      );
    }
  }

  const parsed = parseSyncDate(body.date);
  if ('error' in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const result = await preview(parsed.iso);
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'preview failed' }, { status: 500 });
  }
}
