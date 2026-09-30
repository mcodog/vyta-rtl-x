'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { DollarSign, Package, ListChecks, Clock, User, ArrowRight, Info } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { apiFetch } from '@/lib/api-fetch';

type ChangeType = 'price' | 'stock' | 'general';

interface HistoryRow {
  id: string;
  created_at: string;
  product_id: string;
  change_type: ChangeType;
  field: string;
  old_value: string | null;
  new_value: string | null;
  source: string;
  reference_type: string | null;
  reference_id: string | null;
  note: string | null;
  actor_id: string | null;
  actor_email: string | null;
}

const FIELD_LABELS: Record<string, string> = {
  price: 'Price',
  stock_quantity: 'Stock quantity',
  low_stock_threshold: 'Low-stock threshold',
  name: 'Name',
  slug: 'Slug',
  sku: 'SKU',
  category: 'Category',
  strength: 'Strength',
  purity: 'Purity',
  form: 'Form',
  active: 'Status',
  featured: 'Featured',
  description_short: 'Short description',
  description: 'Full description',
  benefits: 'Benefits',
  mechanism: 'Mechanism',
  pack_sizes: 'Pack options',
  pack_options: 'Pack pricing',
  image_url: 'Image',
  coa_url: 'Certificates (COA)',
};

const SOURCE_META: Record<string, { label: string; className: string }> = {
  admin_edit: { label: 'Admin edit', className: 'bg-teal/10 text-teal-dark' },
  csv_import: { label: 'CSV import', className: 'bg-indigo-500/10 text-indigo-600' },
  invoice_paid: { label: 'Invoice paid', className: 'bg-blue-500/10 text-blue-600' },
  invoice_cancel: { label: 'Invoice cancelled', className: 'bg-blue-500/10 text-blue-600' },
  order_confirmed: { label: 'Order confirmed', className: 'bg-purple-500/10 text-purple-600' },
  order_cancelled: { label: 'Order cancelled', className: 'bg-purple-500/10 text-purple-600' },
  po_receipt: { label: 'PO received', className: 'bg-emerald-500/10 text-emerald-700' },
  untracked: { label: 'Outside the admin', className: 'bg-amber-500/10 text-amber-700' },
};

/** Admin page for the row that caused an automatic change, when there is one. */
function referenceHref(r: HistoryRow): string | null {
  if (!r.reference_id) return null;
  if (r.reference_type === 'invoice') return `/admin/invoices/${r.reference_id}`;
  if (r.reference_type === 'order') return `/admin/orders/${r.reference_id}`;
  if (r.reference_type === 'purchase_order') return `/admin/purchase-orders/${r.reference_id}`;
  return null;
}

const REFERENCE_LABELS: Record<string, string> = {
  invoice: 'View invoice',
  order: 'View order',
  purchase_order: 'View purchase order',
};

function sourceMeta(source: string) {
  return SOURCE_META[source] ?? { label: source, className: 'bg-gray-500/10 text-ink-muted' };
}

/** Human-friendly value formatting per field. */
function formatValue(field: string, value: string | null): string {
  if (value === null || value === '') return '—';
  if (field === 'price' || field === 'wholesale_price') {
    const n = Number(value);
    return Number.isFinite(n) ? `$${n.toFixed(2)}` : value;
  }
  if (field === 'low_stock_threshold') return `≤ ${value}`;
  if (field === 'active') return value === 'true' ? 'Active' : 'Inactive';
  if (field === 'featured') return value === 'true' ? 'Yes' : 'No';
  if ((field === 'image_url' || field === 'coa_url') && value.length > 40) {
    return `${value.slice(0, 37)}…`;
  }
  return value;
}

const TABS: { key: ChangeType; label: string; icon: React.ReactNode }[] = [
  { key: 'price', label: 'Price changes', icon: <DollarSign className="w-3.5 h-3.5" /> },
  { key: 'stock', label: 'Stock changes', icon: <Package className="w-3.5 h-3.5" /> },
  { key: 'general', label: 'General', icon: <ListChecks className="w-3.5 h-3.5" /> },
];

export default function ProductHistoryPanel({ productId }: { productId: string }) {
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<ChangeType>('price');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token ?? '';
        const data = await apiFetch<{ history: HistoryRow[] }>(
          `/api/admin/products/${productId}/history?limit=500`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!cancelled) setRows(data.history ?? []);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? 'Failed to load history');
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [productId]);

  const byType = useMemo(() => {
    const map: Record<ChangeType, HistoryRow[]> = { price: [], stock: [], general: [] };
    for (const r of rows) {
      if (map[r.change_type]) map[r.change_type].push(r);
    }
    return map;
  }, [rows]);

  const active = byType[tab];

  return (
    <div className="bg-surface border border-line rounded-xl p-4">
      {/* Tabs */}
      <div className="flex flex-wrap items-center gap-1.5 mb-4">
        {TABS.map((t) => {
          const count = byType[t.key].length;
          const isActive = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                isActive
                  ? 'bg-ink text-white'
                  : 'bg-white text-ink-muted border border-line hover:text-ink'
              }`}
            >
              {t.icon}
              {t.label}
              <span
                className={`ml-0.5 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full text-[10px] font-semibold ${
                  isActive ? 'bg-white/20 text-white' : 'bg-surface text-ink-muted'
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {tab === 'stock' && (
        <div className="flex items-start gap-2 mb-3 text-xs text-ink-muted bg-blue-500/5 border border-blue-500/15 rounded-lg px-3 py-2">
          <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-blue-500" />
          <span>
            Stock changes include manual edits (with who made them) and automatic moves
            when an order is <strong>confirmed</strong>, an invoice is{' '}
            <strong>paid</strong> or <strong>cancelled</strong>, or a purchase order is{' '}
            <strong>received</strong> — each linked to its source. The full ledger across
            all products is under <strong>Stock Ledger</strong>.
          </span>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-8 justify-center text-ink-muted text-sm">
          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-teal" />
          Loading history…
        </div>
      ) : error ? (
        <div className="py-6 text-center text-sm text-red-600">{error}</div>
      ) : active.length === 0 ? (
        <div className="py-8 text-center text-sm text-ink-muted">
          No {tab === 'general' ? 'general' : `${tab}`} changes recorded yet.
        </div>
      ) : (
        <ul className="space-y-2">
          {active.map((r) => {
            const sm = sourceMeta(r.source);
            return (
              <li
                key={r.id}
                className="bg-white border border-line rounded-lg px-3 py-2.5 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-ink">
                      {FIELD_LABELS[r.field] ?? r.field}
                    </span>
                    <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-medium ${sm.className}`}>
                      {sm.label}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-1 text-sm tabular-nums">
                    <span className="text-ink-muted line-through decoration-red-300">
                      {formatValue(r.field, r.old_value)}
                    </span>
                    <ArrowRight className="w-3.5 h-3.5 text-ink-muted flex-shrink-0" />
                    <span className="font-semibold text-ink">
                      {formatValue(r.field, r.new_value)}
                    </span>
                  </div>
                  {r.note && (
                    <p className="text-[11px] text-ink-muted mt-1">{r.note}</p>
                  )}
                  {referenceHref(r) && (
                    <a
                      href={referenceHref(r)!}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-teal-dark hover:underline mt-1"
                    >
                      {REFERENCE_LABELS[r.reference_type ?? ''] ?? 'View source'}
                      <ArrowRight className="w-3 h-3" />
                    </a>
                  )}
                </div>
                <div className="flex flex-col sm:items-end gap-1 text-[11px] text-ink-muted flex-shrink-0">
                  <span className="inline-flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {new Date(r.created_at).toLocaleString()}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <User className="w-3 h-3" />
                    {r.actor_email ?? 'System'}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
