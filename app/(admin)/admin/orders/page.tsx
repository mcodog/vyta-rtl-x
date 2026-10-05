'use client';

import React, { useState, useEffect } from 'react';
import { Search, Filter, Eye, Truck, Printer, PackagePlus, ExternalLink, Loader2, Trash2, FileText } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  getAllOrders,
  updateOrderStatus,
  createOrderShipment,
  buyOrderLabel,
  fetchLabelBlob,
  deleteOrder,
} from '@/lib/admin/api';
import { getOrCreateInvoiceForOrder } from '@/lib/admin/invoices';
import { useUserRole } from '../layout';
import { canEdit, canDelete } from '@/lib/permissions';
import { printPdfBlob } from '@/lib/print-pdf';
import { APP_TIME_ZONE, addDays, appDayKey, formatAppDate, todayInAppTz } from '@/lib/datetime';
import BulkShipmentDialog, { type SkippedOrder } from './_components/BulkShipmentDialog';

// A selected order fails the bulk *create shipment* check when it can't have a
// shipment record made. Returns the human reason, or null when it qualifies.
function shipmentBlockReason(order: any): string | null {
  if (order.fulfillment_type === 'pickup') return 'Pickup order — no shipment needed';
  if (order.easyship_shipment_id) return 'Shipment already created';
  const dest = order.shipping_address;
  if (!dest?.address || !dest?.city) return 'Missing shipping address';
  if (!dest?.postalCode) return 'Missing postal code';
  if (!dest?.country) return 'Missing country';
  return null;
}

// A selected order fails the bulk *buy label* check when a label can't be
// purchased for it. Returns the human reason, or null when it qualifies.
function labelBlockReason(order: any): string | null {
  if (order.fulfillment_type === 'pickup') return 'Pickup order — no label needed';
  if (!order.easyship_shipment_id) return 'No shipment yet — create one first';
  if (order.label_state === 'generated') return 'Label already purchased';
  return null;
}

const statusColors: Record<string, string> = {
  pending: 'bg-amber-500/10 text-amber-400',
  paid: 'bg-blue-500/10 text-blue-400',
  processing: 'bg-purple-500/10 text-purple-400',
  shipped: 'bg-indigo-500/10 text-indigo-400',
  delivered: 'bg-emerald-500/10 text-emerald-400',
  cancelled: 'bg-red-500/10 text-red-400',
};

// Label lifecycle badge styling. Mirrors EasyshipLabelInfo['state'].
const labelStateStyles: Record<string, string> = {
  generated: 'bg-emerald-500/10 text-emerald-500',
  pending: 'bg-amber-500/10 text-amber-500',
  processing: 'bg-amber-500/10 text-amber-500',
  failed: 'bg-red-500/10 text-red-500',
  not_created: 'bg-gray-500/10 text-ink-muted',
};

const labelStateText: Record<string, string> = {
  generated: 'Label ready',
  pending: 'Label pending',
  processing: 'Label processing',
  failed: 'Label failed',
  not_created: 'Shipment created',
};

export default function AdminOrders() {
  const userRole = useUserRole();
  const router = useRouter();
  const [orders, setOrders] = useState<any[]>([]);
  const [filteredOrders, setFilteredOrders] = useState<any[]>([]);
  const [updating, setUpdating] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Per-order in-flight shipment/label action. Keyed by order id → the label of
  // what's running ("Creating shipment…", "Buying label…") so each row can show
  // its own spinner while bulk actions run several rows at once.
  const [rowBusy, setRowBusy] = useState<Record<string, string>>({});
  // Per-order error to surface inline in the shipment column, keyed by order id.
  const [rowMsg, setRowMsg] = useState<Record<string, string>>({});
  // Selection + bulk actions. Shipment/label actions need edit rights; delete
  // needs delete rights (both admin-only today).
  const canDeleteOrders = canDelete(userRole);
  const canManageShipments = canEdit(userRole);
  const showSelection = canDeleteOrders || canManageShipments;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  // Whether a bulk shipment/label run is in progress (disables the toolbar).
  const [bulkRunning, setBulkRunning] = useState(false);
  // The open bulk confirmation dialog (create shipments / buy labels), with the
  // partitioned eligible + skipped orders it will act on.
  const [bulkDialog, setBulkDialog] = useState<
    { action: 'create' | 'label'; eligible: any[]; skipped: SkippedOrder[] } | null
  >(null);

  useEffect(() => {
    setIsLoading(true);
    getAllOrders()
      .then((data) => {
        setOrders(data);
        setFilteredOrders(data);
      })
      .catch(() => setError('Failed to load orders'))
      .finally(() => setIsLoading(false));
  }, []);

  useEffect(() => {
    let result = orders;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (o) =>
          o.order_number?.toLowerCase().includes(q) ||
          o.customer_name?.toLowerCase().includes(q) ||
          o.customer_email?.toLowerCase().includes(q)
      );
    }
    if (statusFilter !== 'all') {
      result = result.filter((o) => o.status === statusFilter);
    }
    setFilteredOrders(result);
  }, [search, statusFilter, orders]);

  const handleStatusChange = async (orderId: string, status: string) => {
    setUpdating(orderId);
    await updateOrderStatus(orderId, status as any);
    const updated = await getAllOrders();
    setOrders(updated);
    setUpdating(null);
  };

  const refreshOrders = async () => {
    const updated = await getAllOrders();
    setOrders(updated);
  };

  // ---- Per-row status (spinner label + inline error) ----
  const startRow = (id: string, label: string) => {
    setRowBusy((prev) => ({ ...prev, [id]: label }));
    setRowMsg((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };
  const endRow = (id: string, error?: string) => {
    setRowBusy((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    if (error) setRowMsg((prev) => ({ ...prev, [id]: error }));
  };

  // Create (or retry) the Easyship shipment record for an order that doesn't
  // have one yet (e.g. placed before Easyship was configured).
  const handleCreateShipment = async (orderId: string) => {
    startRow(orderId, 'Creating shipment…');
    try {
      const res = await createOrderShipment(orderId);
      await refreshOrders();
      endRow(
        orderId,
        res.easyship_shipment_id
          ? undefined
          : res.auto_shipment_error || 'Shipment was not created — check Easyship settings.',
      );
    } catch (e: any) {
      endRow(orderId, e?.message || 'Failed to create shipment');
    }
  };

  // Print an already-purchased label (no new tab).
  const handlePrintLabel = async (orderId: string) => {
    startRow(orderId, 'Printing label…');
    try {
      const blob = await fetchLabelBlob(orderId);
      printPdfBlob(blob);
      endRow(orderId);
    } catch (e: any) {
      endRow(orderId, e?.message || 'Failed to load label');
    }
  };

  // Buy the label, then immediately print it (no new tab).
  const handleBuyAndPrint = async (orderId: string) => {
    startRow(orderId, 'Buying label…');
    try {
      await buyOrderLabel(orderId);
      await refreshOrders();
      const blob = await fetchLabelBlob(orderId);
      printPdfBlob(blob);
      endRow(orderId);
    } catch (e: any) {
      endRow(orderId, e?.message || 'Failed to buy label');
    }
  };

  // Generate (or open the existing) invoice for an order, then jump to it.
  // Orders are capped at one invoice, so re-clicking just reopens it.
  const handleGenerateInvoice = async (orderId: string) => {
    startRow(orderId, 'Generating invoice…');
    try {
      const res = await getOrCreateInvoiceForOrder(orderId);
      if (!res.success || !res.invoice_id) {
        endRow(orderId, res.error || 'Failed to generate invoice');
        return;
      }
      router.push(`/admin/invoices/${res.invoice_id}`);
    } catch (e: any) {
      endRow(orderId, e?.message || 'Failed to generate invoice');
    }
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

  const allVisibleSelected =
    filteredOrders.length > 0 && filteredOrders.every((o) => selected.has(o.id));

  const toggleAll = () => {
    setSelected((prev) => {
      if (filteredOrders.length > 0 && filteredOrders.every((o) => prev.has(o.id))) {
        return new Set();
      }
      return new Set(filteredOrders.map((o) => o.id));
    });
  };

  // Click a day divider to select / deselect every order in that day. Toggles
  // off only when the whole group is already selected.
  const toggleGroup = (groupOrders: any[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = groupOrders.length > 0 && groupOrders.every((o) => next.has(o.id));
      for (const o of groupOrders) {
        if (allSelected) next.delete(o.id);
        else next.add(o.id);
      }
      return next;
    });
  };

  const deleteOrders = async (ids: string[]) => {
    if (ids.length === 0) return;
    const confirmed = window.confirm(
      `Delete ${ids.length} order${ids.length !== 1 ? 's' : ''}? This also removes any linked invoices and cannot be undone.`,
    );
    if (!confirmed) return;

    setDeleting(true);
    setError(null);
    try {
      const results = await Promise.all(ids.map((id) => deleteOrder(id)));
      const failed = results.filter((r) => !r.success);
      if (failed.length) {
        setError(`Failed to delete ${failed.length} of ${ids.length} order(s).`);
      }
      setSelected(new Set());
      await refreshOrders();
    } finally {
      setDeleting(false);
    }
  };

  const handleDeleteSelected = () => deleteOrders(Array.from(selected));

  // ---- Bulk shipment / label actions ----

  // Partition the current selection into eligible orders + skipped orders (with
  // reasons) for the given action, then open the confirmation dialog.
  const openBulkDialog = (action: 'create' | 'label') => {
    const chosen = orders.filter((o) => selected.has(o.id));
    const check = action === 'create' ? shipmentBlockReason : labelBlockReason;
    const eligible: any[] = [];
    const skipped: SkippedOrder[] = [];
    for (const order of chosen) {
      const reason = check(order);
      if (reason) skipped.push({ order, reason });
      else eligible.push(order);
    }
    setBulkDialog({ action, eligible, skipped });
  };

  // Run a per-row async action across a batch, showing each row's spinner while
  // it runs. Errors are captured per-row (never abort the batch).
  const runBatch = async (
    batch: any[],
    label: string,
    fn: (order: any) => Promise<string | undefined>,
  ) => {
    await Promise.all(
      batch.map(async (order) => {
        startRow(order.id, label);
        try {
          const err = await fn(order);
          endRow(order.id, err);
        } catch (e: any) {
          endRow(order.id, e?.message || 'Action failed');
        }
      }),
    );
  };

  const handleBulkConfirm = async () => {
    if (!bulkDialog) return;
    const { action, eligible } = bulkDialog;
    setBulkDialog(null);
    if (eligible.length === 0) return;

    setBulkRunning(true);
    try {
      if (action === 'create') {
        await runBatch(eligible, 'Creating shipment…', async (order) => {
          const res = await createOrderShipment(order.id);
          return res.easyship_shipment_id
            ? undefined
            : res.auto_shipment_error || 'Shipment was not created';
        });
      } else {
        await runBatch(eligible, 'Buying label…', async (order) => {
          await buyOrderLabel(order.id);
          return undefined;
        });
      }
      await refreshOrders();
      setSelected(new Set());
    } finally {
      setBulkRunning(false);
    }
  };

  // Total table columns, used for the day-divider colSpan.
  const columnCount = showSelection ? 8 : 7;

  // Group the (newest-first) orders by calendar day so the table can show a
  // readable divider each time the day changes.
  const orderGroups = React.useMemo(() => {
    // Day keys are New York calendar days, whatever zone the viewer is in.
    const todayKey = todayInAppTz();
    const yesterdayKey = addDays(todayKey, -1);

    const groups: {
      key: string;
      label: string;
      relative: string | null;
      orders: any[];
      count: number;
      total: number;
    }[] = [];
    const index = new Map<string, number>();

    for (const order of filteredOrders) {
      const key = appDayKey(order.created_at) ?? String(order.created_at);
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
          orders: [],
          count: 0,
          total: 0,
        });
      }
      const g = groups[gi];
      g.orders.push(order);
      g.count += 1;
      g.total += Number(order.total) || 0;
    }
    return groups;
  }, [filteredOrders]);

  const renderOrderRow = (order: any) => (
    <tr key={order.id} className={`hover:bg-surface transition-colors ${selected.has(order.id) ? 'bg-teal/5' : ''}`}>
      {showSelection && (
        <td className="px-5 py-4">
          <input
            type="checkbox"
            checked={selected.has(order.id)}
            onChange={() => toggleOne(order.id)}
            aria-label={`Select order ${order.order_number}`}
            className="w-4 h-4 rounded border-line text-teal-dark focus:ring-teal/40 cursor-pointer"
          />
        </td>
      )}
      <td className="px-5 py-4">
        <Link href={`/admin/orders/${order.id}`} className="font-mono text-sm text-ink hover:text-ink transition-colors">
          {order.order_number}
        </Link>
      </td>
      <td className="px-5 py-4">
        <div className="text-sm font-medium text-ink">{order.customer_name || 'Guest'}</div>
        <div className="text-xs text-ink-muted">{order.customer_email}</div>
      </td>
      <td className="px-5 py-4 font-semibold text-ink tabular-nums">${order.total?.toFixed(2)}</td>
      <td className="px-5 py-4">
        <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${statusColors[order.status]}`}>
          {order.status}
        </span>
      </td>
      <td className="px-5 py-4 align-top">
        {/* Row-level loading: shows what's running for this order (create /
            buy / print), including during a bulk run. */}
        {rowBusy[order.id] && (
          <div className="mb-1.5 inline-flex items-center gap-1.5 px-2 py-1 bg-teal/10 border border-teal/20 rounded-lg text-[11px] font-medium text-teal-dark">
            <Loader2 className="w-3 h-3 animate-spin" />
            {rowBusy[order.id]}
          </div>
        )}
        {order.fulfillment_type === 'pickup' ? (
          <span className="text-xs text-ink-muted">Pickup — no shipment</span>
        ) : order.easyship_shipment_id ? (
          <div className="space-y-1.5 min-w-[12rem]">
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium ${labelStateStyles[order.label_state || 'not_created'] || labelStateStyles.not_created}`}>
              <Truck className="w-3 h-3" />
              {labelStateText[order.label_state || 'not_created'] || 'Shipment created'}
            </span>
            {order.tracking_number && (
              <div className="text-[11px] text-ink-muted font-mono flex items-center gap-1">
                {order.tracking_url ? (
                  <a
                    href={order.tracking_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-teal-dark hover:underline inline-flex items-center gap-1"
                  >
                    {order.tracking_number}
                    <ExternalLink className="w-3 h-3" />
                  </a>
                ) : (
                  <span>{order.tracking_number}</span>
                )}
              </div>
            )}
            {order.tracking_status && (
              <div className="text-[10px] text-ink-muted capitalize">{order.tracking_status}</div>
            )}
            {canEdit(userRole) && (
              <div className="pt-0.5">
                {order.label_state === 'generated' ? (
                  <button
                    onClick={() => handlePrintLabel(order.id)}
                    disabled={!!rowBusy[order.id]}
                    className="inline-flex items-center gap-1 px-2 py-1 bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 rounded-lg text-[11px] font-medium hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
                  >
                    <Printer className="w-3 h-3" />
                    Print Label
                  </button>
                ) : (
                  <button
                    onClick={() => handleBuyAndPrint(order.id)}
                    disabled={!!rowBusy[order.id]}
                    className="inline-flex items-center gap-1 px-2 py-1 bg-teal/10 border border-teal/20 text-teal-dark rounded-lg text-[11px] font-medium hover:bg-teal/20 transition-colors disabled:opacity-50"
                  >
                    <Printer className="w-3 h-3" />
                    Buy &amp; Print Label
                  </button>
                )}
              </div>
            )}
            {rowMsg[order.id] && (
              <p className="text-[10px] text-red-500 max-w-[12rem]">{rowMsg[order.id]}</p>
            )}
          </div>
        ) : (
          <div className="space-y-1.5">
            <span className="text-xs text-ink-muted">No shipment</span>
            {order.auto_shipment_error && (
              <p className="text-[10px] text-red-500 max-w-[12rem]" title={order.auto_shipment_error}>
                Auto-create failed
              </p>
            )}
            {canEdit(userRole) && (
              <div>
                <button
                  onClick={() => handleCreateShipment(order.id)}
                  disabled={!!rowBusy[order.id]}
                  className="inline-flex items-center gap-1 px-2 py-1 bg-teal/10 border border-teal/20 text-teal-dark rounded-lg text-[11px] font-medium hover:bg-teal/20 transition-colors disabled:opacity-50"
                >
                  <PackagePlus className="w-3 h-3" />
                  Create Shipment
                </button>
              </div>
            )}
            {rowMsg[order.id] && (
              <p className="text-[10px] text-red-500 max-w-[12rem]">{rowMsg[order.id]}</p>
            )}
          </div>
        )}
      </td>
      <td className="px-5 py-4 text-sm text-ink-muted">{new Date(order.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: APP_TIME_ZONE })}</td>
      <td className="px-5 py-4">
        <div className="flex items-center gap-2">
          {canEdit(userRole) ? (
            <select
              value={order.status}
              onChange={(e) => handleStatusChange(order.id, e.target.value)}
              disabled={updating === order.id}
              className="text-sm bg-surface border border-line text-ink rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-teal/40"
            >
              <option value="pending">Pending</option>
              <option value="paid">Paid</option>
              <option value="processing">Processing</option>
              <option value="shipped">Shipped</option>
              <option value="delivered">Delivered</option>
              <option value="cancelled">Cancelled</option>
            </select>
          ) : (
            <span className={`inline-flex px-3 py-1.5 rounded text-xs font-medium ${statusColors[order.status]}`}>
              {order.status}
            </span>
          )}
          <Link
            href={`/admin/orders/${order.id}`}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-ink-muted hover:text-ink hover:bg-surface transition-colors"
          >
            <Eye className="w-4 h-4" />
          </Link>
          {canEdit(userRole) && (
            <button
              onClick={() => handleGenerateInvoice(order.id)}
              disabled={!!rowBusy[order.id]}
              title="Generate invoice"
              className="w-8 h-8 flex items-center justify-center rounded-lg text-ink-muted hover:text-teal-dark hover:bg-surface transition-colors disabled:opacity-50"
            >
              <FileText className="w-4 h-4" />
            </button>
          )}
          {canDeleteOrders && (
            <button
              onClick={() => deleteOrders([order.id])}
              disabled={deleting}
              title="Delete order"
              className="w-8 h-8 flex items-center justify-center rounded-lg text-ink-muted hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </td>
    </tr>
  );

  return (
    <>
      {/* Search & Filter Bar */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
          <input
            type="text"
            placeholder="Search orders, customers..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-white border border-line rounded-lg text-sm text-ink placeholder-ink-muted focus:outline-none focus:ring-2 focus:ring-teal/40"
          />
        </div>
        <div className="relative">
          <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="pl-10 pr-8 py-2.5 bg-white border border-line rounded-lg text-sm text-ink focus:outline-none focus:ring-2 focus:ring-teal/40 appearance-none"
          >
            <option value="all">All Statuses</option>
            <option value="pending">Pending</option>
            <option value="paid">Paid</option>
            <option value="processing">Processing</option>
            <option value="shipped">Shipped</option>
            <option value="delivered">Delivered</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
      </div>

      {/* Summary */}
      <div className="flex gap-4 mb-6 text-sm">
        <span className="text-ink-muted">{filteredOrders.length} order{filteredOrders.length !== 1 ? 's' : ''}</span>
        <span className="text-teal-dark">{filteredOrders.filter(o => o.status === 'pending').length} pending</span>
        <span className="text-blue-400">{filteredOrders.filter(o => o.status === 'paid').length} paid</span>
      </div>

      {/* Bulk actions */}
      {showSelection && selected.size > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4 px-4 py-3 bg-teal/5 border border-teal/30 rounded-lg">
          <span className="text-sm text-ink">
            {selected.size} order{selected.size !== 1 ? 's' : ''} selected
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setSelected(new Set())}
              disabled={deleting || bulkRunning}
              className="px-3 py-1.5 rounded-lg border border-line text-sm text-ink-muted hover:text-ink hover:border-ink/20 disabled:opacity-50"
            >
              Clear
            </button>
            {canManageShipments && (
              <>
                <button
                  onClick={() => openBulkDialog('create')}
                  disabled={deleting || bulkRunning}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal/10 border border-teal/20 text-teal-dark text-sm font-medium hover:bg-teal/20 disabled:opacity-50"
                >
                  {bulkRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <PackagePlus className="w-4 h-4" />}
                  Create shipments
                </button>
                <button
                  onClick={() => openBulkDialog('label')}
                  disabled={deleting || bulkRunning}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal/10 border border-teal/20 text-teal-dark text-sm font-medium hover:bg-teal/20 disabled:opacity-50"
                >
                  {bulkRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
                  Generate labels
                </button>
              </>
            )}
            {canDeleteOrders && (
              <button
                onClick={handleDeleteSelected}
                disabled={deleting || bulkRunning}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium disabled:opacity-50"
              >
                {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                Delete selected
              </button>
            )}
          </div>
        </div>
      )}

      {/* Orders Table */}
      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}
      <div className="bg-white rounded-xl border border-line overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-line">
                {showSelection && (
                  <th className="px-5 py-3 text-left w-10">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleAll}
                      aria-label="Select all orders"
                      className="w-4 h-4 rounded border-line text-teal-dark focus:ring-teal/40 cursor-pointer"
                    />
                  </th>
                )}
                <th className="px-5 py-3 text-left text-xs font-semibold text-ink-muted uppercase tracking-wider">Order</th>
                <th className="px-5 py-3 text-left text-xs font-semibold text-ink-muted uppercase tracking-wider">Customer</th>
                <th className="px-5 py-3 text-left text-xs font-semibold text-ink-muted uppercase tracking-wider">Total</th>
                <th className="px-5 py-3 text-left text-xs font-semibold text-ink-muted uppercase tracking-wider">Status</th>
                <th className="px-5 py-3 text-left text-xs font-semibold text-ink-muted uppercase tracking-wider">Shipment</th>
                <th className="px-5 py-3 text-left text-xs font-semibold text-ink-muted uppercase tracking-wider">Time</th>
                <th className="px-5 py-3 text-left text-xs font-semibold text-ink-muted uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/50">
              {orderGroups.map((group) => {
                const groupSelected =
                  group.orders.length > 0 && group.orders.every((o) => selected.has(o.id));
                return (
                <React.Fragment key={group.key}>
                  <tr className={`bg-surface/70 ${showSelection ? 'cursor-pointer hover:bg-teal/5' : ''}`}>
                    {showSelection && (
                      <td className="px-5 py-2.5 border-y border-line">
                        <input
                          type="checkbox"
                          checked={groupSelected}
                          onChange={() => toggleGroup(group.orders)}
                          aria-label={`Select all orders on ${group.label}`}
                          className="w-4 h-4 rounded border-line text-teal-dark focus:ring-teal/40 cursor-pointer"
                        />
                      </td>
                    )}
                    <td
                      colSpan={showSelection ? columnCount - 1 : columnCount}
                      className="px-5 py-2.5 border-y border-line"
                      onClick={showSelection ? () => toggleGroup(group.orders) : undefined}
                      title={showSelection ? 'Click to select every order on this day' : undefined}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                        <div className="flex items-baseline gap-2">
                          {group.relative && (
                            <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-teal/10 text-teal-dark">
                              {group.relative}
                            </span>
                          )}
                          <span className="text-sm font-semibold text-ink">{group.label}</span>
                          {groupSelected && (
                            <span className="text-[10px] font-medium text-teal-dark">Selected</span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-xs text-ink-muted">
                          <span>{group.count} order{group.count !== 1 ? 's' : ''}</span>
                          <span className="text-line">•</span>
                          <span className="font-medium text-ink tabular-nums">${group.total.toFixed(2)} total</span>
                        </div>
                      </div>
                    </td>
                  </tr>
                  {group.orders.map((order) => renderOrderRow(order))}
                </React.Fragment>
                );
              })}
              {isLoading && (
                <tr>
                  <td colSpan={columnCount} className="px-5 py-12 text-center text-ink-muted text-sm">Loading orders...</td>
                </tr>
              )}
              {!isLoading && filteredOrders.length === 0 && (
                <tr>
                  <td colSpan={columnCount} className="px-5 py-12 text-center text-ink-muted text-sm">
                    {search || statusFilter !== 'all' ? 'No orders match your filters' : 'No orders yet'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {bulkDialog && (
        <BulkShipmentDialog
          action={bulkDialog.action}
          eligible={bulkDialog.eligible}
          skipped={bulkDialog.skipped}
          onConfirm={handleBulkConfirm}
          onCancel={() => setBulkDialog(null)}
        />
      )}
    </>
  );
}
