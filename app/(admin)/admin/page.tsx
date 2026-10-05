'use client';

import React, { useState, useEffect } from 'react';
import {
  TrendingUp, Clock, Users, DollarSign, ArrowRight, FileText,
  AlertTriangle, PackageX, RefreshCw, Loader2, CheckCircle2, BookOpen,
} from 'lucide-react';
import Link from 'next/link';
import {
  getAdminStats, getAllOrders, getRestockNeeded, getAutoShipmentFailures,
  createOrderShipment, type RestockItem, type ShipmentFailure,
} from '@/lib/admin/api';
import { getInvoices, type InvoiceListItem } from '@/lib/admin/invoices';
import type { InvoiceStatus } from '@/lib/types/ecommerce';
import { canEdit } from '@/lib/permissions';
import FulfillmentAlerts from './_components/FulfillmentAlerts';
import { useUserRole } from './layout';
import { GUIDES } from './guides/_content';
import EarningsByChannel from '@/components/admin/EarningsByChannel';
import { formatAppDate } from '@/lib/datetime';

// Status is conveyed by a small coloured dot beside a plain-text label rather
// than a filled colour box, so semantic colour reads as an accent, not a slab.
const orderStatusDot: Record<string, string> = {
  pending: 'bg-amber-500',
  received: 'bg-amber-500',
  confirmed: 'bg-blue-500',
  paid: 'bg-blue-500',
  processing: 'bg-teal',
  shipped: 'bg-indigo-500',
  delivered: 'bg-emerald-500',
  cancelled: 'bg-red-500',
  refunded: 'bg-red-500',
};

const invoiceStatusDot: Record<InvoiceStatus, string> = {
  draft: 'bg-ink-light',
  sent: 'bg-blue-500',
  paid: 'bg-emerald-500',
  partial: 'bg-amber-500',
  overdue: 'bg-red-500',
  cancelled: 'bg-ink-light',
  pending_payment: 'bg-amber-500',
  expired: 'bg-ink-light',
};

const DASHBOARD_GUIDES = GUIDES.slice(0, 4);

export default function AdminDashboard() {
  const userRole = useUserRole();
  const editable = canEdit(userRole);

  const [stats, setStats] = useState<any>(null);
  const [recentOrders, setRecentOrders] = useState<any[]>([]);
  const [recentInvoices, setRecentInvoices] = useState<InvoiceListItem[]>([]);
  const [restock, setRestock] = useState<RestockItem[]>([]);
  const [failures, setFailures] = useState<ShipmentFailure[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Per-row retry state for the shipment-failures panel.
  const [retryState, setRetryState] = useState<Record<string, 'loading' | 'error'>>({});
  const [retryError, setRetryError] = useState<Record<string, string>>({});

  useEffect(() => {
    Promise.all([
      getAdminStats(),
      getAllOrders(),
      getInvoices(),
      getRestockNeeded(),
      getAutoShipmentFailures(),
    ])
      .then(([statsData, orders, invoices, restockData, failureData]) => {
        setStats(statsData);
        setRecentOrders(orders.slice(0, 8));
        setRecentInvoices(invoices.invoices.slice(0, 6));
        setRestock(restockData);
        setFailures(failureData);
      })
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, []);

  async function handleRetry(orderId: string) {
    setRetryState((s) => ({ ...s, [orderId]: 'loading' }));
    setRetryError((e) => ({ ...e, [orderId]: '' }));
    try {
      const res = await createOrderShipment(orderId);
      if (res.auto_shipment_status === 'failed' || res.auto_shipment_error) {
        setRetryState((s) => ({ ...s, [orderId]: 'error' }));
        setRetryError((e) => ({ ...e, [orderId]: res.auto_shipment_error ?? 'Still failing' }));
      } else {
        // Success — drop it from the list.
        setFailures((list) => list.filter((f) => f.id !== orderId));
        setRetryState((s) => {
          const next = { ...s };
          delete next[orderId];
          return next;
        });
      }
    } catch (err: any) {
      setRetryState((s) => ({ ...s, [orderId]: 'error' }));
      setRetryError((e) => ({ ...e, [orderId]: err?.message ?? 'Retry failed' }));
    }
  }

  return (
    <>
      {/* Page header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-ink">Dashboard</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Today&apos;s snapshot and anything that needs your attention.
        </p>
      </div>

      {/* Live fulfillment activity banner — self-hides when there is nothing to show. */}
      <FulfillmentAlerts />

      {/* KPI row — a single teal accent across all four keeps the palette calm. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 md:gap-5 mb-6">
        {isLoading ? (
          <>
            <StatCardSkeleton />
            <StatCardSkeleton />
            <StatCardSkeleton />
            <StatCardSkeleton />
          </>
        ) : (
          <>
            <StatCard icon={TrendingUp} label="Revenue" value={`$${stats?.totalRevenue?.toFixed(2) || '0.00'}`} sub="Total Revenue" />
            <StatCard icon={Clock} label="Pending" value={stats?.pendingOrders || 0} sub="Pending Orders" />
            <StatCard icon={Users} label="Affiliates" value={stats?.totalAffiliates || 0} sub="Total Affiliates" />
            <StatCard icon={DollarSign} label="Owed" value={`$${stats?.pendingCommissions?.toFixed(2) || '0.00'}`} sub="Pending Commissions" />
          </>
        )}
      </div>

      {/* Where the revenue above actually came from. All-time, matching the
          KPI row it sits under — the dashboard has no date filter. */}
      <EarningsByChannel variant="compact" />

      {/* Needs attention — the two action queues, side by side. */}
      <div className="grid gap-6 lg:grid-cols-2 mb-6">
        {/* Restock needed */}
        <section className="bg-white rounded-xl border border-line overflow-hidden flex flex-col">
          <div className="p-5 border-b border-line flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <PackageX className="w-4 h-4 text-amber-500" />
              <h2 className="text-sm font-bold text-ink">Restock needed</h2>
              {!isLoading && restock.length > 0 && <CountBadge n={restock.length} />}
            </div>
            <Link href="/admin/products" className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink transition-colors">
              Manage <ArrowRight className="w-4 h-4" />
            </Link>
          </div>

          {isLoading ? (
            <ListSkeleton rows={4} />
          ) : restock.length === 0 ? (
            <EmptyState icon={CheckCircle2} text="Every active product is above its threshold." />
          ) : (
            <ul className="divide-y divide-line/50">
              {restock.slice(0, 6).map((p) => (
                <li key={p.id}>
                  <Link href="/admin/products" className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-surface transition-colors">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink truncate">{p.name ?? 'Unnamed product'}</p>
                      {p.sku && <p className="text-xs text-ink-muted font-mono truncate">{p.sku}</p>}
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-sm font-semibold tabular-nums">
                        <span className={p.stock_quantity === 0 ? 'text-red-500' : 'text-amber-600'}>{p.stock_quantity}</span>
                        <span className="text-ink-light"> / {p.low_stock_threshold}</span>
                      </p>
                      <p className="text-[11px] text-ink-muted">in stock</p>
                    </div>
                  </Link>
                </li>
              ))}
              {restock.length > 6 && (
                <li className="px-5 py-2.5 text-center">
                  <Link href="/admin/products" className="text-xs text-teal-dark hover:underline">
                    +{restock.length - 6} more below threshold
                  </Link>
                </li>
              )}
            </ul>
          )}
        </section>

        {/* Auto-shipment failures */}
        <section className="bg-white rounded-xl border border-line overflow-hidden flex flex-col">
          <div className="p-5 border-b border-line flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <AlertTriangle className="w-4 h-4 text-red-500" />
              <h2 className="text-sm font-bold text-ink">Shipment failures</h2>
              {!isLoading && failures.length > 0 && <CountBadge n={failures.length} />}
            </div>
            <Link href="/admin/orders" className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink transition-colors">
              Orders <ArrowRight className="w-4 h-4" />
            </Link>
          </div>

          {isLoading ? (
            <ListSkeleton rows={4} />
          ) : failures.length === 0 ? (
            <EmptyState icon={CheckCircle2} text="No auto-shipments have failed. All clear." />
          ) : (
            <ul className="divide-y divide-line/50">
              {failures.slice(0, 6).map((f) => {
                const state = retryState[f.id];
                return (
                  <li key={f.id} className="px-5 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <Link href={`/admin/orders/${f.id}`} className="text-sm font-mono font-medium text-ink hover:text-teal-dark transition-colors flex-shrink-0">
                            {f.order_number ?? '(no #)'}
                          </Link>
                          <span className="text-xs text-ink-muted truncate">
                            {f.customer_name ?? f.customer_email ?? 'Guest'}
                          </span>
                        </div>
                        {f.error && <p className="mt-1 text-xs text-red-600 line-clamp-2">{f.error}</p>}
                      </div>
                      <div className="flex-shrink-0 flex items-center gap-2">
                        {editable && (
                          <button
                            type="button"
                            onClick={() => handleRetry(f.id)}
                            disabled={state === 'loading'}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-line text-xs font-medium text-ink hover:bg-surface transition-colors disabled:opacity-50"
                          >
                            {state === 'loading'
                              ? <Loader2 className="w-3 h-3 animate-spin" />
                              : <RefreshCw className="w-3 h-3" />}
                            Retry
                          </button>
                        )}
                        <Link href={`/admin/orders/${f.id}`} className="text-xs text-teal-dark hover:underline">
                          View
                        </Link>
                      </div>
                    </div>
                    {state === 'error' && retryError[f.id] && (
                      <p className="mt-1.5 text-xs text-red-600">Retry failed: {retryError[f.id]}</p>
                    )}
                  </li>
                );
              })}
              {failures.length > 6 && (
                <li className="px-5 py-2.5 text-center text-xs text-ink-muted">
                  +{failures.length - 6} more failed
                </li>
              )}
            </ul>
          )}
        </section>
      </div>

      {/* Recent Orders */}
      <div className="bg-white rounded-xl border border-line overflow-hidden">
        <div className="p-5 md:p-6 border-b border-line flex items-center justify-between">
          <h2 className="text-lg font-bold text-ink">Recent Orders</h2>
          <Link href="/admin/orders" className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink transition-colors">
            View All <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-line">
                <th className="px-5 py-3 text-left text-xs font-semibold text-ink-muted uppercase tracking-wider">Order</th>
                <th className="px-5 py-3 text-left text-xs font-semibold text-ink-muted uppercase tracking-wider">Customer</th>
                <th className="px-5 py-3 text-left text-xs font-semibold text-ink-muted uppercase tracking-wider">Total</th>
                <th className="px-5 py-3 text-left text-xs font-semibold text-ink-muted uppercase tracking-wider">Status</th>
                <th className="px-5 py-3 text-left text-xs font-semibold text-ink-muted uppercase tracking-wider">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/50">
              {isLoading &&
                Array.from({ length: 6 }).map((_, i) => <OrderSkeletonRow key={i} />)}
              {!isLoading &&
                recentOrders.map((order) => (
                <tr key={order.id} className="hover:bg-surface transition-colors cursor-pointer" onClick={() => window.location.href = `/admin/orders/${order.id}`}>
                  <td className="px-5 py-4 font-mono text-sm text-ink">{order.order_number}</td>
                  <td className="px-5 py-4">
                    <div className="text-sm font-medium text-ink">{order.customer_name || 'Guest'}</div>
                    <div className="text-xs text-ink-muted">{order.customer_email}</div>
                  </td>
                  <td className="px-5 py-4 font-semibold text-ink tabular-nums">${order.total?.toFixed(2)}</td>
                  <td className="px-5 py-4">
                    <StatusDot label={order.status} dot={orderStatusDot[order.status]} />
                  </td>
                  <td className="px-5 py-4 text-sm text-ink-muted">{new Date(order.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
              {!isLoading && recentOrders.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-5 py-12 text-center text-ink-muted text-sm">No orders yet</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent Invoices */}
      <div className="bg-white rounded-xl border border-line overflow-hidden mt-6">
        <div className="p-5 md:p-6 border-b border-line flex items-center justify-between">
          <h2 className="text-lg font-bold text-ink flex items-center gap-2">
            <FileText className="w-4 h-4 text-ink-muted" /> Recent Invoices
          </h2>
          <Link
            href="/admin/invoices"
            className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink transition-colors"
          >
            View All <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-line">
                <th className="px-5 py-3 text-left text-xs font-semibold text-ink-muted uppercase tracking-wider">Invoice</th>
                <th className="px-5 py-3 text-left text-xs font-semibold text-ink-muted uppercase tracking-wider">Customer</th>
                <th className="px-5 py-3 text-right text-xs font-semibold text-ink-muted uppercase tracking-wider">Total</th>
                <th className="px-5 py-3 text-left text-xs font-semibold text-ink-muted uppercase tracking-wider">Status</th>
                <th className="px-5 py-3 text-left text-xs font-semibold text-ink-muted uppercase tracking-wider">Due</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/50">
              {isLoading &&
                Array.from({ length: 5 }).map((_, i) => <InvoiceSkeletonRow key={i} />)}
              {!isLoading &&
                recentInvoices.map((inv) => {
                const isOverdue =
                  inv.status === 'overdue' ||
                  (inv.status === 'sent' && new Date(inv.due_date) < new Date());
                return (
                  <tr
                    key={inv.id}
                    className="hover:bg-surface transition-colors cursor-pointer"
                    onClick={() => (window.location.href = `/admin/invoices/${inv.id}`)}
                  >
                    <td className="px-5 py-4 font-mono text-sm text-ink">{inv.invoice_number}</td>
                    <td className="px-5 py-4">
                      <div className="text-sm font-medium text-ink">{inv.customer_name_display || 'Guest'}</div>
                      {inv.customer_email_display && (
                        <div className="text-xs text-ink-muted">{inv.customer_email_display}</div>
                      )}
                    </td>
                    <td className="px-5 py-4 text-right font-semibold text-ink tabular-nums">
                      ${Number(inv.total).toFixed(2)}
                    </td>
                    <td className="px-5 py-4">
                      <StatusDot
                        label={inv.status}
                        dot={invoiceStatusDot[inv.status]}
                        strike={inv.status === 'cancelled'}
                      />
                    </td>
                    <td className="px-5 py-4 text-sm">
                      <span className={isOverdue ? 'text-red-500 font-medium' : 'text-ink-muted'}>
                        {formatAppDate(inv.due_date, {})}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {!isLoading && recentInvoices.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-5 py-12 text-center text-ink-muted text-sm">
                    No invoices yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Guides & How-Tos */}
      <section className="bg-white rounded-xl border border-line overflow-hidden mt-6">
        <div className="p-5 md:p-6 border-b border-line flex items-center justify-between">
          <h2 className="text-lg font-bold text-ink flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-teal-dark" /> Guides &amp; How-Tos
          </h2>
          <Link href="/admin/guides" className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink transition-colors">
            All guides <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
        <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
          {DASHBOARD_GUIDES.map((g) => {
            const Icon = g.icon;
            return (
              <Link
                key={g.slug}
                href={`/admin/guides/${g.slug}`}
                className="group flex flex-col rounded-lg border border-line p-4 transition-colors hover:border-teal/40"
              >
                <div className="mb-2.5 grid h-9 w-9 place-items-center rounded-lg bg-teal/10">
                  <Icon className="h-5 w-5 text-teal-dark" />
                </div>
                <p className="text-sm font-semibold text-ink group-hover:text-teal-dark transition-colors">{g.title}</p>
                <p className="mt-1 text-xs leading-relaxed text-ink-muted line-clamp-2">{g.summary}</p>
              </Link>
            );
          })}
        </div>
      </section>
    </>
  );
}

/* ---------- small presentational helpers ---------- */

function StatCard({ icon: Icon, label, value, sub }: {
  icon: React.ComponentType<{ className?: string }>; label: string; value: React.ReactNode; sub: string;
}) {
  return (
    <div className="bg-white rounded-xl p-5 border border-line">
      <div className="flex items-center justify-between mb-3">
        <div className="w-10 h-10 bg-teal/10 rounded-lg flex items-center justify-center">
          <Icon className="w-5 h-5 text-teal-dark" />
        </div>
        <span className="text-[10px] font-semibold text-ink-muted uppercase tracking-wider">{label}</span>
      </div>
      <p className="text-2xl md:text-3xl font-bold text-ink tabular-nums">{value}</p>
      <p className="text-xs text-ink-muted mt-1">{sub}</p>
    </div>
  );
}

function StatusDot({ label, dot, strike }: { label: string; dot?: string; strike?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm capitalize ${strike ? 'text-ink-muted line-through' : 'text-ink'}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot ?? 'bg-ink-light'}`} />
      {label}
    </span>
  );
}

function CountBadge({ n }: { n: number }) {
  return (
    <span className="inline-flex items-center justify-center min-w-[20px] h-5 rounded-full bg-surface text-ink-muted text-xs font-semibold px-1.5 tabular-nums">
      {n}
    </span>
  );
}

function EmptyState({ icon: Icon, text }: { icon: React.ComponentType<{ className?: string }>; text: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <Icon className="h-6 w-6 text-emerald-500" />
      <p className="text-sm text-ink-muted">{text}</p>
    </div>
  );
}

function ListSkeleton({ rows }: { rows: number }) {
  return (
    <ul className="divide-y divide-line/50">
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className="flex items-center justify-between gap-3 px-5 py-3.5 animate-pulse">
          <div className="min-w-0 flex-1">
            <div className="h-3.5 w-40 bg-surface rounded mb-1.5" />
            <div className="h-3 w-24 bg-surface rounded" />
          </div>
          <div className="h-4 w-12 bg-surface rounded" />
        </li>
      ))}
    </ul>
  );
}

function StatCardSkeleton() {
  return (
    <div className="bg-white rounded-xl p-5 border border-line animate-pulse">
      <div className="flex items-center justify-between mb-3">
        <div className="w-10 h-10 bg-surface rounded-lg" />
        <div className="h-2.5 w-14 bg-surface rounded" />
      </div>
      <div className="h-8 w-24 bg-surface rounded" />
      <div className="h-3 w-20 bg-surface rounded mt-2" />
    </div>
  );
}

function OrderSkeletonRow() {
  return (
    <tr className="animate-pulse">
      <td className="px-5 py-4"><div className="h-4 w-20 bg-surface rounded" /></td>
      <td className="px-5 py-4">
        <div className="h-3.5 w-32 bg-surface rounded mb-1.5" />
        <div className="h-3 w-40 bg-surface rounded" />
      </td>
      <td className="px-5 py-4"><div className="h-4 w-16 bg-surface rounded" /></td>
      <td className="px-5 py-4"><div className="h-5 w-16 bg-surface rounded" /></td>
      <td className="px-5 py-4"><div className="h-3.5 w-20 bg-surface rounded" /></td>
    </tr>
  );
}

function InvoiceSkeletonRow() {
  return (
    <tr className="animate-pulse">
      <td className="px-5 py-4"><div className="h-4 w-24 bg-surface rounded" /></td>
      <td className="px-5 py-4">
        <div className="h-3.5 w-32 bg-surface rounded mb-1.5" />
        <div className="h-3 w-40 bg-surface rounded" />
      </td>
      <td className="px-5 py-4"><div className="h-4 w-16 bg-surface rounded ml-auto" /></td>
      <td className="px-5 py-4"><div className="h-5 w-16 bg-surface rounded" /></td>
      <td className="px-5 py-4"><div className="h-3.5 w-20 bg-surface rounded" /></td>
    </tr>
  );
}
