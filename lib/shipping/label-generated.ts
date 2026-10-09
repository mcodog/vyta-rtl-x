/**
 * What happens once a shipment's label exists, however it came to exist:
 * bought from the invoice page, the orders page, auto-bought on payment,
 * bought at creation, bought in the Easyship dashboard (arrives via the
 * webhook) or linked by the Easyship sync dialog.
 *
 *  1. The shipment is read back from Easyship and its record (tracking number
 *     and link, carrier and service, label, what it cost, the delivery
 *     estimate) is written onto the row that anchors it AND onto the invoice,
 *     so the invoice always carries its own copy of the shipment.
 *  2. The customer gets the "Your Order Has Shipped!" email, with the admin
 *     team copied (sendFulfillmentEmail does both) — once per invoice. An
 *     invoice already emailed by hand is left alone.
 *
 * Best-effort throughout: nothing here throws, and a failure never undoes the
 * label. A failed email releases its claim so the next label event retries it.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getEasyshipShipmentDetails,
  getShippingConfig,
  type EasyshipShipmentDetails,
} from '@/lib/easyship';
import { isMissingColumnError } from '@/lib/payments/puramass-columns';
import { todayInAppTz } from '@/lib/datetime';
import type { ShipmentAnchor } from '@/lib/shipping/auto-shipment';
import {
  coreShipmentPatch,
  estimatedDeliveryWindow,
  extendedShipmentPatch,
} from '@/lib/shipping/shipment-record';

export interface LabelGeneratedOptions {
  apiKey?: string;
  /** Already-fetched shipment, to skip the Easyship read. */
  details?: EasyshipShipmentDetails | null;
  /** Skip the shipped email (record sync only). */
  skipEmail?: boolean;
}

export interface LabelGeneratedResult {
  synced: boolean;
  invoiceIds: string[];
  email: 'sent' | 'already_sent' | 'not_ready' | 'skipped' | 'failed' | 'no_invoice';
  error?: string;
}

/** Sends nothing on anyone's behalf: the audit row reads as the system. */
const SYSTEM_ACTOR = {
  authorized: true,
  canSendEmails: true,
  role: 'admin' as const,
  actorId: null,
  actorEmail: null,
};

function anchorTable(anchor: ShipmentAnchor): 'orders' | 'invoices' {
  return anchor.kind === 'order' ? 'orders' : 'invoices';
}

/** Core patch, then the extended one on its own so missing columns can't sink the core. */
async function writeRecord(
  db: SupabaseClient,
  table: 'orders' | 'invoices',
  ids: string[],
  core: Record<string, unknown>,
  extended: Record<string, unknown>,
): Promise<void> {
  if (ids.length === 0) return;
  if (Object.keys(core).length > 0) {
    const { error } = await db.from(table).update(core).in('id', ids);
    if (error) {
      console.warn(`[label-generated] ${table} shipment write failed:`, error.message);
    }
  }
  const { error } = await db.from(table).update(extended).in('id', ids);
  if (error && !isMissingColumnError(error)) {
    console.warn(`[label-generated] ${table} shipment detail write failed:`, error.message);
  }
}

export async function onShipmentLabelGenerated(
  db: SupabaseClient,
  anchor: ShipmentAnchor,
  opts: LabelGeneratedOptions = {},
): Promise<LabelGeneratedResult> {
  const result: LabelGeneratedResult = { synced: false, invoiceIds: [], email: 'skipped' };
  try {
    const table = anchorTable(anchor);
    const { data: row } = await db
      .from(table)
      .select('id, easyship_shipment_id, label_state, label_url')
      .eq('id', anchor.id)
      .maybeSingle();
    if (!row) return { ...result, email: 'no_invoice' };

    // 1. Read the shipment back from Easyship.
    let details = opts.details ?? null;
    if (!details && row.easyship_shipment_id) {
      try {
        const apiKey = opts.apiKey ?? (await getShippingConfig(db)).apiKey;
        if (apiKey) details = await getEasyshipShipmentDetails(row.easyship_shipment_id, apiKey);
      } catch (e: any) {
        console.warn('[label-generated] Easyship shipment read failed:', e?.message ?? e);
      }
    }

    // The invoices this shipment belongs to: the anchor itself, or every
    // invoice raised against the order (oldest first — that one gets the email).
    let invoiceIds: string[] = [];
    if (anchor.kind === 'invoice') {
      invoiceIds = [anchor.id];
    } else {
      const { data: invs } = await db
        .from('invoices')
        .select('id')
        .eq('order_id', anchor.id)
        .order('created_at', { ascending: true });
      invoiceIds = (invs ?? []).map((i: any) => i.id);
    }
    result.invoiceIds = invoiceIds;

    // 2. Write the record onto the anchor and mirror it onto the invoice(s).
    if (details) {
      if (!details.easyship_shipment_id) {
        details = { ...details, easyship_shipment_id: row.easyship_shipment_id ?? '' };
      }
      const core = coreShipmentPatch(details);
      const extended = extendedShipmentPatch(details);
      const targets: Array<['orders' | 'invoices', string[]]> = [[table, [anchor.id]]];
      if (anchor.kind === 'order') targets.push(['invoices', invoiceIds]);
      for (const [t, ids] of targets) {
        await writeRecord(db, t, ids, core, extended);
        // First time the label is seen without an Easyship timestamp: stamp it
        // now, on rows that have none, so a later re-sync can't move it.
        if (details.label_state === 'generated' && ids.length > 0) {
          await db
            .from(t)
            .update({ label_generated_at: new Date().toISOString() })
            .in('id', ids)
            .is('label_generated_at', null);
        }
      }
      result.synced = true;
    } else if (anchor.kind === 'order' && invoiceIds.length > 0) {
      // Easyship unreachable — still give the invoice what the order knows.
      const { data: ord } = await db
        .from('orders')
        .select('easyship_shipment_id, easyship_courier_id, tracking_number, tracking_url, carrier, label_url, label_state')
        .eq('id', anchor.id)
        .maybeSingle();
      if (ord) {
        const core: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(ord)) if (v != null && v !== '') core[k] = v;
        await writeRecord(db, 'invoices', invoiceIds, core, {
          easyship_synced_at: new Date().toISOString(),
        });
      }
    }

    // 3. The shipped email — only once the label really exists.
    const labelReady =
      details?.label_state === 'generated' ||
      (!details && (row.label_state === 'generated' || !!row.label_url));
    if (!labelReady) return { ...result, email: 'not_ready' };
    if (opts.skipEmail) return result;
    if (invoiceIds.length === 0) return { ...result, email: 'no_invoice' };

    const emailed = await sendShippedEmailOnce(db, invoiceIds[0], details);
    return { ...result, ...emailed };
  } catch (e: any) {
    console.error('[label-generated] failed:', e?.message ?? e);
    return { ...result, email: 'failed', error: e?.message ?? 'unknown error' };
  }
}

/**
 * Claim the invoice's automatic shipped email, send it, and release the claim
 * if the send fails. The claim is one conditional UPDATE, so the webhook and
 * the buy-label route racing on the same label can't both send.
 */
async function sendShippedEmailOnce(
  db: SupabaseClient,
  invoiceId: string,
  details: EasyshipShipmentDetails | null,
): Promise<Pick<LabelGeneratedResult, 'email' | 'error'>> {
  const { data: inv } = await db
    .from('invoices')
    .select('id, fulfillment_type, shipped_emailed_at')
    .eq('id', invoiceId)
    .maybeSingle();
  if (!inv) return { email: 'no_invoice' };
  if (inv.fulfillment_type === 'pickup') return { email: 'skipped' };
  if (inv.shipped_emailed_at) return { email: 'already_sent' };

  const claimedAt = new Date().toISOString();
  let claimed = false;
  const claim = await db
    .from('invoices')
    .update({ shipped_email_auto_claimed_at: claimedAt })
    .eq('id', invoiceId)
    .is('shipped_emailed_at', null)
    .is('shipped_email_auto_claimed_at', null)
    .select('id');
  if (claim.error) {
    // Before easyship-label-sync-migration.sql there is no claim column:
    // fall back to the shipped_emailed_at check above.
    if (!isMissingColumnError(claim.error)) {
      return { email: 'failed', error: claim.error.message };
    }
  } else if (!claim.data || claim.data.length === 0) {
    return { email: 'already_sent' };
  } else {
    claimed = true;
  }

  const window = details
    ? estimatedDeliveryWindow(todayInAppTz(), details.min_delivery_days, details.max_delivery_days)
    : null;

  // Imported lazily: lib/warehouse/server pulls in nodemailer and the order
  // email loaders, which the label paths shouldn't load until they send.
  const { sendFulfillmentEmail } = await import('@/lib/warehouse/server');
  const sent = await sendFulfillmentEmail(db, SYSTEM_ACTOR, invoiceId, {
    details: {
      trackingNumber: details?.tracking_number ?? null,
      carrier: details?.carrier ?? null,
      trackingUrl: details?.tracking_url ?? null,
      deliveryFrom: window?.deliveryFrom ?? null,
      deliveryTo: window?.deliveryTo ?? null,
    },
    trigger: 'automatically when the Easyship label was generated',
  });

  if (!sent.ok) {
    if (claimed) {
      await db
        .from('invoices')
        .update({ shipped_email_auto_claimed_at: null })
        .eq('id', invoiceId)
        .eq('shipped_email_auto_claimed_at', claimedAt);
    }
    console.error(`[label-generated] shipped email for invoice ${invoiceId} failed:`, sent.error);
    return { email: 'failed', error: sent.error };
  }
  return { email: 'sent' };
}
