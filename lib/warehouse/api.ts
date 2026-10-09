// Client-side wrappers for the warehouse portal. All calls use the
// caller's Supabase access token via Authorization: Bearer.

import { supabase } from '@/lib/supabase';
import type {
  QueueItem,
  QueueSummary,
  QueueViewer,
  FulfillmentStatus,
  NotificationPreview,
  ShipmentDetailsFields,
} from './types';

export * from './types';

async function authHeader(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = j.error || j.message || msg;
    } catch {}
    throw new Error(`${res.status} ${msg}`);
  }
  return (await res.json()) as T;
}

export interface QueueFilters {
  fulfillment_status?: FulfillmentStatus;
  fulfillment_type?: 'shipment' | 'pickup';
  label_state?: string;
}

export async function getQueue(filters: QueueFilters = {}): Promise<{
  items: QueueItem[];
  summary: QueueSummary;
  viewer: QueueViewer;
}> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v) qs.set(k, v);
  }
  const res = await fetch(`/api/warehouse/queue?${qs.toString()}`, {
    headers: await authHeader(),
    cache: 'no-store',
  });
  return jsonOrThrow(res);
}

export async function updateFulfillmentStatus(
  invoiceId: string,
  status: FulfillmentStatus,
): Promise<{ ok: true; item: QueueItem }> {
  const res = await fetch(`/api/warehouse/queue/${invoiceId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(await authHeader()),
    },
    body: JSON.stringify({ fulfillment_status: status }),
  });
  return jsonOrThrow(res);
}

/**
 * Remove an invoice from (or restore it to) the active fulfillment queue.
 * This is a warehouse-only soft hide — it does NOT cancel the linked order.
 */
export async function setRemovedFromQueue(
  invoiceId: string,
  removed: boolean,
): Promise<{ ok: true }> {
  const res = await fetch(`/api/warehouse/queue/${invoiceId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(await authHeader()),
    },
    body: JSON.stringify({ removed_from_queue: removed }),
  });
  return jsonOrThrow(res);
}

export async function cancelFulfillment(
  invoiceId: string,
): Promise<{ ok: true }> {
  const res = await fetch(`/api/warehouse/queue/${invoiceId}/cancel`, {
    method: 'POST',
    headers: await authHeader(),
  });
  return jsonOrThrow(res);
}

export async function saveChecklist(
  invoiceId: string,
  checked: string[],
): Promise<{ ok: true; handling_checklist: string[] }> {
  const res = await fetch(`/api/warehouse/queue/${invoiceId}/checklist`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(await authHeader()),
    },
    body: JSON.stringify({ handling_checklist: checked }),
  });
  return jsonOrThrow(res);
}

export async function fulfillLine(
  invoiceId: string,
  lineId: string,
  qty: number,
): Promise<{ ok: true; line: { id: string; qty_fulfilled: number } }> {
  const res = await fetch(`/api/warehouse/queue/${invoiceId}/line`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(await authHeader()),
    },
    body: JSON.stringify({ action: 'fulfill', line_id: lineId, qty }),
  });
  return jsonOrThrow(res);
}

export async function backorderLine(
  invoiceId: string,
  lineId: string,
  qty: number,
): Promise<{
  ok: true;
  line: { id: string; qty_backordered: number };
  backorder_invoice_id: string;
}> {
  const res = await fetch(`/api/warehouse/queue/${invoiceId}/line`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(await authHeader()),
    },
    body: JSON.stringify({ action: 'backorder', line_id: lineId, qty }),
  });
  return jsonOrThrow(res);
}

export async function uploadPackedPhoto(
  invoiceId: string,
  file: File,
): Promise<{ ok: true; photo: { url: string; path: string; uploaded_at: string } }> {
  const fd = new FormData();
  fd.append('photo', file);
  const res = await fetch(`/api/warehouse/queue/${invoiceId}/photo`, {
    method: 'POST',
    headers: await authHeader(),
    body: fd,
  });
  return jsonOrThrow(res);
}

export async function deletePackedPhoto(
  invoiceId: string,
  path: string,
): Promise<{ ok: true }> {
  const res = await fetch(
    `/api/warehouse/queue/${invoiceId}/photo?path=${encodeURIComponent(path)}`,
    {
      method: 'DELETE',
      headers: await authHeader(),
    },
  );
  return jsonOrThrow(res);
}

// Fetch the invoice's printer-ready HTML (the admin PDF endpoint allows the
// warehouse role). `download` appends ?download=1 so the page auto-opens the
// print dialog ("Save as PDF"). Returns the HTML string for the caller to open
// in a new tab via a blob URL.
export async function fetchInvoicePdfHtml(
  invoiceId: string,
  download = false,
): Promise<string> {
  const res = await fetch(
    `/api/admin/invoices/${invoiceId}/pdf${download ? '?download=1' : ''}`,
    { headers: await authHeader(), cache: 'no-store' },
  );
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = j.error || j.message || msg;
    } catch {}
    throw new Error(`${res.status} ${msg}`);
  }
  return res.text();
}

export async function previewNotification(
  invoiceId: string,
  details: ShipmentDetailsFields = {},
): Promise<NotificationPreview> {
  const params = new URLSearchParams({ preview: '1' });
  for (const [k, v] of Object.entries(details)) if (v) params.set(k, v);
  const res = await fetch(
    `/api/warehouse/queue/${invoiceId}/notify?${params.toString()}`,
    {
      headers: await authHeader(),
    },
  );
  return jsonOrThrow(res);
}

/**
 * Manually (re)send the Packing List PDF to the client shipment recipient.
 * The auto-send on Shipped runs server-side via after(), so this is the
 * "resend / correct address" affordance.
 */
export async function sendPackingList(
  invoiceId: string,
  overrides?: { to?: string; notes?: string },
): Promise<{
  ok: boolean;
  to?: string;
  message_id?: string | null;
  sent_at?: string;
  reason?: string;
  error?: string;
}> {
  const res = await fetch(`/api/warehouse/queue/${invoiceId}/packing-list`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(await authHeader()),
    },
    body: JSON.stringify(overrides ?? {}),
  });
  return jsonOrThrow(res);
}

export async function sendNotification(
  invoiceId: string,
  overrides?: { subject?: string; to?: string } & ShipmentDetailsFields,
): Promise<{
  ok: boolean;
  message_id: string | null;
  emailed_at: string | null;
  error?: string;
  admin_copy?: { sent: boolean; to: string[]; error?: string };
}> {
  const res = await fetch(`/api/warehouse/queue/${invoiceId}/notify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(await authHeader()),
    },
    body: JSON.stringify({ ...overrides }),
  });
  return jsonOrThrow(res);
}
