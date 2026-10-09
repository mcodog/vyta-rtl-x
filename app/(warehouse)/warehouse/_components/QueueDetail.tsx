'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Ban,
  Camera,
  Check,
  ChevronRight,
  Download,
  FileText,
  ImageUp,
  Info,
  MapPin,
  Package,
  Send,
  Store,
  Tag,
  Trash2,
  Truck,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import {
  fulfillLine,
  backorderLine,
  cancelFulfillment,
  saveChecklist,
  updateFulfillmentStatus,
  uploadPackedPhoto,
  deletePackedPhoto,
  fetchInvoicePdfHtml,
  type FulfillmentStatus,
  type QueueItem,
} from '@/lib/warehouse/api';
import {
  currentStepIndex,
  formatWhen,
  isComplete,
  stepsFor,
} from '@/lib/warehouse/types';
import FulfillmentEmailModal from '@/components/FulfillmentEmailModal';
import { useViewer } from '../layout';

interface Props {
  item: QueueItem;
  onMutate: () => void;
}

const NEXT_STATUS: Record<FulfillmentStatus, FulfillmentStatus | null> = {
  pending: 'packed',
  packed: 'shipped', // overridden for pickup below
  shipped: null,
  picked_up: null,
  dropped_off: null,
};

const STATUS_LABEL_FOR: Record<FulfillmentStatus, string> = {
  pending: 'Mark as packed',
  packed: 'Mark as shipped',
  shipped: 'Shipped',
  picked_up: 'Picked up',
  dropped_off: 'Dropped off',
};

export default function QueueDetail({ item, onMutate }: Props) {
  const viewer = useViewer();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checklist, setChecklist] = useState<string[]>(item.handling_checklist);
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setChecklist(item.handling_checklist);
  }, [item.id, item.handling_checklist]);

  const steps = useMemo(() => stepsFor(item.fulfillment_type), [item.fulfillment_type]);
  const idx = currentStepIndex(item.fulfillment_type, item.fulfillment_status);
  const orderCancelled =
    item.status === 'cancelled' || item.order?.status === 'cancelled';
  // Materialised from a paid Stealth Health hosted-checkout order. Stealth Health owns
  // payment/shipping, so several normal invoice fields are intentionally blank.
  const stealthHealth = item.source === 'stealth_health';
  const STEALTH_HEALTH_TIP =
    'This order was placed through the Stealth Health hosted checkout. Stealth Health collects and owns the payment, shipping, and contact details — that’s why some fields are missing here.';

  // A shipment with no bought label yet. Auto-create at checkout can fail
  // (label_state 'not_created'/'failed'), leaving staff no way to ship.
  const isShipment = item.fulfillment_type === 'shipment';
  // Shipment fields, from whichever anchor carries them.
  const labelState = item.order?.label_state ?? item.shipment?.label_state ?? null;
  const labelUrl = item.order?.label_url ?? item.shipment?.label_url ?? null;
  const carrier = item.order?.carrier ?? item.shipment?.carrier ?? null;
  const trackingNumber =
    item.order?.tracking_number ?? item.shipment?.tracking_number ?? null;
  const labelFailed = labelState === 'failed';
  // A Stealth Health row has no order, and used to be unshippable here for
  // that reason alone. It can now anchor its own shipment, so the only bar is
  // that this is an uncancelled shipment invoice without a label yet.
  const needsLabel = isShipment && !orderCancelled && !item.has_label;
  const isAdmin = viewer.role === 'admin';

  // Manually (re)create the EasyShip shipment. Goes through the invoice
  // endpoint, which routes itself: an order-bound invoice still ships off its
  // order, and one without an order (a Stealth Health hand-off) ships to the address
  // the partner reported onto the ledger. force=true inside, so the
  // auto-create toggle is bypassed. That route is admin-gated, so
  // warehouse-only staff get a clear hint instead of a button.
  const createShipment = async () => {
    setBusy('shipment');
    setError(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      const res = await fetch(`/api/admin/invoices/${item.id}/create-shipment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        let msg = res.statusText;
        try {
          const j = await res.json();
          msg = j.error || msg;
        } catch {}
        throw new Error(`${res.status} ${msg}`);
      }
      const data = await res.json();
      // The helper is best-effort and returns 200 even when creation fails;
      // surface the reason so staff know it still needs attention.
      if (!data?.shipment?.easyship_shipment_id) {
        setError(
          data?.shipment?.auto_shipment_error
            ? `Shipment not created: ${data.shipment.auto_shipment_error}`
            : 'Shipment could not be created — check EasyShip settings and the shipping address.',
        );
      }
      onMutate();
    } catch (e: any) {
      setError(e.message || 'Failed to create shipment');
    } finally {
      setBusy(null);
    }
  };

  // Open the invoice's printer-ready page in a new tab (view) or with the print
  // dialog primed for "Save as PDF" (download).
  const openInvoice = async (download: boolean) => {
    setBusy(download ? 'invoice-download' : 'invoice-view');
    setError(null);
    try {
      const html = await fetchInvoicePdfHtml(item.id, download);
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 15_000);
    } catch (e: any) {
      setError(e.message || 'Could not load invoice');
    } finally {
      setBusy(null);
    }
  };

  const advance = async () => {
    let next = NEXT_STATUS[item.fulfillment_status];
    if (item.fulfillment_type === 'pickup' && item.fulfillment_status === 'packed') {
      next = 'picked_up';
    }
    if (!next) return;
    setBusy('advance');
    setError(null);
    try {
      await updateFulfillmentStatus(item.id, next);
      onMutate();
    } catch (e: any) {
      setError(e.message || 'Failed to advance');
    } finally {
      setBusy(null);
    }
  };

  const toggleChecklist = async (key: string) => {
    const next = checklist.includes(key)
      ? checklist.filter((k) => k !== key)
      : [...checklist, key];
    setChecklist(next);
    setBusy('checklist');
    try {
      await saveChecklist(item.id, next);
      onMutate();
    } catch (e: any) {
      setError(e.message || 'Failed to save checklist');
      setChecklist(item.handling_checklist);
    } finally {
      setBusy(null);
    }
  };

  const onPhoto = async (file: File) => {
    setBusy('photo');
    setError(null);
    try {
      await uploadPackedPhoto(item.id, file);
      onMutate();
    } catch (e: any) {
      setError(e.message || 'Failed to upload photo');
    } finally {
      setBusy(null);
      if (cameraRef.current) cameraRef.current.value = '';
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleCancel = async () => {
    setBusy('cancel');
    setError(null);
    try {
      await cancelFulfillment(item.id);
      setConfirmCancel(false);
      onMutate();
    } catch (e: any) {
      setError(e.message || 'Failed to cancel order');
    } finally {
      setBusy(null);
    }
  };

  const removePhoto = async (path: string) => {
    setBusy('photo');
    try {
      await deletePackedPhoto(item.id, path);
      onMutate();
    } catch (e: any) {
      setError(e.message || 'Failed to delete photo');
    } finally {
      setBusy(null);
    }
  };

  const handleLine = async (
    action: 'fulfill' | 'backorder',
    lineId: string,
    qty: number,
  ) => {
    setBusy(`line:${lineId}:${action}`);
    setError(null);
    try {
      if (action === 'fulfill') await fulfillLine(item.id, lineId, qty);
      else await backorderLine(item.id, lineId, qty);
      onMutate();
    } catch (e: any) {
      setError(e.message || `Failed to ${action} line`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="bg-white rounded-lg border border-line p-5 space-y-6">
      {/* Header */}
      <header className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-lg font-semibold text-ink break-words">
            {item.invoice_number}
          </h2>
          {stealthHealth && (
            <span
              title={STEALTH_HEALTH_TIP}
              className="inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider rounded-full px-2 py-0.5 bg-indigo-500/10 text-indigo-700"
            >
              Stealth Health
            </span>
          )}
        </div>
        <div className="text-sm text-ink-muted flex items-center gap-1.5">
          <span>
            {item.customer_name ?? '—'} · {item.customer_email ?? '—'}
          </span>
          {stealthHealth && !item.customer_name && (
            <span title={STEALTH_HEALTH_TIP} className="cursor-help inline-flex">
              <Info className="w-3.5 h-3.5 text-indigo-500" />
            </span>
          )}
        </div>
        {item.order && (
          <div className="text-xs text-ink-muted">
            Order {item.order.order_number} · {item.order.status}
          </div>
        )}
        {/* Shipment + label, from whichever row anchors the parcel: the order
            for a storefront sale, the invoice itself for a Stealth Health
            hand-off. Packing staff need the label state first, so it leads. */}
        {isShipment && (labelState || carrier || trackingNumber) && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                labelState === 'generated'
                  ? 'border-emerald-200 bg-emerald-500/10 text-emerald-700'
                  : labelState === 'failed'
                    ? 'border-red-200 bg-red-500/10 text-red-700'
                    : labelState === 'pending'
                      ? 'border-amber-200 bg-amber-500/10 text-amber-700'
                      : 'border-line bg-gray-500/10 text-ink-muted'
              }`}
            >
              <Tag className="w-3 h-3" />
              {labelState === 'generated'
                ? 'Label ready'
                : labelState === 'failed'
                  ? 'Label failed'
                  : labelState === 'pending'
                    ? 'Label pending'
                    : 'No label yet'}
            </span>
            {carrier && <span>{carrier}</span>}
            {trackingNumber && <span className="font-mono">{trackingNumber}</span>}
          </div>
        )}
        {stealthHealth && (
          <div className="flex items-start gap-2 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-800">
            <Info className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{STEALTH_HEALTH_TIP}</span>
          </div>
        )}
        <div>
          {/* Product labels — reflects the invoice's "Ship with labels" toggle. */}
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${
              item.with_labels
                ? 'bg-teal/10 text-teal-dark'
                : 'bg-gray-500/10 text-ink-muted'
            }`}
          >
            <Tag className="w-3 h-3" />
            {item.with_labels ? 'Ships with labels' : 'No labels'}
          </span>
        </div>
        {/* Action pills sit on their own wrapping row below the name so nothing
            gets squished on a narrow warehouse panel. */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <a
            href={labelUrl ?? undefined}
            target="_blank"
            rel="noreferrer"
            className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm ${
              item.has_label
                ? 'border-line text-teal-dark hover:border-teal'
                : 'border-line text-ink-muted pointer-events-none opacity-70'
            }`}
          >
            <Download className="w-4 h-4" />
            {item.has_label ? 'Download label' : 'No label'}
          </a>
          <button
            type="button"
            onClick={() => openInvoice(false)}
            disabled={busy === 'invoice-view'}
            className="inline-flex items-center gap-1.5 rounded-md border border-line text-sm text-ink-muted px-3 py-1.5 hover:border-teal disabled:opacity-60"
          >
            <FileText className="w-4 h-4" /> View invoice
          </button>
          <button
            type="button"
            onClick={() => openInvoice(true)}
            disabled={busy === 'invoice-download'}
            className="inline-flex items-center gap-1.5 rounded-md border border-line text-sm text-ink-muted px-3 py-1.5 hover:border-teal disabled:opacity-60"
          >
            <Download className="w-4 h-4" /> Download
          </button>
          {needsLabel &&
            (isAdmin ? (
              <button
                type="button"
                onClick={createShipment}
                disabled={busy === 'shipment'}
                className="inline-flex items-center gap-1.5 rounded-md border border-teal text-sm text-teal-dark px-3 py-1.5 hover:bg-teal/5 disabled:opacity-60"
              >
                <Truck className="w-4 h-4" />
                {busy === 'shipment'
                  ? 'Creating…'
                  : labelFailed
                    ? 'Retry shipment'
                    : 'Create shipment / buy label'}
              </button>
            ) : (
              <span
                className="inline-flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 text-amber-700 text-xs px-3 py-1.5"
                title="The shipping label was not created for this order. An admin needs to create the shipment from the admin invoice or orders screen."
              >
                <Truck className="w-4 h-4" />
                No label — needs admin to create shipment
              </span>
            ))}
        </div>
        {orderCancelled && (
          <div className="rounded-md border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
            This {item.order ? 'order' : 'invoice'} was cancelled. Fulfillment
            actions are disabled.
          </div>
        )}
      </header>

      {/* Ship to / pickup */}
      <section>
        <h3 className="text-xs uppercase tracking-wide text-ink-muted mb-2">
          {item.fulfillment_type === 'pickup' ? 'Fulfillment' : 'Ship to'}
        </h3>
        {item.fulfillment_type === 'pickup' ? (
          <div className="flex items-start gap-2 text-sm text-ink">
            <Store className="w-4 h-4 text-teal-dark mt-0.5 shrink-0" />
            <div>
              <div className="font-medium">In-store pickup</div>
              <div className="text-xs text-ink-muted">
                Customer collects this order — no shipping address.
              </div>
            </div>
          </div>
        ) : (
          <ShipToBlock
            address={item.order?.shipping_address ?? item.shipping_address ?? null}
            fallbackName={item.customer_name}
            isStealthHealth={stealthHealth}
            stealthHealthTip={STEALTH_HEALTH_TIP}
          />
        )}
      </section>

      {/* Stepper */}
      <section>
        <h3 className="text-xs uppercase tracking-wide text-ink-muted mb-3">
          Fulfillment ({item.fulfillment_type})
        </h3>
        <ol className="flex items-center gap-2">
          {steps.map((s, i) => (
            <React.Fragment key={s.key}>
              <li
                className={`flex-1 rounded-md border px-3 py-2 ${
                  i < idx
                    ? 'border-emerald-500/40 bg-emerald-500/5'
                    : i === idx
                      ? 'border-teal bg-teal/5'
                      : 'border-line'
                }`}
              >
                <div className="flex items-center gap-2">
                  {i < idx ? (
                    <Check className="w-4 h-4 text-emerald-600" />
                  ) : i === idx ? (
                    <ChevronRight className="w-4 h-4 text-teal-dark" />
                  ) : (
                    <div className="w-4 h-4 rounded-full border border-line" />
                  )}
                  <span className="text-sm font-medium text-ink">{s.label}</span>
                </div>
                <div className="text-xs text-ink-muted mt-0.5">{s.description}</div>
              </li>
              {i < steps.length - 1 && (
                <ChevronRight className="w-4 h-4 text-ink-muted" />
              )}
            </React.Fragment>
          ))}
        </ol>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {!orderCancelled && !isComplete(item.fulfillment_type, item.fulfillment_status) && (
            <button
              type="button"
              disabled={busy === 'advance'}
              onClick={advance}
              className="rounded-md bg-teal-dark text-white text-sm font-medium px-4 py-2 hover:bg-ocean disabled:opacity-60"
            >
              {STATUS_LABEL_FOR[item.fulfillment_status]}
            </button>
          )}
          {/* One customer email — "Your Order Has Shipped!" — once the
              shipment is packed (or further along). */}
          {!orderCancelled &&
            viewer.canSendEmails &&
            item.fulfillment_type === 'shipment' &&
            item.fulfillment_status !== 'pending' && (
              <button
                type="button"
                onClick={() => setNotifyOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-md border border-line text-sm text-ink-muted px-3 py-2 hover:border-teal"
              >
                <Send className="w-4 h-4" /> Send shipped email
                {item.shipped_emailed_at && (
                  <span className="text-[11px] text-emerald-600">· sent</span>
                )}
              </button>
            )}
          {!orderCancelled &&
            !isComplete(item.fulfillment_type, item.fulfillment_status) && (
              <button
                type="button"
                onClick={() => setConfirmCancel(true)}
                disabled={busy === 'cancel'}
                className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-red-200 text-sm text-red-600 px-3 py-2 hover:bg-red-50 disabled:opacity-60"
              >
                <Ban className="w-4 h-4" /> Cancel {item.order ? 'order' : 'invoice'}
              </button>
            )}
        </div>
      </section>

      {/* Checklist */}
      <section>
        <h3 className="text-xs uppercase tracking-wide text-ink-muted mb-2">
          Handling checklist
        </h3>
        <ul className="space-y-1">
          {steps.map((s) => (
            <li key={s.key}>
              <label className="flex items-start gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={checklist.includes(s.key)}
                  onChange={() => toggleChecklist(s.key)}
                  disabled={busy === 'checklist'}
                />
                <span>
                  <span className="font-medium">{s.label}</span>
                  <span className="text-ink-muted ml-1">{s.description}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </section>

      {/* Photos */}
      <section>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <h3 className="text-xs uppercase tracking-wide text-ink-muted">
            Packed photos ({item.packed_photos.length})
          </h3>
          <div className="flex items-center gap-2">
            {/* capture="environment" opens the rear camera directly on phones;
                on desktop it falls back to the file picker. */}
            <label
              className={`inline-flex items-center gap-1.5 rounded-md border border-line text-sm px-3 py-1.5 cursor-pointer hover:border-teal ${
                busy === 'photo' ? 'opacity-60 pointer-events-none' : 'text-teal-dark'
              }`}
            >
              <Camera className="w-4 h-4" /> Take photo
              <input
                ref={cameraRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                disabled={busy === 'photo'}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onPhoto(f);
                }}
              />
            </label>
            <label
              className={`inline-flex items-center gap-1.5 rounded-md border border-line text-sm px-3 py-1.5 cursor-pointer hover:border-teal ${
                busy === 'photo' ? 'opacity-60 pointer-events-none' : 'text-ink-muted'
              }`}
            >
              <ImageUp className="w-4 h-4" /> Upload
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                disabled={busy === 'photo'}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onPhoto(f);
                }}
              />
            </label>
          </div>
        </div>
        {item.packed_photos.length === 0 ? (
          <p className="text-xs text-ink-muted">No photos yet.</p>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {item.packed_photos.map((p) => (
              <div
                key={p.path}
                className="relative group rounded-md overflow-hidden border border-line aspect-square"
              >
                <img
                  src={p.url}
                  alt="packed"
                  className="w-full h-full object-cover"
                />
                <button
                  type="button"
                  onClick={() => removePhoto(p.path)}
                  className="absolute top-1 right-1 bg-white/90 rounded-full p-1 text-ink-muted opacity-0 group-hover:opacity-100"
                  title="Remove"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Line items */}
      <section>
        <h3 className="text-xs uppercase tracking-wide text-ink-muted mb-2">
          Line items
        </h3>
        <ul className="space-y-2">
          {item.line_items.map((l) => {
            const remaining = l.qty - l.qty_fulfilled - l.qty_backordered;
            return (
              <li
                key={l.id}
                className="rounded-md border border-line px-3 py-2 bg-white"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm text-ink truncate">{l.description}</div>
                    <div className="text-xs text-ink-muted">
                      qty {l.qty} · fulfilled {l.qty_fulfilled} · backordered{' '}
                      {l.qty_backordered} · remaining {remaining}
                    </div>
                  </div>
                </div>
                {!orderCancelled && remaining > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <LineActionInput
                      max={remaining}
                      label="Fulfill"
                      disabled={busy?.startsWith(`line:${l.id}`)}
                      onSubmit={(qty) => handleLine('fulfill', l.id, qty)}
                    />
                    <LineActionInput
                      max={remaining}
                      label="Backorder"
                      disabled={busy?.startsWith(`line:${l.id}`)}
                      onSubmit={(qty) => handleLine('backorder', l.id, qty)}
                      tone="muted"
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {/* Attribution */}
      <section className="text-xs text-ink-muted grid grid-cols-2 gap-2">
        <div>
          <div className="font-semibold text-ink">Packed</div>
          {item.packed_at
            ? `${item.packed_by_name ?? 'staff'} · ${formatWhen(item.packed_at)}`
            : '—'}
        </div>
        <div>
          <div className="font-semibold text-ink">Fulfilled</div>
          {item.fulfilled_at
            ? `${item.fulfilled_by_name ?? 'staff'} · ${formatWhen(item.fulfilled_at)}`
            : '—'}
        </div>
      </section>

      {error && (
        <div className="text-sm rounded-md border border-red-200 bg-red-50 text-red-700 px-3 py-2">
          {error}
        </div>
      )}

      {notifyOpen && (
        <FulfillmentEmailModal
          invoiceId={item.id}
          invoiceNumber={item.invoice_number}
          onClose={() => setNotifyOpen(false)}
          onSent={onMutate}
        />
      )}

      {confirmCancel && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4">
          <div className="bg-white rounded-lg w-full max-w-md border border-line">
            <div className="px-5 py-3 border-b border-line flex items-center gap-2">
              <Ban className="w-4 h-4 text-red-600" />
              <h3 className="font-semibold text-ink">
                Cancel {item.order ? 'order' : 'invoice'}
              </h3>
            </div>
            <div className="p-5 text-sm text-ink-muted space-y-2">
              <p>
                Cancel {item.order ? 'order' : 'invoice'}{' '}
                <span className="font-medium text-ink">
                  {item.order?.order_number ?? item.invoice_number}
                </span>
                ? It will move to the Cancelled tab and can no longer be
                fulfilled.
              </p>
              <p className="text-xs">
                Inventory that was already deducted is restocked from the
                admin refund flow, not here.
              </p>
            </div>
            <div className="px-5 py-3 border-t border-line flex items-center justify-end gap-2">
              <button
                onClick={() => setConfirmCancel(false)}
                disabled={busy === 'cancel'}
                className="text-sm text-ink-muted hover:text-ink px-3 py-1.5"
              >
                Keep {item.order ? 'order' : 'invoice'}
              </button>
              <button
                onClick={handleCancel}
                disabled={busy === 'cancel'}
                className="text-sm rounded-md bg-red-600 text-white px-4 py-1.5 hover:bg-red-700 disabled:opacity-60"
              >
                {busy === 'cancel'
                  ? 'Cancelling…'
                  : `Cancel ${item.order ? 'order' : 'invoice'}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Ship-to address block ----------

function ShipToBlock({
  address,
  fallbackName,
  isStealthHealth = false,
  stealthHealthTip,
}: {
  address: Record<string, unknown> | null;
  fallbackName: string | null;
  isStealthHealth?: boolean;
  stealthHealthTip?: string;
}) {
  const a = (address ?? {}) as Record<string, any>;
  const name =
    [a.firstName, a.lastName].filter(Boolean).join(' ').trim() ||
    fallbackName ||
    '';
  const cityLine = [a.city, a.state, a.postalCode].filter(Boolean).join(', ');
  const hasAddress = Boolean(
    a.address || a.address2 || a.city || a.state || a.postalCode || a.country,
  );

  if (!hasAddress) {
    // A Stealth Health order has no address by design — Stealth Health ships it — so
    // explain that instead of the usual "verify with the customer" warning.
    if (isStealthHealth) {
      return (
        <p
          className="flex items-start gap-1.5 text-sm text-ink-muted cursor-help"
          title={stealthHealthTip}
        >
          <Info className="w-4 h-4 text-indigo-500 shrink-0 mt-0.5" />
          Shipped by Stealth Health — no address on file here.
        </p>
      );
    }
    return (
      <p className="text-sm text-red-600">
        No shipping address on file for this order — verify with the customer
        before shipping.
      </p>
    );
  }

  return (
    <div className="flex items-start gap-2 text-sm text-ink">
      <MapPin className="w-4 h-4 text-teal-dark mt-0.5 shrink-0" />
      <address className="not-italic leading-relaxed">
        {name && <div className="font-medium">{name}</div>}
        {a.address && <div>{a.address}</div>}
        {a.address2 && <div>{a.address2}</div>}
        {cityLine && <div>{cityLine}</div>}
        {a.country && <div>{a.country}</div>}
        {a.phone && (
          <div className="text-xs text-ink-muted mt-0.5">{a.phone}</div>
        )}
      </address>
    </div>
  );
}

// ---------- Line action input ----------

function LineActionInput({
  max,
  label,
  onSubmit,
  disabled,
  tone = 'primary',
}: {
  max: number;
  label: string;
  onSubmit: (qty: number) => void;
  disabled?: boolean;
  tone?: 'primary' | 'muted';
}) {
  const [qty, setQty] = useState(max);
  return (
    <div className="inline-flex items-center gap-1">
      <input
        type="number"
        min={1}
        max={max}
        value={qty}
        onChange={(e) => setQty(Math.max(1, Math.min(max, Number(e.target.value))))}
        className="w-14 px-2 py-1 text-sm rounded border border-line"
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => onSubmit(qty)}
        className={`text-xs rounded px-2 py-1 ${
          tone === 'primary'
            ? 'bg-teal-dark text-white hover:bg-ocean'
            : 'border border-line text-ink-muted hover:border-teal'
        } disabled:opacity-60`}
      >
        {label}
      </button>
    </div>
  );
}
