'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import Link from 'next/link';
import {
  Check, Search, DollarSign, FileText, ChevronRight, Printer, User, Users, RefreshCw,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { apiFetch } from '@/lib/api-fetch';
import { useToast } from '@/contexts/ToastContext';
import { useUserRole } from '../layout';
import { canEdit } from '@/lib/permissions';
import type { LedgerCommission, LedgerRecipient, CommissionSource } from '@/lib/admin/commission-ledger';

type StatusView = 'pending' | 'paid' | 'all';

interface Group {
  recipient: LedgerRecipient;
  rows: LedgerCommission[];
  pending: number;
  paid: number;
  latest: string;
}

const money = (n: number) => `$${n.toFixed(2)}`;
const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString() : '—');

function reference(c: LedgerCommission): string {
  if (c.invoice_number) return c.invoice_number;
  if (c.order_number) return c.order_number;
  const id = c.invoice_id ?? c.order_id;
  return id ? id.slice(0, 8) : '—';
}

function referenceHref(c: LedgerCommission): string | null {
  if (c.invoice_id) return `/admin/invoices/${c.invoice_id}`;
  if (c.order_id) return `/admin/orders/${c.order_id}`;
  return null;
}

/** Opens a staff-only HTML report in a new tab (the route needs the bearer token). */
async function openReport(path: string): Promise<boolean> {
  // Open synchronously so the popup isn't blocked after the await.
  const win = window.open('', '_blank');
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(path, {
      headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
    });
    if (!res.ok) {
      win?.close();
      return false;
    }
    const url = URL.createObjectURL(await res.blob());
    if (win) win.location.href = url;
    else window.open(url, '_blank');
    return true;
  } catch {
    win?.close();
    return false;
  }
}

export default function AdminCommissions() {
  const toast = useToast();
  const editable = canEdit(useUserRole());

  const [recipients, setRecipients] = useState<LedgerRecipient[]>([]);
  const [commissions, setCommissions] = useState<LedgerCommission[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusView, setStatusView] = useState<StatusView>('pending');
  const [sourceFilter, setSourceFilter] = useState<'all' | CommissionSource>('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [paying, setPaying] = useState<string | null>(null);
  const [printing, setPrinting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{ recipients: LedgerRecipient[]; commissions: LedgerCommission[] }>(
        '/api/admin/commissions',
        { timeoutMs: 30_000 },
      );
      setRecipients(data.recipients);
      setCommissions(data.commissions);
    } catch (e: any) {
      toast.error(e?.message || 'Could not load commissions');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const recipientByKey = useMemo(() => new Map(recipients.map((r) => [r.key, r])), [recipients]);

  const groups = useMemo<Group[]>(() => {
    const q = search.trim().toLowerCase();
    const map = new Map<string, Group>();
    for (const c of commissions) {
      if (statusView !== 'all' && c.status !== statusView) continue;
      if (sourceFilter !== 'all' && c.source !== sourceFilter) continue;
      const recipient = recipientByKey.get(c.recipient_key);
      if (!recipient) continue;
      if (q) {
        const hay = [recipient.name, recipient.email, recipient.referral_code, c.customer_name, reference(c), c.order_number];
        if (!hay.some((v) => (v ?? '').toLowerCase().includes(q))) continue;
      }
      const g = map.get(c.recipient_key) ?? { recipient, rows: [], pending: 0, paid: 0, latest: c.created_at };
      g.rows.push(c);
      if (c.status === 'pending') g.pending += c.amount;
      if (c.status === 'paid') g.paid += c.amount;
      if (c.created_at > g.latest) g.latest = c.created_at;
      map.set(c.recipient_key, g);
    }
    // Most recent activity first; commissions arrive newest-first already.
    return [...map.values()].sort((a, b) => new Date(b.latest).getTime() - new Date(a.latest).getTime());
  }, [commissions, recipientByKey, statusView, sourceFilter, search]);

  const totals = useMemo(() => {
    let pending = 0;
    let paid = 0;
    const owed = new Set<string>();
    for (const c of commissions) {
      if (c.status === 'pending') {
        pending += c.amount;
        owed.add(c.recipient_key);
      } else if (c.status === 'paid') paid += c.amount;
    }
    return { pending, paid, owed: owed.size };
  }, [commissions]);

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const allExpanded = groups.length > 0 && groups.every((g) => expanded.has(g.recipient.key));
  const toggleAll = () =>
    setExpanded(allExpanded ? new Set() : new Set(groups.map((g) => g.recipient.key)));

  const markPaid = async (c: LedgerCommission) => {
    if (!confirm(`Mark ${money(c.amount)} on ${reference(c)} as paid?`)) return;
    setPaying(c.id);
    try {
      await apiFetch('/api/admin/commissions', {
        method: 'POST',
        body: JSON.stringify({ source: c.source, ids: [c.id] }),
      });
      toast.success('Commission marked paid');
      await load();
    } catch (e: any) {
      toast.error(e?.message || 'Could not mark commission paid');
    } finally {
      setPaying(null);
    }
  };

  const printReport = async (key: string | null) => {
    const params = new URLSearchParams();
    if (key) params.set('recipient', key);
    if (statusView !== 'all') params.set('status', statusView);
    if (!key) {
      if (sourceFilter !== 'all') params.set('source', sourceFilter);
      if (search.trim()) params.set('q', search.trim());
    }
    setPrinting(key ?? 'all');
    const ok = await openReport(`/api/admin/commissions/report?${params.toString()}`);
    setPrinting(null);
    if (!ok) toast.error('Could not generate report');
  };

  const showPending = statusView !== 'paid';
  const showPaid = statusView !== 'pending';
  const groupCols = 4 + (showPending ? 1 : 0) + (showPaid ? 1 : 0);

  return (
    <>
      {/* Stats */}
      <div className="flex flex-wrap gap-4 mb-6 text-sm">
        <div className="flex items-center gap-2 bg-white border border-line rounded-lg px-4 py-2.5">
          <span className="w-2 h-2 rounded-full bg-amber-500" />
          <span className="text-teal-dark font-semibold tabular-nums">{money(totals.pending)}</span>
          <span className="text-ink-muted">pending</span>
        </div>
        <div className="flex items-center gap-2 bg-white border border-line rounded-lg px-4 py-2.5">
          <Users className="w-4 h-4 text-ink-muted" />
          <span className="text-ink font-semibold tabular-nums">{totals.owed}</span>
          <span className="text-ink-muted">{totals.owed === 1 ? 'recipient owed' : 'recipients owed'}</span>
        </div>
        <div className="flex items-center gap-2 bg-white border border-line rounded-lg px-4 py-2.5">
          <span className="w-2 h-2 rounded-full bg-emerald-500" />
          <span className="text-emerald-500 font-semibold tabular-nums">{money(totals.paid)}</span>
          <span className="text-ink-muted">paid</span>
        </div>
        <div className="flex items-center gap-2 bg-white border border-line rounded-lg px-4 py-2.5">
          <DollarSign className="w-4 h-4 text-ink-muted" />
          <span className="text-ink font-semibold tabular-nums">{commissions.length}</span>
          <span className="text-ink-muted">commissions</span>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row sm:flex-wrap gap-3 mb-6">
        <div className="inline-flex rounded-lg border border-line bg-white p-0.5 self-start">
          {(['pending', 'paid', 'all'] as StatusView[]).map((v) => (
            <button
              key={v}
              onClick={() => setStatusView(v)}
              className={`px-3.5 py-2 rounded-md text-sm font-medium transition-colors ${
                statusView === v ? 'bg-ink text-white' : 'text-ink-muted hover:text-ink'
              }`}
            >
              {v === 'pending' ? 'Pending' : v === 'paid' ? 'Paid' : 'Show all'}
            </button>
          ))}
        </div>
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
          <input
            type="text"
            placeholder="Search by name, email, code, customer or invoice…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-white border border-line rounded-lg text-sm text-ink placeholder-ink-muted focus:outline-none focus:ring-2 focus:ring-teal/40"
          />
        </div>
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as 'all' | CommissionSource)}
          className="px-3 pr-8 py-2.5 bg-white border border-line rounded-lg text-sm text-ink focus:outline-none focus:ring-2 focus:ring-teal/40 appearance-none"
        >
          <option value="all">Affiliates &amp; sales</option>
          <option value="affiliate">Affiliates</option>
          <option value="sales">Sales persons</option>
        </select>
        <button
          onClick={() => printReport(null)}
          disabled={printing !== null}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-ink hover:bg-ink/90 text-white rounded-lg text-sm font-medium disabled:opacity-50"
        >
          <FileText className="w-4 h-4" />
          {printing === 'all' ? 'Generating…' : 'Full report'}
        </button>
      </div>

      <div className="bg-white rounded-xl border border-line overflow-hidden">
        <div className="p-5 md:p-6 border-b border-line flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-ink">
            {statusView === 'pending' ? 'Pending commissions' : statusView === 'paid' ? 'Paid commissions' : 'All commissions'}
          </h2>
          <div className="flex items-center gap-3">
            <span className="text-sm text-ink-muted">
              {groups.length} {groups.length === 1 ? 'recipient' : 'recipients'}
            </span>
            {groups.length > 0 && (
              <button onClick={toggleAll} className="text-sm text-teal-dark hover:underline">
                {allExpanded ? 'Collapse all' : 'Expand all'}
              </button>
            )}
            <button
              onClick={load}
              disabled={loading}
              title="Refresh"
              className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-surface disabled:opacity-40"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px]">
            <thead>
              <tr className="border-b border-line">
                <th className="px-5 py-3 text-left text-xs font-semibold text-ink-muted uppercase tracking-wider">Recipient</th>
                <th className="px-5 py-3 text-left text-xs font-semibold text-ink-muted uppercase tracking-wider">Commissions</th>
                <th className="px-5 py-3 text-left text-xs font-semibold text-ink-muted uppercase tracking-wider">Latest</th>
                {showPending && (
                  <th className="px-5 py-3 text-right text-xs font-semibold text-ink-muted uppercase tracking-wider">Pending</th>
                )}
                {showPaid && (
                  <th className="px-5 py-3 text-right text-xs font-semibold text-ink-muted uppercase tracking-wider">Paid</th>
                )}
                <th className="px-5 py-3 text-right text-xs font-semibold text-ink-muted uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && commissions.length === 0 ? (
                Array.from({ length: 6 }).map((_, i) => <GroupSkeletonRow key={i} cols={groupCols} />)
              ) : groups.length === 0 ? (
                <tr>
                  <td colSpan={groupCols} className="px-5 py-12 text-center text-ink-muted text-sm">
                    {commissions.length === 0
                      ? 'No commissions yet'
                      : statusView === 'pending' && !search && sourceFilter === 'all'
                        ? 'Nothing pending — everyone is paid up'
                        : 'No commissions match your filters'}
                  </td>
                </tr>
              ) : (
                groups.map((g) => {
                  const open = expanded.has(g.recipient.key);
                  return (
                    <React.Fragment key={g.recipient.key}>
                      <tr
                        onClick={() => toggle(g.recipient.key)}
                        className={`border-b border-line/60 cursor-pointer transition-colors ${open ? 'bg-surface/60' : 'hover:bg-surface'}`}
                      >
                        <td className="px-5 py-4">
                          <div className="flex items-start gap-3">
                            <ChevronRight
                              className={`w-4 h-4 mt-0.5 shrink-0 text-ink-muted transition-transform ${open ? 'rotate-90' : ''}`}
                            />
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-medium text-ink text-sm">{g.recipient.name}</span>
                                <span
                                  className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${
                                    g.recipient.source === 'affiliate'
                                      ? 'bg-blue-500/10 text-blue-600'
                                      : 'bg-purple-500/10 text-purple-600'
                                  }`}
                                >
                                  {g.recipient.source === 'affiliate' ? 'Affiliate' : 'Sales'}
                                </span>
                                {g.recipient.referral_code && (
                                  <span className="font-mono text-xs text-ink-muted">{g.recipient.referral_code}</span>
                                )}
                              </div>
                              <div className="text-xs text-ink-muted truncate">{g.recipient.email}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-4 text-sm text-ink tabular-nums">{g.rows.length}</td>
                        <td className="px-5 py-4 text-sm text-ink-muted">{fmtDate(g.latest)}</td>
                        {showPending && (
                          <td className="px-5 py-4 text-right font-semibold text-amber-600 tabular-nums">{money(g.pending)}</td>
                        )}
                        {showPaid && (
                          <td className="px-5 py-4 text-right font-semibold text-emerald-600 tabular-nums">{money(g.paid)}</td>
                        )}
                        <td className="px-5 py-4" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-2">
                            <Link
                              href={g.recipient.profile_href}
                              className="inline-flex items-center gap-1 px-3 py-1.5 border border-line rounded-lg text-xs font-medium text-ink hover:bg-surface"
                            >
                              <User className="w-3.5 h-3.5" /> Profile
                            </Link>
                            <button
                              onClick={() => printReport(g.recipient.key)}
                              disabled={printing !== null}
                              className="inline-flex items-center gap-1 px-3 py-1.5 border border-line rounded-lg text-xs font-medium text-ink hover:bg-surface disabled:opacity-50"
                            >
                              <Printer className="w-3.5 h-3.5" />
                              {printing === g.recipient.key ? '…' : 'Print report'}
                            </button>
                          </div>
                        </td>
                      </tr>
                      {open && (
                        <tr className="border-b border-line">
                          <td colSpan={groupCols} className="p-0 bg-surface/40">
                            <CommissionDetail
                              rows={g.rows}
                              editable={editable}
                              paying={paying}
                              onMarkPaid={markPaid}
                            />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function CommissionDetail({
  rows,
  editable,
  paying,
  onMarkPaid,
}: {
  rows: LedgerCommission[];
  editable: boolean;
  paying: string | null;
  onMarkPaid: (c: LedgerCommission) => void;
}) {
  return (
    <div className="pl-12 pr-5 py-3">
      <table className="w-full">
        <thead>
          <tr className="border-b border-line">
            <th className="py-2 pr-4 text-left text-[11px] font-semibold text-ink-muted uppercase tracking-wider">Date</th>
            <th className="py-2 pr-4 text-left text-[11px] font-semibold text-ink-muted uppercase tracking-wider">Invoice</th>
            <th className="py-2 pr-4 text-left text-[11px] font-semibold text-ink-muted uppercase tracking-wider">Customer</th>
            <th className="py-2 pr-4 text-right text-[11px] font-semibold text-ink-muted uppercase tracking-wider">Base</th>
            <th className="py-2 pr-4 text-right text-[11px] font-semibold text-ink-muted uppercase tracking-wider">Rate</th>
            <th className="py-2 pr-4 text-right text-[11px] font-semibold text-ink-muted uppercase tracking-wider">Commission</th>
            <th className="py-2 pr-4 text-left text-[11px] font-semibold text-ink-muted uppercase tracking-wider">Status</th>
            <th className="py-2 text-right text-[11px] font-semibold text-ink-muted uppercase tracking-wider" />
          </tr>
        </thead>
        <tbody className="divide-y divide-line/50">
          {rows.map((c) => {
            const href = referenceHref(c);
            return (
              <tr key={`${c.source}-${c.id}`}>
                <td className="py-2.5 pr-4 text-sm text-ink-muted whitespace-nowrap">{fmtDate(c.created_at)}</td>
                <td className="py-2.5 pr-4 text-sm font-mono">
                  {href ? (
                    <Link href={href} className="text-teal-dark hover:underline">
                      {reference(c)}
                    </Link>
                  ) : (
                    <span className="text-ink">{reference(c)}</span>
                  )}
                </td>
                <td className="py-2.5 pr-4 text-sm text-ink">{c.customer_name || <span className="text-ink-muted">—</span>}</td>
                <td className="py-2.5 pr-4 text-sm text-ink text-right tabular-nums">{money(c.base)}</td>
                <td className="py-2.5 pr-4 text-sm text-ink-muted text-right tabular-nums">{c.rate ? `${c.rate}%` : '—'}</td>
                <td className="py-2.5 pr-4 text-sm font-semibold text-ink text-right tabular-nums">{money(c.amount)}</td>
                <td className="py-2.5 pr-4">
                  <span
                    className={`inline-flex px-2 py-0.5 rounded text-xs font-medium capitalize ${
                      c.status === 'paid'
                        ? 'bg-emerald-500/10 text-emerald-600'
                        : c.status === 'pending'
                          ? 'bg-amber-500/10 text-amber-600'
                          : 'bg-red-500/10 text-red-500'
                    }`}
                  >
                    {c.status}
                  </span>
                  {c.status === 'paid' && c.paid_at && (
                    <span className="ml-2 text-xs text-ink-muted">{fmtDate(c.paid_at)}</span>
                  )}
                </td>
                <td className="py-2.5 text-right">
                  {editable && c.status === 'pending' && (
                    <button
                      onClick={() => onMarkPaid(c)}
                      disabled={paying === c.id}
                      className="inline-flex items-center gap-1 px-2.5 py-1 bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 rounded-lg text-xs font-medium hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
                    >
                      <Check className="w-3.5 h-3.5" />
                      {paying === c.id ? '…' : 'Mark paid'}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function GroupSkeletonRow({ cols }: { cols: number }) {
  return (
    <tr className="animate-pulse border-b border-line/60">
      <td className="px-5 py-4">
        <div className="h-3.5 w-32 bg-surface rounded mb-1.5" />
        <div className="h-3 w-44 bg-surface rounded" />
      </td>
      {Array.from({ length: cols - 1 }).map((_, i) => (
        <td key={i} className="px-5 py-4"><div className="h-3.5 w-16 bg-surface rounded" /></td>
      ))}
    </tr>
  );
}
