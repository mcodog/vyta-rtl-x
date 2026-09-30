'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, Bot, ExternalLink, PackageCheck, User } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';

type Kind = 'manual' | 'automatic' | 'untracked';

interface LedgerEntry {
  id: string;
  created_at: string;
  product_id: string;
  product_name: string | null;
  product_sku: string | null;
  old_qty: number | null;
  new_qty: number | null;
  delta: number | null;
  source: string;
  source_label: string;
  kind: Kind;
  actor_email: string | null;
  note: string | null;
  reference: { type: string; id: string; label: string; href: string | null } | null;
}

interface UnstockedLine {
  id: string;
  description: string;
  qty: number;
  price_type: string | null;
  guess_product_id: string | null;
  guess_vials_per_unit: number | null;
}

interface UnstockedInvoice {
  id: string;
  invoice_number: string | null;
  created_at: string;
  customer_name: string | null;
  customer_email: string | null;
  fulfillment_status: string | null;
  stock_pending: boolean;
  unlinked_lines: UnstockedLine[];
}

interface ProductOption {
  id: string;
  name: string;
  vials_per_box: number | null;
}

const PAGE_SIZE = 100;

const KIND_TABS: { key: 'all' | Kind; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'manual', label: 'Manual' },
  { key: 'automatic', label: 'Automatic' },
  { key: 'untracked', label: 'Outside the admin' },
];

const KIND_BADGE: Record<Kind, string> = {
  manual: 'bg-teal/10 text-teal-dark',
  automatic: 'bg-blue-500/10 text-blue-600',
  untracked: 'bg-amber-500/10 text-amber-700',
};

const inputClass =
  'w-full px-3 py-2 bg-surface rounded-lg border border-line focus:outline-none focus:ring-2 focus:ring-teal/40 text-sm text-ink';

export default function StockLedgerPage() {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [migrated, setMigrated] = useState(true);

  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<'all' | Kind>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const query = useCallback(
    (offset: number) => {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset), kind });
      if (search.trim()) qs.set('q', search.trim());
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      return apiFetch<{ entries: LedgerEntry[]; total: number; migrated?: boolean }>(
        `/api/admin/stock-ledger?${qs.toString()}`,
      );
    },
    [kind, search, from, to],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await query(0);
      setEntries(data.entries ?? []);
      setTotal(data.total ?? 0);
      setMigrated(data.migrated !== false);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load the stock ledger');
    }
    setLoading(false);
  }, [query]);

  // Re-query when a filter changes; the search box waits for typing to settle.
  useEffect(() => {
    const t = setTimeout(() => void load(), 300);
    return () => clearTimeout(t);
  }, [load]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const data = await query(entries.length);
      setEntries((prev) => [...prev, ...(data.entries ?? [])]);
      setTotal(data.total ?? total);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load more');
    }
    setLoadingMore(false);
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-ink">Stock Ledger</h1>
        <p className="text-sm text-ink-muted mt-1">
          Every change to product stock. Manual changes show who made them; automatic ones
          link to the invoice, order or purchase order that caused them.
        </p>
      </div>

      {!migrated && (
        <div className="mb-4 bg-amber-50 border border-amber-200 text-amber-800 text-sm p-3 rounded-lg">
          The stock ledger table isn&apos;t in the database yet. Run{' '}
          <code className="font-mono">stock-ledger-migration.sql</code> in the Supabase SQL editor.
        </div>
      )}

      <NeedsAttention onFixed={load} />

      <div className="bg-white border border-line rounded-lg p-4 mb-4 flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs font-medium text-ink-muted mb-1">Product</label>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name or SKU"
            className={inputClass}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-ink-muted mb-1">From</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className="block text-xs font-medium text-ink-muted mb-1">To</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputClass} />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {KIND_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setKind(t.key)}
              className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                kind === t.key
                  ? 'bg-ink text-white'
                  : 'bg-white text-ink-muted border border-line hover:text-ink'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => void load()}
          className="bg-ink hover:bg-ink/90 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 text-red-700 text-sm p-3 rounded-lg">{error}</div>
      )}

      <div className="bg-white border border-line rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface text-ink-muted text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-3 font-medium">When</th>
                <th className="text-left px-4 py-3 font-medium">Product</th>
                <th className="text-right px-4 py-3 font-medium">Change</th>
                <th className="text-left px-4 py-3 font-medium">Stock</th>
                <th className="text-left px-4 py-3 font-medium">Source</th>
                <th className="text-left px-4 py-3 font-medium">Who / caused by</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-ink-muted">Loading…</td></tr>
              ) : entries.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-ink-muted">No stock changes match these filters</td></tr>
              ) : (
                entries.map((e) => <LedgerRow key={e.id} entry={e} />)
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center justify-between mt-3">
        <p className="text-xs text-ink-muted">
          Showing {entries.length} of {total} changes.
        </p>
        {entries.length < total && !loading && (
          <button
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="text-sm font-medium text-teal-dark hover:underline disabled:opacity-50"
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </div>
  );
}

function LedgerRow({ entry: e }: { entry: LedgerEntry }) {
  const delta = e.delta ?? 0;
  return (
    <tr className="border-t border-line align-top">
      <td className="px-4 py-3 text-ink-muted whitespace-nowrap">{new Date(e.created_at).toLocaleString()}</td>
      <td className="px-4 py-3">
        <span className="text-ink font-medium">{e.product_name ?? 'Deleted product'}</span>
        {e.product_sku && <div className="text-xs text-ink-muted font-mono">{e.product_sku}</div>}
      </td>
      <td
        className={`px-4 py-3 text-right font-semibold tabular-nums whitespace-nowrap ${
          delta > 0 ? 'text-emerald-600' : delta < 0 ? 'text-red-600' : 'text-ink-muted'
        }`}
      >
        {delta > 0 ? `+${delta}` : delta}
      </td>
      <td className="px-4 py-3 whitespace-nowrap tabular-nums">
        <span className="text-ink-muted">{e.old_qty ?? '—'}</span>
        <ArrowRight className="inline w-3.5 h-3.5 mx-1 text-ink-muted" />
        <span className="font-semibold text-ink">{e.new_qty ?? '—'}</span>
      </td>
      <td className="px-4 py-3">
        <span className={`inline-flex px-2 py-0.5 rounded text-[11px] font-medium whitespace-nowrap ${KIND_BADGE[e.kind]}`}>
          {e.source_label}
        </span>
      </td>
      <td className="px-4 py-3 text-ink">
        {e.reference && (
          <div className="flex items-center gap-1">
            <Bot className="w-3.5 h-3.5 text-ink-muted flex-shrink-0" />
            {e.reference.href ? (
              <Link href={e.reference.href} className="text-teal-dark hover:underline inline-flex items-center gap-1">
                {e.reference.label}
                <ExternalLink className="w-3 h-3" />
              </Link>
            ) : (
              <span>{e.reference.label}</span>
            )}
          </div>
        )}
        {(e.kind === 'manual' || e.actor_email) && (
          <div className={`flex items-center gap-1 ${e.reference ? 'text-xs text-ink-muted mt-0.5' : ''}`}>
            <User className="w-3.5 h-3.5 text-ink-muted flex-shrink-0" />
            {e.reference ? 'by ' : ''}
            {e.actor_email ?? <span className="italic text-ink-muted">unknown</span>}
          </div>
        )}
        {e.kind === 'untracked' && (
          <div className="text-xs text-amber-700 mt-0.5">Changed directly in the database</div>
        )}
        {e.note && <div className="text-xs text-ink-muted mt-0.5">{e.note}</div>}
      </td>
    </tr>
  );
}

/** Paid Stealth Health invoices whose stock was not (fully) taken. */
function NeedsAttention({ onFixed }: { onFixed: () => void }) {
  const [invoices, setInvoices] = useState<UnstockedInvoice[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ invoices: UnstockedInvoice[]; products: ProductOption[] }>(
        '/api/admin/stock-ledger/needs-attention',
      );
      setInvoices(data.invoices ?? []);
      setProducts(data.products ?? []);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to check for missed stock');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div className="mb-4 bg-red-50 border border-red-200 text-red-700 text-sm p-3 rounded-lg">{error}</div>
    );
  }
  if (invoices.length === 0) return null;

  return (
    <div className="mb-6 bg-amber-50 border border-amber-200 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-1">
        <AlertTriangle className="w-4 h-4 text-amber-600" />
        <h2 className="text-sm font-semibold text-amber-900">Needs attention</h2>
      </div>
      <p className="text-xs text-amber-800 mb-4">
        These paid Stealth Health orders did not take all their stock. Check the product and
        vials per unit on each line, then take the stock. It&apos;s recorded against the invoice
        and your name.
      </p>
      <div className="space-y-3">
        {invoices.map((inv) => (
          <UnstockedInvoiceCard
            key={inv.id}
            invoice={inv}
            products={products}
            onDone={() => {
              void load();
              onFixed();
            }}
          />
        ))}
      </div>
    </div>
  );
}

function UnstockedInvoiceCard({
  invoice,
  products,
  onDone,
}: {
  invoice: UnstockedInvoice;
  products: ProductOption[];
  onDone: () => void;
}) {
  const [picks, setPicks] = useState<Record<string, { product_id: string; vials_per_unit: string }>>(() =>
    Object.fromEntries(
      invoice.unlinked_lines.map((l) => [
        l.id,
        {
          product_id: l.guess_product_id ?? '',
          vials_per_unit: String(l.guess_vials_per_unit ?? (l.price_type === 'vial' ? 1 : '')),
        },
      ]),
    ),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = invoice.unlinked_lines.every((l) => {
    const p = picks[l.id];
    return p?.product_id && Number(p.vials_per_unit) >= 1;
  });

  async function takeStock() {
    setSaving(true);
    setError(null);
    try {
      await apiFetch('/api/admin/stock-ledger/needs-attention', {
        method: 'POST',
        body: JSON.stringify({
          invoice_id: invoice.id,
          links: invoice.unlinked_lines.map((l) => ({
            line_id: l.id,
            product_id: picks[l.id]?.product_id,
            vials_per_unit: Number(picks[l.id]?.vials_per_unit),
          })),
        }),
      });
      onDone();
    } catch (e: any) {
      setError(e?.message ?? 'Could not take the stock');
    }
    setSaving(false);
  }

  return (
    <div className="bg-white border border-amber-200 rounded-lg p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="text-sm">
          <Link href={`/admin/invoices/${invoice.id}`} className="font-semibold text-ink hover:underline">
            {invoice.invoice_number ? `Invoice ${invoice.invoice_number}` : 'Invoice'}
          </Link>
          <span className="text-ink-muted">
            {' · '}
            {invoice.customer_name || invoice.customer_email || 'Guest'}
            {' · '}
            {new Date(invoice.created_at).toLocaleDateString()}
          </span>
        </div>
        {invoice.stock_pending && invoice.unlinked_lines.length === 0 && (
          <span className="text-xs text-amber-800">Paid, but stock has not been taken yet</span>
        )}
      </div>

      {invoice.unlinked_lines.length > 0 && (
        <div className="space-y-2 mb-3">
          {invoice.unlinked_lines.map((l) => (
            <div key={l.id} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_110px] gap-2 items-center">
              <div className="text-sm text-ink">
                {l.description} <span className="text-ink-muted">× {l.qty}</span>
              </div>
              <select
                value={picks[l.id]?.product_id ?? ''}
                onChange={(e) =>
                  setPicks((prev) => ({ ...prev, [l.id]: { ...prev[l.id], product_id: e.target.value } }))
                }
                className={inputClass}
              >
                <option value="">Choose product…</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min={1}
                  value={picks[l.id]?.vials_per_unit ?? ''}
                  onChange={(e) =>
                    setPicks((prev) => ({ ...prev, [l.id]: { ...prev[l.id], vials_per_unit: e.target.value } }))
                  }
                  className={inputClass}
                  aria-label="Vials per unit"
                />
                <span className="text-xs text-ink-muted whitespace-nowrap">vials/unit</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {error && <div className="mb-2 text-xs text-red-600">{error}</div>}

      <button
        onClick={() => void takeStock()}
        disabled={saving || !ready}
        className="inline-flex items-center gap-1.5 bg-ink hover:bg-ink/90 text-white text-xs font-medium px-3 py-2 rounded-lg transition-colors disabled:opacity-50"
      >
        <PackageCheck className="w-3.5 h-3.5" />
        {saving ? 'Taking stock…' : 'Take stock'}
      </button>
    </div>
  );
}
