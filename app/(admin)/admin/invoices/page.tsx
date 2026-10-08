'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  FileText, Plus, Search, Filter, BarChart2, ExternalLink, Download, Tag,
  ChevronLeft, ChevronRight, Trash2, Loader2, RefreshCw, Package, Printer,
  CheckCircle2, X as XIcon, AlertTriangle, Store,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import {
  getInvoices, getAgingReport, deleteInvoice, deleteInvoices as bulkDeleteInvoices,
  setInvoiceFulfillmentStatus,
  type InvoiceListItem, type InvoiceStats,
} from '@/lib/admin/invoices';
import { INVOICE_STATUS_META, INVOICE_STATUSES } from '@/lib/admin/invoice-status';
import { formatMoney, normalizeCurrency } from '@/lib/currency';
import { addDays, appDayKey, formatAppDate, todayInAppTz } from '@/lib/datetime';
import type { InvoiceStatus, AgingBucket } from '@/lib/supabase';
import PricelistsTab from '@/components/admin/PricelistsTab';
import EasyshipSyncDialog from '@/components/admin/EasyshipSyncDialog';
import { useUserRole } from '@/app/(admin)/admin/layout';
import { canDelete } from '@/lib/permissions';
import {
  InvoiceSourceBadge,
  InvoiceTotalAmount,
  PuramassShipTo,
} from '@/components/admin/PuramassInvoiceBlocks';
import { isPuramassInvoice, puramassMoneySplit } from '@/lib/admin/puramass-invoice';

type Tab = 'invoices' | 'pricelists';

const PAGE_SIZE = 20;
const EMPTY_STATS: InvoiceStats = { count: 0, outstanding: 0, overdueCount: 0, paid: 0 };

export default function InvoicesIndex() {
  const router = useRouter();
  const userRole = useUserRole();
  // Admin/assistant see all aging; affiliates see aging scoped to their own
  // customers (the /api/admin/invoices/aging route enforces that scoping).
  const canSeeAging = userRole === 'admin' || userRole === 'assistant' || userRole === 'affiliate';

  const [tab, setTab] = useState<Tab>('invoices');
  const [rows, setRows] = useState<InvoiceListItem[]>([]);
  const [stats, setStats] = useState<InvoiceStats>(EMPTY_STATS);
  const [total, setTotal] = useState(0);
  const [aging, setAging] = useState<AgingBucket[]>([]);
  const [showAging, setShowAging] = useState(false);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus | 'all'>('all');
  // Default view is paid invoices only; "Show all" unlocks the status filter.
  const [showAll, setShowAll] = useState(false);
  const effectiveStatusFilter: InvoiceStatus | 'all' = showAll ? statusFilter : 'paid';
  // Origin filter — Stealth Health hand-offs read very differently from invoices
  // raised here, and reconciling one against Stealth Health means seeing only those.
  const [sourceFilter, setSourceFilter] = useState<'all' | 'puramass' | 'manual'>('all');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  // Bulk-delete selection state (admin only).
  const canDeleteInvoices = canDelete(userRole);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Bumped after a delete to force the paginated list to re-fetch.
  const [refreshKey, setRefreshKey] = useState(0);
  // Sync-Easyship dialog is admin-only. Warehouse/assistant/affiliate never see the button.
  const [showEasyshipSync, setShowEasyshipSync] = useState(false);
  const [syncOutcome, setSyncOutcome] = useState<string | null>(null);
  // In-flight fulfillment-status changes, keyed by invoice id, so the row can
  // show a spinner without blocking siblings.
  const [fulfillmentSaving, setFulfillmentSaving] = useState<Set<string>>(new Set());
  // Per-row bulk-shipment / bulk-label progress.
  const [bulkBusy, setBulkBusy] = useState<Map<string, string>>(new Map());
  const [bulkOutcome, setBulkOutcome] = useState<string | null>(null);
  // Bulk confirmation dialogs.
  const [bulkConfirm, setBulkConfirm] = useState<null | 'shipments' | 'labels'>(null);
  // Row hover preview — the custom tooltip. Held here (not per row) so only one
  // can ever be open, and so it survives the pointer travelling onto it.
  const [preview, setPreview] = useState<{ invoice: InvoiceListItem; x: number; y: number } | null>(null);
  const previewHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce the search box and reset to the first page when the query changes.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  // Reset to the first page whenever a scope filter changes.
  useEffect(() => {
    setPage(0);
  }, [effectiveStatusFilter, sourceFilter]);

  // Server-side paginated fetch (status + search + page).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getInvoices({
      status: effectiveStatusFilter !== 'all' ? effectiveStatusFilter : undefined,
      source: sourceFilter !== 'all' ? sourceFilter : undefined,
      q: debouncedSearch || undefined,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    })
      .then((res) => {
        if (cancelled) return;
        setRows(res.invoices);
        setTotal(res.total);
        setStats(res.stats);
        setSelected(new Set());
      })
      .catch((err) => {
        if (cancelled) return;
        // Never leave the page stuck in a loading spinner on error.
        console.error('Failed to load invoices:', err);
        setRows([]);
        setTotal(0);
        setStats(EMPTY_STATS);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [effectiveStatusFilter, sourceFilter, debouncedSearch, page, refreshKey]);

  // Aging report is an admin/assistant tool; load it once for them only.
  useEffect(() => {
    if (!canSeeAging) return;
    getAgingReport().then(setAging).catch(() => {});
  }, [canSeeAging]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeStart = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd = Math.min(total, (page + 1) * PAGE_SIZE);
  const hasFilters =
    debouncedSearch.length > 0 || effectiveStatusFilter !== 'all' || sourceFilter !== 'all';

  const openPdf = async (id: string, download = false) => {
    const { data: { session } } = await supabase.auth.getSession();
    const url = `/api/admin/invoices/${id}/pdf${download ? '?download=1' : ''}`;
    const res = await fetch(url, {
      headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
    });
    if (!res.ok) return alert('Could not open invoice PDF');
    const blob = await res.blob();
    window.open(URL.createObjectURL(blob), '_blank');
  };

  // ---- Selection + bulk delete ----
  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allVisibleSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const toggleAll = () => {
    setSelected((prev) => {
      if (rows.length > 0 && rows.every((r) => prev.has(r.id))) return new Set();
      return new Set(rows.map((r) => r.id));
    });
  };

  const deleteInvoicesLocal = async (ids: string[]) => {
    if (ids.length === 0) return;
    const confirmed = window.confirm(
      `Delete ${ids.length} invoice${ids.length !== 1 ? 's' : ''}? ` +
      `The linked orders are removed too when multiple invoices are deleted at once. ` +
      `Line items and payments are cascaded. This cannot be undone.`,
    );
    if (!confirmed) return;

    setDeleting(true);
    setDeleteError(null);
    try {
      if (ids.length === 1) {
        // Single-invoice DELETE leaves the paired order intact (per spec).
        const r = await deleteInvoice(ids[0]);
        if (!r.success) {
          setDeleteError(r.error ?? 'Failed to delete invoice');
        }
      } else {
        // Bulk DELETE also tears down the paired orders and releases wallet
        // addresses back to the pool.
        const r = await bulkDeleteInvoices(ids);
        if (!r.success) {
          setDeleteError(r.error ?? 'Failed to delete invoices');
        }
      }
      if (ids.length >= rows.length && page > 0) {
        setPage((p) => Math.max(0, p - 1));
      } else {
        setRefreshKey((k) => k + 1);
      }
    } finally {
      setDeleting(false);
    }
  };

  const handleDeleteSelected = () => deleteInvoicesLocal(Array.from(selected));

  // ---- Bulk shipment / label helpers ----

  /** Run `task` over `items` with up to `concurrency` promises in flight. */
  async function runPool<T, R>(
    items: T[],
    concurrency: number,
    task: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let idx = 0;
    async function worker() {
      while (idx < items.length) {
        const i = idx++;
        results[i] = await task(items[i]);
      }
    }
    const pool = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(pool);
    return results;
  }

  /** Selected rows that are eligible for shipment creation:
   *  linked to an order, not pickup, no shipment yet. */
  const shipmentEligible = React.useMemo(
    () => rows.filter((r) => selected.has(r.id)
      && (r as any).order_id
      && ((r as any).fulfillment_type ?? 'shipment') !== 'pickup'
      && !(r as any).easyship_shipment_id),
    [rows, selected],
  );

  /** Selected rows that are eligible for label purchase:
   *  linked to an order, have a shipment, no label yet. */
  const labelEligible = React.useMemo(
    () => rows.filter((r) => selected.has(r.id)
      && (r as any).order_id
      && (r as any).easyship_shipment_id
      && (r as any).label_state !== 'generated'),
    [rows, selected],
  );

  async function runBulkShipments() {
    setBulkConfirm(null);
    if (shipmentEligible.length === 0) return;
    setBulkOutcome(null);
    const token = (await supabase.auth.getSession()).data.session?.access_token;
    let ok = 0;
    let failed = 0;
    await runPool(shipmentEligible, 4, async (inv) => {
      setBulkBusy((prev) => new Map(prev).set(inv.id, 'Creating shipment…'));
      try {
        const res = await fetch(`/api/admin/orders/${(inv as any).order_id}/create-shipment`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({}),
        });
        if (res.ok) ok += 1; else failed += 1;
      } catch {
        failed += 1;
      } finally {
        setBulkBusy((prev) => {
          const next = new Map(prev);
          next.delete(inv.id);
          return next;
        });
      }
    });
    setBulkOutcome(
      `Shipments created: ${ok}` + (failed ? ` · ${failed} failed` : ''),
    );
    setRefreshKey((k) => k + 1);
  }

  async function runBulkLabels() {
    setBulkConfirm(null);
    if (labelEligible.length === 0) return;
    setBulkOutcome(null);
    const token = (await supabase.auth.getSession()).data.session?.access_token;
    let ok = 0;
    let failed = 0;
    await runPool(labelEligible, 4, async (inv) => {
      setBulkBusy((prev) => new Map(prev).set(inv.id, 'Buying label…'));
      try {
        const res = await fetch(`/api/admin/orders/${(inv as any).order_id}/buy-label`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
        if (res.ok) ok += 1; else failed += 1;
      } catch {
        failed += 1;
      } finally {
        setBulkBusy((prev) => {
          const next = new Map(prev);
          next.delete(inv.id);
          return next;
        });
      }
    });
    setBulkOutcome(
      `Labels purchased: ${ok}` + (failed ? ` · ${failed} failed` : ''),
    );
    setRefreshKey((k) => k + 1);
  }

  const updateFulfillment = async (
    id: string,
    status: 'pending' | 'packed' | 'shipped' | 'picked_up' | 'dropped_off',
  ) => {
    // Optimistic: flip the row's status instantly so the select doesn't feel laggy.
    setRows((prev) => prev.map((r) => r.id === id ? { ...r, fulfillment_status: status } as any : r));
    setFulfillmentSaving((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    const res = await setInvoiceFulfillmentStatus(id, status);
    setFulfillmentSaving((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    if (!res.success) {
      // Revert on failure by re-fetching the page.
      setRefreshKey((k) => k + 1);
      alert(res.error ?? 'Failed to update fulfillment status');
    }
  };

  // Total table columns, used for the day-divider colSpan. The issue date isn't
  // a column — the day divider above each group already carries it.
  const columnCount = canDeleteInvoices ? 8 : 7;

  // Group the invoices on this page by issue date, so the table shows a
  // readable divider each time the day changes.
  const invoiceGroups = React.useMemo(() => {
    // Day keys are New York calendar days, whatever zone the viewer is in.
    const todayKey = todayInAppTz();
    const yesterdayKey = addDays(todayKey, -1);

    const groups: {
      key: string;
      label: string;
      relative: string | null;
      invoices: InvoiceListItem[];
      count: number;
      totals: Record<string, number>;
    }[] = [];
    const index = new Map<string, number>();

    for (const inv of rows) {
      const key = appDayKey(inv.issue_date) ?? String(inv.issue_date);
      let gi = index.get(key);
      if (gi === undefined) {
        gi = groups.length;
        index.set(key, gi);
        groups.push({
          key,
          label: formatAppDate(key, {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          }),
          relative: key === todayKey ? 'Today' : key === yesterdayKey ? 'Yesterday' : null,
          invoices: [],
          count: 0,
          totals: {},
        });
      }
      const g = groups[gi];
      g.invoices.push(inv);
      g.count += 1;
      // A Stealth Health sale can straddle two currencies (goods as Stealth Health charged
      // them, shipping in ours), so it lands in both buckets rather than
      // putting a mixed sum under the invoice's stored currency.
      const split = puramassMoneySplit(inv, inv.puramass);
      if (split) {
        g.totals[split.goodsCurrency] = (g.totals[split.goodsCurrency] ?? 0) + split.goods;
        g.totals[split.shippingCurrency] =
          (g.totals[split.shippingCurrency] ?? 0) + split.shipping;
      } else {
        const gcur = normalizeCurrency(inv.currency);
        g.totals[gcur] = (g.totals[gcur] ?? 0) + (Number(inv.total) || 0);
      }
    }
    return groups;
  }, [rows]);

  /** Navigate to the invoice. Shared by the row click and the hover preview. */
  const openInvoice = (id: string) => {
    setPreview(null);
    router.push(`/admin/invoices/${id}`);
  };

  /** Interactive cells (checkbox, selects, buttons) opt out of the row click. */
  const stopRowClick = (e: React.MouseEvent) => e.stopPropagation();

  // Anchored where the pointer entered the row, not tracked on every move —
  // re-positioning on mousemove would re-render the whole table each frame.
  const showPreview = (inv: InvoiceListItem, e: React.MouseEvent) => {
    if (previewHideTimer.current) clearTimeout(previewHideTimer.current);
    setPreview({ invoice: inv, x: e.clientX, y: e.clientY });
  };

  /** Small grace period so the pointer can travel onto the tooltip itself. */
  const schedulePreviewHide = () => {
    if (previewHideTimer.current) clearTimeout(previewHideTimer.current);
    previewHideTimer.current = setTimeout(() => setPreview(null), 120);
  };

  const keepPreview = () => {
    if (previewHideTimer.current) clearTimeout(previewHideTimer.current);
  };

  // Never leave a tooltip behind when the page unmounts or the list re-renders
  // out from under it.
  useEffect(() => () => {
    if (previewHideTimer.current) clearTimeout(previewHideTimer.current);
  }, []);
  useEffect(() => { setPreview(null); }, [rows]);

  const renderInvoiceRow = (inv: InvoiceListItem) => {
    const effective = inv.status_effective ?? inv.status;
    const meta = INVOICE_STATUS_META[effective];
    const isOverdueRow = effective === 'overdue';
    // Stealth Health hand-off behind this invoice, when there is one. Everything it
    // carries (phone, ship-to, transaction) comes from Stealth Health, never from
    // this admin — the badge and the "From Stealth Health" chip say so.
    const pm = inv.puramass ?? null;
    return (
      <tr
        key={inv.id}
        onClick={() => openInvoice(inv.id)}
        onMouseEnter={(e) => showPreview(inv, e)}
        onMouseLeave={schedulePreviewHide}
        className={`cursor-pointer hover:bg-surface transition-colors ${selected.has(inv.id) ? 'bg-teal/5' : ''}`}
      >
        {canDeleteInvoices && (
          <td className="px-5 py-4" onClick={stopRowClick}>
            <input
              type="checkbox"
              checked={selected.has(inv.id)}
              onChange={() => toggleOne(inv.id)}
              aria-label={`Select invoice ${inv.invoice_number}`}
              className="w-4 h-4 rounded border-line text-teal-dark focus:ring-teal/40 cursor-pointer"
            />
          </td>
        )}
        <td className="px-5 py-4">
          {/* Kept as a real link for keyboard users and open-in-new-tab; the
              row's own click handler covers everything else. */}
          <Link
            href={`/admin/invoices/${inv.id}`}
            onClick={stopRowClick}
            className="font-mono text-sm text-ink hover:text-teal-dark"
          >
            {inv.invoice_number}
          </Link>
          {inv.is_backorder && (
            <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-700 align-middle">
              Backorder
            </span>
          )}
          {/* Origin sits on its own line under the number — beside it, the
              chip crowded the invoice code. */}
          {isPuramassInvoice(inv) && (
            <div className="mt-1">
              <InvoiceSourceBadge source={inv.source} compact />
            </div>
          )}
          {pm?.transaction_id && (
            <div
              className="mt-0.5 font-mono text-[10px] text-ink-light truncate max-w-[10rem]"
              title={`Stealth Health transaction ${pm.transaction_id}`}
            >
              {pm.transaction_id}
            </div>
          )}
        </td>
        <td className="px-5 py-4">
          <div className="text-sm text-ink">{inv.customer_name_display ?? '—'}</div>
          {inv.customer_email_display && (
            <div className="text-xs text-ink-muted">{inv.customer_email_display}</div>
          )}
          {/* Stealth Health collects the buyer's phone and ship-to on its hosted page;
              neither is on the invoice row, so both come off the hand-off ledger. */}
          {pm?.customer_phone && (
            <div className="text-xs text-ink-muted">{pm.customer_phone}</div>
          )}
          {pm && (
            <div className="mt-1.5 max-w-[16rem]">
              <PuramassShipTo puramass={pm} compact />
            </div>
          )}
        </td>
        <td className={`px-5 py-4 text-sm whitespace-nowrap ${isOverdueRow ? 'text-red-600 font-medium' : 'text-ink-muted'}`}>
          {formatAppDate(inv.due_date, {})}
        </td>
        <td className="px-5 py-4 text-sm font-semibold text-ink whitespace-nowrap">
          <InvoiceTotalAmount invoice={inv} puramass={pm} align="left" />
        </td>
        <td className="px-5 py-4">
          <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${meta.badge}`}>{meta.label}</span>
        </td>
        <td className="px-5 py-4 whitespace-nowrap" onClick={stopRowClick}>
          {(() => {
            const ft = (inv as any).fulfillment_type ?? 'shipment';
            const fs = (inv as any).fulfillment_status ?? 'pending';
            const options = ft === 'pickup'
              ? [
                  { v: 'pending', l: 'To pack' },
                  { v: 'packed', l: 'Packed' },
                  { v: 'picked_up', l: 'Picked up' },
                ]
              : [
                  { v: 'pending', l: 'To pack' },
                  { v: 'packed', l: 'Packed' },
                  { v: 'shipped', l: 'Shipped' },
                  { v: 'dropped_off', l: 'Dropped off' },
                ];
            return (
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-1.5">
                  <select
                    value={fs}
                    onChange={(e) => updateFulfillment(inv.id, e.target.value as any)}
                    onClick={(e) => e.stopPropagation()}
                    disabled={fulfillmentSaving.has(inv.id) || !canDeleteInvoices}
                    className="text-xs bg-surface border border-line rounded px-1.5 py-0.5 focus:outline-none focus:ring-2 focus:ring-teal/40 disabled:opacity-60"
                    aria-label="Fulfillment status"
                  >
                    {options.map((o) => (
                      <option key={o.v} value={o.v}>{o.l}</option>
                    ))}
                  </select>
                  {fulfillmentSaving.has(inv.id) && (
                    <Loader2 className="w-3 h-3 animate-spin text-ink-muted" />
                  )}
                </div>
                {bulkBusy.has(inv.id) && (
                  <span className="text-[10px] text-teal-dark inline-flex items-center gap-1">
                    <Loader2 className="w-2.5 h-2.5 animate-spin" />
                    {bulkBusy.get(inv.id)}
                  </span>
                )}
                {(inv as any).tracking_number && (
                  <span className="text-[10px] text-ink-muted font-mono truncate max-w-[8rem]">
                    {(inv as any).tracking_number}
                  </span>
                )}
                {pm && !pm.shipping_address && (
                  <span
                    className="inline-flex items-center gap-1 text-[10px] text-amber-700"
                    title="Stealth Health has not reported a shipping address for this order — it can't be packed until one arrives. Re-sync it, or ask the customer, on Stealth Health Orders."
                  >
                    <AlertTriangle className="w-2.5 h-2.5" /> No address
                  </span>
                )}
              </div>
            );
          })()}
        </td>
        <td className="px-5 py-4" onClick={stopRowClick}>
          <div className="flex items-center gap-1">
            <Link
              href={`/admin/invoices/${inv.id}`}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-ink-muted hover:text-ink hover:bg-surface"
              title="View"
            >
              <ExternalLink className="w-4 h-4" />
            </Link>
            <button
              onClick={() => openPdf(inv.id, false)}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-ink-muted hover:text-ink hover:bg-surface"
              title="View PDF"
            >
              <FileText className="w-4 h-4" />
            </button>
            <button
              onClick={() => openPdf(inv.id, true)}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-ink-muted hover:text-ink hover:bg-surface"
              title="Download / Print"
            >
              <Download className="w-4 h-4" />
            </button>
            {canDeleteInvoices && (
              <button
                onClick={() => deleteInvoicesLocal([inv.id])}
                disabled={deleting}
                className="w-8 h-8 flex items-center justify-center rounded-lg text-ink-muted hover:text-red-600 hover:bg-red-50 disabled:opacity-50"
                title="Delete invoice"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        </td>
      </tr>
    );
  };

  return (
    <>
      {/* Tabs */}
      <div className="flex items-center gap-1 mb-6 border-b border-line">
        <TabButton active={tab === 'invoices'} onClick={() => setTab('invoices')} icon={FileText}>
          Invoices
        </TabButton>
        <TabButton active={tab === 'pricelists'} onClick={() => setTab('pricelists')} icon={Tag}>
          Pricelists
        </TabButton>
      </div>

      {tab === 'pricelists' ? (
        <PricelistsTab />
      ) : (
      <>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-ink flex items-center gap-2">
            <FileText className="w-6 h-6 text-teal-dark" /> Invoices
          </h1>
          <p className="text-sm text-ink-muted mt-1">{stats.count} invoice{stats.count !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex gap-2">
          {canSeeAging && (
            <button
              onClick={() => setShowAging((v) => !v)}
              className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm transition-colors ${
                showAging
                  ? 'bg-teal/10 border border-teal text-teal-dark'
                  : 'bg-white border border-line text-ink-muted hover:text-ink hover:border-ink/20'
              }`}
            >
              <BarChart2 className="w-4 h-4" /> Aging
            </button>
          )}
          {userRole === 'admin' && (
            <button
              onClick={() => setShowEasyshipSync(true)}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-line text-ink-muted hover:text-ink hover:border-ink/20 rounded-lg text-sm transition-colors"
              title="Match Easyship shipments to invoices"
            >
              <RefreshCw className="w-4 h-4" /> Sync Easyship
            </button>
          )}
          {/* New Order creates the order + its draft invoice and lands on the
              invoice. Order creation is admin-only (the POST route enforces it),
              so only surface the button for admins. */}
          {userRole === 'admin' && (
            <Link
              href="/admin/orders/new"
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-line text-ink-muted hover:text-ink hover:border-ink/20 rounded-lg text-sm font-medium transition-colors"
              title="Create an order (with its invoice) — shipping, labels & tracking"
            >
              <Package className="w-4 h-4" /> New Order
            </Link>
          )}
          {/* Affiliates may create invoices too — the create endpoint scopes
              them to their own bound customers. */}
          <Link
            href="/admin/invoices/new"
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-ink hover:bg-ink/90 text-white rounded-lg text-sm font-medium"
          >
            <Plus className="w-4 h-4" /> New Invoice
          </Link>
        </div>
      </div>

      {syncOutcome && (
        <div className="mb-4 flex items-start justify-between gap-3 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-lg">
          <span className="text-sm text-emerald-800">{syncOutcome}</span>
          <button onClick={() => setSyncOutcome(null)} className="text-emerald-700 hover:text-emerald-900">
            <Trash2 className="w-3.5 h-3.5 opacity-0" />
          </button>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <StatCard label="Total" value={stats.count} />
        <StatCard label="Outstanding" value={`$${stats.outstanding.toFixed(2)}`} highlight />
        <StatCard label="Overdue" value={stats.overdueCount} tone={stats.overdueCount > 0 ? 'danger' : 'normal'} />
        <StatCard label="Paid" value={stats.paid} />
      </div>

      {/* Aging panel */}
      {showAging && (
        <div className="bg-white rounded-xl border border-line p-5 mb-6">
          <h3 className="text-sm font-semibold text-ink mb-3">Accounts Receivable Aging</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 sm:divide-x divide-line/50 border border-line rounded-lg overflow-hidden">
            {aging.map((b) => (
              <div key={b.label} className="px-3 py-3 text-center bg-surface">
                <div className="text-[10px] uppercase tracking-wider text-ink-muted">{b.label}</div>
                <div className="mt-1 text-lg font-bold text-ink tabular-nums">${b.total.toFixed(2)}</div>
                <div className="text-xs text-ink-muted">{b.count} inv.</div>
              </div>
            ))}
          </div>
          <div className="mt-3 text-right text-sm">
            <span className="text-ink-muted">Grand total: </span>
            <span className="font-semibold text-ink tabular-nums">
              ${aging.reduce((s, b) => s + b.total, 0).toFixed(2)}
            </span>
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
          <input
            type="text"
            placeholder="Search by invoice # or customer..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-white border border-line rounded-lg text-sm text-ink placeholder-ink-muted focus:outline-none focus:ring-2 focus:ring-teal/40"
          />
        </div>
        <div className="relative">
          <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
          <select
            value={effectiveStatusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
            disabled={!showAll}
            title={showAll ? undefined : 'Turn on "Show all" to filter by other statuses'}
            className="w-full sm:w-auto pl-10 pr-8 py-2.5 bg-white border border-line rounded-lg text-sm text-ink focus:outline-none focus:ring-2 focus:ring-teal/40 appearance-none disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <option value="all">All Statuses</option>
            {INVOICE_STATUSES.map((s) => (
              <option key={s} value={s}>{INVOICE_STATUS_META[s].label}</option>
            ))}
          </select>
        </div>
        <div className="relative">
          <Store className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value as any)}
            title="Where the invoice came from"
            className="w-full sm:w-auto pl-10 pr-8 py-2.5 bg-white border border-line rounded-lg text-sm text-ink focus:outline-none focus:ring-2 focus:ring-teal/40 appearance-none"
          >
            <option value="all">All Sources</option>
            <option value="puramass">Stealth Health orders</option>
            <option value="manual">Created here</option>
          </select>
        </div>
        <label className="inline-flex items-center gap-2 px-3 py-2.5 bg-white border border-line rounded-lg text-sm text-ink cursor-pointer select-none whitespace-nowrap">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => setShowAll(e.target.checked)}
            className="w-4 h-4 rounded border-line text-teal-dark focus:ring-teal/40 cursor-pointer"
          />
          Show all
        </label>
      </div>

      {/* Bulk actions */}
      {canDeleteInvoices && selected.size > 0 && (
        <div className="flex items-center justify-between gap-3 mb-4 px-4 py-3 bg-teal/5 border border-teal/30 rounded-lg flex-wrap">
          <span className="text-sm text-ink">
            {selected.size} invoice{selected.size !== 1 ? 's' : ''} selected
          </span>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setBulkConfirm('shipments')}
              disabled={bulkBusy.size > 0 || shipmentEligible.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-ink hover:bg-ink/90 text-white text-sm font-medium disabled:opacity-50"
              title={shipmentEligible.length === 0 ? 'No eligible shipments in selection' : `Create ${shipmentEligible.length} shipment(s)`}
            >
              <Package className="w-4 h-4" />
              Create shipments{shipmentEligible.length > 0 ? ` (${shipmentEligible.length})` : ''}
            </button>
            <button
              onClick={() => setBulkConfirm('labels')}
              disabled={bulkBusy.size > 0 || labelEligible.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white hover:bg-surface border border-line text-ink text-sm font-medium disabled:opacity-50"
              title={labelEligible.length === 0 ? 'No labels to buy in selection' : `Buy ${labelEligible.length} label(s)`}
            >
              <Printer className="w-4 h-4" />
              Buy labels{labelEligible.length > 0 ? ` (${labelEligible.length})` : ''}
            </button>
            <button
              onClick={() => setSelected(new Set())}
              disabled={deleting || bulkBusy.size > 0}
              className="px-3 py-1.5 rounded-lg border border-line text-sm text-ink-muted hover:text-ink hover:border-ink/20 disabled:opacity-50"
            >
              Clear
            </button>
            <button
              onClick={handleDeleteSelected}
              disabled={deleting || bulkBusy.size > 0}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium disabled:opacity-50"
            >
              {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              Delete selected
            </button>
          </div>
        </div>
      )}
      {bulkOutcome && (
        <div className="mb-4 flex items-start justify-between gap-3 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-lg">
          <div className="flex items-start gap-2 text-sm text-emerald-800">
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{bulkOutcome}</span>
          </div>
          <button onClick={() => setBulkOutcome(null)} className="text-emerald-700 hover:text-emerald-900">
            <XIcon className="w-4 h-4" />
          </button>
        </div>
      )}
      {deleteError && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{deleteError}</div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl border border-line overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead>
              <tr className="border-b border-line">
                {canDeleteInvoices && (
                  <th className="px-5 py-3 text-left w-10">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleAll}
                      aria-label="Select all invoices on this page"
                      className="w-4 h-4 rounded border-line text-teal-dark focus:ring-teal/40 cursor-pointer"
                    />
                  </th>
                )}
                {['Invoice', 'Customer', 'Due', 'Total', 'Status', 'Shipping', ''].map((h, i) => (
                  <th key={h || `col-${i}`} className="px-5 py-3 text-left text-xs font-semibold text-ink-muted uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line/50">
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} showCheckbox={canDeleteInvoices} />)
              ) : rows.length === 0 ? (
                <tr><td colSpan={columnCount} className="px-5 py-12 text-center text-sm text-ink-muted">
                  {hasFilters ? 'No invoices match your filters' : 'No invoices yet'}
                </td></tr>
              ) : invoiceGroups.map((group) => (
                <React.Fragment key={group.key}>
                  <tr className="bg-surface/70">
                    <td colSpan={columnCount} className="px-5 py-2.5 border-y border-line">
                      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                        <div className="flex items-baseline gap-2">
                          {group.relative && (
                            <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-teal/10 text-teal-dark">
                              {group.relative}
                            </span>
                          )}
                          <span className="text-sm font-semibold text-ink">{group.label}</span>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-ink-muted">
                          <span>{group.count} invoice{group.count !== 1 ? 's' : ''}</span>
                          <span className="text-line">•</span>
                          <span className="font-medium text-ink tabular-nums">
                            {(['CAD', 'USD'] as const)
                              .filter((cur) => group.totals[cur])
                              .map((cur) => `${formatMoney(group.totals[cur], cur)} ${cur}`)
                              .join(' · ') || `${formatMoney(0, 'CAD')} CAD`}
                            {' '}total
                          </span>
                        </div>
                      </div>
                    </td>
                  </tr>
                  {group.invoices.map((inv) => renderInvoiceRow(inv))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {!loading && total > 0 && (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-5 py-3 border-t border-line">
            <span className="text-sm text-ink-muted">
              Showing <span className="font-medium text-ink tabular-nums">{rangeStart}</span>–
              <span className="font-medium text-ink tabular-nums">{rangeEnd}</span> of{' '}
              <span className="font-medium text-ink tabular-nums">{total}</span>
            </span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-ink-muted">Page {page + 1} of {totalPages}</span>
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-line text-sm text-ink-muted hover:text-ink hover:border-ink/20 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronLeft className="w-4 h-4" /> Prev
              </button>
              <button
                onClick={() => setPage((p) => (p + 1 < totalPages ? p + 1 : p))}
                disabled={page + 1 >= totalPages}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-line text-sm text-ink-muted hover:text-ink hover:border-ink/20 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
      </>
      )}

      {/* Row hover preview. A plain title attribute can't carry the customer,
          the ship-to or a click target, so this is a real floating card —
          clicking it opens the same invoice the row does. */}
      {preview && (
        <InvoicePreviewCard
          invoice={preview.invoice}
          x={preview.x}
          y={preview.y}
          onOpen={() => openInvoice(preview.invoice.id)}
          onMouseEnter={keepPreview}
          onMouseLeave={schedulePreviewHide}
        />
      )}

      <EasyshipSyncDialog
        open={showEasyshipSync}
        onClose={() => setShowEasyshipSync(false)}
        onApplied={(r) => {
          setSyncOutcome(
            `Easyship sync applied: ${r.applied} attached` +
            (r.skipped ? ` · ${r.skipped} skipped` : '') +
            (r.failed ? ` · ${r.failed} failed` : ''),
          );
          setRefreshKey((k) => k + 1);
        }}
      />

      {/* Bulk shipment / label confirmation. Different copy per action —
          "Create shipments" flags rows that will be skipped; "Buy labels"
          warns about wallet funds since Easyship charges on purchase. */}
      {bulkConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl w-full max-w-md p-6 shadow-xl">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                <AlertTriangle className="w-4 h-4 text-amber-600" />
              </div>
              <h3 className="font-bold text-ink">
                {bulkConfirm === 'shipments' ? 'Create shipments' : 'Buy shipping labels'}
              </h3>
            </div>
            {bulkConfirm === 'shipments' ? (
              <>
                <p className="text-sm text-ink-muted mb-3">
                  {shipmentEligible.length} eligible invoice{shipmentEligible.length !== 1 ? 's' : ''} will
                  have an Easyship shipment created. Rows without a linked order,
                  pickup rows, and rows already carrying a shipment are skipped.
                </p>
                {selected.size > shipmentEligible.length && (
                  <p className="text-xs text-amber-600 mb-3">
                    {selected.size - shipmentEligible.length} of {selected.size} selected row(s) will be skipped.
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="text-sm text-ink-muted mb-3">
                  {labelEligible.length} shipping label{labelEligible.length !== 1 ? 's' : ''} will
                  be purchased from Easyship. <strong className="text-ink">Your Easyship wallet will
                  be charged.</strong>
                </p>
                {selected.size > labelEligible.length && (
                  <p className="text-xs text-amber-600 mb-3">
                    {selected.size - labelEligible.length} of {selected.size} selected row(s) will be skipped
                    (no shipment or label already bought).
                  </p>
                )}
              </>
            )}
            <div className="flex gap-3 mt-5">
              <button
                onClick={() => setBulkConfirm(null)}
                className="flex-1 px-4 py-2 border border-line rounded-lg text-sm text-ink-muted hover:text-ink"
              >
                Cancel
              </button>
              <button
                onClick={bulkConfirm === 'shipments' ? runBulkShipments : runBulkLabels}
                className={`flex-1 px-4 py-2 text-white rounded-lg text-sm font-medium ${
                  bulkConfirm === 'shipments' ? 'bg-ink hover:bg-ink/90' : 'bg-teal hover:bg-teal/90'
                }`}
              >
                {bulkConfirm === 'shipments' ? 'Create' : 'Buy labels'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * The floating preview shown while a row is hovered: a white, rounded, shadowed
 * card that summarises the invoice and doubles as a click target for it.
 *
 * Positioned from the pointer and clamped to the viewport, so it never runs off
 * the bottom or the right edge of a long table.
 */
function InvoicePreviewCard({
  invoice,
  x,
  y,
  onOpen,
  onMouseEnter,
  onMouseLeave,
}: {
  invoice: InvoiceListItem;
  x: number;
  y: number;
  onOpen: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const CARD_W = 320;
  const CARD_H = 300;
  const GAP = 16;
  // Flip to the other side of the pointer when there isn't room.
  const left = typeof window !== 'undefined' && x + GAP + CARD_W > window.innerWidth
    ? Math.max(GAP, x - GAP - CARD_W)
    : x + GAP;
  const top = typeof window !== 'undefined' && y + GAP + CARD_H > window.innerHeight
    ? Math.max(GAP, window.innerHeight - CARD_H - GAP)
    : y + GAP;

  const effective = invoice.status_effective ?? invoice.status;
  const meta = INVOICE_STATUS_META[effective];
  const cur = normalizeCurrency(invoice.currency);
  const pm = invoice.puramass ?? null;
  const fs = (invoice as any).fulfillment_status ?? 'pending';

  return (
    <div
      role="link"
      tabIndex={-1}
      onClick={onOpen}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{ left, top, width: CARD_W }}
      className="fixed z-40 cursor-pointer bg-white border border-line rounded-xl shadow-xl p-4 text-left"
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="font-mono text-sm font-semibold text-ink">{invoice.invoice_number}</span>
        <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-medium ${meta.badge}`}>
          {meta.label}
        </span>
      </div>

      <div className="flex items-center gap-1.5 mb-3">
        <InvoiceSourceBadge source={invoice.source} />
        {invoice.is_backorder && (
          <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-700">
            Backorder
          </span>
        )}
      </div>

      <div className="space-y-0.5 mb-3">
        <div className="text-sm text-ink">{invoice.customer_name_display ?? 'Guest / offline'}</div>
        {invoice.customer_email_display && (
          <div className="text-xs text-ink-muted break-words">{invoice.customer_email_display}</div>
        )}
        {pm?.customer_phone && <div className="text-xs text-ink-muted">{pm.customer_phone}</div>}
      </div>

      {pm && (
        <div className="mb-3 pb-3 border-b border-line/60">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted mb-1">
            Ship to · via Stealth Health
          </div>
          <PuramassShipTo puramass={pm} compact />
        </div>
      )}

      <div className="space-y-1 text-xs">
        <div className="flex justify-between">
          <span className="text-ink-muted">Total</span>
          <InvoiceTotalAmount
            invoice={invoice}
            puramass={pm}
            className="font-semibold text-ink"
          />
        </div>
        {invoice.amount_due > 0 && (
          <div className="flex justify-between">
            <span className="text-ink-muted">Amount due</span>
            <span className="tabular-nums text-teal-dark">{formatMoney(invoice.amount_due, cur)}</span>
          </div>
        )}
        <div className="flex justify-between">
          <span className="text-ink-muted">Issued</span>
          <span className="text-ink">{formatAppDate(invoice.issue_date, {})}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-ink-muted">Due</span>
          <span className={effective === 'overdue' ? 'text-red-600 font-medium' : 'text-ink'}>
            {formatAppDate(invoice.due_date, {})}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-ink-muted">Fulfilment</span>
          <span className="text-ink capitalize">{String(fs).replace('_', ' ')}</span>
        </div>
      </div>

      <div className="mt-3 pt-3 border-t border-line/60 text-xs font-medium text-teal-dark">
        Open invoice →
      </div>
    </div>
  );
}

function SkeletonRow({ showCheckbox = false }: { showCheckbox?: boolean }) {
  return (
    <tr className="animate-pulse">
      {showCheckbox && <td className="px-5 py-4"><div className="h-4 w-4 bg-surface rounded" /></td>}
      <td className="px-5 py-4"><div className="h-4 w-24 bg-surface rounded" /></td>
      <td className="px-5 py-4">
        <div className="h-3.5 w-32 bg-surface rounded mb-1.5" />
        <div className="h-3 w-40 bg-surface rounded" />
      </td>
      <td className="px-5 py-4"><div className="h-3.5 w-20 bg-surface rounded" /></td>
      <td className="px-5 py-4"><div className="h-4 w-16 bg-surface rounded" /></td>
      <td className="px-5 py-4"><div className="h-5 w-16 bg-surface rounded-full" /></td>
      <td className="px-5 py-4"><div className="h-5 w-20 bg-surface rounded" /></td>
      <td className="px-5 py-4">
        <div className="flex items-center gap-1">
          <div className="w-8 h-8 bg-surface rounded-lg" />
          <div className="w-8 h-8 bg-surface rounded-lg" />
          <div className="w-8 h-8 bg-surface rounded-lg" />
        </div>
      </td>
    </tr>
  );
}

function TabButton({
  active, onClick, icon: Icon, children,
}: { active: boolean; onClick: () => void; icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active
          ? 'border-teal text-teal-dark'
          : 'border-transparent text-ink-muted hover:text-ink'
      }`}
    >
      <Icon className="w-4 h-4" /> {children}
    </button>
  );
}

function StatCard({
  label, value, highlight, tone = 'normal',
}: { label: string; value: string | number; highlight?: boolean; tone?: 'normal' | 'danger' }) {
  const valueColor =
    tone === 'danger'
      ? 'text-red-600'
      : highlight
        ? 'text-teal-dark'
        : 'text-ink';
  return (
    <div className={`bg-white rounded-xl border ${highlight ? 'border-teal/40' : 'border-line'} p-4`}>
      <div className="text-xs font-semibold text-ink-muted uppercase tracking-wider">{label}</div>
      <div className={`mt-1 text-xl font-bold tabular-nums ${valueColor}`}>{value}</div>
    </div>
  );
}
