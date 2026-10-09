// Types + step state machines shared by the warehouse portal UI, client
// wrappers, and server routes.

export type FulfillmentType = 'shipment' | 'pickup';
export type FulfillmentStatus = 'pending' | 'packed' | 'shipped' | 'picked_up' | 'dropped_off';
export type LabelState = 'not_created' | 'pending' | 'generated' | 'failed';

export interface QueueLineItem {
  id: string;
  description: string;
  qty: number;
  qty_fulfilled: number;
  qty_backordered: number;
  unit_price: number;
  line_total: number;
}

export interface PackedPhoto {
  url: string;
  path: string;
  uploaded_at: string;
}

export interface QueueOrderJoin {
  id: string;
  order_number: string;
  status: string;
  tracking_number: string | null;
  carrier: string | null;
  label_state: LabelState | null;
  label_url: string | null;
  shipping_address: Record<string, unknown> | null;
}

export interface QueueItem {
  id: string;
  invoice_number: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  /** Invoice origin. 'stealth_health' = materialised from a paid Stealth Health
   *  hosted-checkout order (fulfilment/shipping owned by Stealth Health). */
  source: string | null;
  status: string;
  fulfillment_type: FulfillmentType;
  fulfillment_status: FulfillmentStatus;
  non_payable: boolean;
  with_labels: boolean;
  removed_from_queue: boolean;
  handling_checklist: string[];
  packed_photos: PackedPhoto[];
  packed_at: string | null;
  packed_by: string | null;
  packed_by_name: string | null;
  fulfilled_at: string | null;
  fulfilled_by: string | null;
  fulfilled_by_name: string | null;
  packed_emailed_at: string | null;
  shipped_emailed_at: string | null;
  total: number;
  created_at: string;
  line_items: QueueLineItem[];
  order: QueueOrderJoin | null;
  /**
   * Ship-to for an invoice that has no `orders` row behind it. Today that is
   * the Stealth Health hand-off: the address lives on
   * `puramass_orders.shipping_address` and is copied here on read, in the
   * `orders.shipping_address` shape the queue renders.
   */
  shipping_address: Record<string, unknown> | null;
  /**
   * Easyship shipment anchored on the invoice itself, for the same rows that
   * have no `orders` row (Stealth Health hand-offs). Null when the invoice has
   * no shipment of its own — including on a database that hasn't run
   * easyship-invoice-shipment-migration.sql.
   */
  shipment: QueueInvoiceShipment | null;
  item_count: number;
  has_label: boolean;
}

/** The invoice-anchored half of `QueueOrderJoin`. */
export interface QueueInvoiceShipment {
  easyship_shipment_id: string | null;
  label_state: string | null;
  label_url: string | null;
  tracking_number: string | null;
  carrier: string | null;
}

export interface QueueSummary {
  toFulfill: number;
  packed: number;
  shipped: number;
  pickedUp: number;
  shipments: number;
  pickups: number;
}

export interface QueueViewer {
  role: 'admin' | 'warehouse' | null;
  can_send_emails: boolean;
}

export interface NotificationPreview {
  subject: string;
  /** Plain-text version of the email. */
  body: string;
  /** The branded email exactly as it will be sent. */
  html: string;
  to: string | null;
  defaults: { subject: string };
  /** Null on a shipped email means it goes out without a tracking number. */
  trackingNumber: string | null;
}

// ---------- Step state machines ----------

export interface FulfillmentStep {
  key: string;
  label: string;
  description: string;
  status: FulfillmentStatus;
}

export const SHIPMENT_STEPS: FulfillmentStep[] = [
  {
    key: 'verify',
    label: 'Verify',
    description: 'Confirm items, customer, and shipping address.',
    status: 'pending',
  },
  {
    key: 'pack',
    label: 'Pack',
    description: 'Pack the items; capture a packed photo.',
    status: 'packed',
  },
  {
    key: 'label',
    label: 'Label & ship',
    description: 'Attach the label and hand off to the carrier.',
    status: 'shipped',
  },
];

export const PICKUP_STEPS: FulfillmentStep[] = [
  {
    key: 'verify',
    label: 'Verify',
    description: 'Confirm items and customer.',
    status: 'pending',
  },
  {
    key: 'pack',
    label: 'Pack',
    description: 'Bag/box for pickup; capture a packed photo.',
    status: 'packed',
  },
  {
    key: 'handoff',
    label: 'Handoff',
    description: 'Customer arrived and received the order.',
    status: 'picked_up',
  },
];

export function stepsFor(type: FulfillmentType): FulfillmentStep[] {
  return type === 'pickup' ? PICKUP_STEPS : SHIPMENT_STEPS;
}

export function currentStepIndex(
  type: FulfillmentType,
  status: FulfillmentStatus,
): number {
  const steps = stepsFor(type);
  const idx = steps.findIndex((s) => s.status === status);
  return idx < 0 ? 0 : idx;
}

export function isComplete(
  type: FulfillmentType,
  status: FulfillmentStatus,
): boolean {
  if (type === 'pickup') return status === 'picked_up';
  return status === 'shipped';
}

const STATUS_LABELS: Record<FulfillmentStatus, string> = {
  pending: 'Pending',
  packed: 'Packed',
  shipped: 'Shipped',
  picked_up: 'Picked up',
  dropped_off: 'Dropped off',
};

export function statusLabel(status: FulfillmentStatus): string {
  return STATUS_LABELS[status] ?? status;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

// Forward-only status flow for the EasyShip webhook (Cluster 6 also uses).
export const ORDER_FLOW: ReadonlyArray<string> = [
  'pending',
  'received',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
];

export const TERMINAL_ORDER_STATUSES: ReadonlyArray<string> = ['cancelled', 'expired'];

export function advanceOrderForward(
  current: string,
  next: string | null,
): string | null {
  if (!next) return null;
  if (TERMINAL_ORDER_STATUSES.includes(current)) return null;
  const ci = ORDER_FLOW.indexOf(current);
  const ni = ORDER_FLOW.indexOf(next);
  if (ci < 0 || ni < 0) return null;
  return ni > ci ? next : null;
}
