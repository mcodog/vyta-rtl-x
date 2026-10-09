'use client';

import React, { useEffect, useState } from 'react';
import { X, Send, Loader2, RotateCcw, Mail, AlertCircle, AlertTriangle } from 'lucide-react';
import {
  previewNotification,
  sendNotification,
  type NotificationPreview,
} from '@/lib/warehouse/api';

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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    previewNotification(invoiceId, kind)
      .then((p) => {
        if (cancelled) return;
        setPreview(p);
        setTo(p.to ?? '');
        setSubject(p.subject ?? p.defaults.subject);
      })
      .catch((e: any) => {
        if (cancelled) return;
        setError(e?.message ?? 'Failed to load preview');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [invoiceId, kind]);

  const heading = (() => {
    if (kind === 'packed') {
      return fulfillmentType === 'pickup' ? 'Ready-for-pickup email' : 'Order packed email';
    }
    return fulfillmentType === 'pickup' ? 'Pickup confirmation' : 'Order shipped email';
  })();

  const missingTracking =
    kind === 'shipped' && fulfillmentType !== 'pickup' && !!preview && !preview.trackingNumber;

  async function handleSend() {
    setSending(true);
    setError('');
    try {
      const res = await sendNotification(invoiceId, kind, {
        to: to.trim() || undefined,
        subject: subject.trim() || undefined,
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
                  No tracking number on this order yet — the email will go out without one
                  and without the Track Your Order button.
                </span>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-ink-muted mb-1">To</label>
              <input
                type="email"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="w-full px-3 py-2 bg-surface border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400/40"
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
                className="w-full px-3 py-2 bg-surface border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400/40"
              />
            </div>

            {preview?.html && (
              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1">Preview</label>
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
            disabled={sending || loading || !preview || !to.trim() || !subject.trim()}
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
