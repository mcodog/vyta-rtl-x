'use client';

/**
 * Small presentational pieces shared across the Stealth Health settlement
 * dashboard. Kept in one file so the KPI cards, money formatting and status
 * chips read the same on the overview, the invoice list and the invoice page.
 */
import { formatAppDate } from '@/lib/datetime';
import React from 'react';
import { formatMoney, type Currency } from '@/lib/currency';
import {
  SETTLEMENT_STATUS_META,
  toAmount,
  type SettlementInvoiceStatus,
} from '@/lib/admin/stealth-health';

export type Tint = 'emerald' | 'blue' | 'teal' | 'amber' | 'rose' | 'neutral';

const TINTS: Record<Tint, { fg: string; bg: string }> = {
  emerald: { fg: 'text-emerald-700', bg: 'bg-emerald-100' },
  blue: { fg: 'text-blue-700', bg: 'bg-blue-100' },
  teal: { fg: 'text-teal-dark', bg: 'bg-teal/10' },
  amber: { fg: 'text-amber-700', bg: 'bg-amber-100' },
  rose: { fg: 'text-rose-700', bg: 'bg-rose-100' },
  neutral: { fg: 'text-ink', bg: 'bg-surface' },
};

/** Cents → a currency string. Every figure on this dashboard goes through here. */
export function money(cents: number, currency: Currency = 'USD'): string {
  return formatMoney(toAmount(cents), currency);
}

export const fmtInt = (n: number) => Number(n ?? 0).toLocaleString();

export function fmtDate(d: string | null | undefined): string {
  return formatAppDate(d, {});
}

export function KpiCard({ label, value, sub, icon: Icon, tint = 'neutral', hint }: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  tint?: Tint;
  hint?: string;
}) {
  const t = TINTS[tint];
  return (
    <div className="bg-white rounded-xl border border-line p-5" title={hint}>
      <div className="flex items-start justify-between mb-3">
        <p className="text-[10px] text-ink-muted uppercase tracking-wider font-semibold">{label}</p>
        <div className={`w-9 h-9 rounded-lg ${t.bg} flex items-center justify-center shrink-0`}>
          <Icon className={`w-4 h-4 ${t.fg}`} />
        </div>
      </div>
      <p className={`text-2xl font-bold tabular-nums ${t.fg}`}>{value}</p>
      {sub && <p className="text-xs text-ink-muted mt-1">{sub}</p>}
    </div>
  );
}

export function StatusBadge({ status }: { status: SettlementInvoiceStatus }) {
  const meta = SETTLEMENT_STATUS_META[status] ?? SETTLEMENT_STATUS_META.draft;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${meta.classes}`}>
      {meta.label}
    </span>
  );
}

/** One line of an arithmetic breakdown — label left, signed amount right. */
export function MoneyRow({ label, cents, currency, sign, strong, hint }: {
  label: string;
  cents: number;
  currency: Currency;
  sign?: '+' | '−';
  strong?: boolean;
  hint?: string;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-4 py-1.5 ${strong ? 'border-t border-line pt-2.5 mt-1' : ''}`}
      title={hint}
    >
      <span className={strong ? 'text-sm font-semibold text-ink' : 'text-sm text-ink-muted'}>
        {label}
      </span>
      <span className={`tabular-nums ${strong ? 'text-base font-bold text-ink' : 'text-sm text-ink'}`}>
        {sign && <span className="text-ink-muted mr-0.5">{sign}</span>}
        {money(cents, currency)}
      </span>
    </div>
  );
}

/**
 * Compact bar chart of a daily series. Deliberately dependency-free (as with
 * the storefront analytics charts) — an SVG polyline plus hover targets.
 */
export function DailyBars({ points, currency, title, subtitle }: {
  points: Array<{ date: string; earned_cents: number; orders: number }>;
  currency: Currency;
  title: string;
  subtitle?: string;
}) {
  const max = Math.max(1, ...points.map((p) => p.earned_cents));
  return (
    <div className="bg-white rounded-xl border border-line p-5">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {subtitle && <p className="text-xs text-ink-muted mt-0.5">{subtitle}</p>}
      </div>
      {points.length === 0 ? (
        <div className="h-32 flex items-center justify-center text-xs text-ink-muted">
          Nothing earned in this range.
        </div>
      ) : (
        <div className="flex items-end gap-[2px] h-32">
          {points.map((p) => (
            <div
              key={p.date}
              className="flex-1 min-w-[2px] bg-teal/70 hover:bg-teal rounded-t transition-colors"
              style={{ height: `${Math.max(2, (p.earned_cents / max) * 100)}%` }}
              title={`${p.date} · ${money(p.earned_cents, currency)} · ${p.orders} order${p.orders === 1 ? '' : 's'}`}
            />
          ))}
        </div>
      )}
      {points.length > 0 && (
        <div className="flex justify-between text-[10px] text-ink-muted mt-2">
          <span>{points[0].date}</span>
          <span>{points[points.length - 1].date}</span>
        </div>
      )}
    </div>
  );
}

/** The "the migration hasn't run yet" banner every tab can show. */
export function MigrationNotice() {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 mb-5">
      <p className="text-sm font-semibold text-amber-900">Settlement tables not found</p>
      <p className="text-xs text-amber-800 mt-1 leading-relaxed">
        Run <code className="px-1 py-0.5 rounded bg-amber-100 font-mono">stealth-health-settlement-migration.sql</code>{' '}
        in the Supabase SQL editor to enable invoicing and payout tracking. Until then the earnings
        figures below are computed live from the hand-off ledger, but nothing can be billed or
        marked as paid.
      </p>
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-line bg-white p-10 text-center text-sm text-ink-muted">
      {message}
    </div>
  );
}
