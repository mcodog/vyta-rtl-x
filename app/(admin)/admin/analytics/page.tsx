'use client';

import { formatAppDate } from '@/lib/datetime';
import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  Boxes, TrendingUp, DollarSign, ClipboardList, AlertTriangle, Loader2,
  RefreshCw, Calendar, FileText, Users, ShoppingCart, Eye, Search, Percent,
  Receipt, CheckCircle2, UserPlus, Megaphone, Info, CreditCard, Package,
  Handshake, Scale, Wallet, ArrowRight, BarChart3, MapPin, Target,
} from 'lucide-react';
import { getAnalyticsSummary, type AnalyticsSummary, type FunnelSummary, type PuramassSummary } from '@/lib/admin/analytics';
import { getStealthHealthSummary, type StealthHealthSummary } from '@/lib/admin/stealth-health-client';
import { toAmount } from '@/lib/admin/stealth-health';
import { PO_STATUS_META } from '@/lib/admin/po-status';
import { formatMoney } from '@/lib/currency';
import { StoreReportView, type StoreView } from './_components/StoreReportView';
import AcquisitionSection from './_components/AcquisitionSection';
import { useUserRole } from '../layout';
import { isAnalytics } from '@/lib/permissions';

function fmtCurrency(n: number) {
  return formatMoney(n, 'CAD');
}
const fmtCAD = (n: number) => formatMoney(n, 'CAD');
const fmtUSD = (n: number) => formatMoney(n, 'USD');
const fmtInt = (n: number) => n.toLocaleString();
const fmtPct = (n: number) => `${n}%`;

function fmtDate(d: string | null) {
  return formatAppDate(d, {});
}

// Local YYYY-MM-DD for the <input type="date"> presets.
function isoDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDay(d);
}

type Tint = 'emerald' | 'blue' | 'teal' | 'amber' | 'neutral';
const TINTS: Record<Tint, { fg: string; bg: string }> = {
  emerald: { fg: 'text-emerald-700', bg: 'bg-emerald-100' },
  blue: { fg: 'text-blue-700', bg: 'bg-blue-100' },
  teal: { fg: 'text-teal-dark', bg: 'bg-teal/10' },
  amber: { fg: 'text-amber-700', bg: 'bg-amber-100' },
  neutral: { fg: 'text-ink', bg: 'bg-surface' },
};

type TabId = 'overview' | 'products' | 'customers' | 'locations' | 'acquisition' | 'traffic' | 'checkout' | 'inventory';

/** Tabs served by the store report (one fetch, four views). */
const STORE_TAB_IDS = new Set<TabId>(['overview', 'products', 'customers', 'locations']);

const TABS: Array<{ id: TabId; label: string; icon: React.ElementType }> = [
  { id: 'overview', label: 'Overview', icon: BarChart3 },
  { id: 'products', label: 'Products', icon: Package },
  { id: 'customers', label: 'Customers', icon: Users },
  { id: 'locations', label: 'Locations', icon: MapPin },
  { id: 'acquisition', label: 'Acquisition', icon: Target },
  { id: 'traffic', label: 'Traffic & conversion', icon: Megaphone },
  { id: 'checkout', label: 'Hosted checkout', icon: CreditCard },
  { id: 'inventory', label: 'Inventory & finance', icon: Boxes },
];

export default function AnalyticsPage() {
  const role = useUserRole();
  // The marketing partner role reads only the sales its ads produced. Every
  // route behind this page filters to the paid channels for it, so say so once,
  // above the tabs, rather than letting a number be read as the whole business.
  const paidAdsOnly = isAnalytics(role);
  const [tab, setTab] = useState<TabId>('overview');
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const isStoreTab = STORE_TAB_IDS.has(tab);

  const load = useCallback(async () => {
    setRefreshing(true);
    const s = await getAnalyticsSummary({ from: from || null, to: to || null });
    setSummary(s);
    setLoading(false);
    setRefreshing(false);
  }, [from, to]);

  // The operational summary is only fetched for the tabs that render it, so the
  // store report (the default view) is never held up by it.
  useEffect(() => {
    if (!isStoreTab) {
      setLoading((prev) => (summary == null ? true : prev));
      load();
    }
    // `summary` is deliberately not a dependency: it changes on every load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStoreTab, load]);

  return (
    <>
      {/* Header */}
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-ink flex items-center gap-2">
          <TrendingUp className="w-6 h-6 text-teal-dark" aria-hidden /> Analytics
        </h1>
        <p className="text-sm text-ink-muted mt-1">
          Date-wise sales and orders, product and location breakdowns, and the operational picture behind them.
        </p>
      </div>

      {paidAdsOnly && (
        <div className="rounded-xl border border-teal/30 bg-teal/5 p-3 mb-4 flex gap-2">
          <Target className="w-4 h-4 text-teal-dark shrink-0 mt-0.5" aria-hidden />
          <p className="text-xs text-ink">
            <span className="font-semibold">Paid-ads view.</span>{' '}
            Every sales figure on this page counts only orders won by a paid ad — Google,
            Meta, Microsoft, TikTok, LinkedIn and other paid channels — along with the
            visitors those ads brought. Organic, referral, affiliate, direct and
            unattributed sales are not included, so these totals are not the whole store.
          </p>
        </div>
      )}

      {/* Tabs */}
      <div className="border-b border-line mb-5 -mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto">
        <div className="flex gap-1 min-w-max" role="tablist" aria-label="Analytics views">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = t.id === tab;
            return (
              <button key={t.id} type="button" role="tab" aria-selected={active}
                onClick={() => setTab(t.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  active
                    ? 'border-teal text-ink'
                    : 'border-transparent text-ink-muted hover:text-ink hover:border-line'
                }`}>
                <Icon className="w-4 h-4" aria-hidden /> {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {isStoreTab ? (
        <StoreReportView view={tab as StoreView} />
      ) : (
        <OperationalTabs
          tab={tab}
          summary={summary}
          loading={loading}
          refreshing={refreshing}
          from={from}
          to={to}
          setFrom={setFrom}
          setTo={setTo}
          reload={load}
        />
      )}
    </>
  );
}

/**
 * The pre-existing operational surfaces — traffic funnel, hosted-checkout
 * ledger, and inventory/finance — kept behind their own tabs and their own
 * all-time-by-default range, which is what those views want (an open purchase
 * order is not a "last 30 days" fact).
 */
function OperationalTabs({
  tab, summary, loading, refreshing, from, to, setFrom, setTo, reload,
}: {
  tab: TabId;
  summary: AnalyticsSummary | null;
  loading: boolean;
  refreshing: boolean;
  from: string;
  to: string;
  setFrom: (v: string) => void;
  setTo: (v: string) => void;
  reload: () => void;
}) {
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <Loader2 className="w-6 h-6 animate-spin text-ink-muted" aria-hidden />
        <p className="text-sm text-ink-muted">Loading analytics…</p>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <p className="text-sm text-ink-muted">Could not load analytics.</p>
        <button onClick={reload}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-teal-dark text-white rounded-lg text-sm font-medium hover:bg-teal/90">
          <RefreshCw className="w-4 h-4" aria-hidden /> Try again
        </button>
      </div>
    );
  }

  const { inventory, incoming, revenue, funnel, puramass } = summary;
  const cad = revenue.by_currency?.CAD ?? { invoiced: 0, paid: 0, outstanding: 0, invoice_count: 0, paid_invoice_count: 0 };
  const usd = revenue.by_currency?.USD ?? { invoiced: 0, paid: 0, outstanding: 0, invoice_count: 0, paid_invoice_count: 0 };
  const hasRange = Boolean(from || to);

  return (
    <div className={refreshing ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
      {/* One filter row, above everything on this tab. */}
      <div className="bg-white rounded-xl border border-line p-3 mb-5 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          {[
            { label: '7d', days: 7 },
            { label: '30d', days: 30 },
            { label: '90d', days: 90 },
          ].map((p) => {
            const activePreset = from === daysAgo(p.days) && to === isoDay(new Date());
            return (
              <button key={p.label} type="button" aria-pressed={activePreset}
                onClick={() => { setFrom(daysAgo(p.days)); setTo(isoDay(new Date())); }}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  activePreset
                    ? 'bg-teal-dark text-white border-teal'
                    : 'bg-white text-ink-muted border-line hover:bg-surface hover:text-ink'
                }`}>
                {p.label}
              </button>
            );
          })}
        </div>
        <DateField label="From" value={from} onChange={setFrom} />
        <DateField label="To" value={to} onChange={setTo} />
        {hasRange && (
          <button type="button" onClick={() => { setFrom(''); setTo(''); }}
            className="text-xs text-ink-muted hover:text-ink">
            Clear
          </button>
        )}
        <span className="text-[11px] text-ink-muted">
          {hasRange ? 'Filtered range' : 'All time'}
        </span>
        <button onClick={reload} disabled={refreshing}
          className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-line rounded-lg text-sm text-ink hover:bg-surface disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden /> Refresh
        </button>
      </div>

      {tab === 'acquisition' && (
        <AcquisitionSection from={from} to={to} hasRange={hasRange} />
      )}

      {tab === 'traffic' && <AdBaselineSection funnel={funnel} hasRange={hasRange} />}

      {tab === 'checkout' && <PuramassSection pm={puramass} hasRange={hasRange} from={from} to={to} />}

      {tab === 'inventory' && (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
            <KpiCard tint="emerald" icon={Boxes} label="Inventory On Hand"
              value={fmtCurrency(inventory.value)}
              sub={`${inventory.units.toLocaleString()} units · ${inventory.sku_count} SKU${inventory.sku_count !== 1 ? 's' : ''}`} />
            <KpiCard tint="blue" icon={ClipboardList} label="Incoming (Open POs)"
              value={fmtCurrency(incoming.value)}
              sub={`${incoming.units.toLocaleString()} units · ${incoming.po_count} PO${incoming.po_count !== 1 ? 's' : ''}`} />
            <KpiCard tint="teal" icon={DollarSign} label="Earnings — CAD 🇨🇦"
              value={fmtCAD(cad.paid)}
              sub={`${cad.paid_invoice_count} paid · ${fmtCAD(cad.outstanding)} outstanding`} />
            <KpiCard tint="blue" icon={DollarSign} label="Earnings — USD 🇺🇸"
              value={fmtUSD(usd.paid)}
              sub={`${usd.paid_invoice_count} paid · ${fmtUSD(usd.outstanding)} outstanding`} />
          </div>

          {/* Detail cards */}
          <div className="grid lg:grid-cols-3 gap-6 mb-6">
            <DetailCard title="Inventory Snapshot" icon={Boxes} tint="emerald"
              link={{ href: '/admin/products', label: 'View products' }}
              rows={[
                { label: 'Total units', value: inventory.units.toLocaleString() },
                { label: 'Total value', value: fmtCurrency(inventory.value) },
                { label: 'SKUs tracked', value: String(inventory.sku_count) },
                {
                  label: 'Low stock SKUs', value: String(inventory.low_stock_count),
                  accent: inventory.low_stock_count > 0 ? 'amber' : undefined,
                  icon: inventory.low_stock_count > 0 ? AlertTriangle : undefined,
                },
              ]} />
            <DetailCard title="Revenue" icon={DollarSign} tint="teal"
              link={{ href: '/admin/invoices', label: 'View invoices' }}
              rows={[
                { label: 'Invoiced (non-draft)', value: fmtCurrency(revenue.invoiced) },
                { label: 'Paid', value: fmtCurrency(revenue.paid), accent: 'emerald' },
                { label: 'Outstanding', value: fmtCurrency(revenue.outstanding), accent: revenue.outstanding > 0 ? 'amber' : undefined },
                { label: 'Invoices', value: `${revenue.paid_invoice_count} paid / ${revenue.invoice_count} total` },
              ]} />
            <DetailCard title="Incoming Stock" icon={ClipboardList} tint="blue"
              link={{ href: '/admin/purchase-orders', label: 'View purchase orders' }}
              rows={[
                { label: 'Open POs', value: String(incoming.po_count) },
                { label: 'Incoming units', value: incoming.units.toLocaleString() },
                { label: 'Incoming value', value: fmtCurrency(incoming.value) },
              ]} />
          </div>

          {/* Revenue by currency */}
          <div className="mb-6">
            <h2 className="text-sm font-semibold text-ink mb-3 flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-teal-dark" aria-hidden /> Revenue by currency
            </h2>
            <div className="grid sm:grid-cols-2 gap-4">
              <CurrencyRevenueCard label="Canadian" flag="🇨🇦" code="CAD" fmt={fmtCAD} bucket={cad} />
              <CurrencyRevenueCard label="American" flag="🇺🇸" code="USD" fmt={fmtUSD} bucket={usd} />
            </div>
          </div>

          {/* Open Purchase Orders */}
          <div className="bg-white rounded-xl border border-line overflow-hidden">
            <div className="p-5 border-b border-line">
              <h2 className="font-semibold text-ink text-sm flex items-center gap-2">
                <ClipboardList className="w-4 h-4 text-teal-dark" aria-hidden /> Open Purchase Orders
              </h2>
            </div>
            {incoming.pos.length === 0 ? (
              <div className="p-8 text-center text-sm text-ink-muted">
                No open purchase orders. Inventory replenishment is up to date.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[640px]">
                  <thead>
                    <tr className="border-b border-line bg-surface">
                      <th className="px-5 py-3 text-left text-xs font-semibold text-ink-muted uppercase tracking-wider">PO #</th>
                      <th className="px-5 py-3 text-left text-xs font-semibold text-ink-muted uppercase tracking-wider">Supplier</th>
                      <th className="px-5 py-3 text-left text-xs font-semibold text-ink-muted uppercase tracking-wider">Status</th>
                      <th className="px-5 py-3 text-left text-xs font-semibold text-ink-muted uppercase tracking-wider">Expected</th>
                      <th className="px-5 py-3 text-right text-xs font-semibold text-ink-muted uppercase tracking-wider">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/50">
                    {incoming.pos.map((po) => {
                      const meta = PO_STATUS_META[po.status as keyof typeof PO_STATUS_META];
                      return (
                        <tr key={po.id} className="hover:bg-surface transition-colors">
                          <td className="px-5 py-3">
                            <Link href={`/admin/purchase-orders/${po.id}`}
                              className="inline-flex items-center gap-1.5 font-mono text-sm font-medium text-teal-dark hover:text-teal-dark/80">
                              <FileText className="w-3.5 h-3.5" aria-hidden /> {po.po_number}
                            </Link>
                          </td>
                          <td className="px-5 py-3 text-sm text-ink">{po.supplier_name ?? '—'}</td>
                          <td className="px-5 py-3">
                            <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium border ${meta?.badge ?? 'bg-gray-500/10 text-gray-700 border-gray-200'}`}>
                              {meta?.label ?? po.status.replace('_', ' ')}
                            </span>
                          </td>
                          <td className="px-5 py-3 text-sm text-ink-muted">{fmtDate(po.expected_date)}</td>
                          <td className="px-5 py-3 text-right tabular-nums font-semibold text-ink">{fmtCurrency(po.total)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---- sub-components ----

function KpiCard({ label, value, sub, icon: Icon, tint }: {
  label: string; value: string; sub: string; icon: React.ElementType; tint: Tint;
}) {
  const t = TINTS[tint];
  return (
    <div className="bg-white rounded-xl border border-line p-5">
      <div className="flex items-start justify-between mb-3">
        <p className="text-[10px] text-ink-muted uppercase tracking-wider font-semibold">{label}</p>
        <div className={`w-9 h-9 rounded-lg ${t.bg} flex items-center justify-center`}>
          <Icon className={`w-4 h-4 ${t.fg}`} />
        </div>
      </div>
      <p className={`text-2xl font-bold tabular-nums ${t.fg}`}>{value}</p>
      <p className="text-xs text-ink-muted mt-1">{sub}</p>
    </div>
  );
}

function CurrencyRevenueCard({
  label, flag, code, fmt, bucket,
}: {
  label: string; flag: string; code: 'CAD' | 'USD';
  fmt: (n: number) => string;
  bucket: { invoiced: number; paid: number; outstanding: number; invoice_count: number; paid_invoice_count: number };
}) {
  const rows: { label: string; value: string; accent?: 'emerald' | 'amber' }[] = [
    { label: 'Invoiced', value: fmt(bucket.invoiced) },
    { label: 'Paid', value: fmt(bucket.paid), accent: 'emerald' },
    { label: 'Outstanding', value: fmt(bucket.outstanding), accent: bucket.outstanding > 0 ? 'amber' : undefined },
    { label: 'Paid / total', value: `${bucket.paid_invoice_count} / ${bucket.invoice_count}` },
  ];
  const accentClass = (a?: 'emerald' | 'amber') =>
    a === 'emerald' ? 'text-emerald-700' : a === 'amber' ? 'text-amber-700' : 'text-ink';
  return (
    <div className="bg-white rounded-xl border border-line overflow-hidden">
      <div className="p-4 border-b border-line flex items-center justify-between">
        <h3 className="font-semibold text-ink text-sm flex items-center gap-2">
          <span className="text-base">{flag}</span> {label}
        </h3>
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-teal/10 text-teal-dark">{code}</span>
      </div>
      <div className="p-4 space-y-2.5 text-sm">
        {rows.map((r) => (
          <div key={r.label} className="flex justify-between items-center">
            <span className="text-ink-muted">{r.label}</span>
            <span className={`font-semibold tabular-nums ${accentClass(r.accent)}`}>{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface DetailRow {
  label: string;
  value: string;
  accent?: 'emerald' | 'amber';
  icon?: React.ElementType;
}

function DetailCard({ title, icon: Icon, tint, rows, link }: {
  title: string; icon: React.ElementType; tint: Tint; rows: DetailRow[];
  link: { href: string; label: string };
}) {
  const t = TINTS[tint];
  const accentClass = (a?: 'emerald' | 'amber') =>
    a === 'emerald' ? 'text-emerald-700' : a === 'amber' ? 'text-amber-700' : 'text-ink';
  return (
    <div className="bg-white rounded-xl border border-line overflow-hidden flex flex-col">
      <div className="p-5 border-b border-line">
        <h2 className="font-semibold text-ink text-sm flex items-center gap-2">
          <span className={`w-7 h-7 rounded-lg ${t.bg} flex items-center justify-center`}>
            <Icon className={`w-4 h-4 ${t.fg}`} />
          </span>
          {title}
        </h2>
      </div>
      <div className="p-5 space-y-2.5 text-sm flex-1">
        {rows.map((r) => {
          const RowIcon = r.icon;
          return (
            <div key={r.label} className="flex justify-between items-center">
              <span className="text-ink-muted flex items-center gap-1.5">
                {RowIcon && <RowIcon className="w-3.5 h-3.5 text-amber-600" />}
                {r.label}
              </span>
              <span className={`font-semibold tabular-nums ${accentClass(r.accent)}`}>{r.value}</span>
            </div>
          );
        })}
      </div>
      <div className="px-5 py-3 border-t border-line">
        <Link href={link.href} className="text-xs text-teal-dark hover:text-teal-dark/80">{link.label} →</Link>
      </div>
    </div>
  );
}

function DateField({ label, value, onChange }: {
  label: string; value: string; onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 bg-white border border-line rounded-lg px-3 py-1.5">
      <Calendar className="w-3.5 h-3.5 text-ink-muted" />
      <span className="text-[10px] text-ink-muted uppercase tracking-wider">{label}</span>
      <input type="date" value={value} onChange={(e) => onChange(e.target.value)}
        className="text-sm text-ink bg-transparent border-0 focus:outline-none" />
    </label>
  );
}

// ---- Traffic & conversion (ad baseline) ----

// Section-wide semantic colours, drawn from a CVD-validated categorical set.
const C = {
  shoppers: '#1b5d83', // blue — traffic
  orders: '#eb6834',   // orange — orders placed
  paid: '#059669',     // emerald — paid / success
  pending: '#eda100',  // amber — payment in flight
  abandoned: '#e34948',// red — payment window lapsed
  cancelled: '#6E8898',// grey — cancelled
  other: '#DCE7EB',
};

function AdBaselineSection({ funnel, hasRange }: { funnel: FunnelSummary; hasRange: boolean }) {
  return (
    <section className="mb-8">
      <div className="flex items-center gap-2 mb-1">
        <div className="w-8 h-8 rounded-lg bg-teal/10 flex items-center justify-center">
          <Megaphone className="w-4 h-4 text-teal-dark" />
        </div>
        <h2 className="text-lg font-bold text-ink">Traffic &amp; Conversion — Ad Baseline</h2>
      </div>
      <p className="text-sm text-ink-muted mb-3 ml-10">
        Where your funnel stands {hasRange ? 'over the selected range' : 'all-time'}. Snapshot this before your ads go
        live, then revisit the same range afterwards to measure the lift.
      </p>

      {/* Explainer */}
      <div className="rounded-xl border border-teal/30 bg-teal/[0.04] p-4 mb-5 flex gap-3">
        <Info className="w-4 h-4 text-teal-dark shrink-0 mt-0.5" />
        <p className="text-xs text-ink-muted leading-relaxed">
          <span className="font-semibold text-ink">Capture your baseline first.</span>{' '}
          Use the <span className="font-medium text-ink">7d / 30d / 90d</span> presets above to freeze the current
          numbers, note them, and compare the same window once ads are running.{' '}
          Shopper engagement now counts <span className="font-medium text-ink">anonymous visitors too</span>,
          so figures from before attribution started collecting are not comparable with those after it.
          For the split by traffic source, see the{' '}
          <span className="font-medium text-ink">Acquisition</span> tab.
        </p>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <KpiCard tint="blue" icon={Users} label="Active Shoppers"
          value={fmtInt(funnel.active_shoppers)} sub={`${fmtInt(funnel.registrations)} new sign-ups`} />
        <KpiCard tint="teal" icon={ShoppingCart} label="Orders Placed"
          value={fmtInt(funnel.orders_placed)}
          sub={`${fmtInt(funnel.paid_orders)} paid · ${fmtInt(funnel.abandoned_orders)} abandoned`} />
        <KpiCard tint="emerald" icon={CheckCircle2} label="Paid Orders"
          value={fmtInt(funnel.paid_orders)} sub={`${fmtPct(funnel.rates.payment)} payment rate`} />
        <KpiCard tint="teal" icon={Percent} label="Overall Conversion"
          value={fmtPct(funnel.rates.overall)} sub="paid ÷ active shoppers" />
      </div>

      {/* Funnel + outcomes/engagement */}
      <div className="grid lg:grid-cols-2 gap-6 mb-6">
        <ConversionFunnel funnel={funnel} />
        <div className="flex flex-col gap-6">
          <OrderOutcomes funnel={funnel} />
          <EngagementStats funnel={funnel} />
        </div>
      </div>

      {/* Daily trends (small multiples — each its own scale) */}
      <div className="grid md:grid-cols-2 gap-6">
        <MiniTrendChart
          title="Daily active shoppers"
          subtitle={funnel.daily_truncated ? `Most recent ${funnel.daily.length} days` : 'Distinct visitors per day'}
          points={funnel.daily}
          series={[{ key: 'shoppers', label: 'Active shoppers', color: C.shoppers, fill: true }]}
        />
        <MiniTrendChart
          title="Daily orders"
          subtitle="Orders placed vs paid, per day"
          points={funnel.daily}
          series={[
            { key: 'orders', label: 'Placed', color: C.orders, fill: false },
            { key: 'paid', label: 'Paid', color: C.paid, fill: true },
          ]}
        />
      </div>
    </section>
  );
}

function PuramassSection({ pm, hasRange, from, to }: {
  pm: PuramassSummary; hasRange: boolean; from: string; to: string;
}) {
  const primary = pm.primary_currency;
  const fmtCur = primary === 'USD' ? fmtUSD : fmtCAD;
  const usd = pm.by_currency?.USD ?? { paid_orders: 0, gross: 0, refunds: 0, net: 0 };
  const cad = pm.by_currency?.CAD ?? { paid_orders: 0, gross: 0, refunds: 0, net: 0 };

  const outcomes = [
    { label: 'Paid', value: pm.paid_orders, color: C.paid },
    { label: 'Pending', value: pm.pending_orders, color: C.pending },
    { label: 'Expired', value: pm.expired_orders, color: C.abandoned },
    { label: 'Cancelled', value: pm.cancelled_orders, color: C.cancelled },
  ];
  const totalHandoffs = Math.max(1, pm.total_handoffs);
  const topMax = Math.max(1, ...pm.top_products.map((x) => x.quantity));

  const dailyPoints: DailyPoint[] = pm.daily.map((d) => ({
    date: d.date, shoppers: 0, orders: 0, paid: d.paid, revenue: d.revenue,
  }));

  return (
    <section className="mb-8">
      <div className="flex items-center gap-2 mb-1">
        <div className="w-8 h-8 rounded-lg bg-teal/10 flex items-center justify-center">
          <CreditCard className="w-4 h-4 text-teal-dark" />
        </div>
        <h2 className="text-lg font-bold text-ink">Stealth Health — Paid Orders</h2>
      </div>
      <p className="text-sm text-ink-muted mb-4 ml-10">
        Orders handed off to Stealth Health hosted checkout {hasRange ? 'over the selected range' : 'all-time'} — a separate
        revenue stream from your storefront invoices. Headline figures are shown in {primary}.
      </p>

      {pm.total_handoffs === 0 ? (
        <div className="rounded-xl border border-line bg-white p-8 text-center text-sm text-ink-muted">
          No Stealth Health hand-offs in this range yet.
        </div>
      ) : (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
            <KpiCard tint="emerald" icon={CheckCircle2} label="Paid Orders"
              value={fmtInt(pm.paid_orders)}
              sub={`${fmtPct(pm.conversion)} of ${fmtInt(pm.total_handoffs)} hand-offs`} />
            <KpiCard tint="teal" icon={DollarSign} label={`Net Revenue — ${primary}`}
              value={fmtCur(pm.net)}
              sub={pm.refunds > 0
                ? `${fmtCur(pm.gross)} gross · ${fmtCur(pm.refunds)} refunded`
                : `${fmtCur(pm.gross)} gross`} />
            <KpiCard tint="blue" icon={Receipt} label="Avg Order Value"
              value={fmtCur(pm.aov)} sub={`${primary} per paid order`} />
            <KpiCard tint="teal" icon={Package} label="Units Sold"
              value={fmtInt(pm.units)} sub="across paid orders" />
          </div>

          {/* What that revenue is worth to US — Stealth Health collects it, so
              the settlement dashboard is where it turns into a receivable. */}
          <StealthHealthEarningsStrip from={from} to={to} />

          <div className="grid lg:grid-cols-2 gap-6 mb-6">
            {/* Hand-off outcomes */}
            <div className="bg-white rounded-xl border border-line p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
                  <Receipt className="w-4 h-4 text-teal-dark" /> Hand-off outcomes
                </h3>
                <span className="text-xs text-ink-muted">{fmtInt(pm.total_handoffs)} total</span>
              </div>
              <div className="flex w-full h-3 rounded-full overflow-hidden gap-[2px] mb-3 bg-surface">
                {outcomes.filter((s) => s.value > 0).map((s) => (
                  <div key={s.label} style={{ width: `${(s.value / totalHandoffs) * 100}%`, background: s.color }}
                    title={`${s.label}: ${fmtInt(s.value)}`} />
                ))}
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                {outcomes.map((s) => (
                  <div key={s.label} className="flex items-center gap-1.5 text-xs">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: s.color }} />
                    <span className="text-ink-muted">{s.label}</span>
                    <span className="ml-auto font-semibold tabular-nums text-ink">{fmtInt(s.value)}</span>
                  </div>
                ))}
              </div>
              {usd.paid_orders > 0 && cad.paid_orders > 0 && (
                <div className="mt-4 pt-3 border-t border-line grid grid-cols-2 gap-4 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-ink-muted">🇺🇸 USD net</span>
                    <span className="font-semibold tabular-nums text-ink">{fmtUSD(usd.net)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-ink-muted">🇨🇦 CAD net</span>
                    <span className="font-semibold tabular-nums text-ink">{fmtCAD(cad.net)}</span>
                  </div>
                </div>
              )}
            </div>

            {/* Top products */}
            <div className="bg-white rounded-xl border border-line p-5">
              <h3 className="text-sm font-semibold text-ink mb-3 flex items-center gap-2">
                <Package className="w-4 h-4 text-teal-dark" /> Top products (paid)
              </h3>
              {pm.top_products.length === 0 ? (
                <div className="text-xs text-ink-muted py-4 text-center">No line items on paid orders yet.</div>
              ) : (
                <div className="space-y-2.5">
                  {pm.top_products.map((p) => {
                    const w = Math.max(4, (p.quantity / topMax) * 100);
                    return (
                      <div key={p.sku}>
                        <div className="flex items-center justify-between text-xs mb-1">
                          <span className="text-ink truncate pr-2">{p.name ?? p.sku}</span>
                          <span className="text-ink-muted tabular-nums shrink-0">
                            {fmtInt(p.quantity)} unit{p.quantity !== 1 ? 's' : ''} · {fmtInt(p.orders)} order{p.orders !== 1 ? 's' : ''}
                          </span>
                        </div>
                        <div className="h-1.5 bg-surface rounded-full overflow-hidden">
                          <div className="h-full rounded-full bg-teal" style={{ width: `${w}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Daily trends */}
          <div className="grid md:grid-cols-2 gap-6">
            <MiniTrendChart
              title="Daily paid orders"
              subtitle={pm.daily_truncated ? `Most recent ${pm.daily.length} days` : 'Stealth Health paid orders per day'}
              points={dailyPoints}
              series={[{ key: 'paid', label: 'Paid orders', color: C.paid, fill: true }]}
            />
            <MiniTrendChart
              title={`Daily paid revenue — ${primary}`}
              subtitle="Net of refunds, per day"
              points={dailyPoints}
              series={[{ key: 'revenue', label: 'Revenue', color: '#1B5D83', fill: true }]}
              format={fmtCur}
            />
          </div>
        </>
      )}
    </section>
  );
}

function ConversionFunnel({ funnel }: { funnel: FunnelSummary }) {
  const stages = [
    { label: 'Active shoppers', value: funnel.active_shoppers, icon: Users, color: '#6EB2B8' },
    { label: 'Added to cart', value: funnel.cart_shoppers, icon: ShoppingCart, color: '#438B9E' },
    { label: 'Orders placed', value: funnel.orders_placed, icon: Receipt, color: '#1B5D83' },
    { label: 'Paid orders', value: funnel.paid_orders, icon: CheckCircle2, color: C.paid },
  ];
  const max = Math.max(1, ...stages.map((s) => s.value));

  return (
    <div className="bg-white rounded-xl border border-line p-5">
      <h3 className="text-sm font-semibold text-ink mb-4 flex items-center gap-2">
        <TrendingUp className="w-4 h-4 text-teal-dark" /> Conversion funnel
      </h3>
      <div className="space-y-3">
        {stages.map((s, i) => {
          const prev = i > 0 ? stages[i - 1].value : null;
          const step = prev != null && prev > 0 ? +((s.value / prev) * 100).toFixed(1) : null;
          const w = Math.max(2, (s.value / max) * 100);
          const Icon = s.icon;
          return (
            <div key={s.label}>
              {step != null && (
                <div className="text-[10px] text-ink-light mb-1 ml-[8.75rem]">↓ {fmtPct(step)} continue</div>
              )}
              <div className="flex items-center gap-3">
                <div className="w-32 shrink-0 flex items-center gap-1.5 text-xs text-ink">
                  <Icon className="w-3.5 h-3.5 shrink-0" style={{ color: s.color }} />
                  <span className="truncate">{s.label}</span>
                </div>
                <div className="flex-1 h-7 bg-surface rounded-md overflow-hidden">
                  <div className="h-full rounded-md transition-[width] duration-500"
                    style={{ width: `${w}%`, background: s.color }} />
                </div>
                <div className="w-14 text-right text-sm font-semibold tabular-nums text-ink">{fmtInt(s.value)}</div>
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-ink-muted mt-4 pt-3 border-t border-line">
        Overall, <span className="font-semibold text-ink">{fmtPct(funnel.rates.overall)}</span> of visitors
        reach a paid order{funnel.rates.cart > 0 && <> · <span className="font-semibold text-ink">{fmtPct(funnel.rates.cart)}</span> add to cart</>}.
      </p>
    </div>
  );
}

function OrderOutcomes({ funnel }: { funnel: FunnelSummary }) {
  const known = funnel.paid_orders + funnel.pending_orders + funnel.abandoned_orders + funnel.cancelled_orders;
  const other = Math.max(0, funnel.orders_placed - known);
  const segs = [
    { label: 'Paid', value: funnel.paid_orders, color: C.paid },
    { label: 'Pending', value: funnel.pending_orders, color: C.pending },
    { label: 'Abandoned', value: funnel.abandoned_orders, color: C.abandoned },
    { label: 'Cancelled', value: funnel.cancelled_orders, color: C.cancelled },
    ...(other > 0 ? [{ label: 'Other', value: other, color: C.other }] : []),
  ];
  const total = Math.max(1, funnel.orders_placed);

  return (
    <div className="bg-white rounded-xl border border-line p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
          <Receipt className="w-4 h-4 text-teal-dark" /> Order outcomes
        </h3>
        <span className="text-xs text-ink-muted">{fmtInt(funnel.orders_placed)} placed</span>
      </div>
      {funnel.orders_placed === 0 ? (
        <div className="text-xs text-ink-muted py-4 text-center">No orders placed in this range yet.</div>
      ) : (
        <>
          <div className="flex w-full h-3 rounded-full overflow-hidden gap-[2px] mb-3 bg-surface">
            {segs.filter((s) => s.value > 0).map((s) => (
              <div key={s.label} style={{ width: `${(s.value / total) * 100}%`, background: s.color }}
                title={`${s.label}: ${fmtInt(s.value)}`} />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            {segs.map((s) => (
              <div key={s.label} className="flex items-center gap-1.5 text-xs">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: s.color }} />
                <span className="text-ink-muted">{s.label}</span>
                <span className="ml-auto font-semibold tabular-nums text-ink">{fmtInt(s.value)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function EngagementStats({ funnel }: { funnel: FunnelSummary }) {
  const rows: { label: string; value: string; icon: React.ElementType }[] = [
    { label: 'New registrations', value: fmtInt(funnel.registrations), icon: UserPlus },
    { label: 'Product views', value: fmtInt(funnel.product_views), icon: Eye },
    { label: 'Searches', value: fmtInt(funnel.searches), icon: Search },
    { label: 'Add-to-cart events', value: fmtInt(funnel.cart_events), icon: ShoppingCart },
    { label: 'Order revenue (paid)', value: fmtCurrency(funnel.order_revenue), icon: DollarSign },
    { label: 'Avg. order value', value: fmtCurrency(funnel.aov), icon: Receipt },
  ];
  return (
    <div className="bg-white rounded-xl border border-line p-5">
      <h3 className="text-sm font-semibold text-ink mb-3 flex items-center gap-2">
        <Users className="w-4 h-4 text-teal-dark" /> Engagement &amp; value
      </h3>
      <div className="space-y-2.5 text-sm">
        {rows.map((r) => {
          const Icon = r.icon;
          return (
            <div key={r.label} className="flex items-center justify-between">
              <span className="text-ink-muted flex items-center gap-1.5">
                <Icon className="w-3.5 h-3.5 text-ink-light" /> {r.label}
              </span>
              <span className="font-semibold tabular-nums text-ink">{r.value}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type DailyPoint = FunnelSummary['daily'][number];
interface ChartSeries {
  key: 'shoppers' | 'orders' | 'paid' | 'revenue';
  label: string;
  color: string;
  fill: boolean;
}

function MiniTrendChart({ title, subtitle, points, series, format }: {
  title: string; subtitle?: string; points: DailyPoint[]; series: ChartSeries[];
  format?: (n: number) => string;
}) {
  const fmtVal = format ?? fmtInt;
  const [hover, setHover] = useState<number | null>(null);
  const W = 480, H = 160, padL = 8, padR = 10, padT = 12, padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = points.length;
  const baseY = padT + plotH;

  const maxVal = Math.max(1, ...points.flatMap((p) => series.map((s) => Number(p[s.key] ?? 0))));
  const x = (i: number) => (n <= 1 ? padL + plotW / 2 : padL + (i * plotW) / (n - 1));
  const y = (v: number) => padT + plotH * (1 - v / maxVal);

  const fmtDay = (d: string) =>
    new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  const linePath = (key: ChartSeries['key']) =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(Number(p[key] ?? 0)).toFixed(1)}`).join(' ');
  const areaPath = (key: ChartSeries['key']) =>
    `${linePath(key)} L ${x(n - 1).toFixed(1)} ${baseY.toFixed(1)} L ${x(0).toFixed(1)} ${baseY.toFixed(1)} Z`;

  const showDots = n > 0 && n <= 24;
  const hovered = hover != null ? points[hover] : null;
  const tipLeftPct = hover != null ? Math.min(88, Math.max(12, (x(hover) / W) * 100)) : 0;

  return (
    <div className="bg-white rounded-xl border border-line p-4">
      <div className="flex items-start justify-between mb-2 gap-2">
        <div>
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          {subtitle && <p className="text-[11px] text-ink-muted mt-0.5">{subtitle}</p>}
        </div>
        {series.length > 1 && (
          <div className="flex flex-wrap items-center gap-2.5">
            {series.map((s) => (
              <span key={s.key} className="inline-flex items-center gap-1 text-[11px] text-ink-muted">
                <span className="inline-block rounded-full" style={{ width: 8, height: 8, background: s.color }} />
                {s.label}
              </span>
            ))}
          </div>
        )}
      </div>

      {n === 0 ? (
        <div className="h-[160px] flex items-center justify-center text-xs text-ink-muted">
          No activity in this range yet.
        </div>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" onMouseLeave={() => setHover(null)}>
            {[0, 0.5, 1].map((t) => {
              const gy = padT + plotH * t;
              return <line key={t} x1={padL} x2={W - padR} y1={gy} y2={gy} stroke="#DCE7EB" strokeWidth={1} strokeOpacity={0.4} />;
            })}
            {series.filter((s) => s.fill).map((s) => (
              <path key={`a-${s.key}`} d={areaPath(s.key)} fill={s.color} fillOpacity={0.12} stroke="none" />
            ))}
            {series.map((s) => (
              <path key={`l-${s.key}`} d={linePath(s.key)} fill="none" stroke={s.color} strokeWidth={2}
                strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {showDots && series.map((s) =>
              points.map((p, i) => (
                <circle key={`${s.key}-${i}`} cx={x(i)} cy={y(Number(p[s.key] ?? 0))} r={2.5}
                  fill={s.color} stroke="#fff" strokeWidth={1} />
              )),
            )}
            {!showDots && series.map((s) => (
              <circle key={`end-${s.key}`} cx={x(n - 1)} cy={y(Number(points[n - 1][s.key] ?? 0))} r={3}
                fill={s.color} stroke="#fff" strokeWidth={1.5} />
            ))}
            {hover != null && (
              <g>
                <line x1={x(hover)} x2={x(hover)} y1={padT} y2={baseY} stroke="#56707F" strokeWidth={1} strokeDasharray="3 3" />
                {series.map((s) => (
                  <circle key={`h-${s.key}`} cx={x(hover)} cy={y(Number(points[hover][s.key] ?? 0))} r={3.5}
                    fill={s.color} stroke="#fff" strokeWidth={1.5} />
                ))}
              </g>
            )}
            {points.map((_, i) => (
              <rect key={i} x={i * (W / n)} y={0} width={W / n} height={H} fill="transparent"
                onMouseEnter={() => setHover(i)} />
            ))}
          </svg>

          <div className="absolute top-1 left-2 text-[10px] text-ink-light tabular-nums">{fmtVal(maxVal)}</div>
          {n > 1 && (
            <>
              <div className="absolute bottom-1 left-2 text-[10px] text-ink-light">{fmtDay(points[0].date)}</div>
              <div className="absolute bottom-1 right-2 text-[10px] text-ink-light">{fmtDay(points[n - 1].date)}</div>
            </>
          )}

          {hovered && (
            <div className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg bg-ink text-white text-[11px] px-2.5 py-1.5 shadow-lg"
              style={{ left: `${tipLeftPct}%`, top: 2 }}>
              <div className="font-semibold mb-0.5 whitespace-nowrap">{fmtDay(hovered.date)}</div>
              {series.map((s) => (
                <div key={s.key} className="flex items-center gap-1.5 whitespace-nowrap">
                  <span className="inline-block w-2 h-2 rounded-full" style={{ background: s.color }} />
                  <span className="text-white/80">{s.label}</span>
                  <span className="ml-auto font-semibold tabular-nums">{fmtVal(Number(hovered[s.key] ?? 0))}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Stealth Health revenue seen from OUR side of the deal.
 *
 * The Stealth Health figures above are what buyers paid Stealth Health. Because they
 * collect and we fulfil, that money is a receivable — this strip shows what it
 * is actually worth to us under the settlement terms, and what is still owed.
 * Loaded separately so a missing settlement migration degrades to nothing
 * rendered here rather than breaking the analytics page.
 */
function StealthHealthEarningsStrip({ from, to }: { from: string; to: string }) {
  const [sh, setSh] = useState<StealthHealthSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getStealthHealthSummary({ from: from || null, to: to || null })
      .then((s) => { if (!cancelled) setSh(s); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [from, to]);

  if (loading || !sh || sh.earned.order_count === 0) return null;

  const cur = sh.currency;
  const fmt = (cents: number) => formatMoney(toAmount(cents), cur);
  const b = sh.balance;

  return (
    <div className="bg-white rounded-xl border border-line p-5 mb-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
          <Handshake className="w-4 h-4 text-teal-dark" /> What we earn on it
        </h3>
        <Link href="/admin/stealth-health"
          className="inline-flex items-center gap-1 text-xs font-medium text-teal-dark hover:underline">
          Settlement dashboard <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <EarningsStat icon={DollarSign} tint="text-teal-dark" label="Earned"
          value={fmt(sh.earned.due_cents)}
          sub={`${fmtInt(sh.earned.order_count)} paid order${sh.earned.order_count === 1 ? '' : 's'}`} />
        <EarningsStat icon={Percent} tint="text-amber-700" label="Their cut"
          value={fmt(sh.earned.fee_cents)}
          sub={sh.earned.fee_cents === 0 ? 'they retain nothing' : 'commission + fees'} />
        <EarningsStat icon={Wallet} tint="text-emerald-700" label="Paid to us"
          value={fmt(b.paid_cents)} sub="all-time remittances" />
        <EarningsStat icon={Scale} tint={b.outstanding_cents > 0 ? 'text-amber-700' : 'text-emerald-700'}
          label="They owe us" value={fmt(b.outstanding_cents)} sub="all-time balance" />
      </div>

      <p className="text-[11px] text-ink-muted mt-4 pt-3 border-t border-line leading-relaxed">
        {sh.terms_summary}{' '}
        {b.uninvoiced_cents > 0
          ? <>· <span className="font-medium text-ink">{fmt(b.uninvoiced_cents)}</span> earned but not yet invoiced.</>
          : '· Everything earned has been invoiced.'}
      </p>
    </div>
  );
}

function EarningsStat({ icon: Icon, tint, label, value, sub }: {
  icon: React.ElementType; tint: string; label: string; value: string; sub: string;
}) {
  return (
    <div>
      <p className="text-[10px] text-ink-muted uppercase tracking-wider font-semibold flex items-center gap-1.5 mb-1">
        <Icon className={`w-3.5 h-3.5 ${tint}`} /> {label}
      </p>
      <p className={`text-xl font-bold tabular-nums ${tint}`}>{value}</p>
      <p className="text-[11px] text-ink-muted mt-0.5">{sub}</p>
    </div>
  );
}
