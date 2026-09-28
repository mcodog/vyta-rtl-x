'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle, BookOpen, Copy, ExternalLink, Globe, Loader2, Pencil, Plus, Power, Trash2,
} from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { useUserRole } from '../layout';
import { canEdit } from '@/lib/permissions';
import { adminFetch, fmtMoney } from '@/components/admin/affiliates/api';
import LandingPageModal, { type AdminLandingPage } from '@/components/admin/LandingPageModal';

const RANGES = [
  { days: 0, label: 'All time' },
  { days: 90, label: '90 days' },
  { days: 30, label: '30 days' },
  { days: 7, label: '7 days' },
];

const pct = (n: number | null | undefined, d: number | null | undefined) =>
  n != null && d ? `${Math.round((n / d) * 1000) / 10}%` : '—';

/**
 * Admin → Landing Pages.
 *
 * One row per off-site landing page: the offer it is printing right now, the
 * link its button must use, and what it has produced — visitors, sign-ups,
 * checkouts and paid orders. See LANDING_PAGES.md for how a page is set up.
 */
export default function LandingPagesPage() {
  const toast = useToast();
  const editable = canEdit(useUserRole());

  const [pages, setPages] = useState<AdminLandingPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [migrationNeeded, setMigrationNeeded] = useState(false);
  const [days, setDays] = useState(0);
  const [editing, setEditing] = useState<AdminLandingPage | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await adminFetch<{ landingPages?: AdminLandingPage[]; migrationNeeded?: boolean }>(
      `/api/admin/landing-pages${days ? `?days=${days}` : ''}`,
    );
    if (!res.ok) toast.error(res.data.error ?? 'Could not load landing pages');
    setPages(res.data.landingPages ?? []);
    setMigrationNeeded(!!res.data.migrationNeeded);
    setLoading(false);
  }, [toast, days]);

  useEffect(() => {
    setLoading(true);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what} copied`);
    } catch {
      toast.error('Could not copy');
    }
  };

  const toggle = async (p: AdminLandingPage) => {
    setBusy(p.id);
    const res = await adminFetch(`/api/admin/landing-pages/${p.id}`, { method: 'PATCH', body: { active: !p.active } });
    setBusy(null);
    if (!res.ok) return toast.error(res.data.error ?? 'Could not update the landing page');
    toast.success(`${p.name} ${p.active ? 'switched off' : 'switched on'}`);
    load();
  };

  const remove = async (p: AdminLandingPage) => {
    if (!confirm(`Delete "${p.name}"? Its discount code goes with it. This cannot be undone.`)) return;
    setBusy(p.id);
    const res = await adminFetch(`/api/admin/landing-pages/${p.id}`, { method: 'DELETE' });
    setBusy(null);
    if (!res.ok) return toast.error(res.data.error ?? 'Could not delete the landing page');
    toast.success(`${p.name} deleted`);
    load();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink">Landing Pages</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">
            Pages on other domains that send visitors here. Each one prints the percentage set below, and
            checkout puts its code into the discount field for everyone who arrives from it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="rounded-lg border border-line bg-white px-3 py-2 text-sm"
            aria-label="Date range"
          >
            {RANGES.map((r) => (
              <option key={r.days} value={r.days}>{r.label}</option>
            ))}
          </select>
          {editable && !migrationNeeded && (
            <button
              onClick={() => setEditing('new')}
              className="inline-flex items-center gap-2 rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-white hover:bg-ink/90"
            >
              <Plus className="h-4 w-4" /> New landing page
            </button>
          )}
        </div>
      </div>

      {migrationNeeded && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Run <span className="font-mono">landing-pages-migration.sql</span> in the Supabase SQL editor to
            enable landing pages. Until then no landing offer is applied.
          </span>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-ink-muted" />
        </div>
      ) : pages.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-line bg-white py-16 text-center">
          <Globe className="h-8 w-8 text-line" />
          <p className="text-sm text-ink-muted">No landing pages yet.</p>
          <p className="flex items-center gap-1.5 text-xs text-ink-muted">
            <BookOpen className="h-3.5 w-3.5" /> The setup guide is LANDING_PAGES.md in the repository.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {pages.map((p) => {
            const s = p.stats;
            const revenue = s ? Object.entries(s.revenue) : [];
            const status = !p.active
              ? { label: 'Off', cls: 'bg-gray-100 text-ink-muted' }
              : p.live_percent > 0
                ? { label: `Live · ${+p.live_percent.toFixed(2)}% off`, cls: 'bg-emerald-100 text-emerald-700' }
                : p.code
                  ? { label: 'Offer not live', cls: 'bg-amber-100 text-amber-700' }
                  : { label: 'No offer', cls: 'bg-surface text-ink-muted' };
            return (
              <div key={p.id} className="rounded-xl border border-line bg-white p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold text-ink">{p.name}</h2>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${status.cls}`}>{status.label}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-ink-muted">
                      <span className="font-mono">{p.slug}</span>
                      {p.domain ? ` · ${p.domain}` : ''}
                      {p.code
                        ? ` · code ${p.code.code}${p.code.first_order_only ? ' · first order only' : ''}${
                            p.code.excluded_product_ids.length
                              ? ` · excl. ${p.code.excluded_product_ids.length} product${p.code.excluded_product_ids.length === 1 ? '' : 's'}`
                              : ''
                          }`
                        : ''}
                    </p>
                    {p.code && p.live_percent === 0 && p.active && (
                      <p className="mt-1 text-xs text-amber-700">
                        Its code is switched off, not started, ended or not a percentage — the landing page is
                        being told there is no offer.
                      </p>
                    )}
                  </div>
                  <div className="flex gap-1">
                    <IconBtn title="Open the button link" onClick={() => window.open(p.cta_url, '_blank', 'noopener')}>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </IconBtn>
                    {editable && (
                      <>
                        <IconBtn title="Edit" onClick={() => setEditing(p)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </IconBtn>
                        <IconBtn title={p.active ? 'Switch off' : 'Switch on'} onClick={() => toggle(p)} disabled={busy === p.id}>
                          <Power className={`h-3.5 w-3.5 ${p.active ? 'text-emerald-600' : ''}`} />
                        </IconBtn>
                        {(s?.orders ?? 0) === 0 && (
                          <IconBtn title="Delete" onClick={() => remove(p)} disabled={busy === p.id}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </IconBtn>
                        )}
                      </>
                    )}
                  </div>
                </div>

                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  <CopyRow label="Button link" value={p.cta_url} onCopy={() => copy(p.cta_url, 'Button link')} />
                  <CopyRow label="Offer API" value={p.api_url} onCopy={() => copy(p.api_url, 'Offer API URL')} />
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
                  <Stat label="Visitors" value={s?.visitors ?? null} />
                  <Stat label="Sign-ups" value={s?.signups ?? null} hint={pct(s?.signups, s?.visitors)} />
                  <Stat label="Checkouts" value={s?.checkouts ?? null} hint={pct(s?.checkouts, s?.visitors)} />
                  <Stat label="Purchasers" value={s?.purchasers ?? null} hint={pct(s?.purchasers, s?.visitors)} />
                  <Stat label="Paid orders" value={s?.orders ?? 0} />
                  <div className="rounded-lg bg-surface px-3 py-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">Revenue</p>
                    {revenue.length === 0 ? (
                      <p className="mt-1 text-sm font-bold text-ink">{fmtMoney(0)}</p>
                    ) : (
                      revenue.map(([currency, amount]) => (
                        <p key={currency} className="mt-1 text-sm font-bold text-ink">
                          {fmtMoney(amount)} <span className="text-[10px] font-medium text-ink-muted">{currency}</span>
                        </p>
                      ))
                    )}
                  </div>
                  <div className="rounded-lg bg-surface px-3 py-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">Discounts given</p>
                    <p className="mt-1 text-sm font-bold text-ink">{fmtMoney(s?.discount_given ?? 0)}</p>
                  </div>
                </div>
              </div>
            );
          })}
          <p className="text-[11px] text-ink-muted">
            Visitors, sign-ups, checkouts and purchasers count people whose first or last visit came through the
            page, and only those who accepted cookies when the consent banner is on — read them as a floor. Paid
            orders and revenue are exact: every order is stamped with its landing page at checkout. Revenue is goods
            after discounts, before shipping and tax.
          </p>
        </div>
      )}

      {editing && (
        <LandingPageModal
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            toast.success(editing === 'new' ? 'Landing page created' : 'Landing page saved');
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number | null; hint?: string }) {
  return (
    <div className="rounded-lg bg-surface px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">{label}</p>
      <p className="mt-1 text-sm font-bold text-ink tabular-nums">{value == null ? '—' : value.toLocaleString()}</p>
      {hint && hint !== '—' && <p className="text-[10px] text-ink-muted">{hint} of visitors</p>}
    </div>
  );
}

function CopyRow({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-line px-3 py-2">
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{value}</span>
      <button onClick={onCopy} aria-label={`Copy ${label}`} className="rounded p-1 text-ink-muted hover:bg-surface hover:text-ink">
        <Copy className="h-3.5 w-3.5" />
      </button>
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
