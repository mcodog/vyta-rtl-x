'use client';

import React, { useState, useEffect } from 'react';
import {
  Plus, Search, Filter, FileText, Edit2, Loader2,
  Building2, Tag, Lock,
} from 'lucide-react';
import Link from 'next/link';
import { getPurchaseOrders, type PurchaseOrderListItem } from '@/lib/admin/purchase-orders';
import { PO_STATUS_META, isPoLocked } from '@/lib/admin/po-status';
import type { PurchaseOrderStatus } from '@/lib/types/ecommerce';
import { formatAppDate } from '@/lib/datetime';

export default function PurchaseOrdersPage() {
  const [pos, setPOs] = useState<PurchaseOrderListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<PurchaseOrderStatus | 'all'>('all');

  useEffect(() => { load(); }, [statusFilter]);

  async function load() {
    setLoading(true);
    const data = await getPurchaseOrders(statusFilter !== 'all' ? { status: statusFilter } : undefined);
    setPOs(data);
    setLoading(false);
  }

  const filtered = pos.filter((po) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      po.po_number.toLowerCase().includes(q) ||
      (po.supplier?.name ?? '').toLowerCase().includes(q)
    );
  });

  const totalValue = pos.reduce((s, p) => s + Number(p.total), 0);
  const paidCount = pos.filter((p) => p.status === 'paid').length;
  const openValue = pos
    .filter((p) => p.status === 'pending' || p.status === 'partially_fulfilled' || p.status === 'fulfilled')
    .reduce((s, p) => s + Number(p.total), 0);

  return (
    <>
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-ink">Purchase Orders</h1>
          <p className="text-sm text-ink-muted mt-1">{pos.length} order{pos.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex gap-2">
          <Link href="/admin/purchase-orders/supplier-pricelists" className="px-3 py-2.5 bg-white border border-line rounded-lg text-ink-muted hover:text-ink text-sm flex items-center gap-2 transition-colors">
            <Tag className="w-4 h-4" /> Pricelists
          </Link>
          <Link href="/admin/purchase-orders/suppliers" className="px-3 py-2.5 bg-white border border-line rounded-lg text-ink-muted hover:text-ink text-sm flex items-center gap-2 transition-colors">
            <Building2 className="w-4 h-4" /> Suppliers
          </Link>
          <Link href="/admin/purchase-orders/new" className="inline-flex items-center gap-2 bg-ink text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-ink/90 transition-colors">
            <Plus className="w-4 h-4" /> Create Purchase Order
          </Link>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Total Orders', value: pos.length, unit: 'orders', color: 'text-ink' },
          { label: 'Total Value', value: `$${totalValue.toFixed(2)}`, unit: 'CAD', color: 'text-ink' },
          { label: 'Open Value', value: `$${openValue.toFixed(2)}`, unit: 'CAD', color: 'text-amber-600' },
          { label: 'Paid', value: paidCount, unit: 'orders', color: 'text-emerald-600' },
        ].map((s) => (
          <div key={s.label} className="bg-white rounded-xl border border-line p-4">
            <p className="text-xs text-ink-muted mb-1">{s.label}</p>
            <p className={`text-2xl font-bold tabular-nums ${s.color}`}>{s.value}</p>
            <p className="text-xs text-ink-muted">{s.unit}</p>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
          <input
            type="text"
            placeholder="Search by PO number or supplier..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-white border border-line rounded-lg text-sm text-ink placeholder-ink-muted focus:outline-none focus:ring-2 focus:ring-teal/40"
          />
        </div>
        <div className="relative">
          <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as PurchaseOrderStatus | 'all')}
            className="pl-10 pr-8 py-2.5 bg-white border border-line rounded-lg text-sm text-ink focus:outline-none focus:ring-2 focus:ring-teal/40 appearance-none"
          >
            <option value="all">All Statuses</option>
            <option value="pending">Pending</option>
            <option value="partially_fulfilled">Partially Fulfilled</option>
            <option value="fulfilled">Fulfilled</option>
            <option value="paid">Paid</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-line overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-line">
                {['PO Number', 'Supplier', 'Items', 'Total', 'Expected', 'Status', 'Created', ''].map((h) => (
                  <th key={h} className={`px-5 py-3 text-left text-xs font-semibold text-ink-muted uppercase tracking-wider ${h === 'Total' ? 'text-right' : ''}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line/50">
              {loading && (
                <tr><td colSpan={8} className="px-5 py-12 text-center"><Loader2 className="w-5 h-5 animate-spin text-ink-muted mx-auto" /></td></tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={8} className="px-5 py-12 text-center text-ink-muted text-sm">
                  {search || statusFilter !== 'all' ? 'No orders match your filters' : 'No purchase orders yet'}
                </td></tr>
              )}
              {filtered.map((po) => {
                const meta = PO_STATUS_META[po.status];
                return (
                  <tr key={po.id} className="hover:bg-surface transition-colors">
                    <td className="px-5 py-4">
                      <Link href={`/admin/purchase-orders/${po.id}`} className="font-mono text-sm font-semibold text-ink hover:text-teal-dark transition-colors">{po.po_number}</Link>
                    </td>
                    <td className="px-5 py-4"><p className="text-sm font-medium text-ink">{po.supplier?.name ?? '—'}</p></td>
                    <td className="px-5 py-4 text-sm text-ink-muted tabular-nums">{po.item_count}</td>
                    <td className="px-5 py-4 text-right font-semibold tabular-nums text-ink">${Number(po.total).toFixed(2)}</td>
                    <td className="px-5 py-4 text-sm text-ink-muted">{formatAppDate(po.expected_date, {})}</td>
                    <td className="px-5 py-4">
                      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-xs font-medium ${meta.badge}`}>
                        {isPoLocked(po.status) && <Lock className="w-3 h-3" />}
                        {meta.label}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-sm text-ink-muted">{new Date(po.created_at).toLocaleDateString()}</td>
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-1.5">
                        <Link href={`/admin/purchase-orders/${po.id}`} className="w-8 h-8 flex items-center justify-center rounded-lg text-ink-muted hover:text-ink hover:bg-surface transition-colors" title="Open">
                          <Edit2 className="w-3.5 h-3.5" />
                        </Link>
                        <a href={`/api/admin/purchase-orders/${po.id}/pdf`} target="_blank" rel="noreferrer" className="w-8 h-8 flex items-center justify-center rounded-lg text-ink-muted hover:text-ink hover:bg-surface transition-colors" title="View PDF">
                          <FileText className="w-3.5 h-3.5" />
                        </a>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
