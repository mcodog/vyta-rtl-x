'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, Loader2, Mail, RotateCw } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { useToast } from '@/contexts/ToastContext';
import type { ConfirmationLogRow, ConfirmationSummary } from '@/lib/order-confirmation-data';

/**
 * Admin view of the paid-order confirmation email (lib/order-confirmation.ts):
 * whether it went out, when, to whom and by whom, with a Send / Resend button.
 *
 *   <OrderConfirmationEmailCard> — sidebar card on the order / invoice pages,
 *                                  with the full send history.
 *   <OrderConfirmationCell>      — compact status + button for list tables,
 *                                  fed a summary the list API already fetched.
 */

export type ConfirmationCardTarget =
  | { orderId: string }
  | { invoiceId: string }
  | { puramassOrderId: string };

type StatusResponse =
  | { applicable: false }
  | {
      applicable: true;
      kind: 'storefront' | 'stealth_health' | 'manual';
      summary: ConfirmationSummary;
      history: ConfirmationLogRow[];
      recipient: string | null;
      orderNumber: string | null;
      blockedReason: string | null;
    };

interface SendResponse {
  success: true;
  to: string;
  sent_at: string;
}

const ENDPOINT = '/api/admin/confirmation-email';

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

function targetQuery(target: ConfirmationCardTarget): string {
  return new URLSearchParams(target as Record<string, string>).toString();
}

/** Ask before sending again; false = the admin cancelled. */
function confirmResend(recipient: string | null, sendCount: number): boolean {
  if (sendCount <= 0) return true;
  const times = sendCount === 1 ? 'once' : `${sendCount} times`;
  return window.confirm(
    `${recipient || 'This customer'} has already been sent this confirmation ${times}. Send it again?`,
  );
}

function postSend(target: ConfirmationCardTarget): Promise<SendResponse> {
  return apiFetch<SendResponse>(ENDPOINT, {
    method: 'POST',
    body: JSON.stringify(target),
    timeoutMs: 30_000,
  });
}

export default function OrderConfirmationEmailCard({
  target,
  canSend = true,
  onSent,
}: {
  target: ConfirmationCardTarget;
  canSend?: boolean;
  onSent?: () => void;
}) {
  const toast = useToast();
  const query = targetQuery(target);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      setStatus(await apiFetch<StatusResponse>(`${ENDPOINT}?${query}`));
    } catch (e: any) {
      setError(e?.message || 'Could not load the confirmation status.');
    } finally {
      setLoading(false);
    }
  }, [query]);

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
    if (!confirmResend(live.recipient, live.summary.sendCount)) return;
    setSending(true);
    try {
      const res = await postSend(target);
      toast.success(`Order confirmation ${sentBefore ? 're' : ''}sent to ${res.to}.`);
      await load();
      onSent?.();
    } catch (e: any) {
      toast.error(e?.message || 'The email could not be sent.');
      await load();
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="bg-white rounded-xl border border-line p-5">
      <div className="flex items-center gap-2 mb-3">
        <Mail className="w-4 h-4 text-ink-muted" />
        <h3 className="font-semibold text-ink text-sm">Order confirmation email</h3>
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
                Last {when(summary.lastSentAt)} to{' '}
                <span className="font-medium">{summary.lastSentTo}</span> ·{' '}
                {summary.lastSentBy ? `by ${summary.lastSentBy}` : 'automatically on payment'}
              </p>
            </div>
          ) : (
            <div className="rounded-lg px-3 py-2 text-xs border bg-amber-50 border-amber-200 text-amber-800">
              <p className="font-semibold">Not sent</p>
              <p className="mt-0.5">This customer hasn&apos;t been sent an order confirmation.</p>
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
                  <Mail className="w-3.5 h-3.5" />
                )}
                {sentBefore ? 'Resend order confirmation' : 'Send order confirmation'}
              </button>
              <p className="mt-1.5 text-[10px] text-ink-muted">
                {live.blockedReason ?? `Goes to ${live.recipient}`}
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

/** Compact status + send button for a list-table row. */
export function OrderConfirmationCell({
  summary: initial,
  target,
  canSend = true,
}: {
  summary: ConfirmationSummary | null | undefined;
  target: ConfirmationCardTarget | null;
  canSend?: boolean;
}) {
  const toast = useToast();
  const [summary, setSummary] = useState<ConfirmationSummary | null>(initial ?? null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    setSummary(initial ?? null);
  }, [initial]);

  const sendCount = summary?.sendCount ?? 0;
  const sentBefore = sendCount > 0;

  async function send() {
    if (!target) return;
    if (!confirmResend(summary?.lastSentTo ?? null, sendCount)) return;
    setSending(true);
    try {
      const res = await postSend(target);
      setSummary((s) => ({
        sendCount: (s?.sendCount ?? 0) + 1,
        lastSentAt: res.sent_at,
        lastSentTo: res.to,
        lastSentBy: 'you',
        lastAttemptFailed: false,
        lastError: null,
      }));
      toast.success(`Order confirmation ${sentBefore ? 're' : ''}sent to ${res.to}.`);
    } catch (e: any) {
      toast.error(e?.message || 'The email could not be sent.');
    } finally {
      setSending(false);
    }
  }

  let label: React.ReactNode;
  if (summary?.lastAttemptFailed) {
    label = (
      <span
        className="inline-flex items-center gap-1 text-[11px] font-medium text-red-600"
        title={`Last attempt failed: ${summary.lastError || 'unknown error'}`}
      >
        <Mail className="h-3 w-3" /> Failed
      </span>
    );
  } else if (summary && sentBefore) {
    label = (
      <span
        className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700"
        title={`Last sent ${summary.lastSentAt ? new Date(summary.lastSentAt).toLocaleString() : ''} to ${summary.lastSentTo || 'the customer'} ${summary.lastSentBy ? `by ${summary.lastSentBy}` : 'automatically'}.`}
      >
        <Check className="h-3 w-3" />
        Sent {summary.lastSentAt ? new Date(summary.lastSentAt).toLocaleDateString() : ''}
        {sendCount > 1 ? ` · ${sendCount}×` : ''}
      </span>
    );
  } else {
    label = (
      <span
        className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700"
        title="No order confirmation email has been sent for this order."
      >
        <Mail className="h-3 w-3" /> Not sent
      </span>
    );
  }

  const action = sentBefore ? 'Resend the order confirmation email' : 'Send the order confirmation email';
  return (
    <div className="flex items-center gap-2">
      {label}
      {canSend && target && (
        <button
          onClick={send}
          disabled={sending}
          title={action}
          aria-label={action}
          className="inline-flex h-6 w-6 items-center justify-center rounded border border-line bg-surface text-ink-muted hover:border-ink/20 hover:text-ink disabled:opacity-40"
        >
          {sending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : sentBefore ? (
            <RotateCw className="h-3 w-3" />
          ) : (
            <Mail className="h-3 w-3" />
          )}
        </button>
      )}
    </div>
  );
}
