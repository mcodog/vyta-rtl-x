import { supabase } from '@/lib/supabase';
import { apiFetch } from '@/lib/api-fetch';
import type {
  Invoice,
  InvoiceLineItem,
  Payment,
  AgingBucket,
  InvoiceStatus,
  PaymentMethod,
} from '@/lib/types/ecommerce';
import type { PuramassInvoiceContext } from '@/lib/admin/puramass-invoice';

async function getToken(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ---- LIST TYPES ----

/** A list row enriched server-side with derived/display fields. */
export interface InvoiceListItem extends Invoice {
  amount_paid: number;
  amount_due: number;
  /** Virtual status the UI should render (may be `overdue` while stored lags). */
  status_effective: InvoiceStatus;
  customer_name_display: string | null;
  customer_email_display: string | null;
  sales_person_name: string | null;
  /** Present once the backorder-split phase ships; optional today. */
  is_backorder?: boolean;
  /** Where the invoice came from — 'stealth_health' for a Stealth Health hand-off. */
  source?: string | null;
  /**
   * The Stealth Health order behind this invoice, when it has one. Attached
   * server-side from the hand-off ledger, which is where the buyer's phone and
   * shipping address live for those sales.
   */
  puramass?: PuramassInvoiceContext | null;
}

/** Summary card figures, computed over the status+scope set (not the page). */
export interface InvoiceStats {
  count: number;
  outstanding: number;
  overdueCount: number;
  paid: number;
}

export interface InvoiceListResult {
  invoices: InvoiceListItem[];
  total: number;
  stats: InvoiceStats;
}

// ---- INVOICES LIST ----

export async function getInvoices(filters?: {
  status?: InvoiceStatus;
  customer_id?: string;
  /** 'puramass' = Stealth Health hand-offs only; 'manual' = everything else. */
  source?: 'puramass' | 'manual';
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<InvoiceListResult> {
  const token = await getToken();
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.customer_id) params.set('customer_id', filters.customer_id);
  if (filters?.source) params.set('source', filters.source);
  if (filters?.q) params.set('q', filters.q);
  if (filters?.limit != null) params.set('limit', String(filters.limit));
  if (filters?.offset != null) params.set('offset', String(filters.offset));
  const qs = params.toString();

  return apiFetch<InvoiceListResult>(
    `/api/admin/invoices${qs ? `?${qs}` : ''}`,
    { headers: authHeaders(token) },
  );
}

// ---- SINGLE INVOICE WITH LINE ITEMS + PAYMENTS ----

export async function getInvoice(id: string): Promise<{
  invoice: Invoice & {
    customer_name?: string;
    customer_email?: string;
    customer_phone?: string;
    sales_person_name?: string;
    sales_person_email?: string;
    /** 'stealth_health' for an invoice materialised from a Stealth Health hand-off. */
    source?: string | null;
  };
  line_items: InvoiceLineItem[];
  payments: Payment[];
  amount_paid: number;
  amount_due: number;
} | null> {
  const { data: inv, error } = await supabase
    .from('invoices')
    .select(`
      *,
      customers!invoices_customer_id_fkey (first_name, last_name, email, phone),
      sales_persons (first_name, last_name, email)
    `)
    .eq('id', id)
    .single();

  if (error || !inv) return null;

  const { data: lines } = await supabase
    .from('invoice_line_items')
    .select('*')
    .eq('invoice_id', id);

  const { data: pmts } = await supabase
    .from('payments')
    .select('*')
    .eq('invoice_id', id)
    .order('paid_at', { ascending: false });

  const amount_paid = (pmts ?? []).reduce((s, p) => s + Number(p.amount), 0);
  const amount_due = Number(inv.total) - amount_paid;

  return {
    invoice: {
      ...inv,
      customer_name: inv.customers
        ? `${inv.customers.first_name} ${inv.customers.last_name}`
        : (inv.customer_name ?? null),
      customer_email: inv.customers?.email ?? inv.customer_email ?? null,
      customer_phone: inv.customers?.phone ?? inv.customer_phone ?? null,
      sales_person_name: inv.sales_persons
        ? `${inv.sales_persons.first_name} ${inv.sales_persons.last_name}`
        : null,
      sales_person_email: inv.sales_persons?.email ?? null,
    },
    line_items: lines ?? [],
    payments: pmts ?? [],
    amount_paid,
    amount_due,
  };
}

// ---- CREATE INVOICE ----

export interface CreateInvoicePayload {
  order_id?: string;
  customer_id?: string;
  customer_name?: string;
  customer_email?: string;
  customer_phone?: string;
  due_date?: string;
  subtotal: number;
  tax_total: number;
  shipping_cost: number;
  total: number;
  currency?: string;
  notes?: string;
  status?: InvoiceStatus;
  sales_person_id?: string;
  sales_person_commission_rate?: number;
  line_items: Array<{
    product_id?: string;
    product_variant_id?: string;
    description: string;
    qty: number;
    unit_price: number;
    discount_pct?: number;
  }>;
}

export async function createInvoice(
  payload: CreateInvoicePayload
): Promise<{
  success: boolean;
  invoice?: Invoice;
  /** Present when the order was split: the backorder (draft) invoice. */
  backorder_invoice?: Invoice;
  /** True when the order was split into a primary + backorder invoice. */
  split?: boolean;
  error?: string;
}> {
  const token = await getToken();
  try {
    const result = await apiFetch<{ invoice: Invoice; backorder_invoice?: Invoice; split?: boolean }>(
      '/api/admin/invoices',
      {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(payload),
      },
    );
    return {
      success: true,
      invoice: result.invoice,
      backorder_invoice: result.backorder_invoice,
      split: result.split,
    };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ---- UPDATE INVOICE ----

/**
 * Status / due date / notes change. Goes through PATCH /api/admin/invoices/[id]
 * rather than writing the row from the browser, so the server-side effects of
 * a status change run: marking paid decrements stock and emails the order
 * confirmation, cancelling restores stock, and the change is audited.
 */
export async function updateInvoice(
  id: string,
  updates: Partial<Pick<Invoice, 'status' | 'due_date' | 'notes'>>
): Promise<{ success: boolean; error?: string }> {
  const token = await getToken();
  try {
    await apiFetch(`/api/admin/invoices/${id}`, {
      method: 'PATCH',
      headers: authHeaders(token),
      body: JSON.stringify(updates),
    });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ---- UPDATE INVOICE (full edit, including line items / customer / sales person) ----

export interface UpdateInvoicePayload {
  customer_id?: string | null;
  customer_name?: string | null;
  customer_email?: string | null;
  customer_phone?: string | null;
  due_date?: string;
  subtotal?: number;
  tax_total?: number;
  shipping_cost?: number;
  total?: number;
  currency?: string;
  notes?: string | null;
  sales_person_id?: string | null;
  sales_person_commission_rate?: number;
  line_items?: Array<{
    product_id?: string | null;
    product_variant_id?: string | null;
    description: string;
    qty: number;
    unit_price: number;
    discount_pct?: number;
  }>;
}

export async function replaceInvoice(
  id: string,
  payload: UpdateInvoicePayload,
): Promise<{ success: boolean; error?: string }> {
  const token = await getToken();
  try {
    await apiFetch(`/api/admin/invoices/${id}`, {
      method: 'PATCH',
      headers: authHeaders(token),
      body: JSON.stringify(payload),
    });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ---- DELETE INVOICE ----

/**
 * Hard-delete an invoice. Line items, payments, backorders and email logs
 * cascade from the invoice row; the parent order (if any) is left untouched.
 */
export async function deleteInvoice(
  id: string,
): Promise<{ success: boolean; error?: string }> {
  const token = await getToken();
  try {
    await apiFetch(`/api/admin/invoices/${id}`, {
      method: 'DELETE',
      headers: { ...authHeaders(token), 'Content-Type': '' },
    });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message || 'Failed to delete invoice' };
  }
}

// ---- RECORD PAYMENT ----

export async function recordPayment(
  invoiceId: string,
  amount: number,
  method: PaymentMethod,
  referenceNote?: string
): Promise<{ success: boolean; error?: string }> {
  const token = await getToken();
  try {
    await apiFetch(`/api/admin/invoices/${invoiceId}/payments`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ amount, method, reference_note: referenceNote }),
    });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ---- AGING REPORT ----

/** Returns the ordered aging buckets (current → 90+). Empty array on error. */
export async function getAgingReport(): Promise<AgingBucket[]> {
  const token = await getToken();
  try {
    const res = await apiFetch<{ buckets: AgingBucket[] }>(
      '/api/admin/invoices/aging',
      { headers: authHeaders(token) },
    );
    return res.buckets ?? [];
  } catch (e) {
    console.error(e);
    return [];
  }
}

// ---- EMAIL INVOICE ----

export async function emailInvoice(
  invoiceId: string,
  options?: { to?: string; bcc?: string[] },
): Promise<{ success: boolean; error?: string }> {
  const token = await getToken();
  try {
    await apiFetch(`/api/admin/invoices/${invoiceId}/email`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(options ?? {}),
    });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ---- CUSTOMER CLIENTS (Ships-to-Client picker) ----

export interface CustomerClient {
  id: string;
  customer_id: string;
  first_name: string | null;
  last_name: string | null;
  address: string;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  phone: string | null;
  email: string | null;
  created_at: string;
  updated_at: string;
}

export async function listCustomerClients(customerId: string): Promise<CustomerClient[]> {
  const token = await getToken();
  try {
    const res = await apiFetch<{ clients: CustomerClient[] }>(
      `/api/admin/customer-clients?customer_id=${encodeURIComponent(customerId)}`,
      { headers: authHeaders(token) },
    );
    return res.clients ?? [];
  } catch (e) {
    console.error('listCustomerClients failed:', e);
    return [];
  }
}

export async function createCustomerClient(input: {
  customer_id: string;
  first_name?: string;
  last_name?: string;
  address: string;
  city?: string;
  state?: string;
  postal_code?: string;
  country?: string;
  phone?: string;
  email?: string;
}): Promise<{ success: boolean; client?: CustomerClient; error?: string }> {
  const token = await getToken();
  try {
    const res = await apiFetch<{ client: CustomerClient }>(
      '/api/admin/customer-clients',
      {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(input),
      },
    );
    return { success: true, client: res.client };
  } catch (e: any) {
    return { success: false, error: e?.message ?? 'Failed to save client' };
  }
}

// ---- SHIPPING READINESS (create-form pre-flight) ----

export interface ShippingReadinessCheck {
  key: string;
  label: string;
  ok: boolean;
  detail?: string;
}

export interface ShippingReadinessRate {
  courier_id: string;
  courier_name: string;
  service_name: string;
  min_delivery_time: number;
  max_delivery_time: number;
  total_charge: number;
  currency: string;
  tracking_rating: number;
}

/** Where a destination the server resolved for us came from. */
export type ShippingDestinationSource = 'order' | 'puramass' | 'client' | 'customer';

export interface ShippingReadinessResult {
  ready: boolean;
  checks: ShippingReadinessCheck[];
  rates: ShippingReadinessRate[];
  ratesNote: string | null;
  /** Set when the form had no usable destination and the server resolved the
   *  invoice's own — a Stealth Health hand-off's ledger address, say. */
  destination?: {
    country?: string | null;
    postal_code?: string | null;
    city?: string | null;
    state?: string | null;
  } | null;
  destination_source?: ShippingDestinationSource | null;
}

export async function shippingReadiness(input: {
  destination: {
    country?: string | null;
    postal_code?: string | null;
    city?: string | null;
    state?: string | null;
  };
  /** Lets the server fall back to the invoice's own address when the form has
   *  none — the normal case for an invoice with no customer picked. */
  invoice_id?: string | null;
  items: Array<{ qty: number; weight_kg?: number | null }>;
}): Promise<ShippingReadinessResult> {
  const token = await getToken();
  return apiFetch<ShippingReadinessResult>('/api/admin/invoices/shipping-readiness', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(input),
    timeoutMs: 20_000,
  });
}

// ---- MANUAL EASYSHIP SHIPMENT ----

export interface InvoiceShipmentResult {
  /** Which row ended up carrying the shipment. */
  anchor?: 'order' | 'invoice';
  shipment?: {
    easyship_shipment_id: string | null;
    label_state: string | null;
    label_url: string | null;
    tracking_number: string | null;
    carrier: string | null;
    auto_shipment_status: string | null;
    auto_shipment_error: string | null;
  } | null;
  error?: string;
}

/**
 * Create the Easyship shipment for an invoice, with or without an order behind
 * it. The route picks the anchor; a Stealth Health hand-off ships off the
 * invoice using the address from the Stealth Health ledger.
 */
export async function createInvoiceShipment(
  id: string,
  opts: {
    courier_service_id?: string | null;
    courier_preference?: 'cheapest' | 'ups' | 'fedex' | null;
    insured?: boolean;
    handover?: 'dropoff' | 'collection' | 'free_collection' | null;
    buy_label?: boolean;
  } = {},
): Promise<InvoiceShipmentResult> {
  const token = await getToken();
  return apiFetch<InvoiceShipmentResult>(
    `/api/admin/invoices/${id}/create-shipment`,
    {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(opts),
      timeoutMs: 30_000,
    },
  );
}

export interface InvoiceLabelResult {
  anchor?: 'order' | 'invoice';
  label?: {
    state: string | null;
    url: string | null;
    tracking_number: string | null;
    carrier: string | null;
  } | null;
  error?: string;
}

/**
 * Buy the Easyship label for an invoice's shipment. Charges the Easyship
 * wallet. Works whether the shipment hangs off the invoice's order or off the
 * invoice itself.
 */
export async function buyInvoiceLabel(id: string): Promise<InvoiceLabelResult> {
  const token = await getToken();
  return apiFetch<InvoiceLabelResult>(`/api/admin/invoices/${id}/buy-label`, {
    method: 'POST',
    headers: authHeaders(token),
    // Easyship polls for the generated PDF before returning.
    timeoutMs: 45_000,
  });
}

// ---- INLINE FULFILLMENT STATUS ----

/**
 * Set the warehouse-facing fulfillment status inline from the list page.
 * Values match the DB CHECK on invoices.fulfillment_status:
 * pending | packed | shipped | picked_up | dropped_off.
 */
export async function setInvoiceFulfillmentStatus(
  id: string,
  fulfillment_status: 'pending' | 'packed' | 'shipped' | 'picked_up' | 'dropped_off',
): Promise<{ success: boolean; error?: string }> {
  const token = await getToken();
  try {
    await apiFetch(`/api/admin/invoices/${id}`, {
      method: 'PATCH',
      headers: authHeaders(token),
      body: JSON.stringify({ fulfillment_status }),
    });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e?.message ?? 'Failed to update fulfillment status' };
  }
}

// ---- BULK DELETE ----

/**
 * Hard-delete a batch of invoices. Cascades take out the line items,
 * payments, backorders and email logs; the paired orders are torn down
 * too (unlike the single-invoice DELETE, which leaves the order alone).
 */
export async function deleteInvoices(
  ids: string[],
): Promise<{ success: boolean; deleted?: number; ordersDeleted?: number; error?: string }> {
  const token = await getToken();
  try {
    const res = await apiFetch<{ ok: true; deleted: number; ordersDeleted: number }>(
      '/api/admin/invoices',
      {
        method: 'DELETE',
        headers: authHeaders(token),
        body: JSON.stringify({ ids }),
      },
    );
    return { success: true, deleted: res.deleted, ordersDeleted: res.ordersDeleted };
  } catch (e: any) {
    return { success: false, error: e?.message ?? 'Failed to delete invoices' };
  }
}

// ---- TRACKING ----

export interface InvoiceTrackingSnapshot {
  hasOrder: boolean;
  order_id: string | null;
  order_number: string | null;
  order_status: string | null;
  hasShipment: boolean;
  live: boolean;
  /** Destination place label (e.g. "Toronto, ON, CA") for the shipment map. */
  destination: string | null;
  tracking: {
    status: string | null;
    number: string | null;
    url: string | null;
    carrier: string | null;
    easyship_shipment_id: string | null;
    label_state: string | null;
    label_url: string | null;
    checkpoints?: Array<{
      message: string;
      occurred_at: string;
      location?: string | null;
      primary_status?: string | null;
    }>;
    refresh_error?: string;
    /** Last after()-scheduled auto-shipment attempt. `status` is one of
     *  'success' | 'skipped' | 'failed'; `stage` is 'create' / 'rate' /
     *  'buy-label'. Null when no attempt has ever run for this order. */
    auto_shipment?: {
      status: 'success' | 'skipped' | 'failed' | string;
      stage: string | null;
      error: string | null;
      attempted_at: string | null;
    } | null;
  } | null;
}

/**
 * Get the shipping/tracking snapshot for an invoice's linked order.
 * `refresh: true` calls Easyship live; only admins persist the result.
 */
export async function getInvoiceTracking(
  id: string,
  opts: { refresh?: boolean } = {},
): Promise<InvoiceTrackingSnapshot> {
  const token = await getToken();
  const qs = opts.refresh ? '?refresh=1' : '';
  return apiFetch<InvoiceTrackingSnapshot>(
    `/api/admin/invoices/${id}/tracking${qs}`,
    { headers: authHeaders(token) },
  );
}

// ---- PURAMASS HAND-OFF ----

/**
 * The Stealth Health order behind an invoice, or null when the invoice was raised
 * here rather than handed off to Stealth Health.
 *
 * A separate call because the detail page reads the invoice under the caller's
 * RLS, while the hand-off ledger is service-role only — same shape as the
 * tracking snapshot above.
 */
export async function getInvoicePuramass(
  id: string,
): Promise<PuramassInvoiceContext | null> {
  const token = await getToken();
  try {
    const res = await apiFetch<{ puramass: PuramassInvoiceContext | null }>(
      `/api/admin/invoices/${id}/puramass`,
      { headers: authHeaders(token) },
    );
    return res.puramass ?? null;
  } catch {
    // The Stealth Health block is supplementary — never break the detail page over it.
    return null;
  }
}

// ---- EASYSHIP SYNC ----

export interface EasyshipSyncMatch {
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
  ambiguous: boolean;
}

export interface EasyshipSyncUnmatched {
  easyship_shipment_id: string;
  tracking_number: string | null;
  courier_name: string | null;
  destination_name: string | null;
  created_at: string | null;
  status: string | null;
}

export interface EasyshipSyncPreview {
  date: string;
  fetched: number;
  easyshipError: string | null;
  matches: EasyshipSyncMatch[];
  unmatched: EasyshipSyncUnmatched[];
}

export async function previewEasyshipSync(
  dateIso: string,
): Promise<EasyshipSyncPreview> {
  const token = await getToken();
  return apiFetch<EasyshipSyncPreview>('/api/admin/invoices/easyship-sync', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ date: dateIso }),
    // Easyship's /shipments listing walks pagination, which can be slow on a
    // heavy day — give the preview twice the default budget.
    timeoutMs: 25_000,
  });
}

// ---- EASYSHIP MANUAL MATCH ----

/** An invoice row in the hand-match picker (server-paginated, 10 per page). */
export interface EasyshipManualInvoice {
  invoice_id: string;
  invoice_number: string;
  /**
   * Which row holds this invoice's shipment: the order behind it, or the
   * invoice itself when there is no order (hand-written invoices and
   * Stealth Health hand-offs).
   */
  anchor: 'order' | 'invoice';
  /** Null when the invoice anchors its own shipment. */
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
  /** Status of the order behind the invoice; null when there is no order. */
  order_status: string | null;
}

export interface EasyshipManualInvoicePage {
  invoices: EasyshipManualInvoice[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** Default page size for the hand-match invoice picker. */
export const EASYSHIP_MANUAL_PAGE_SIZE = 10;

export async function listEasyshipManualInvoices(opts: {
  page?: number;
  pageSize?: number;
  search?: string;
  includeLinked?: boolean;
}): Promise<EasyshipManualInvoicePage> {
  const token = await getToken();
  return apiFetch<EasyshipManualInvoicePage>('/api/admin/invoices/easyship-sync', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      mode: 'manual-invoices',
      page: opts.page ?? 1,
      pageSize: opts.pageSize ?? EASYSHIP_MANUAL_PAGE_SIZE,
      search: opts.search ?? '',
      includeLinked: opts.includeLinked ?? false,
    }),
  });
}

/** The order or invoice a shipment is already attached to. */
export interface EasyshipShipmentOwner {
  kind: 'order' | 'invoice';
  id: string;
  /** Order number / invoice number — whatever an operator would recognise. */
  label: string | null;
}

export interface EasyshipManualShipments {
  /** Start of the fetched window (ISO). The picker has no date field. */
  since: string;
  lookbackDays: number;
  fetched: number;
  easyshipError: string | null;
  shipments: EasyshipSyncUnmatched[];
  /** shipment id → the order or invoice it is already attached to. */
  linked: Record<string, EasyshipShipmentOwner>;
}

/**
 * Every Easyship shipment in the server's fixed lookback window. Deliberately
 * takes no date: picking the wrong day was the easiest way to end up with an
 * empty picker.
 */
export async function listEasyshipManualShipments(): Promise<EasyshipManualShipments> {
  const token = await getToken();
  return apiFetch<EasyshipManualShipments>('/api/admin/invoices/easyship-sync', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ mode: 'manual-shipments' }),
    // Same reasoning as the auto preview, over a wider window — walking
    // Easyship pagination is slow.
    timeoutMs: 45_000,
  });
}

/**
 * Attach one shipment to an invoice — to the order behind it, or to the
 * invoice itself when `order_id` is null. `override` re-points an anchor that
 * is already bound elsewhere or already marked shipped; the operator confirms
 * that explicitly in the dialog.
 */
export async function linkEasyshipShipment(entry: {
  invoice_id: string;
  order_id?: string | null;
  easyship_shipment_id: string;
  tracking_number?: string | null;
  label_url?: string | null;
  courier_name?: string | null;
  override?: boolean;
}): Promise<EasyshipSyncApplyResult> {
  const token = await getToken();
  return apiFetch<EasyshipSyncApplyResult>('/api/admin/invoices/easyship-sync', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ apply: [entry] }),
  });
}

export interface EasyshipSyncApplyResult {
  applied: number;
  failed: Array<{ invoice_id: string; error: string }>;
  skipped: Array<{ invoice_id: string; reason: string }>;
}

export async function applyEasyshipSync(
  matches: EasyshipSyncMatch[],
): Promise<EasyshipSyncApplyResult> {
  const token = await getToken();
  return apiFetch<EasyshipSyncApplyResult>('/api/admin/invoices/easyship-sync', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      apply: matches.map((m) => ({
        invoice_id: m.invoice_id,
        order_id: m.order_id,
        easyship_shipment_id: m.easyship_shipment_id,
        tracking_number: m.tracking_number,
        label_url: m.label_url,
        courier_name: m.courier_name,
      })),
    }),
  });
}

// ---- AUTO-CREATE FROM ORDER ----

export async function autoCreateInvoiceFromOrder(
  orderId: string
): Promise<{ success: boolean; invoice_id?: string; error?: string }> {
  // Fetch order with items
  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .select('*, order_items(*)')
    .eq('id', orderId)
    .single();

  if (orderErr || !order) return { success: false, error: 'Order not found' };

  // Prefer the relational order_items table, but fall back to the orders.items
  // JSONB column, which is where the current e-Transfer checkout stores line
  // items (it never populates order_items). Without this, invoices generated
  // from those orders would have no lines and be rejected.
  const rawItems =
    Array.isArray(order.order_items) && order.order_items.length > 0
      ? order.order_items
      : Array.isArray(order.items)
        ? order.items
        : [];

  const lineItems = rawItems.map((item: any) => ({
    product_variant_id: item.product_variant_id ?? undefined,
    description: item.name_snapshot ?? item.product_name ?? item.name ?? 'Product',
    qty: item.qty ?? item.quantity ?? 1,
    unit_price: item.unit_price ?? item.price_at_time ?? item.price ?? 0,
    discount_pct: item.discount_pct ?? 0,
  }));

  if (lineItems.length === 0) {
    return { success: false, error: 'Order has no line items to invoice' };
  }

  const subtotal = order.subtotal ?? order.total ?? 0;
  const tax_total = order.tax_total ?? 0;
  const shipping_cost = order.shipping_cost ?? 0;
  const total = order.total ?? subtotal + tax_total + shipping_cost;

  const result = await createInvoice({
    order_id: orderId,
    customer_id: order.customer_id ?? undefined,
    subtotal,
    tax_total,
    shipping_cost,
    total,
    line_items: lineItems,
  });

  if (!result.success) return result;

  // Prevent double-decrement: if this order already adjusted product stock
  // (its payment was confirmed before the invoice existed), the invoice must
  // not decrement the same goods again when it is later marked paid. Carry the
  // order's stock_adjusted flag onto the new invoice so adjust_stock_for_invoice
  // short-circuits.
  if (order.stock_adjusted && result.invoice?.id) {
    await supabase
      .from('invoices')
      .update({ stock_adjusted: true })
      .eq('id', result.invoice.id);
  }

  return { success: true, invoice_id: result.invoice?.id };
}

// ---- GET-OR-CREATE INVOICE FOR AN ORDER ----

/**
 * Return the invoice for an order, creating one from the order if none exists.
 * Orders are capped at one invoice each (uniq_invoices_order_id), so this both
 * powers the "Generate Invoice" action and stays safe against double-clicks:
 * an already-invoiced order just resolves to its existing invoice.
 */
export async function getOrCreateInvoiceForOrder(
  orderId: string,
): Promise<{ success: boolean; invoice_id?: string; existed?: boolean; error?: string }> {
  const { data: existing } = await supabase
    .from('invoices')
    .select('id')
    .eq('order_id', orderId)
    .maybeSingle();

  if (existing?.id) {
    return { success: true, invoice_id: existing.id, existed: true };
  }

  const result = await autoCreateInvoiceFromOrder(orderId);
  return { ...result, existed: false };
}
