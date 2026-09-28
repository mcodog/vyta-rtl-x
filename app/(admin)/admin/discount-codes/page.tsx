'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle, Copy, Loader2, Pencil, Plus, Search, Ticket, Trash2, Power,
} from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { useUserRole } from '../layout';
import { canEdit } from '@/lib/permissions';
import {
  adminFetch, codeStatus, describeCode, fmtMoney, shareLink, type AdminDiscountCode,
} from '@/components/admin/affiliates/api';
import DiscountCodeModal from '@/components/admin/affiliates/DiscountCodeModal';

const toneCls: Record<string, string> = {
  green: 'bg-emerald-100 text-emerald-700',
  gray: 'bg-gray-100 text-ink-muted',
  amber: 'bg-amber-100 text-amber-700',
  red: 'bg-red-100 text-red-700',
};

type Filter = 'all' | 'affiliate' | 'store' | 'active' | 'inactive';

export default function DiscountCodesPage() {
  const toast = useToast();
  const editable = canEdit(useUserRole());

  const [codes, setCodes] = useState<AdminDiscountCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [migrationNeeded, setMigrationNeeded] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [affiliateFilter, setAffiliateFilter] = useState('all');
  const [editing, setEditing] = useState<AdminDiscountCode | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await adminFetch<{ codes?: AdminDiscountCode[]; migrationNeeded?: boolean }>(
      '/api/admin/discount-codes',
    );
    if (!res.ok) toast.error(res.data.error ?? 'Could not load discount codes');
    setCodes(res.data.codes ?? []);
    setMigrationNeeded(!!res.data.migrationNeeded);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const affiliates = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of codes) if (c.affiliate_id) map.set(c.affiliate_id, c.affiliate_name ?? c.affiliate_email ?? '—');
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [codes]);

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    return codes.filter((c) => {
      if (filter === 'affiliate' && !c.affiliate_id) return false;
      if (filter === 'store' && c.affiliate_id) return false;
      if (filter === 'active' && codeStatus(c).label !== 'Active') return false;
      if (filter === 'inactive' && codeStatus(c).label === 'Active') return false;
      if (affiliateFilter !== 'all' && c.affiliate_id !== affiliateFilter) return false;
      if (!q) return true;
      return (
        c.code.includes(q) ||
        (c.affiliate_name ?? '').toUpperCase().includes(q) ||
        (c.affiliate_email ?? '').toUpperCase().includes(q)
      );
    });
  }, [codes, search, filter, affiliateFilter]);

  const totals = useMemo(
    () =>
      filtered.reduce(
        (t, c) => ({
          orders: t.orders + c.stats.orders,
          revenue: t.revenue + c.stats.revenue,
          discount: t.discount + c.stats.discount_given,
          commission: t.commission + c.stats.commission,
          pending: t.pending + c.stats.commission_pending,
        }),
        { orders: 0, revenue: 0, discount: 0, commission: 0, pending: 0 },
      ),
    [filtered],
  );

  const toggleActive = async (c: AdminDiscountCode) => {
    setBusy(c.id);
    const res = await adminFetch(`/api/admin/discount-codes/${c.id}`, {
      method: 'PATCH',
      body: { active: !c.active },
    });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.data.error ?? 'Could not update the code');
      return;
    }
    toast.success(`${c.code} ${c.active ? 'deactivated' : 'activated'}`);
    load();
  };

  const remove = async (c: AdminDiscountCode) => {
    if (!confirm(`Delete ${c.code}? This cannot be undone.`)) return;
    setBusy(c.id);
    const res = await adminFetch(`/api/admin/discount-codes/${c.id}`, { method: 'DELETE' });
    setBusy(null);
    if (!res.ok) {
      toast.error(res.data.error ?? 'Could not delete the code');
      return;
    }
    toast.success(`${c.code} deleted`);
    load();
  };

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(shareLink(code));
      toast.success('Checkout link copied');
    } catch {
      toast.error('Could not copy');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink">Discount Codes</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Codes buyers enter at checkout. Assign one to an affiliate and every paid order that uses it
            is credited to them.
          </p>
        </div>
        {editable && !migrationNeeded && (
          <button
            onClick={() => setEditing('new')}
            className="inline-flex items-center gap-2 rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-white hover:bg-ink/90"
          >
            <Plus className="h-4 w-4" /> New code
          </button>
        )}
      </div>

      {migrationNeeded && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Run <span className="font-mono">affiliate-discount-codes-payouts-migration.sql</span> in the
            Supabase SQL editor to enable discount codes.
          </span>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Orders" value={String(totals.orders)} hint={`${filtered.length} code${filtered.length === 1 ? '' : 's'}`} />
        <Stat label="Revenue" value={fmtMoney(totals.revenue)} hint="Goods, after discount" />
        <Stat label="Discount given" value={fmtMoney(totals.discount)} />
        <Stat label="Commission" value={fmtMoney(totals.commission)} hint={`${fmtMoney(totals.pending)} unpaid`} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search codes or affiliates"
            className="w-full rounded-lg border border-line bg-white py-2 pl-9 pr-3 text-sm focus:border-teal focus:outline-none"
          />
        </div>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as Filter)}
          className="rounded-lg border border-line bg-white px-3 py-2 text-sm"
        >
          <option value="all">All codes</option>
          <option value="affiliate">Affiliate codes</option>
          <option value="store">Store codes</option>
          <option value="active">Active</option>
          <option value="inactive">Not active</option>
        </select>
        <select
          value={affiliateFilter}
          onChange={(e) => setAffiliateFilter(e.target.value)}
          className="rounded-lg border border-line bg-white px-3 py-2 text-sm"
        >
          <option value="all">All affiliates</option>
          {affiliates.map(([id, label]) => (
            <option key={id} value={id}>{label}</option>
          ))}
        </select>
      </div>

      <div className="overflow-hidden rounded-xl border border-line bg-white">
        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-ink-muted" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <Ticket className="h-8 w-8 text-line" />
            <p className="text-sm text-ink-muted">
              {codes.length === 0 ? 'No discount codes yet.' : 'No codes match these filters.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface text-left text-[11px] uppercase tracking-wider text-ink-muted">
                  <th className="px-4 py-3 font-semibold">Code</th>
                  <th className="px-4 py-3 font-semibold">Affiliate</th>
                  <th className="px-4 py-3 font-semibold">Discount</th>
                  <th className="px-4 py-3 text-right font-semibold">Uses</th>
                  <th className="px-4 py-3 text-right font-semibold">Revenue</th>
                  <th className="px-4 py-3 text-right font-semibold">Discount given</th>
                  <th className="px-4 py-3 text-right font-semibold">Commission</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line/60">
                {filtered.map((c) => {
                  const st = codeStatus(c);
                  return (
                    <tr key={c.id} className="hover:bg-surface/50">
                      <td className="px-4 py-3">
                        <span className="font-mono font-semibold text-ink">{c.code}</span>
                        {c.landing_page && (
                          <Link
                            href="/admin/landing-pages"
                            className="ml-2 rounded-full bg-teal-50 px-2 py-0.5 text-[10px] font-medium text-teal-dark hover:underline"
                          >
                            Landing: {c.landing_page}
                          </Link>
                        )}
                        {c.notes && <span className="block max-w-[180px] truncate text-[11px] text-ink-muted">{c.notes}</span>}
                      </td>
                      <td className="px-4 py-3">
                        {c.affiliate_id ? (
                          <Link href={`/admin/affiliates/${c.affiliate_id}`} className="text-ink hover:text-teal-dark hover:underline">
                            {c.affiliate_name ?? c.affiliate_email ?? 'Affiliate'}
                          </Link>
                        ) : (
                          <span className="text-ink-muted">Store promo</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-ink">
                        {describeCode(c)}
                        <span className="block text-[11px] text-ink-muted">
                          {[
                            c.affiliate_id
                              ? c.commission_rate != null ? `${c.commission_rate}% commission` : 'Default commission'
                              : null,
                            c.min_subtotal ? `min ${fmtMoney(c.min_subtotal)}` : null,
                            c.first_order_only ? 'first order only' : null,
                            c.excluded_product_ids?.length
                              ? `excl. ${c.excluded_product_ids.length} product${c.excluded_product_ids.length === 1 ? '' : 's'}`
                              : null,
                            c.expires_at ? `ends ${new Date(c.expires_at).toLocaleDateString()}` : null,
                          ].filter(Boolean).join(' · ')}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-ink">
                        {c.stats.orders}{c.max_uses != null ? ` / ${c.max_uses}` : ''}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-ink">{fmtMoney(c.stats.revenue)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-ink-muted">{fmtMoney(c.stats.discount_given)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-ink">
                        {c.affiliate_id ? fmtMoney(c.stats.commission) : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${toneCls[st.tone]}`}>{st.label}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          <IconBtn title="Copy checkout link" onClick={() => copy(c.code)}>
                            <Copy className="h-3.5 w-3.5" />
                          </IconBtn>
                          {editable && (
                            <>
                              <IconBtn title="Edit" onClick={() => setEditing(c)}>
                                <Pencil className="h-3.5 w-3.5" />
                              </IconBtn>
                              <IconBtn
                                title={c.active ? 'Deactivate' : 'Activate'}
                                onClick={() => toggleActive(c)}
                                disabled={busy === c.id}
                              >
                                <Power className={`h-3.5 w-3.5 ${c.active ? 'text-emerald-600' : ''}`} />
                              </IconBtn>
                              {c.stats.orders === 0 && c.stats.commission === 0 && (
                                <IconBtn title="Delete" onClick={() => remove(c)} disabled={busy === c.id}>
                                  <Trash2 className="h-3.5 w-3.5" />
                                </IconBtn>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <DiscountCodeModal
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            toast.success(editing === 'new' ? 'Discount code created' : 'Discount code saved');
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-white p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted">{label}</p>
      <p className="mt-2 text-lg font-bold text-ink">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-muted">{hint}</p>}
    </div>
  );
}

function IconBtn({
  title, onClick, disabled, children,
}: { title: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className="rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface hover:text-ink disabled:opacity-50"
    >
      {children}
    </button>
  );
}
