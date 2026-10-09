/**
 * The Easyship webhook: where it lives, what it is subscribed to, and how an
 * incoming event is read.
 *
 * Pure (no server imports) so the admin settings page can show the URL and
 * the parser can be unit-tested. The route is app/api/webhooks/easyship.
 */

/**
 * The endpoint registered in Easyship → Connect → Webhooks. Hard-coded: it is
 * the production storefront, and the value to paste is the same everywhere.
 */
export const EASYSHIP_WEBHOOK_URL = 'https://www.vytabio.com/api/webhooks/easyship';

/** Every event type the endpoint is subscribed to in Easyship. */
export const EASYSHIP_WEBHOOK_EVENTS = [
  'shipment.label.created',
  'shipment.tracking.checkpoints.created',
  'shipment.tracking.status.changed',
  'shipment.cancelled',
  'shipment.label.failed',
  'shipment.warehouse.state.updated',
  'batch.started',
  'batch.finished',
  'batch.item.finished',
  'credit.balance.low',
  'courier.account.state.changed',
  'external.shipment.insured',
  'oauth.authorization.revoked',
  'transaction.record.create',
] as const;

/** The events that change a shipment we track. The rest are acknowledged and ignored. */
export const HANDLED_EASYSHIP_EVENTS = [
  'shipment.label.created',
  'shipment.label.failed',
  'shipment.tracking.status.changed',
  'shipment.tracking.checkpoints.created',
  'shipment.cancelled',
] as const;

export interface NormalizedCheckpoint {
  message: string;
  occurred_at: string;
  location: string | null;
  primary_status: string | null;
}

export interface ParsedEasyshipEvent {
  /** `event_type`, or null for a payload that doesn't name one. */
  eventType: string | null;
  /** False for account-level events (batches, credit, couriers, …). */
  handled: boolean;
  shipmentId: string | null;
  orderNumber: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  carrier: string | null;
  labelUrl: string | null;
  labelState: 'generated' | 'failed' | 'cancelled' | null;
  /** Delivery status — only from tracking events, never a label's status. */
  trackingStatus: string | null;
  checkpoints: NormalizedCheckpoint[] | null;
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

/**
 * Normalize Easyship checkpoint objects to the compact shape the admin UI
 * (timeline + map) consumes. Easyship supplies either a pre-joined `location`
 * or discrete city/state/country parts, and timestamps under `checkpoint_time`.
 */
export function normalizeCheckpoints(arr: unknown): NormalizedCheckpoint[] | null {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.map((c: any) => {
    const location =
      c?.location ||
      [c?.city, c?.state, c?.country_alpha2 ?? c?.country].filter(Boolean).join(', ');
    return {
      message: c?.message ?? '',
      occurred_at: c?.checkpoint_time ?? c?.occurred_at ?? '',
      location: location || null,
      primary_status: c?.primary_status ?? null,
    };
  });
}

/** The most recent checkpoint by timestamp. */
export function latestCheckpoint(cps: NormalizedCheckpoint[]): NormalizedCheckpoint | null {
  return (
    [...cps].sort(
      (a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime(),
    )[0] ?? null
  );
}

/**
 * Read an Easyship webhook body.
 *
 * Easyship wraps the subject of each event in a key named after it —
 * `label` for label events, `tracking_status` / `tracking_checkpoints` for
 * tracking events, `shipment` for the rest — beside `event_type` and
 * `resource_id`. Older and hand-sent payloads put the fields at the top level
 * or under `resource` / `data`, so every value is probed in each of those.
 */
export function parseEasyshipWebhook(payload: any): ParsedEasyshipEvent {
  const p = payload && typeof payload === 'object' ? payload : {};
  const eventType = str(p.event_type) ?? str(p.type) ?? str(p.event);
  const handled =
    eventType == null || (HANDLED_EASYSHIP_EVENTS as readonly string[]).includes(eventType);

  const sources: any[] = [
    p.label,
    p.tracking_status && typeof p.tracking_status === 'object' ? p.tracking_status : null,
    p.tracking_checkpoints && typeof p.tracking_checkpoints === 'object' && !Array.isArray(p.tracking_checkpoints)
      ? p.tracking_checkpoints
      : null,
    p.shipment,
    p.resource,
    p.data,
    p,
  ].filter((s) => s && typeof s === 'object');
  const pick = (...keys: string[]): string | null => {
    for (const s of sources) {
      for (const k of keys) {
        const v = str(s[k]);
        if (v) return v;
      }
    }
    return null;
  };

  const isLabelEvent = eventType?.startsWith('shipment.label.') ?? false;
  const isTrackingEvent = eventType?.startsWith('shipment.tracking.') ?? false;

  const labelUrl =
    pick('label_url') ??
    sources.map((s) => str(s.shipping_documents?.label_url)).find(Boolean) ??
    null;

  let labelState: ParsedEasyshipEvent['labelState'] = null;
  if (eventType === 'shipment.label.failed') labelState = 'failed';
  else if (eventType === 'shipment.cancelled') labelState = 'cancelled';
  else if (eventType === 'shipment.label.created' || labelUrl) labelState = 'generated';
  else if ((pick('label_state') ?? '').toLowerCase() === 'generated') labelState = 'generated';

  const checkpoints = normalizeCheckpoints(
    sources.map((s) => s.checkpoints ?? s.tracking?.checkpoints).find(Array.isArray) ??
      (Array.isArray(p.tracking_checkpoints) ? p.tracking_checkpoints : null),
  );

  // A label event's `status` is the label's ("generated"), not the parcel's.
  // Delivery status comes from tracking events, an explicit tracking_status
  // string, or the newest checkpoint.
  const explicitTracking = typeof p.tracking_status === 'string' ? str(p.tracking_status) : null;
  let trackingStatus: string | null = null;
  if (eventType === 'shipment.cancelled') trackingStatus = 'cancelled';
  else if (!isLabelEvent) {
    trackingStatus =
      explicitTracking ??
      pick('tracking_status', 'delivery_state') ??
      (isTrackingEvent || eventType == null ? pick('status') : null) ??
      (checkpoints ? latestCheckpoint(checkpoints)?.primary_status ?? null : null);
  }

  return {
    eventType,
    handled,
    shipmentId: pick('easyship_shipment_id', 'shipment_id') ?? (handled ? str(p.resource_id) : null),
    orderNumber: pick('platform_order_number', 'order_number'),
    trackingNumber: pick('tracking_number'),
    trackingUrl: pick('tracking_page_url', 'tracking_url'),
    carrier: pick('courier_name', 'carrier', 'courier_umbrella_name'),
    labelUrl,
    labelState,
    trackingStatus,
    checkpoints,
  };
}
