'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, BellRing, Check, Loader2, RotateCw } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { useToast } from '@/contexts/ToastContext';
import type { ConfirmationLogRow, ConfirmationSummary } from '@/lib/order-confirmation-data';

/**
 * Invoice sidebar card for the admin "order paid" email
 * (lib/admin/stealth-health-paid-alert.ts) — sent to the Admin Email
 * Notifications list. Stealth Health invoices send it automatically on payment;
 * manual invoices only ever send it from here.
 */

type StatusResponse =
  | { applicable: false }
  | {
      applicable: true;
      kind: 'stealth_health' | 'manual';
      summary: ConfirmationSummary;
      history: ConfirmationLogRow[];
      recipients: string[];
      blockedReason: string | null;
    };

const ENDPOINT = '/api/admin/paid-alert-email';

function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function AdminPaidAlertEmailCard({
  invoiceId,
  canSend = true,
}: {
  invoiceId: string;
  canSend?: boolean;
}) {
  const toast = useToast();
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      setStatus(await apiFetch<StatusResponse>(`${ENDPOINT}?invoiceId=${encodeURIComponent(invoiceId)}`));
    } catch (e: any) {
      setError(e?.message || 'Could not load the notification status.');
    } finally {
      setLoading(false);
    }
  }, [invoiceId]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  if (!loading && status && !status.applicable) return null;

  const live = status && status.applicable ? status : null;
  const summary = live?.summary;
  const sentBefore = (summary?.sendCount ?? 0) > 0;

  async function send() {
    if (!live) return;
    if (sentBefore) {
      const times = live.summary.sendCount === 1 ? 'once' : `${live.summary.sendCount} times`;
      if (!window.confirm(`The admin notification has already gone out ${times}. Send it again?`)) return;
    }
    setSending(true);
    try {
      const res = await apiFetch<{ success: true; to: string[]; sent_at: string }>(ENDPOINT, {
        method: 'POST',
        body: JSON.stringify({ invoiceId }),
        timeoutMs: 30_000,
      });
      toast.success(`Admin notification ${sentBefore ? 're' : ''}sent to ${res.to.join(', ')}.`);
    } catch (e: any) {
      toast.error(e?.message || 'The email could not be sent.');
    } finally {
      await load();
      setSending(false);
    }
  }

  return (
    <div className="bg-white rounded-xl border border-line p-5">
      <div className="flex items-center gap-2 mb-3">
        <BellRing className="w-4 h-4 text-ink-muted" />
        <h3 className="font-semibold text-ink text-sm">Admin notification email</h3>
      </div>

      {loading && !status ? (
        <p className="text-xs text-ink-muted flex items-center gap-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking…
        </p>
      ) : error && !live ? (
        <p className="text-xs text-red-600">{error}</p>
      ) : live && summary ? (
        <>
          {sentBefore ? (
            <div className="rounded-lg px-3 py-2 text-xs border bg-emerald-50 border-emerald-200 text-emerald-800">
              <p className="font-semibold flex items-center gap-1">
                <Check className="w-3.5 h-3.5" />
                Sent{summary.sendCount > 1 ? ` ${summary.sendCount} times` : ''}
              </p>
              <p className="mt-0.5">
                Last {when(summary.lastSentAt)} ·{' '}
                {summary.lastSentBy ? `by ${summary.lastSentBy}` : 'automatically on payment'}
              </p>
            </div>
          ) : (
            <div className="rounded-lg px-3 py-2 text-xs border bg-amber-50 border-amber-200 text-amber-800">
              <p className="font-semibold">Not sent</p>
              <p className="mt-0.5">
                {live.kind === 'manual'
                  ? 'Manual invoices don’t notify the team automatically — send it from here.'
                  : 'The team hasn’t been notified about this order yet.'}
              </p>
            </div>
          )}

          {summary.lastAttemptFailed && (
            <p className="mt-2 text-xs text-red-600 flex items-start gap-1">
              <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
              Last attempt failed: {summary.lastError}
            </p>
          )}

          {canSend && (
            <>
              <button
                onClick={send}
                disabled={sending || !!live.blockedReason}
                className="mt-3 w-full px-3 py-2 bg-teal/10 border border-teal/20 text-teal-dark rounded-lg text-sm hover:bg-teal/20 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {sending ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : sentBefore ? (
                  <RotateCw className="w-3.5 h-3.5" />
                ) : (
                  <BellRing className="w-3.5 h-3.5" />
                )}
                {sentBefore ? 'Resend admin notification' : 'Send admin notification'}
              </button>
              <p className="mt-1.5 text-[10px] text-ink-muted">
                {live.blockedReason ?? `Goes to ${live.recipients.join(', ')}`}
              </p>
            </>
          )}

          {live.history.length > 0 && (
            <div className="mt-3 pt-3 border-t border-line/60">
              <button
                onClick={() => setShowHistory((v) => !v)}
                className="text-[11px] text-ink-muted hover:text-ink"
              >
                {showHistory ? 'Hide' : 'Show'} send history ({live.history.length})
              </button>
              {showHistory && (
                <ul className="mt-2 space-y-1.5">
                  {live.history.map((row, i) => (
                    <li key={`${row.created_at}-${i}`} className="text-[11px] leading-snug">
                      {row.success ? (
                        <span className="text-emerald-700">✓</span>
                      ) : (
                        <span className="text-red-600">✗</span>
                      )}{' '}
                      <span className="text-ink">{when(row.created_at)}</span>
                      <span className="text-ink-muted">
                        {' '}· {row.to_email} · {row.sent_by_email || 'automatic'}
                      </span>
                      {!row.success && row.error && (
                        <div className="text-red-600 ml-3">{row.error}</div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
