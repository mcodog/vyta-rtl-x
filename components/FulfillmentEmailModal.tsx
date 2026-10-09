'use client';

import React, { useEffect, useRef, useState } from 'react';
import { X, Send, Loader2, RotateCcw, Mail, AlertCircle, AlertTriangle, Truck } from 'lucide-react';
import {
  previewNotification,
  sendNotification,
  type NotificationPreview,
  type ShipmentDetailsFields,
} from '@/lib/warehouse/api';

const CARRIERS = ['Canada Post', 'UPS', 'FedEx', 'Purolator', 'DHL', 'USPS'];

const inputClass =
  'w-full px-3 py-2 bg-surface border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400/40';

export interface FulfillmentEmailModalProps {
  invoiceId: string;
  invoiceNumber?: string | null;
  /** Which template to send. */
  kind: 'packed' | 'shipped';
  /** Adapts the heading copy — 'Ready-for-pickup' vs 'Shipping notification'. */
  fulfillmentType?: 'shipment' | 'pickup';
  onClose: () => void;
  /** Called after a successful send so the caller can refresh state. */
  onSent?: (info: { message_id: string | null; emailed_at: string | null }) => void;
}

/**
 * The manual "Notify packed" / "Notify shipped" sender shared by the warehouse
 * queue detail pane and the admin dashboard's FulfillmentAlerts banner. On
 * open it fetches the server-rendered branded email (lib/fulfillment-email.ts,
 * filled from the invoice's order) and shows it exactly as the customer will
 * see it. The sender can change the recipient and subject; the body is the
 * template. Nothing is sent until they press Send.
 *
 * A shipped email also takes the shipment details — carrier, tracking number,
 * tracking link and estimated delivery — prefilled with whatever is on file.
 * Labels are often bought outside Easyship, so these are usually typed in.
 * They go into this email only (they aren't saved) and the preview follows
 * them as they're typed.
 */
export default function FulfillmentEmailModal({
  invoiceId,
  invoiceNumber,
  kind,
  fulfillmentType,
  onClose,
  onSent,
}: FulfillmentEmailModalProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<NotificationPreview | null>(null);
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [sending, setSending] = useState(false);
  const [carrier, setCarrier] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [trackingUrl, setTrackingUrl] = useState('');
  const [deliveryFrom, setDeliveryFrom] = useState('');
  const [deliveryTo, setDeliveryTo] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const requestId = useRef(0);

  const withShipment = kind === 'shipped' && fulfillmentType !== 'pickup';
  const details: ShipmentDetailsFields = withShipment
    ? {
        carrier: carrier.trim(),
        tracking_number: trackingNumber.trim(),
        tracking_url: trackingUrl.trim(),
        delivery_from: deliveryFrom,
        delivery_to: deliveryTo,
      }
    : {};
  const detailsKey = JSON.stringify(details);

  // First load: the email as it stands, and what's on file to prefill.
  useEffect(() => {
    let cancelled = false;
    const id = ++requestId.current;
    setLoading(true);
    setError('');
    previewNotification(invoiceId, kind)
      .then((p) => {
        if (cancelled || id !== requestId.current) return;
        setPreview(p);
        setTo(p.to ?? '');
        setSubject(p.subject ?? p.defaults.subject);
        setCarrier(p.stored?.carrier ?? '');
        setTrackingNumber(p.stored?.number ?? '');
        setTrackingUrl(p.stored?.url ?? '');
      })
      .catch((e: any) => {
        if (cancelled) return;
        setError(e?.message ?? 'Failed to load preview');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [invoiceId, kind]);

  // Re-render the preview as the shipment details change (debounced; only the
  // latest request's answer is kept).
  useEffect(() => {
    if (!withShipment || loading || !preview) return;
    const handle = setTimeout(() => {
      const id = ++requestId.current;
      setRefreshing(true);
      previewNotification(invoiceId, kind, JSON.parse(detailsKey))
        .then((p) => { if (id === requestId.current) setPreview(p); })
        .catch(() => { /* keep the last good preview */ })
        .finally(() => { if (id === requestId.current) setRefreshing(false); });
    }, 450);
    return () => clearTimeout(handle);
    // `preview` is deliberately left out: it changes on every refresh.
  }, [detailsKey, withShipment, loading, invoiceId, kind]);

  const heading = (() => {
    if (kind === 'packed') {
      return fulfillmentType === 'pickup' ? 'Ready-for-pickup email' : 'Order packed email';
    }
    return fulfillmentType === 'pickup' ? 'Pickup confirmation' : 'Order shipped email';
  })();

  const missingTracking = withShipment && !!preview && !trackingNumber.trim();
  const badWindow = !!deliveryFrom && !!deliveryTo && deliveryTo < deliveryFrom;

  async function handleSend() {
    setSending(true);
    setError('');
    try {
      const res = await sendNotification(invoiceId, kind, {
        to: to.trim() || undefined,
        subject: subject.trim() || undefined,
        ...details,
      });
      if (!res.ok) {
        setError(res.error ?? 'Failed to send email');
        setSending(false);
        return;
      }
      onSent?.({ message_id: res.message_id ?? null, emailed_at: res.emailed_at ?? null });
      onClose();
    } catch (e: any) {
      setError(e?.message ?? 'Failed to send email');
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl border border-line shadow-xl w-full max-w-2xl max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-indigo-500/10 p-1.5">
              <Mail className="w-4 h-4 text-indigo-600" />
            </div>
            <div>
              <div className="font-semibold text-ink text-sm">{heading}</div>
              {invoiceNumber && (
                <div className="text-xs text-ink-muted font-mono">{invoiceNumber}</div>
              )}
            </div>
          </div>
          <button onClick={onClose} className="text-ink-muted hover:text-ink" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />
          </div>
        ) : (
          <div className="px-5 py-4 space-y-3 overflow-y-auto">
            {error && (
              <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {missingTracking && (
              <div className="flex items-start gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>
                  No tracking number yet — add one below, or the email goes out without
                  tracking and without the Track Your Order button.
                </span>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-ink-muted mb-1">To</label>
              <input
                type="email"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className={inputClass}
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-medium text-ink-muted">Subject</label>
                {preview && subject !== preview.defaults.subject && (
                  <button
                    type="button"
                    onClick={() => setSubject(preview.defaults.subject)}
                    className="inline-flex items-center gap-1 text-[11px] text-ink-muted hover:text-ink"
                    title="Restore the default subject"
                  >
                    <RotateCcw className="w-3 h-3" /> Reset to default
                  </button>
                )}
              </div>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className={inputClass}
              />
            </div>

            {withShipment && (
              <fieldset className="rounded-xl border border-line p-3 space-y-3">
                <legend className="px-1 text-xs font-semibold text-ink flex items-center gap-1.5">
                  <Truck className="w-3.5 h-3.5" /> Shipment details
                </legend>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-ink-muted mb-1">Carrier</label>
                    <input
                      type="text"
                      list="fulfillment-carriers"
                      value={carrier}
                      onChange={(e) => setCarrier(e.target.value)}
                      placeholder="e.g. Canada Post"
                      className={inputClass}
                    />
                    <datalist id="fulfillment-carriers">
                      {CARRIERS.map((c) => <option key={c} value={c} />)}
                    </datalist>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-ink-muted mb-1">Tracking number</label>
                    <input
                      type="text"
                      value={trackingNumber}
                      onChange={(e) => setTrackingNumber(e.target.value)}
                      placeholder="e.g. 1Z9VYTA1234567890"
                      className={`${inputClass} font-mono`}
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-ink-muted mb-1">
                    Tracking link <span className="font-normal">(optional)</span>
                  </label>
                  <input
                    type="url"
                    value={trackingUrl}
                    onChange={(e) => setTrackingUrl(e.target.value)}
                    placeholder="Built automatically for Canada Post, UPS, FedEx, Purolator, DHL, USPS"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-ink-muted mb-1">
                    Estimated delivery <span className="font-normal">(optional)</span>
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="date"
                      value={deliveryFrom}
                      onChange={(e) => setDeliveryFrom(e.target.value)}
                      aria-label="Estimated delivery from"
                      className={inputClass}
                    />
                    <span className="text-ink-muted text-sm">to</span>
                    <input
                      type="date"
                      value={deliveryTo}
                      min={deliveryFrom || undefined}
                      onChange={(e) => setDeliveryTo(e.target.value)}
                      aria-label="Estimated delivery to"
                      className={inputClass}
                    />
                  </div>
                  {badWindow && (
                    <p className="mt-1 text-[11px] text-red-600">The end date is before the start date.</p>
                  )}
                </div>
                <p className="text-[11px] text-ink-muted">
                  Used in this email only — not saved to the order.
                </p>
              </fieldset>
            )}

            {preview?.html && (
              <div>
                <label className="text-xs font-medium text-ink-muted mb-1 flex items-center gap-1.5">
                  Preview
                  {refreshing && <Loader2 className="w-3 h-3 animate-spin" />}
                </label>
                <iframe
                  title="Email preview"
                  srcDoc={preview.html}
                  sandbox=""
                  className="w-full h-[55vh] rounded-lg border border-line bg-[#EEF4F7]"
                />
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-line bg-surface/50">
          <button
            onClick={onClose}
            disabled={sending}
            className="px-4 py-2 bg-white border border-line text-ink rounded-lg text-sm font-medium hover:bg-surface disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSend}
            disabled={sending || loading || refreshing || badWindow || !preview || !to.trim() || !subject.trim()}
            className="inline-flex items-center gap-2 px-4 py-2 bg-ink text-white rounded-lg text-sm font-semibold hover:bg-ink/90 disabled:opacity-50"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Send email
          </button>
        </div>
      </div>
    </div>
  );
}
