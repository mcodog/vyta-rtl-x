import { supabase } from '@/lib/supabase';
import type { Order, Customer, Affiliate, Commission, UserRole } from '@/lib/supabase';
import { apiFetch } from '@/lib/api-fetch';
import { logAuditClient } from '@/lib/admin/audit';

/**
 * Get the current user's access token for API requests
 */
async function getAccessToken(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token || null;
}

/**
 * Get all orders with customer info
 */
export async function getAllOrders(): Promise<(Order & { customer_email?: string; customer_name?: string })[]> {
  const { data, error } = await supabase
    .from('orders')
    .select(`
      *,
      customers (
        email,
        first_name,
        last_name
      )
    `)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching orders:', error);
    return [];
  }

  return (data || []).map((order: any) => ({
    ...order,
    customer_email: order.customers?.email,
    customer_name: order.customers ? `${order.customers.first_name} ${order.customers.last_name}` : null,
  }));
}

/**
 * Update order status
 */
export async function updateOrderStatus(
  orderId: string,
  status: Order['status'],
  trackingNumber?: string
): Promise<{ success: boolean; error?: string }> {
  // Route through the server PATCH so the full lifecycle engine runs
  // (stock decrement + oversell guard on confirm, stock restore on
  // cancel/refund, first-order flag, auto-invoice). A direct client write
  // to `orders` bypassed all of it — and only worked at all because RLS was
  // permissive.
  const accessToken = await getAccessToken();
  if (!accessToken) {
    return { success: false, error: 'Not authenticated' };
  }

  try {
    await apiFetch(`/api/admin/orders/${orderId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        status,
        ...(trackingNumber ? { tracking_number: trackingNumber } : {}),
      }),
    });
    return { success: true };
  } catch (error: any) {
    console.error('Error updating order:', error);
    return { success: false, error: error?.message || 'Failed to update order' };
  }
}

/**
 * Hard-delete an order. The server route tears down FK-bound rows first
 * (linked invoices, commissions, shipment logs, order items) so the delete is
 * safe despite the order↔invoice foreign key.
 */
export async function deleteOrder(
  orderId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    await apiFetch(`/api/admin/orders/${orderId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': '' },
    });
    return { success: true };
  } catch (error: any) {
    console.error('Error deleting order:', error);
    return { success: false, error: error.message || 'Network error' };
  }
}

// ---------- Easyship shipment / label actions ----------

export interface OrderShipmentResult {
  id: string;
  easyship_shipment_id: string | null;
  label_state: string | null;
  label_url: string | null;
  tracking_number: string | null;
  carrier: string | null;
  auto_shipment_status: string | null;
  auto_shipment_error: string | null;
}

/**
 * Create (or re-attempt) the Easyship shipment record for an order. Used when
 * the order was placed before Easyship was configured, or the auto-create at
 * checkout failed and the admin wants to retry.
 */
export async function createOrderShipment(
  orderId: string,
  courierServiceId?: string,
): Promise<OrderShipmentResult> {
  const { order } = await apiFetch<{ order: OrderShipmentResult }>(
    `/api/admin/orders/${orderId}/create-shipment`,
    {
      method: 'POST',
      body: JSON.stringify(courierServiceId ? { courier_service_id: courierServiceId } : {}),
      timeoutMs: 45_000,
    },
  );
  return order;
}

/**
 * Purchase the shipping label for an order's existing Easyship shipment.
 * Returns the refreshed label state (state/url/tracking/carrier).
 */
export async function buyOrderLabel(orderId: string): Promise<{
  state: string;
  url: string | null;
  tracking_number: string | null;
  carrier: string | null;
}> {
  const { label } = await apiFetch<{
    label: { state: string; url: string | null; tracking_number: string | null; carrier: string | null };
  }>(`/api/admin/orders/${orderId}/buy-label`, {
    method: 'POST',
    body: JSON.stringify({}),
    timeoutMs: 45_000,
  });
  return label;
}

export interface OrderRateOption {
  courier_id: string;
  courier_name: string;
  service_name: string;
  total_charge: number;
  currency: string;
}

/**
 * Live courier rate options for an order (UPS/FedEx, cheapest first). Used to
 * let an admin pick which courier the label is bought with.
 */
export async function getOrderRates(orderId: string): Promise<OrderRateOption[]> {
  const { rates } = await apiFetch<{ rates: OrderRateOption[] }>(
    `/api/admin/orders/${orderId}/rates`,
    { timeoutMs: 30_000 },
  );
  return rates ?? [];
}

/**
 * Fetch the label PDF as a Blob via the authenticated proxy route. The label
 * endpoint requires a Bearer token, so it can't be loaded with a plain <a>/
 * window.open — callers print the returned blob (e.g. via a hidden iframe).
 */
export async function fetchLabelBlob(orderId: string): Promise<Blob> {
  let authHeader: Record<string, string> = {};
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) {
      authHeader = { Authorization: `Bearer ${session.access_token}` };
    }
  } catch {
    /* no session — request will 403 and throw below */
  }
  const res = await fetch(`/api/admin/orders/${orderId}/label`, {
    headers: authHeader,
  });
  if (!res.ok) {
    let message = `Failed to load label (${res.status})`;
    try { message = (await res.json()).error ?? message; } catch {}
    throw new Error(message);
  }
  return res.blob();
}

/**
 * Get all affiliates with their stats
 */
export async function getAllAffiliates(): Promise<(Affiliate & {
  pending_earnings?: number;
  total_referrals?: number;
  referral_code?: string;
})[]> {
  // Get affiliates
  const { data: affiliates, error } = await supabase
    .from('affiliates')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching affiliates:', error);
    return [];
  }

  // Get referral codes and commissions for each affiliate
  const result = await Promise.all(
    (affiliates || []).map(async (affiliate) => {
      // Get referral code
      const { data: codes } = await supabase
        .from('referral_codes')
        .select('code, uses_count')
        .eq('affiliate_id', affiliate.id)
        .eq('active', true)
        .limit(1);

      // Get pending commissions
      const { data: pendingCommissions } = await supabase
        .from('commissions')
        .select('amount')
        .eq('affiliate_id', affiliate.id)
        .eq('status', 'pending');

      const pendingEarnings = (pendingCommissions || []).reduce((sum, c) => sum + c.amount, 0);

      return {
        ...affiliate,
        referral_code: codes?.[0]?.code,
        total_referrals: codes?.[0]?.uses_count || 0,
        pending_earnings: pendingEarnings,
      };
    })
  );

  return result;
}

/**
 * Get all commissions
 */
export async function getAllCommissions(): Promise<(Commission & {
  affiliate_email?: string;
  affiliate_name?: string;
  order_number?: string;
})[]> {
  const { data, error } = await supabase
    .from('commissions')
    .select(`
      *,
      affiliates (
        email,
        first_name,
        last_name
      ),
      orders!commissions_order_id_fkey (
        order_number
      ),
      invoices (
        invoice_number
      )
    `)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching commissions:', error);
    return [];
  }

  return (data || []).map((commission: any) => ({
    ...commission,
    affiliate_email: commission.affiliates?.email,
    affiliate_name: commission.affiliates ? `${commission.affiliates.first_name} ${commission.affiliates.last_name}` : null,
    // Hosted (Stealth Health) sales are keyed on an invoice — there is no
    // orders row — so fall back to the invoice number as the reference.
    order_number: commission.orders?.order_number ?? commission.invoices?.invoice_number,
  }));
}

/**
 * Update an affiliate's commission rate
 */
export async function updateAffiliateCommissionRate(
  affiliateId: string,
  rate: number
): Promise<{ success: boolean; error?: string }> {
  if (rate < 0 || rate > 1) {
    return { success: false, error: 'Rate must be between 0 and 1' };
  }

  const { error } = await supabase
    .from('affiliates')
    .update({ commission_rate: rate })
    .eq('id', affiliateId);

  if (error) {
    console.error('Error updating commission rate:', error);
    return { success: false, error: 'Failed to update commission rate' };
  }

  await logAuditClient({
    action: 'affiliate.commission_rate_update',
    entity_type: 'affiliate',
    entity_id: affiliateId,
  });

  return { success: true };
}

/**
 * Mark commission as paid
 */
export async function markCommissionPaid(commissionId: string): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase
    .from('commissions')
    .update({
      status: 'paid',
      paid_at: new Date().toISOString(),
    })
    .eq('id', commissionId);

  if (error) {
    console.error('Error marking commission paid:', error);
    return { success: false, error: 'Failed to update commission' };
  }

  await logAuditClient({
    action: 'commission.marked_paid',
    entity_type: 'commission',
    entity_id: commissionId,
  });

  return { success: true };
}

/**
 * Create a new affiliate (provisions Auth user + affiliates + referral code +
 * customers role + sales_person in one server-side transaction-by-hand).
 */
export async function createAffiliate(data: {
  first_name: string;
  last_name: string;
  email: string;
  wallet_address?: string | null;
  active?: boolean;
  /** The code the admin typed. Left blank, the server proposes one. */
  referral_code?: string;
}): Promise<{ success: boolean; affiliate_id?: string; referral_code?: string | null; error?: string }> {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    return { success: false, error: 'Not authenticated' };
  }

  try {
    const result = await apiFetch<{
      success: boolean;
      affiliate_id: string;
      referral_code: string | null;
    }>('/api/admin/affiliates', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        first_name: data.first_name,
        last_name: data.last_name,
        email: data.email.toLowerCase(),
        wallet_address: data.wallet_address || null,
        active: data.active ?? true,
        referral_code: data.referral_code || null,
      }),
    });
    return {
      success: true,
      affiliate_id: result.affiliate_id,
      referral_code: result.referral_code ?? null,
    };
  } catch (error: any) {
    console.error('Error creating affiliate:', error);
    return { success: false, error: error.message || 'Network error' };
  }
}

/**
 * Update an affiliate (profile + wallet + credentials + active).
 */
export async function updateAffiliate(
  affiliateId: string,
  updates: {
    first_name?: string;
    last_name?: string;
    email?: string;
    wallet_address?: string | null;
    active?: boolean;
    password?: string;
  },
): Promise<{ success: boolean; error?: string }> {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    return { success: false, error: 'Not authenticated' };
  }

  try {
    await apiFetch(`/api/admin/affiliates/${affiliateId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(updates),
    });
    return { success: true };
  } catch (error: any) {
    console.error('Error updating affiliate:', error);
    return { success: false, error: error.message || 'Network error' };
  }
}

/**
 * Delete an affiliate (FK-safe teardown of all rows sharing its UUID).
 */
export async function deleteAffiliate(
  affiliateId: string,
): Promise<{ success: boolean; error?: string }> {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    return { success: false, error: 'Not authenticated' };
  }

  try {
    await apiFetch(`/api/admin/affiliates/${affiliateId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': '' },
    });
    return { success: true };
  } catch (error: any) {
    console.error('Error deleting affiliate:', error);
    return { success: false, error: error.message || 'Network error' };
  }
}

/**
 * Activate / deactivate an affiliate (Auth ban + active flag).
 */
export async function toggleAffiliateActive(
  affiliateId: string,
  active: boolean,
): Promise<{ success: boolean; error?: string }> {
  return updateAffiliate(affiliateId, { active });
}

/**
 * Send an account link to the affiliate's email. Affiliates authenticate via
 * Supabase auth (the `affiliates.password_hash` column is legacy), so this is
 * a recovery link either way; `purpose` only picks the copy — 'welcome' for a
 * freshly created account, 'reset' for a plain password reset. `redirectPath`
 * defaults to the reset-password page.
 */
export async function sendCustomerMagicLink(
  affiliateId: string,
  redirectPath: string = '/reset-password',
  purpose: 'welcome' | 'reset' = 'welcome',
): Promise<{ success: boolean; error?: string }> {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    return { success: false, error: 'Not authenticated' };
  }

  try {
    await apiFetch(`/api/admin/affiliates/${affiliateId}/magic-link`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ redirectPath, purpose }),
    });
    return { success: true };
  } catch (error: any) {
    console.error('Error sending account link:', error);
    return { success: false, error: error.message || 'Network error' };
  }
}

/**
 * Get all sales-person commissions (invoice-based stream), enriched with the
 * sales person + invoice number. Mirrors getAllCommissions for the unified UI.
 */
export async function getAllSalesCommissions(): Promise<any[]> {
  const { data, error } = await supabase
    .from('sales_commissions')
    .select(`
      *,
      sales_persons (first_name, last_name, email),
      invoices (invoice_number)
    `)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching sales commissions:', error);
    return [];
  }

  return (data || []).map((c: any) => ({
    ...c,
    sales_person_name: c.sales_persons
      ? `${c.sales_persons.first_name} ${c.sales_persons.last_name}`
      : null,
    sales_person_email: c.sales_persons?.email ?? null,
    invoice_number: c.invoices?.invoice_number ?? null,
  }));
}

/**
 * Mark a sales-person commission as paid.
 */
export async function markSalesCommissionPaid(
  commissionId: string,
): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase
    .from('sales_commissions')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', commissionId);

  if (error) {
    console.error('Error marking sales commission paid:', error);
    return { success: false, error: 'Failed to update commission' };
  }

  await logAuditClient({
    action: 'sales_commission.marked_paid',
    entity_type: 'sales_commission',
    entity_id: commissionId,
  });

  return { success: true };
}

/**
 * Get dashboard stats
 */
export async function getAdminStats(): Promise<{
  totalOrders: number;
  totalRevenue: number;
  pendingOrders: number;
  totalAffiliates: number;
  pendingCommissions: number;
  totalCommissionsPaid: number;
}> {
  // Get orders stats
  const { data: orders } = await supabase
    .from('orders')
    .select('status, total');

  const totalOrders = orders?.length || 0;
  const totalRevenue = (orders || []).reduce((sum, o) => sum + (o.total || 0), 0);
  const pendingOrders = (orders || []).filter(o => o.status === 'pending' || o.status === 'received' || o.status === 'confirmed').length;

  // Get affiliates count
  const { count: affiliateCount } = await supabase
    .from('affiliates')
    .select('*', { count: 'exact', head: true });

  // Commission totals come from the server: a browser read of `commissions`
  // can come back empty under RLS, which showed $0 owed.
  let pendingCommissions = 0;
  let totalCommissionsPaid = 0;
  try {
    const summary = await apiFetch<{ pending: number; paid: number }>('/api/admin/commissions?summary=1');
    pendingCommissions = summary.pending;
    totalCommissionsPaid = summary.paid;
  } catch (err) {
    console.error('Error fetching commission totals:', err);
  }

  return {
    totalOrders,
    totalRevenue,
    pendingOrders,
    totalAffiliates: affiliateCount || 0,
    pendingCommissions,
    totalCommissionsPaid,
  };
}

/** Default low-stock threshold when a product has none set (mirrors lib/admin/low-stock.ts). */
const DASHBOARD_LOW_STOCK_THRESHOLD = 10;

export interface RestockItem {
  id: string;
  name: string | null;
  sku: string | null;
  stock_quantity: number;
  low_stock_threshold: number;
}

/**
 * Read-only list of active products at or below their low-stock threshold,
 * neediest first. Distinct from lib/admin/low-stock.ts, which mutates the
 * `low_stock_alerted` flag and sends email — this one only reads, so it is
 * safe to call from the dashboard on every load.
 */
export async function getRestockNeeded(limit = 50): Promise<RestockItem[]> {
  const { data, error } = await supabase
    .from('products')
    .select('id, name, sku, stock_quantity, low_stock_threshold, is_active, active')
    .order('stock_quantity', { ascending: true });

  if (error) {
    console.error('Error fetching restock list:', error);
    return [];
  }

  return (data ?? [])
    .filter((p: any) => (p.is_active ?? p.active ?? true) !== false)
    .map((p: any) => ({
      id: p.id,
      name: p.name ?? null,
      sku: p.sku ?? null,
      stock_quantity: Number(p.stock_quantity ?? 0),
      low_stock_threshold: Number(p.low_stock_threshold ?? DASHBOARD_LOW_STOCK_THRESHOLD),
    }))
    .filter((p) => p.stock_quantity <= p.low_stock_threshold)
    .slice(0, limit);
}

export interface ShipmentFailure {
  id: string;
  order_number: string | null;
  customer_name: string | null;
  customer_email: string | null;
  error: string | null;
  created_at: string | null;
}

/**
 * Read-only list of orders whose automatic Easyship shipment creation failed
 * (`auto_shipment_status = 'failed'`), most recent first. Surfaced on the
 * dashboard so failed auto-shipments can be retried instead of going unnoticed.
 */
export async function getAutoShipmentFailures(limit = 25): Promise<ShipmentFailure[]> {
  const { data, error } = await supabase
    .from('orders')
    .select(`
      id, order_number, auto_shipment_status, auto_shipment_error, created_at,
      customers ( email, first_name, last_name )
    `)
    .eq('auto_shipment_status', 'failed')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Error fetching shipment failures:', error);
    return [];
  }

  return (data ?? []).map((o: any) => ({
    id: o.id,
    order_number: o.order_number ?? null,
    customer_name: o.customers
      ? `${o.customers.first_name ?? ''} ${o.customers.last_name ?? ''}`.trim() || null
      : null,
    customer_email: o.customers?.email ?? null,
    error: o.auto_shipment_error ?? null,
    created_at: o.created_at ?? null,
  }));
}

/**
 * Get single order with full details (items, customer, commission)
 */
export async function getOrderDetail(orderId: string) {
  // Get order with customer
  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select(`
      *,
      customers (
        email,
        first_name,
        last_name,
        phone,
        shipping_address,
        shipping_city,
        shipping_state,
        shipping_postal_code,
        shipping_country
      )
    `)
    .eq('id', orderId)
    .single();

  if (orderError || !order) {
    console.error('Error fetching order:', orderError);
    return null;
  }

  // Get order items. Current orders (e-Transfer checkout) store their line
  // items in the orders.items JSONB column and never populate the order_items
  // table, so fall back to that JSONB when the relational table has no rows —
  // otherwise the detail view shows an empty item list.
  const { data: itemRows } = await supabase
    .from('order_items')
    .select('*')
    .eq('order_id', orderId);

  const items =
    itemRows && itemRows.length > 0
      ? itemRows
      : Array.isArray(order.items)
        ? order.items.map((it: any, i: number) => ({
            id: it.id ?? `${orderId}-item-${i}`,
            product_id: it.id ?? null,
            product_name: it.name ?? 'Product',
            quantity: it.quantity ?? 1,
            price_at_time: it.price ?? 0,
            strength: it.strength ?? null,
          }))
        : [];

  // Get commission if any (match by order_number since that's what checkout stores)
  const { data: commissions } = await supabase
    .from('commissions')
    .select(`
      *,
      affiliates (
        email,
        first_name,
        last_name
      ),
      referral_codes (
        code
      )
    `)
    .eq('order_id', order.id);

  return {
    order: {
      ...order,
      customer_email: order.customers?.email,
      customer_name: order.customers ? `${order.customers.first_name} ${order.customers.last_name}` : null,
      customer_phone: order.customers?.phone,
      customer_shipping: order.customers ? {
        address: order.customers.shipping_address,
        city: order.customers.shipping_city,
        state: order.customers.shipping_state,
        postal_code: order.customers.shipping_postal_code,
        country: order.customers.shipping_country,
      } : null,
    },
    items: (items || []).map((item: any) => ({
      ...item,
      product_name: item.product_name,
      product_strength: item.strength,
      product_image: null,
    })),
    commission: commissions?.[0] ? {
      ...commissions[0],
      affiliate_name: commissions[0].affiliates ? `${commissions[0].affiliates.first_name} ${commissions[0].affiliates.last_name}` : null,
      affiliate_email: commissions[0].affiliates?.email,
      referral_code: commissions[0].referral_codes?.code,
    } : null,
  };
}

/**
 * Update order tracking number
 */
export async function updateOrderTracking(
  orderId: string,
  trackingNumber: string
): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase
    .from('orders')
    .update({
      tracking_number: trackingNumber,
      updated_at: new Date().toISOString(),
    })
    .eq('id', orderId);

  if (error) {
    console.error('Error updating tracking:', error);
    return { success: false, error: 'Failed to update tracking' };
  }

  await logAuditClient({
    action: 'order.tracking_update',
    entity_type: 'order',
    entity_id: orderId,
  });

  return { success: true };
}

/**
 * Get all customers
 */
export async function getAllCustomers(): Promise<Customer[]> {
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching customers:', error);
    return [];
  }

  return data || [];
}

/**
 * Toggle customer admin status
 * Note: This function updates both is_admin and role columns
 * The database trigger will keep them in sync
 */
export async function toggleCustomerAdmin(
  customerId: string,
  isAdmin: boolean
): Promise<{ success: boolean; error?: string }> {
  // Role changes go through the admin-gated server route, NEVER a direct
  // client write — a browser-side `customers` update let a signed-in user
  // self-promote to admin. The PUT route re-mirrors the legacy `is_admin`
  // flag from `role`.
  const newRole: 'customer' | 'admin' = isAdmin ? 'admin' : 'customer';
  return updateUser(customerId, { role: newRole });
}

/**
 * Update customer role (for more granular role management)
 */
export async function updateCustomerRole(
  customerId: string,
  role: UserRole
): Promise<{ success: boolean; error?: string }> {
  // Server-gated (admin only) — see toggleCustomerAdmin.
  return updateUser(customerId, { role });
}

/**
 * Get users with optional filters
 */
export async function getUsers(filters?: {
  role?: UserRole | 'all';
  active?: boolean | 'all';
  search?: string;
}): Promise<Customer[]> {
  let query = supabase
    .from('customers')
    .select('*')
    .order('created_at', { ascending: false });

  // Apply role filter
  if (filters?.role && filters.role !== 'all') {
    query = query.eq('role', filters.role);
  }

  // Apply active filter
  if (filters?.active !== undefined && filters.active !== 'all') {
    query = query.eq('active', filters.active);
  }

  // Apply search filter
  if (filters?.search) {
    const searchTerm = filters.search.toLowerCase();
    query = query.or(`email.ilike.%${searchTerm}%,first_name.ilike.%${searchTerm}%,last_name.ilike.%${searchTerm}%`);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching users:', error);
    return [];
  }

  return data || [];
}

/**
 * Create a new user
 * Creates user in Supabase Auth AND customers table with matching IDs
 */
export async function createUser(userData: {
  email: string;
  first_name: string;
  last_name: string;
  role: UserRole;
  password_hash: string; // Plain text password
  phone?: string;
  active?: boolean;
  email_verified?: boolean;
  can_send_fulfillment_emails?: boolean;
  preferred_currency?: string;
}): Promise<{ success: boolean; error?: string; user?: Customer }> {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    return { success: false, error: 'Not authenticated' };
  }

  try {
    const data = await apiFetch<{ user: Customer }>('/api/admin/users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        email: userData.email.toLowerCase(),
        first_name: userData.first_name,
        last_name: userData.last_name,
        role: userData.role,
        password: userData.password_hash,
        phone: userData.phone,
        active: userData.active,
        email_verified: userData.email_verified,
        can_send_fulfillment_emails: userData.can_send_fulfillment_emails,
        preferred_currency: userData.preferred_currency,
      }),
    });
    return { success: true, user: data.user };
  } catch (error: any) {
    console.error('Error creating user:', error);
    return { success: false, error: error.message || 'Network error' };
  }
}

/**
 * Update an existing user
 * Updates both customers table and Supabase Auth if needed
 */
export async function updateUser(
  userId: string,
  updates: Partial<Omit<Customer, 'id' | 'created_at' | 'updated_at'>> & { new_password?: string }
): Promise<{ success: boolean; error?: string }> {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    return { success: false, error: 'Not authenticated' };
  }

  try {
    await apiFetch(`/api/admin/users/${userId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(updates),
    });
    return { success: true };
  } catch (error: any) {
    console.error('Error updating user:', error);
    return { success: false, error: error.message || 'Network error' };
  }
}

/**
 * Delete a user. Hard delete → DELETE route (Auth + profile + bound rows).
 * Soft delete → PUT { active:false } (deactivate + Auth ban).
 */
export async function deleteUser(
  userId: string,
  hard: boolean = false
): Promise<{ success: boolean; error?: string }> {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    return { success: false, error: 'Not authenticated' };
  }

  try {
    if (hard) {
      await apiFetch(`/api/admin/users/${userId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': '' },
      });
    } else {
      await apiFetch(`/api/admin/users/${userId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ active: false }),
      });
    }
    return { success: true };
  } catch (error: any) {
    console.error('Error deleting user:', error);
    return { success: false, error: error.message || 'Network error' };
  }
}

/**
 * Toggle user active status (PUT → deactivate/reactivate + Auth ban sync)
 */
export async function toggleUserActive(
  userId: string,
  active: boolean
): Promise<{ success: boolean; error?: string }> {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    return { success: false, error: 'Not authenticated' };
  }

  try {
    await apiFetch(`/api/admin/users/${userId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ active }),
    });
    return { success: true };
  } catch (error: any) {
    console.error('Error toggling user active status:', error);
    return { success: false, error: error.message || 'Failed to update user status' };
  }
}

/**
 * Products at or below their per-product low-stock threshold, lowest stock
 * first. Powers the red Products nav badge and the dashboard low-stock list.
 */
export async function getLowStockProducts(): Promise<
  Pick<import('@/lib/supabase').Product, 'id' | 'name' | 'sku' | 'slug' | 'stock_quantity' | 'low_stock_threshold' | 'image_url' | 'price'>[]
> {
  const { data, error } = await supabase
    .from('products')
    .select('id, name, sku, slug, stock_quantity, low_stock_threshold, image_url, price')
    .eq('active', true)
    .order('stock_quantity', { ascending: true });

  if (error) {
    console.error('Error fetching low-stock products:', error);
    return [];
  }

  return (data ?? []).filter(
    (p: any) => (p.stock_quantity ?? 0) <= (p.low_stock_threshold ?? 10),
  );
}
