import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getShippingConfig,
  fetchEasyshipRates,
  isAllowedCourier,
  createEasyshipShipment,
  buyEasyshipLabel,
  parcelQuantity,
  type ShippingConfig,
} from '@/lib/easyship';
import type { EasyshipRateRequest, EasyshipHandover } from '@/lib/types/ecommerce';
import {
  resolveInvoiceDestination,
  type InvoiceRowForDestination,
} from '@/lib/shipping/invoice-destination';
import { isMissingColumnError } from '@/lib/payments/puramass-columns';
import {
  COURIER_PREFERENCES,
  DEFAULT_COURIER_PREFERENCE,
  pickCourier,
  type CourierPreference,
} from '@/lib/shipping/courier-pick';
import { onShipmentLabelGenerated } from '@/lib/shipping/label-generated';

export type { CourierPreference };

/**
 * Narrow an untrusted client value to a CourierPreference. Anything else
 * (including undefined/null) returns undefined so the caller falls back to the
 * site-wide preference instead of silently shipping with a bogus carrier.
 */
export function normalizeCourierPreference(value: unknown): CourierPreference | undefined {
  const v = typeof value === 'string' ? value.toLowerCase().replace(/[\s-]+/g, '_') : '';
  return COURIER_PREFERENCES.includes(v as CourierPreference)
    ? (v as CourierPreference)
    : undefined;
}

// Sane non-zero floor (kg) so a quote/shipment never goes out at 0kg, which
// EasyShip rejects. Kept low so it doesn't alter existing single-item quotes.
export const MIN_SHIPMENT_WEIGHT_KG = 0.05;

/**
 * Quantity-scaled shipment weight. Shared by the storefront rate quote
 * (`/api/shipping/rates`) and the actual shipment created here so the quoted
 * rate and the purchased label are computed from the SAME weight.
 *
 * `baseWeight` is the per-unit weight (`unitWeightKg(cfg)`); it is
 * multiplied by the total item quantity (min factor 1) and floored at a sane
 * minimum. Items may carry `quantity` (order/cart items) or `qty`.
 */
export function computeScaledWeight(
  items: Array<{ quantity?: number; qty?: number }> | null | undefined,
  baseWeight: number,
): number {
  const itemQty = (items ?? []).reduce(
    (s, i) => s + (Number(i.quantity) || Number(i.qty) || 0),
    0,
  );
  const itemFactor = Math.max(1, itemQty);
  const base = baseWeight > 0 ? baseWeight : 0.5;
  return Math.max(base * itemFactor, MIN_SHIPMENT_WEIGHT_KG);
}

/**
 * Per-unit parcel weight (kg): Settings → Default parcel "Per-vial weight",
 * else the configured box weight, else 0.05.
 */
export function unitWeightKg(cfg: Pick<ShippingConfig, 'itemWeightKg' | 'box'>): number {
  const configured = Number(cfg.itemWeightKg) || Number(cfg.box?.weight) || 0;
  return configured > 0 ? configured : MIN_SHIPMENT_WEIGHT_KG;
}

export interface AutoShipmentSettings {
  autoCreate: boolean;
  courierPreference: CourierPreference;
  autoBuyLabel: boolean;
}

export async function getAutoShipmentSettings(
  db: SupabaseClient,
): Promise<AutoShipmentSettings> {
  try {
    const { data } = await db
      .from('site_settings')
      .select('easyship_auto_create_shipment, easyship_auto_buy_label')
      .limit(1)
      .maybeSingle();
    return {
      autoCreate: !!data?.easyship_auto_create_shipment,
      // Shipping is free and the buyer never sees or picks a rate, so every
      // shipment nobody chose a service for books the best value: the
      // cheapest UPS / Canada Post service that arrives within 2 days.
      // (easyship_auto_courier_preference is no longer read — its column
      // default was 'cheapest', which would book slow services.)
      courierPreference: DEFAULT_COURIER_PREFERENCE,
      autoBuyLabel: !!data?.easyship_auto_buy_label,
    };
  } catch {
    return { autoCreate: false, courierPreference: DEFAULT_COURIER_PREFERENCE, autoBuyLabel: false };
  }
}

// ---------- Logging primitives (never throw) ----------

/**
 * What a shipment hangs off.
 *
 * An `order` for anything that came through the storefront or was raised as an
 * order in this admin. An `invoice` for the ones that have no order behind them
 * — Stealth Health hand-offs above all, which are materialised
 * straight into `invoices` and keep their ship-to on the hand-off ledger (see
 * lib/shipping/invoice-destination.ts).
 *
 * `invoices` carries the same shipment column names as `orders`
 * (easyship-invoice-shipment-migration.sql), so every write below is
 * table-agnostic and the two paths can't drift.
 */
export type ShipmentAnchor =
  | { kind: 'order'; id: string }
  | { kind: 'invoice'; id: string };

/** First value that is a non-blank string, else null. */
function firstNonBlank(...values: Array<string | null | undefined>): string | null {
  for (const v of values) {
    const t = typeof v === 'string' ? v.trim() : '';
    if (t) return t;
  }
  return null;
}

function anchorTable(anchor: ShipmentAnchor): 'orders' | 'invoices' {
  return anchor.kind === 'order' ? 'orders' : 'invoices';
}

async function recordAttempt(
  db: SupabaseClient,
  anchor: ShipmentAnchor,
  stage: string,
  status: 'success' | 'skipped' | 'failed',
  error?: string,
  courier?: string,
) {
  try {
    await db
      .from(anchorTable(anchor))
      .update({
        auto_shipment_status: status,
        auto_shipment_stage: stage,
        auto_shipment_error: error ?? null,
        auto_shipment_attempted_at: new Date().toISOString(),
      })
      .eq('id', anchor.id);
    // shipment_auto_logs columns: order_id, invoice_id, stage, ok, courier,
    // error. 'skipped' is a non-failure outcome, so it logs ok=true with the
    // reason in `error` for visibility on the admin feed. invoice_id is only
    // sent for an invoice-anchored attempt so an order log still writes on a
    // database where that column hasn't been added yet.
    await db.from('shipment_auto_logs').insert({
      ...(anchor.kind === 'order'
        ? { order_id: anchor.id }
        : { invoice_id: anchor.id }),
      stage,
      ok: status !== 'failed',
      courier: courier ?? null,
      error: error ?? null,
    });
  } catch {
    // intentional swallow — auto-shipment is best-effort
  }
}

// ---------- Auto-create shipment ----------

/** Destination in the shape `orders.shipping_address` uses. */
export interface ShipmentDestination {
  firstName?: string | null;
  lastName?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  phone?: string | null;
  email?: string | null;
}

interface OrderRowForShipment {
  id: string;
  easyship_shipment_id: string | null;
  fulfillment_type: string | null;
  shipping_address: any;
  // Order line items (JSONB). Drives the quantity-scaled shipment weight so the
  // label matches the storefront quote. Optional — fetched from the order row
  // when a caller's select didn't include it.
  items?: Array<{ quantity?: number; qty?: number }> | null;
  // Used for the Easyship destination contact email + declared customs value
  // (both required, customs value must be > 0). Optional — callers pass when
  // available; sensible fallbacks apply otherwise.
  email?: string | null;
  total?: number | string | null;
  // Courier chosen for this order (customer at checkout / admin pick). Used as
  // the courier_service_id at shipment creation when no explicit override is
  // passed to autoCreateShipmentForOrder.
  easyship_courier_id?: string | null;
}

export interface AutoShipmentOptions {
  /** Override the courier picked at checkout / preference. */
  courierIdOverride?: string;
  /**
   * Courier preference for this shipment only, overriding the site-wide
   * best-value default. Used when the admin picked a carrier (UPS / Canada
   * Post / cheapest) without a specific live rate.
   */
  courierPreference?: CourierPreference;
  /** Purchase Easyship parcel insurance (default false). */
  insured?: boolean;
  /** Handover method: dropoff (default), collection, or free_collection. */
  handover?: EasyshipHandover;
  /** Buy the label immediately after the shipment is created (charges wallet). */
  buyLabel?: boolean;
}

/** Everything the shared creation path needs, whatever it hangs off. */
interface ShipmentSubject {
  anchor: ShipmentAnchor;
  existingShipmentId: string | null;
  fulfillmentType: string | null;
  destination: ShipmentDestination | null;
  /** Why there is no destination, logged as the skip reason. */
  destinationReason?: string | null;
  /** Quantity-bearing lines; drives the scaled parcel weight. */
  items: Array<{ quantity?: number; qty?: number }>;
  /** Contact email fallback for the Easyship destination. */
  email: string | null;
  /** Contact phone on the record, when the address itself carries none. */
  phone?: string | null;
  /** Contact name on the record, when the address itself carries none. */
  contactName?: string | null;
  /** Order total. Not declared to Easyship — every unit is declared at 1. */
  total: number | string | null;
  /** Courier already chosen for this parcel (customer's checkout pick). */
  storedCourierId: string | null;
}

/**
 * Create the Easyship shipment for a subject and write it back onto whichever
 * table anchors it. Shared by the order and invoice paths so a fix to the
 * courier choice, the parcel or the label buy lands on both.
 */
async function createShipmentForSubject(
  db: SupabaseClient,
  subject: ShipmentSubject,
  force: boolean,
  opts: AutoShipmentOptions,
): Promise<void> {
  const { anchor } = subject;
  const table = anchorTable(anchor);
  try {
    if (subject.existingShipmentId) {
      await recordAttempt(db, anchor, 'create', 'skipped', 'already has shipment');
      return;
    }
    if (subject.fulfillmentType === 'pickup') {
      await recordAttempt(db, anchor, 'create', 'skipped', 'pickup');
      return;
    }
    const settings = await getAutoShipmentSettings(db);
    if (!settings.autoCreate && !force) {
      await recordAttempt(db, anchor, 'create', 'skipped', 'autoCreate=off');
      return;
    }
    const dest = subject.destination;
    if (!dest?.postalCode) {
      await recordAttempt(
        db,
        anchor,
        'create',
        'skipped',
        subject.destinationReason ?? 'no postal',
      );
      return;
    }
    const cfg = await getShippingConfig(db);
    if (!cfg.enabled || !cfg.apiKey) {
      await recordAttempt(db, anchor, 'create', 'skipped', 'easyship disabled');
      return;
    }

    // The parcel: the real unit count, each at the configured per-unit
    // weight. The quote and the shipment are built from the same numbers, so
    // the service picked on price is bought at that price. Box sides left
    // blank in Settings go out as 1 cm (lib/easyship.ts parcelDimensions).
    const units = parcelQuantity(subject.items);
    const unitWeight = unitWeightKg(cfg);
    const scaledWeight = computeScaledWeight(subject.items, unitWeight);

    const ratePayload: EasyshipRateRequest = {
      origin_country_alpha2: cfg.origin.country_alpha2 || 'CA',
      origin_postal_code: cfg.origin.postal_code || '',
      // Easyship's 2024-09 rates endpoint requires origin city + state and
      // destination state for US/CA (422 "can't be blank" otherwise). These
      // come from Settings → shipping origin and the parcel's destination.
      origin_city: cfg.origin.city || '',
      origin_state: cfg.origin.state || '',
      destination_country_alpha2: dest.country?.length === 2 ? dest.country : 'CA',
      destination_postal_code: dest.postalCode,
      destination_city: dest.city ?? '',
      destination_state: dest.state ?? '',
      total_actual_weight: scaledWeight,
      quantity: units,
      boxes: [
        {
          length: cfg.box.length ?? 0,
          width: cfg.box.width ?? 0,
          height: cfg.box.height ?? 0,
          weight: scaledWeight,
        },
      ],
    };

    // Easyship rejects a shipment whose destination contact is incomplete, and
    // it does so with a 422 the admin has to decode. Resolve the same
    // fallbacks it would need, then say plainly what is still missing rather
    // than letting the raw error be the answer.
    //
    // The phone falls back to the house number from Settings → shipping
    // origin: an address that reached us without one (a Stealth Health hand-off
    // reports whatever the buyer typed) still needs a number a courier can
    // call, and that is the one we already send as the sender's.
    const destinationPhone = firstNonBlank(dest.phone, subject.phone, cfg.origin.phone);
    const destinationName =
      firstNonBlank([dest.firstName, dest.lastName].filter(Boolean).join(' '), subject.contactName);
    const missing = [
      !firstNonBlank(dest.address) ? 'street address' : null,
      !firstNonBlank(dest.city) ? 'city' : null,
      !destinationName ? 'contact name' : null,
      !destinationPhone
        ? 'contact phone (and no house number in Settings → shipping origin)'
        : null,
    ].filter(Boolean);
    if (missing.length > 0) {
      await recordAttempt(
        db,
        anchor,
        'create',
        'skipped',
        `destination is missing: ${missing.join(', ')}`,
      );
      return;
    }

    const rates = (await fetchEasyshipRates(ratePayload, cfg.apiKey)).filter(
      isAllowedCourier,
    );
    // Courier is chosen BEFORE creation: an explicit service override (admin
    // picked a live rate) wins, then a per-shipment carrier preference (admin
    // picked UPS / Canada Post / cheapest without a live rate), then the
    // courier stored on the subject (customer's checkout choice), then best
    // value (cheapest service within 2 days). The chosen id is baked into the shipment via
    // courier_settings.courier_service_id.
    const chosenCourierId =
      opts.courierIdOverride ||
      (opts.courierPreference ? null : subject.storedCourierId) ||
      null;
    let pick: { courier_id: string; courier_name: string } | null = null;
    // A stored choice only stands while it is still a UPS / Canada Post
    // service on this lane; an admin's explicit pick always stands.
    const chosenRate = chosenCourierId
      ? rates.find((r) => r.courier_id === chosenCourierId)
      : undefined;
    if (chosenCourierId && (chosenRate || opts.courierIdOverride)) {
      pick = chosenRate ?? { courier_id: chosenCourierId, courier_name: '' };
    } else {
      if (rates.length === 0) {
        await recordAttempt(db, anchor, 'rate', 'failed', 'no allowed couriers');
        return;
      }
      pick = pickCourier(rates, opts.courierPreference ?? settings.courierPreference);
    }
    if (!pick) {
      await recordAttempt(db, anchor, 'rate', 'failed', 'no preferred courier');
      return;
    }

    const result = await createEasyshipShipment(
      {
        order_id: anchor.id,
        selected_courier_id: pick.courier_id,
        insured: opts.insured,
        handover: opts.handover,
        origin: {
          name: cfg.origin.name ?? '',
          company: cfg.origin.company ?? cfg.origin.name ?? '',
          phone: cfg.origin.phone ?? '',
          email: cfg.origin.email ?? '',
          address: cfg.origin.address ?? '',
          city: cfg.origin.city ?? '',
          state: cfg.origin.state ?? '',
          postal_code: cfg.origin.postal_code ?? '',
          country_alpha2: cfg.origin.country_alpha2 ?? 'CA',
        },
        destination: {
          // Split back into the two fields the request shape wants; Easyship
          // joins them into contact_name.
          firstName: firstNonBlank(dest.firstName) ?? destinationName!.split(' ')[0],
          lastName:
            firstNonBlank(dest.lastName) ??
            (firstNonBlank(dest.firstName) ? '' : destinationName!.split(' ').slice(1).join(' ')),
          address: dest.address ?? '',
          city: dest.city ?? '',
          state: dest.state ?? '',
          postalCode: dest.postalCode,
          country: dest.country ?? '',
          country_alpha2: dest.country?.length === 2 ? dest.country : 'CA',
          phone: destinationPhone ?? undefined,
          // Easyship requires a valid contact email; fall back to the
          // subject's email then the sender email when the address has none.
          email: dest.email || subject.email || cfg.origin.email || '',
        },
        parcels: [
          {
            // One supplements line: the real unit count at the per-unit
            // weight, declared at 1 per unit (createEasyshipShipment fixes the
            // category and value). Same numbers as the quote above.
            quantity: units,
            actual_weight: scaledWeight / units,
            height: cfg.box.height,
            width: cfg.box.width,
            length: cfg.box.length,
            declared_currency: 'CAD',
          },
        ],
      },
      cfg.apiKey,
    );

    await db
      .from(table)
      .update({
        easyship_shipment_id: result.easyship_shipment_id,
        easyship_courier_id: pick.courier_id,
        tracking_number: result.tracking_number,
        carrier: result.courier_name || pick.courier_name || undefined,
        label_url: result.label_url ?? null,
        // Draft shipment — no label bought yet.
        label_state: result.label_url ? 'generated' : 'not_created',
      })
      .eq('id', anchor.id);

    await recordAttempt(db, anchor, 'create', 'success', undefined, pick.courier_name);

    // Some accounts buy the label at creation. Treat that like any other
    // label: mirror the shipment onto the invoice and send the shipped email.
    if (result.label_url) {
      await onShipmentLabelGenerated(db, anchor, { apiKey: cfg.apiKey });
    }

    // Optionally buy the label right away. Charges the Easyship wallet, so
    // the invoice route only forwards buyLabel=true when the admin explicitly
    // opted in. Best-effort — errors log to shipment_auto_logs and don't
    // roll back the shipment.
    if (opts.buyLabel && result.easyship_shipment_id) {
      await buyLabelForAnchor(db, anchor, result.easyship_shipment_id, cfg.apiKey);
    }
  } catch (e: any) {
    await recordAttempt(
      db,
      anchor,
      'create',
      'failed',
      e?.message ?? 'unknown error',
    );
  }
}

/**
 * Buy the label for an already-created shipment and write the result back onto
 * its anchor. Never throws — a failed purchase is logged and left for the
 * admin to retry.
 */
async function buyLabelForAnchor(
  db: SupabaseClient,
  anchor: ShipmentAnchor,
  shipmentId: string,
  apiKey?: string,
): Promise<void> {
  try {
    const label = await buyEasyshipLabel(shipmentId, apiKey);
    await db
      .from(anchorTable(anchor))
      .update({
        label_state: label.state,
        label_url: label.url,
        tracking_number: label.tracking_number ?? undefined,
        carrier: label.carrier ?? undefined,
      })
      .eq('id', anchor.id);
    await recordAttempt(db, anchor, 'buy-label', 'success');
    // Label in hand → mirror the shipment onto the invoice and email the
    // customer + admins. A label still generating is finished by the webhook,
    // which runs the same step.
    if (label.state === 'generated') {
      await onShipmentLabelGenerated(db, anchor, { apiKey });
    }
  } catch (e: any) {
    await recordAttempt(db, anchor, 'buy-label', 'failed', e?.message ?? 'unknown');
  }
}

export async function autoCreateShipmentForOrder(
  db: SupabaseClient,
  order: OrderRowForShipment,
  force = false,
  optsOrCourierId?: string | AutoShipmentOptions,
): Promise<void> {
  // Back-compat: earlier callers passed the courier id string as the 4th arg.
  const opts: AutoShipmentOptions =
    typeof optsOrCourierId === 'string'
      ? { courierIdOverride: optsOrCourierId }
      : (optsOrCourierId ?? {});

  // Fetch the order's items if the caller didn't select them (the admin
  // create-shipment route selects a narrow column set).
  let items = order.items;
  if (!Array.isArray(items)) {
    try {
      const { data: itemsRow } = await db
        .from('orders')
        .select('items')
        .eq('id', order.id)
        .maybeSingle();
      items = Array.isArray(itemsRow?.items) ? (itemsRow!.items as any) : [];
    } catch {
      items = [];
    }
  }

  await createShipmentForSubject(
    db,
    {
      anchor: { kind: 'order', id: order.id },
      existingShipmentId: order.easyship_shipment_id,
      fulfillmentType: order.fulfillment_type,
      destination: order.shipping_address ?? null,
      items: items ?? [],
      email: order.email ?? null,
      total: order.total ?? null,
      storedCourierId: order.easyship_courier_id ?? null,
    },
    force,
    opts,
  );
}

/**
 * Create the Easyship shipment for an invoice that has no order behind it.
 *
 * This is what makes Stealth Health hand-offs shippable: the
 * destination comes from the hand-off ledger (or the drop-ship client, or the
 * customer profile — see resolveInvoiceDestination), the weight from the
 * invoice's own lines, and the shipment is written back onto the invoice.
 *
 * An invoice that IS bound to an order delegates to the order path, so a
 * parcel can never end up with two shipments.
 */
export async function autoCreateShipmentForInvoice(
  db: SupabaseClient,
  invoiceId: string,
  force = false,
  opts: AutoShipmentOptions = {},
): Promise<void> {
  const anchor: ShipmentAnchor = { kind: 'invoice', id: invoiceId };
  try {
    const { data: invoice, error: invErr } = await db
      .from('invoices')
      .select(
        'id, order_id, source, fulfillment_type, easyship_shipment_id, easyship_courier_id, customer_id, customer_name, customer_email, customer_phone, ships_to_client, client_id, total',
      )
      .eq('id', invoiceId)
      .maybeSingle();
    // This select is also the pre-flight for the shipment columns: if they
    // aren't there, stop BEFORE calling Easyship, or the shipment would be
    // created in their system with nowhere here to record it.
    if (invErr) {
      if (isMissingColumnError(invErr)) {
        await recordAttempt(
          db,
          anchor,
          'create',
          'skipped',
          'invoice shipment columns missing — run easyship-invoice-shipment-migration.sql',
        );
      }
      return;
    }
    if (!invoice) return;

    // Order-bound invoices stay on the order path — that row owns the parcel.
    if (invoice.order_id) {
      const { data: order } = await db
        .from('orders')
        .select(
          'id, easyship_shipment_id, easyship_courier_id, fulfillment_type, shipping_address, email, total',
        )
        .eq('id', invoice.order_id)
        .maybeSingle();
      if (order) {
        await autoCreateShipmentForOrder(db, order as OrderRowForShipment, force, opts);
      }
      return;
    }

    const { destination, reason } = await resolveInvoiceDestination(
      db,
      invoice as InvoiceRowForDestination,
    );

    const { data: lines } = await db
      .from('invoice_line_items')
      .select('qty')
      .eq('invoice_id', invoiceId);

    await createShipmentForSubject(
      db,
      {
        anchor,
        existingShipmentId: (invoice as any).easyship_shipment_id ?? null,
        fulfillmentType: invoice.fulfillment_type ?? null,
        destination,
        destinationReason: reason,
        items: (lines ?? []).map((l: any) => ({ qty: Number(l.qty) || 0 })),
        email: destination?.email ?? invoice.customer_email ?? null,
        phone: destination?.phone ?? invoice.customer_phone ?? null,
        contactName: invoice.customer_name ?? null,
        total: invoice.total ?? null,
        storedCourierId: (invoice as any).easyship_courier_id ?? null,
      },
      force,
      opts,
    );
  } catch (e: any) {
    await recordAttempt(db, anchor, 'create', 'failed', e?.message ?? 'unknown error');
  }
}

// ---------- Auto-buy label on invoice paid ----------

export async function autoBuyLabelForPaidInvoice(
  db: SupabaseClient,
  invoiceId: string,
): Promise<void> {
  try {
    const settings = await getAutoShipmentSettings(db);
    if (!settings.autoBuyLabel) return;
    const { data: inv } = await db
      .from('invoices')
      .select('id, order_id, fulfillment_type, easyship_shipment_id, label_state')
      .eq('id', invoiceId)
      .maybeSingle();
    if (!inv) return;
    if (inv.fulfillment_type === 'pickup') return;

    // Where the shipment actually lives: the linked order, or the invoice
    // itself for a hand-off that never had one.
    let anchor: ShipmentAnchor;
    let shipmentId: string | null;
    let labelState: string | null;
    if (inv.order_id) {
      const { data: ord } = await db
        .from('orders')
        .select('id, easyship_shipment_id, label_state')
        .eq('id', inv.order_id)
        .maybeSingle();
      if (!ord) return;
      anchor = { kind: 'order', id: ord.id };
      shipmentId = ord.easyship_shipment_id ?? null;
      labelState = ord.label_state ?? null;
    } else {
      anchor = { kind: 'invoice', id: inv.id };
      shipmentId = (inv as any).easyship_shipment_id ?? null;
      labelState = (inv as any).label_state ?? null;
    }

    if (!shipmentId) return;
    if (labelState === 'generated') return;

    const cfg = await getShippingConfig(db);
    if (!cfg.enabled || !cfg.apiKey) return;

    await buyLabelForAnchor(db, anchor, shipmentId, cfg.apiKey);
  } catch {
    // swallow
  }
}
