'use client';

/**
 * The Stealth Health hosted-checkout ledger, shown as the "Orders" tab of
 * /admin/stealth-health. It used to live at /admin/puramass-orders; the
 * hand-offs it lists are the raw rows every settlement figure on the rest of
 * this dashboard is derived from, so it now sits beside them.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  CreditCard,
  Loader2,
  RefreshCw,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  Eye,
  Check,
  EyeOff,
  Trash2,
  Copy,
  MapPin,
  Search,
  Columns3,
  CloudDownload,
  FileText,
  MailCheck,
  MailPlus,
  ShoppingCart,
  Sparkles,
  X,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useToast } from '@/contexts/ToastContext';
import { useUserRole } from '@/app/(admin)/admin/layout';
import { canDelete, canEdit } from '@/lib/permissions';
import type { ConfirmationSummary } from '@/lib/order-confirmation-data';
import { INVOICE_STATUS_META, effectiveStatus } from '@/lib/admin/invoice-status';
import type { InvoiceStatus } from '@/lib/types/ecommerce';
import {
  toShippingAddress,
  formatAddressLines,
  formatAddressOneLine,
} from '@/lib/payments/puramass-address';
import {
  RECOVERABLE_STATUSES,
  hasReusablePaymentLink,
  recoveryOffer,
  wasRecovered,
} from '@/lib/payments/puramass-abandoned';
import { COLUMNS, useColumnPreferences, type ColumnKey } from './columns';
import CustomerOrderQuickview from './CustomerOrderQuickview';
import DeletePuramassOrdersDialog from './DeletePuramassOrdersDialog';
import RequestAddressDialog from './RequestAddressDialog';
import RecoverCheckoutDialog, {
  type RecoverySendPayload,
  type RecoverySendResult,
} from './RecoverCheckoutDialog';
import BulkRecoverDialog from './BulkRecoverDialog';

interface LedgerItem {
  sku?: string;
  quantity?: number;
}

/** The customer-facing invoice a paid hand-off materialised into. */
interface InvoiceSummary {
  id: string;
  invoice_number: string;
  customer_id: string | null;
  customer_email: string | null;
  status: string;
  fulfillment_status: string | null;
  fulfillment_type: string | null;
  due_date: string | null;
  packed_at: string | null;
  fulfilled_at: string | null;
  currency: string | null;
  subtotal: number | null;
  shipping_cost: number | null;
  total: number | null;
  created_at: string;
}

export interface PuramassOrderRow {
  id: string;
  partner_reference: string;
  transaction_id: string | null;
  payment_link: string | null;
  status: string;
  subtotal_cents: number | null;
  customer_id: string | null;
  customer_email: string | null;
  /** Buyer name/phone Stealth Health captured on its hosted page (null when absent). */
  customer_name: string | null;
  customer_phone: string | null;
  /** `{ address, address2, city, state, zip, country }` — null until reported. */
  shipping_address: unknown;
  /** 'puramass' (partner-reported) or 'customer' (typed on the request page). */
  shipping_address_source: string | null;
  shipping_address_updated_at: string | null;
  /** When the "we didn't catch your address" email last went out. */
  address_requested_at: string | null;
  items: LedgerItem[];
  referral_code: string | null;
  /** Who `referral_code` belongs to. Null when the code matches no active or
   *  inactive referral code — a typo, or a code deleted since the sale. */
  affiliate: { id: string; name: string | null; active: boolean } | null;
  paid_at: string | null;
  currency: string | null;
  created_at: string;
  updated_at: string;
  invoice_id: string | null;
  invoice: InvoiceSummary | null;
  /** Abandoned-cart recovery. Null/0 until the buyer has been chased once. */
  recovery_email_sent_at: string | null;
  recovery_email_count: number | null;
  recovery_promo_code: string | null;
  recovery_discount_type: string | null;
  recovery_discount_value: number | null;
  /** Order-confirmation email state (logged against the invoice); null = never sent. */
  confirmation?: ConfirmationSummary | null;
}



/**
 * Whether this hand-off shows on the buyer's /account/orders page, and why.
 * The account reads the materialised invoice (source='stealth_health'), so it
 * appears only once the invoice exists AND is linked to a customer account.
 */
function accountVisibility(row: PuramassOrderRow): {
  displays: boolean;
  notLinked: boolean;
  reason: string;
} {
  const inv = row.invoice;
  if (!row.invoice_id || !inv) {
    if (row.status !== 'paid') {
      return { displays: false, notLinked: false, reason: 'Not paid yet — no customer order exists until Stealth Health confirms payment.' };
    }
    return { displays: false, notLinked: false, reason: 'Paid, but not yet materialised into an invoice — nothing shows in the account until it is.' };
  }
  if (inv.status === 'pending_payment' || inv.status === 'expired') {
    return {
      displays: false,
      notLinked: false,
      reason:
        inv.status === 'expired'
          ? `Invoice ${inv.invoice_number} lapsed unpaid, so the account page hides it.`
          : `Invoice ${inv.invoice_number} is waiting for payment on the Stealth Health checkout — it appears in the account once paid.`,
    };
  }
  if (inv.status === 'draft') {
    return { displays: false, notLinked: false, reason: 'The linked invoice is a draft, which the account page hides.' };
  }
  if (!inv.customer_id) {
    return {
      displays: false,
      notLinked: true,
      reason: `Invoice ${inv.invoice_number} exists but is not linked to a customer account (guest email), so no one sees it. Run the account backfill to link it by email.`,
    };
  }
  return {
    displays: true,
    notLinked: false,
    reason: `Visible in ${row.customer_email ?? 'the customer'}'s account as ${inv.invoice_number}.`,
  };
}

const PAGE_SIZE = 25;

/** Payment states, in the order the filter tabs present them. */
const STATUS_TABS: { key: string; label: string; hint?: string }[] = [
  { key: 'paid', label: 'Paid' },
  { key: 'payment_pending', label: 'Pending' },
  // Cuts across pending and expired: every unpaid cart old enough to chase.
  { key: 'abandoned', label: 'Abandoned', hint: 'Unpaid carts old enough to chase with a recovery email' },
  { key: 'expired', label: 'Expired' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'all', label: 'All' },
];

const STATUS_BADGE: Record<string, string> = {
  payment_pending: 'bg-amber-100 text-amber-700',
  paid: 'bg-emerald-100 text-emerald-700',
  expired: 'bg-gray-200 text-gray-600',
  cancelled: 'bg-red-100 text-red-700',
};

// Mirrors the fulfilment chip on the admin dashboard (FulfillmentAlerts).
const FULFILLMENT_BADGE: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Pending', cls: 'bg-amber-500/10 text-amber-700' },
  packed: { label: 'Packed', cls: 'bg-indigo-500/10 text-indigo-700' },
  shipped: { label: 'Shipped', cls: 'bg-emerald-500/10 text-emerald-700' },
  picked_up: { label: 'Picked up', cls: 'bg-emerald-500/10 text-emerald-700' },
  dropped_off: { label: 'Dropped off', cls: 'bg-emerald-500/10 text-emerald-700' },
};

interface StatusCounts {
  all: number;
  payment_pending: number;
  paid: number;
  expired: number;
  cancelled: number;
  abandoned: number;
}

const EMPTY_COUNTS: StatusCounts = {
  all: 0,
  payment_pending: 0,
  paid: 0,
  expired: 0,
  cancelled: 0,
  abandoned: 0,
};

function statusLabel(s: string): string {
  return s.replace(/_/g, ' ');
}

/** "3h ago" / "2d ago" — compact enough for a table cell. */
function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return 'just now';
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatMoney(cents: number | null, currency: string | null): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)} ${(currency || 'usd').toUpperCase()}`;
}

/** Order-confirmation email state under a paid row's status badge. */
function ConfirmationLine({ row }: { row: PuramassOrderRow }) {
  const c = row.confirmation;
  if (c?.lastAttemptFailed) {
    return (
      <div
        className="mt-1 flex items-center gap-1 text-[11px] text-red-600"
        title={`Last attempt failed: ${c.lastError || 'unknown error'}`}
      >
        <MailCheck className="h-3 w-3" />
        Confirmation failed
      </div>
    );
  }
  if (c && c.sendCount > 0 && c.lastSentAt) {
    return (
      <div
        className="mt-1 flex items-center gap-1 text-[11px] text-emerald-700"
        title={`Order confirmation last sent ${new Date(c.lastSentAt).toLocaleString()} to ${c.lastSentTo || 'the buyer'} ${c.lastSentBy ? `by ${c.lastSentBy}` : 'automatically'}.`}
      >
        <MailCheck className="h-3 w-3" />
        Confirmed {timeAgo(c.lastSentAt)}
        {c.sendCount > 1 ? ` · ${c.sendCount}×` : ''}
      </div>
    );
  }
  return (
    <div className="mt-1 flex items-center gap-1 text-[11px] text-amber-700">
      <MailCheck className="h-3 w-3" />
      No confirmation sent
    </div>
  );
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

/**
 * The shipping address Stealth Health captured on its hosted page. It arrives with
 * the webhook event or a poll, so plenty of rows legitimately have none yet —
 * those render an explanatory placeholder rather than an empty cell.
 */
function ShippingAddressCell({ row }: { row: PuramassOrderRow }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const addr = toShippingAddress(row.shipping_address);
  const lines = formatAddressLines(addr);
  const fromCustomer = row.shipping_address_source === 'customer';

  if (lines.length === 0) {
    return (
      <div className="space-y-0.5">
        <span
          className="block text-xs text-ink-light"
          title={
            row.status === 'payment_pending'
              ? 'Stealth Health reports the address once the order is paid. Sync to re-check.'
              : 'Stealth Health has not returned a shipping address for this order. Sync to re-check, or ask the customer directly.'
          }
        >
          No address yet
        </span>
        {row.address_requested_at && (
          <span
            className="inline-flex items-center gap-1 text-[11px] text-amber-700"
            title={`Asked the customer on ${new Date(row.address_requested_at).toLocaleString()} — waiting on their reply.`}
          >
            <MailPlus className="h-3 w-3" />
            Asked {timeAgo(row.address_requested_at)}
          </span>
        )}
      </div>
    );
  }

  const oneLine = [row.customer_name, formatAddressOneLine(addr)].filter(Boolean).join(', ');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText([row.customer_name, ...lines].filter(Boolean).join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy the address.');
    }
  };

  return (
    <div className="group flex items-start gap-1.5" title={oneLine}>
      <MapPin className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-ink-light" />
      <div className="min-w-0">
        {lines.map((line, i) => (
          <div
            key={i}
            className={`break-words text-xs leading-snug ${i === 0 ? 'text-ink' : 'text-ink-muted'}`}
          >
            {line}
          </div>
        ))}
        {fromCustomer && (
          <span
            className="mt-1 inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700"
            title={
              row.shipping_address_updated_at
                ? `The customer entered this on ${new Date(row.shipping_address_updated_at).toLocaleString()}. A Stealth Health sync will not overwrite it.`
                : 'The customer entered this themselves. A Stealth Health sync will not overwrite it.'
            }
          >
            From customer
          </span>
        )}
      </div>
      <button
        onClick={copy}
        title="Copy address"
        aria-label="Copy shipping address"
        className="ml-auto flex-shrink-0 rounded p-1 text-ink-light opacity-0 transition-opacity hover:text-ink focus:opacity-100 group-hover:opacity-100"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

/**
 * The invoice a paid hand-off materialised into: a link into the admin invoice,
 * its payment status, and how far fulfilment has got. Unpaid orders have none
 * yet, which is the expected state rather than a problem.
 */
function InvoiceCell({ row }: { row: PuramassOrderRow }) {
  const inv = row.invoice;
  if (!inv) {
    return (
      <span
        className="text-xs text-ink-light"
        title={
          row.status === 'paid'
            ? 'Paid, but no fulfilment invoice yet. Sync this order to materialise it.'
            : 'No invoice was recorded for this checkout. New checkouts get one as soon as the buyer is sent to pay.'
        }
      >
        {row.status === 'paid' ? 'Not created' : '—'}
      </span>
    );
  }

  // `sent`/`partial` invoices past their due date read as overdue even before
  // the nightly sweep flips the stored column.
  const shown = effectiveStatus(inv.status as InvoiceStatus, inv.due_date ?? undefined);
  const payment = INVOICE_STATUS_META[shown];
  const fulfilment = inv.fulfillment_status
    ? FULFILLMENT_BADGE[inv.fulfillment_status]
    : undefined;

  return (
    <div className="flex flex-col items-start gap-1">
      <Link
        href={`/admin/invoices/${inv.id}`}
        className="inline-flex items-center gap-1 font-mono text-xs text-ink hover:text-teal-dark"
      >
        <FileText className="h-3.5 w-3.5" />
        {inv.invoice_number}
      </Link>
      <div className="flex flex-wrap gap-1">
        {payment && (
          <span
            className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${payment.badge}`}
          >
            {payment.label}
          </span>
        )}
        {fulfilment && (
          <span
            title={`Fulfilment: ${fulfilment.label}`}
            className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${fulfilment.cls}`}
          >
            {fulfilment.label}
          </span>
        )}
      </div>
    </div>
  );
}

/** Show/hide columns. Hand-rolled popover — the admin has no shared dropdown. */
function ColumnPicker({
  visible,
  toggle,
  reset,
  isDefault,
}: {
  visible: ColumnKey[];
  toggle: (k: ColumnKey) => void;
  reset: () => void;
  isDefault: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const hiddenCount = COLUMNS.length - visible.length;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-2.5 text-sm text-ink transition-colors hover:border-ink/20"
      >
        <Columns3 className="h-4 w-4 text-ink-muted" />
        Columns
        {hiddenCount > 0 && (
          <span className="rounded-full bg-surface px-1.5 py-0.5 text-[11px] text-ink-muted">
            {visible.length}/{COLUMNS.length}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-72 overflow-hidden rounded-xl border border-line bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
              Show columns
            </span>
            <button
              onClick={reset}
              disabled={isDefault}
              className="text-xs font-medium text-teal-dark hover:text-teal-dark disabled:text-ink-light"
            >
              Reset
            </button>
          </div>
          <div className="max-h-80 overflow-y-auto py-1">
            {COLUMNS.map((c) => {
              const checked = visible.includes(c.key);
              return (
                <label
                  key={c.key}
                  className={`flex cursor-pointer items-start gap-2.5 px-4 py-2 hover:bg-surface ${
                    c.locked ? 'cursor-not-allowed opacity-60' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={c.locked}
                    onChange={() => toggle(c.key)}
                    className="mt-0.5 cursor-pointer disabled:cursor-not-allowed"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-ink">
                      {c.label}
                      {c.locked && <span className="ml-1.5 text-[11px] text-ink-light">always on</span>}
                    </span>
                    <span className="block text-[11px] leading-snug text-ink-muted">{c.hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function OrdersTab() {
  const toast = useToast();
  const userRole = useUserRole();
  const canDeleteOrders = canDelete(userRole);
  const canSendConfirmation = canEdit(userRole);
  const { visible, toggle, reset, isDefault } = useColumnPreferences();

  const [rows, setRows] = useState<PuramassOrderRow[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<StatusCounts>(EMPTY_COUNTS);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  // Paid orders are the ones that matter day to day; the rest are one click away.
  const [status, setStatus] = useState<string>('paid');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  // False when the API had to serve the list without the shipping-address
  // columns (migration not visible to PostgREST yet).
  const [addressesAvailable, setAddressesAvailable] = useState(true);
  // Row whose customer-facing order is being previewed in the quickview modal.
  const [quickview, setQuickview] = useState<PuramassOrderRow | null>(null);
  // Bulk-delete selection (admin only) + the rows pending delete confirmation.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<PuramassOrderRow[] | null>(null);
  // Row whose customer is about to be emailed for a missing shipping address.
  const [addressTarget, setAddressTarget] = useState<PuramassOrderRow | null>(null);
  // Row whose abandoned checkout is being emailed back to the buyer.
  const [recoverTarget, setRecoverTarget] = useState<PuramassOrderRow | null>(null);
  // The selected carts being chased in one go — one email per buyer.
  const [bulkRecoverTarget, setBulkRecoverTarget] = useState<PuramassOrderRow[] | null>(null);
  // False when abandoned-checkout-recovery-migration.sql isn't visible yet.
  const [recoveryAvailable, setRecoveryAvailable] = useState(true);
  // The window behind the Abandoned tab, so the UI can name it.
  const [abandonedHours, setAbandonedHours] = useState(1);

  // Debounce the search box and go back to the first page when it changes.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(0);
  }, [status]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // Selection is per-page; a reload (page change / refresh) resets it so we
    // never act on rows that are no longer visible.
    setSelected(new Set());
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      // "abandoned" is a window over several statuses, not a status of its own.
      if (status === 'abandoned') params.set('abandoned', '1');
      else if (status !== 'all') params.set('status', status);
      if (debouncedSearch) params.set('q', debouncedSearch);
      const res = await fetch(`/api/admin/puramass/orders?${params}`, {
        cache: 'no-store',
        headers: await authHeaders(),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to load orders');
      setRows(json.orders ?? []);
      setTotal(json.total ?? 0);
      setCounts({ ...EMPTY_COUNTS, ...(json.counts ?? {}) });
      setAddressesAvailable(json.addressesAvailable !== false);
      setRecoveryAvailable(json.recoveryAvailable !== false);
      if (Number.isFinite(json.abandonedHours)) setAbandonedHours(json.abandonedHours);
    } catch (e: any) {
      setError(e.message ?? 'Failed to load orders');
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [page, status, debouncedSearch]);

  useEffect(() => { load(); }, [load]);

  // Send (or resend) the buyer's paid-order confirmation email.
  const sendConfirmation = async (row: PuramassOrderRow) => {
    const count = row.confirmation?.sendCount ?? 0;
    if (count > 0) {
      const times = count === 1 ? 'once' : `${count} times`;
      const to = row.confirmation?.lastSentTo || row.customer_email || 'This buyer';
      if (!window.confirm(`${to} has already been sent this confirmation ${times}. Send it again?`)) return;
    }
    setConfirmingId(row.id);
    try {
      const res = await fetch('/api/admin/confirmation-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ puramassOrderId: row.id }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? 'The email could not be sent.');
      setRows((cur) =>
        cur.map((r) =>
          r.id === row.id
            ? {
                ...r,
                confirmation: {
                  sendCount: (r.confirmation?.sendCount ?? 0) + 1,
                  lastSentAt: json.sent_at,
                  lastSentTo: json.to,
                  lastSentBy: 'you',
                  lastAttemptFailed: false,
                  lastError: null,
                },
              }
            : r,
        ),
      );
      toast.success(`Order confirmation ${count > 0 ? 're' : ''}sent to ${json.to}.`);
    } catch (e: any) {
      toast.error(e.message ?? 'The email could not be sent.');
    } finally {
      setConfirmingId(null);
    }
  };

  const refreshRow = async (row: PuramassOrderRow) => {
    if (!row.transaction_id) return;
    setRefreshingId(row.id);
    try {
      const res = await fetch('/api/admin/puramass/orders/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ transaction_id: row.transaction_id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Refresh failed');
      const o = json.order ?? {};
      setRows((cur) =>
        cur.map((r) =>
          r.id === row.id
            ? {
                ...r,
                status: o.status ?? r.status,
                paid_at: o.paid_at ?? r.paid_at,
                currency: o.currency ?? r.currency,
                subtotal_cents: typeof o.subtotal_cents === 'number' ? o.subtotal_cents : r.subtotal_cents,
                // Refresh is also the address backfill, so take whatever it
                // learned — but never let an absent field blank out the row.
                shipping_address: o.shipping_address ?? r.shipping_address,
                customer_name: o.customer_name ?? r.customer_name,
                customer_phone: o.customer_phone ?? r.customer_phone,
                customer_email: o.customer_email ?? r.customer_email,
              }
            : r,
        ),
      );
      toast.success(`Status: ${statusLabel(json.status ?? o.status ?? row.status)}`);
    } catch (e: any) {
      toast.error(e.message ?? 'Refresh failed');
    } finally {
      setRefreshingId(null);
    }
  };

  /**
   * Poll Stealth Health for many orders at once. Scoped to whatever the table is
   * showing, so on the default Paid tab this is "re-read every paid order" —
   * the way to backfill shipping addresses, which the cron job never does
   * because it only polls orders still awaiting payment.
   */
  const syncScope = async (opts: { ids?: string[]; statuses?: string[]; label: string }) => {
    setSyncing(true);
    try {
      const res = await fetch('/api/admin/puramass/orders/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ ids: opts.ids, statuses: opts.statuses }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Sync failed');

      if (json.total === 0) {
        toast.success(`Nothing to sync in ${opts.label}.`);
      } else {
        const bits = [`Polled ${json.polled} of ${json.total}`];
        if (json.changed) bits.push(`${json.changed} status change${json.changed === 1 ? '' : 's'}`);
        if (json.addresses) bits.push(`${json.addresses} address${json.addresses === 1 ? '' : 'es'} updated`);
        if (json.errors) bits.push(`${json.errors} failed`);
        const msg = bits.join(' · ');
        if (json.rate_limited) {
          toast.error(`${msg}. Stealth Health rate-limited us — run it again shortly.`);
        } else if (json.errors) {
          toast.error(msg);
        } else {
          toast.success(msg);
        }
      }
      await load();
    } catch (e: any) {
      toast.error(e.message ?? 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  // ---- Selection ----
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

  const selectedRows = rows.filter((r) => selected.has(r.id));

  /**
   * The selected carts worth chasing in bulk: a pending or expired hand-off
   * with somebody to write to. A paid one has nothing to recover, and a
   * cancelled one is left to the per-row dialog, where the email can say so.
   */
  const chaseableRows = selectedRows.filter(
    (r) => hasReusablePaymentLink(r.status) && Boolean(r.customer_email || r.customer_id),
  );
  // Buyers, not orders — two carts from one person are one email.
  const chaseableBuyers = new Set(
    chaseableRows.map((r) => r.customer_id ?? (r.customer_email ?? '').trim().toLowerCase()),
  ).size;

  // ---- Delete ----
  // Runs the DELETE against the ledger. `cascadeInvoice` also tears down the
  // linked customer invoice(s). Returns a result the confirmation dialog uses to
  // show an inline error (and keep itself open) on failure.
  const performDelete = async (
    targets: PuramassOrderRow[],
    opts: { cascadeInvoice: boolean },
  ): Promise<{ success: boolean; error?: string; warning?: string }> => {
    const ids = targets.map((r) => r.id);
    if (ids.length === 0) return { success: false, error: 'Nothing to delete.' };
    try {
      const res = await fetch('/api/admin/puramass/orders', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ ids, cascadeInvoice: opts.cascadeInvoice }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Delete failed');

      const deleted = json.deleted ?? ids.length;
      if (json.warning) {
        toast.error(json.warning);
      } else if (opts.cascadeInvoice && json.invoicesDeleted > 0) {
        toast.success(
          `Deleted ${deleted} order${deleted === 1 ? '' : 's'} and ${json.invoicesDeleted} invoice${json.invoicesDeleted === 1 ? '' : 's'}.`,
        );
      } else {
        toast.success(`Deleted ${deleted} order${deleted === 1 ? '' : 's'}.`);
      }

      // Refresh the list. If the current page just emptied out, step back one.
      if (deleted >= rows.length && page > 0) {
        setPage((p) => Math.max(0, p - 1));
      } else {
        await load();
      }
      return { success: true, warning: json.warning };
    } catch (e: any) {
      return { success: false, error: e.message ?? 'Delete failed' };
    }
  };

  // ---- Ask the customer for a missing address ----
  // The ledger row is stamped with the send time so the table can show "asked
  // 2h ago" without a reload; the address itself lands when they submit it.
  const sendAddressRequest = async (
    row: PuramassOrderRow,
    opts: { email: string; cc: string | null; note: string | null },
  ): Promise<{
    success: boolean;
    email?: string;
    cc?: string[];
    link?: string;
    reused?: boolean;
    error?: string;
  }> => {
    try {
      const res = await fetch('/api/admin/puramass/orders/request-address', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ id: row.id, email: opts.email, cc: opts.cc, note: opts.note }),
      });
      const json = await res.json();
      if (!res.ok) {
        return { success: false, error: json.error ?? 'The request could not be sent.', link: json.link };
      }
      setRows((cur) =>
        cur.map((r) =>
          r.id === row.id
            ? {
                ...r,
                address_requested_at: json.sent_at ?? new Date().toISOString(),
                customer_email: r.customer_email ?? json.email ?? null,
              }
            : r,
        ),
      );
      const copies = Array.isArray(json.cc) ? json.cc.length : 0;
      toast.success(
        `Address request sent to ${json.email}${copies > 0 ? ` (+${copies} copied)` : ''}.`,
      );
      return {
        success: true,
        email: json.email,
        cc: json.cc,
        link: json.link,
        reused: json.reused,
      };
    } catch (e: any) {
      return { success: false, error: e.message ?? 'The request could not be sent.' };
    }
  };

  /**
   * Email an abandoned checkout back to the buyer.
   *
   * The row is patched from the response rather than reloaded: a reload would
   * drop the admin out of whatever page and selection they were working, and
   * the send already tells us everything that changed.
   */
  const sendRecovery = async (
    row: PuramassOrderRow,
    payload: RecoverySendPayload,
  ): Promise<RecoverySendResult> => {
    try {
      const res = await fetch('/api/admin/puramass/orders/recover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ id: row.id, ...payload }),
      });
      const json = await res.json();
      if (!res.ok) {
        return { success: false, error: json.error ?? 'The recovery email could not be sent.' };
      }
      setRows((cur) =>
        cur.map((r) =>
          r.id === row.id
            ? {
                ...r,
                recovery_email_sent_at: json.sent_at ?? new Date().toISOString(),
                recovery_email_count: json.attempt ?? (r.recovery_email_count ?? 0) + 1,
                recovery_promo_code: json.promo_code ?? null,
                recovery_discount_type: json.discount?.type ?? null,
                recovery_discount_value: json.discount?.value ?? null,
              }
            : r,
        ),
      );
      const copies = Array.isArray(json.cc) ? json.cc.length : 0;
      toast.success(
        `Recovery email sent to ${json.to}${copies > 0 ? ` (+${copies} copied)` : ''}.`,
      );
      return { success: true, to: json.to, attempt: json.attempt, recorded: json.recorded };
    } catch (e: any) {
      return { success: false, error: e.message ?? 'The recovery email could not be sent.' };
    }
  };

  // ---- Table shape ----
  // One definition per column so the header, the cells, and the empty-state
  // colSpan can never drift apart as columns are shown and hidden.
  const columnRenderers = useMemo<
    Record<ColumnKey, { align?: 'right'; cellClass?: string; render: (row: PuramassOrderRow) => React.ReactNode }>
  >(
    () => ({
      date: {
        cellClass: 'text-sm text-ink-muted whitespace-nowrap',
        render: (row) => (
          <>
            {new Date(row.created_at).toLocaleDateString()}
            <div className="text-[11px] text-ink-light">
              {new Date(row.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </div>
          </>
        ),
      },
      customer: {
        cellClass: 'text-sm text-ink max-w-[220px]',
        render: (row) => (
          <>
            {row.customer_name && <div className="font-medium text-ink">{row.customer_name}</div>}
            <span className="break-all">{row.customer_email ?? '—'}</span>
            {row.customer_phone && (
              <div className="text-[11px] text-ink-muted">{row.customer_phone}</div>
            )}
          </>
        ),
      },
      address: {
        cellClass: 'max-w-[240px]',
        render: (row) => <ShippingAddressCell row={row} />,
      },
      items: {
        cellClass: 'max-w-xs',
        render: (row) => (
          <span className="break-words text-xs text-ink-muted">
            {(row.items ?? []).map((it) => `${it.sku ?? '?'} × ${it.quantity ?? 0}`).join(', ') || '—'}
          </span>
        ),
      },
      total: {
        align: 'right',
        cellClass: 'text-right text-sm font-semibold text-ink tabular-nums whitespace-nowrap',
        render: (row) => formatMoney(row.subtotal_cents, row.currency),
      },
      status: {
        render: (row) => (
          <>
            <span
              className={`inline-flex rounded px-2 py-0.5 text-xs font-medium capitalize ${
                STATUS_BADGE[row.status] ?? 'bg-gray-100 text-gray-600'
              }`}
            >
              {statusLabel(row.status)}
            </span>
            {row.paid_at && (
              <div className="mt-1 text-[11px] text-ink-muted">
                {new Date(row.paid_at).toLocaleDateString()}
              </div>
            )}
            {wasRecovered(row) ? (
              <div
                className="mt-1 inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700"
                title={`Paid after the recovery email sent on ${new Date(row.recovery_email_sent_at!).toLocaleString()}.`}
              >
                <Sparkles className="h-3 w-3" />
                Recovered
              </div>
            ) : (row.recovery_email_count ?? 0) > 0 ? (
              // Visible without turning the Recovery column on, so nobody
              // chases the same cart twice without meaning to.
              <div
                className="mt-1 inline-flex items-center gap-1 text-[11px] text-amber-700"
                title={
                  row.recovery_email_sent_at
                    ? `Last recovery email sent ${new Date(row.recovery_email_sent_at).toLocaleString()}${
                        row.recovery_promo_code ? ` with ${row.recovery_promo_code}` : ''
                      }.`
                    : 'A recovery email has been sent for this cart.'
                }
              >
                <ShoppingCart className="h-3 w-3" />
                Chased {row.recovery_email_count}×
              </div>
            ) : null}
            {row.status === 'paid' && row.invoice_id && <ConfirmationLine row={row} />}
          </>
        ),
      },
      recovery: {
        cellClass: 'max-w-[180px]',
        render: (row) => {
          const count = row.recovery_email_count ?? 0;
          if (!row.recovery_email_sent_at && count === 0) {
            return (
              <span className="text-xs text-ink-light">
                {row.status === 'paid' ? '—' : 'Not chased'}
              </span>
            );
          }
          const offer = recoveryOffer(row);
          return (
            <div className="space-y-0.5 text-xs">
              <div className="font-medium text-ink">
                {count} email{count === 1 ? '' : 's'}
                {row.recovery_email_sent_at ? ` · ${timeAgo(row.recovery_email_sent_at)}` : ''}
              </div>
              {row.recovery_promo_code && (
                <div className="font-mono text-[11px] text-ink-muted">{row.recovery_promo_code}</div>
              )}
              {offer && <div className="text-[11px] text-teal-dark">{offer}</div>}
            </div>
          );
        },
      },
      invoice: {
        render: (row) => <InvoiceCell row={row} />,
      },
      account: {
        render: (row) => {
          const vis = accountVisibility(row);
          return (
            <span
              title={vis.reason}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                vis.displays
                  ? 'bg-emerald-100 text-emerald-700'
                  : vis.notLinked
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-gray-100 text-gray-500'
              }`}
            >
              {vis.displays ? <Check className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
              {vis.displays ? 'Visible' : vis.notLinked ? 'Not linked' : 'Hidden'}
            </span>
          );
        },
      },
      transaction: {
        cellClass: 'text-sm',
        render: (row) =>
          row.transaction_id ? (
            row.payment_link ? (
              <a
                href={row.payment_link}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-mono text-xs text-ink hover:text-teal-dark"
              >
                {row.transaction_id.slice(0, 12)}…
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : (
              <span className="font-mono text-xs text-ink-muted">{row.transaction_id.slice(0, 12)}…</span>
            )
          ) : (
            <span className="text-ink-muted">—</span>
          ),
      },
      reference: {
        render: (row) => (
          <span className="break-all font-mono text-xs text-ink-muted">{row.partner_reference}</span>
        ),
      },
      referral: {
        cellClass: 'text-sm',
        render: (row) => {
          if (!row.referral_code) return <span className="text-ink-muted">—</span>;
          return (
            <div className="min-w-0">
              <span className="font-mono text-xs font-semibold text-teal-dark">
                {row.referral_code}
              </span>
              {row.affiliate ? (
                <div className="truncate text-xs text-ink-muted">
                  {row.affiliate.name ?? 'Unnamed affiliate'}
                  {/* An inactive code is rejected by the attribution rules, so
                      this sale earned nobody anything — worth saying, since the
                      code itself looks no different. */}
                  {!row.affiliate.active && (
                    <span className="ml-1 text-amber-600">(inactive)</span>
                  )}
                </div>
              ) : (
                <div className="text-xs italic text-ink-muted">Unrecognised code</div>
              )}
            </div>
          );
        },
      },
      updated: {
        cellClass: 'text-xs text-ink-muted whitespace-nowrap',
        render: (row) => new Date(row.updated_at).toLocaleDateString(),
      },
    }),
    [],
  );

  const shownColumns = COLUMNS.filter((c) => visible.includes(c.key));
  // Visible data columns + the selection checkbox + the actions cell.
  const colSpan = shownColumns.length + 2;
  const minWidth = 320 + shownColumns.length * 150;

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filterLabel = STATUS_TABS.find((t) => t.key === status)?.label ?? 'All';
  const hasFilters = status !== 'paid' || debouncedSearch.length > 0;

  return (
    <>
      {/* Heading + primary actions. The page above already carries the Stealth
          Health title, so this is a section heading rather than an <h1>. */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-3">
            <CreditCard className="h-5 w-5 text-teal-dark" />
            <h2 className="text-base font-semibold text-ink">Stealth Health Orders</h2>
          </div>
          <p className="max-w-2xl text-sm text-ink-muted">
            Every hosted-checkout hand-off, for reconciliation. Payment, fulfilment, and
            emails are handled by Stealth Health.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() =>
              syncScope({
                // The abandoned view isn't a status — sync everything it covers.
                statuses:
                  status === 'all'
                    ? undefined
                    : status === 'abandoned'
                      ? [...RECOVERABLE_STATUSES]
                      : [status],
                label: status === 'all' ? 'this ledger' : `${filterLabel.toLowerCase()} orders`,
              })
            }
            disabled={syncing || loading}
            title={
              status === 'all'
                ? 'Re-read every order from Stealth Health'
                : `Re-read every ${filterLabel.toLowerCase()} order from Stealth Health — picks up statuses and shipping addresses`
            }
            className="inline-flex items-center gap-1.5 rounded-lg bg-teal-dark px-3 py-2.5 text-sm font-medium text-white transition-colors hover:bg-ocean disabled:opacity-50"
          >
            {syncing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CloudDownload className="h-4 w-4" />
            )}
            Sync {status === 'all' ? 'all' : filterLabel.toLowerCase()} from Stealth Health
          </button>
          <button
            onClick={load}
            disabled={loading}
            title="Reload this list"
            aria-label="Reload the order list"
            className="inline-flex h-[42px] w-[42px] items-center justify-center rounded-lg border border-line bg-white text-ink-muted transition-colors hover:border-ink/20 hover:text-ink disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <ColumnPicker visible={visible} toggle={toggle} reset={reset} isDefault={isDefault} />
        </div>
      </div>

      {!loading && !addressesAvailable && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Shipping addresses are unavailable: the database is missing the{' '}
          <code className="font-mono text-xs">shipping_address</code> columns. Run{' '}
          <code className="font-mono text-xs">puramass-shipping-address-migration.sql</code> in the
          Supabase SQL editor — everything else on this page works meanwhile.
        </div>
      )}

      {/* Status tabs */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5 border-b border-line">
        {STATUS_TABS.map((t) => {
          const active = status === t.key;
          const count = counts[t.key as keyof StatusCounts] ?? 0;
          return (
            <button
              key={t.key}
              onClick={() => setStatus(t.key)}
              title={t.hint}
              className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-4 py-2 text-sm font-medium transition ${
                active ? 'border-teal text-ink' : 'border-transparent text-ink-muted hover:text-ink'
              }`}
            >
              {t.label}
              <span
                className={`rounded-full px-1.5 py-0.5 text-[11px] ${
                  active ? 'bg-teal-dark text-white' : 'bg-surface text-ink-muted'
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {status === 'abandoned' && (
        <div className="mb-4 flex flex-wrap items-start gap-2 rounded-xl border border-teal/30 bg-teal/5 px-4 py-3">
          <ShoppingCart className="mt-0.5 h-4 w-4 flex-shrink-0 text-teal-dark" />
          <p className="text-xs leading-relaxed text-ink">
            Carts started more than {abandonedHours === 1 ? 'an hour' : `${abandonedHours} hours`} ago
            that never reached payment. Their Stealth Health checkout links are still live, so the cart
            button on each row emails one back to the buyer — with a promo code and a discount if you
            want to sweeten it. Tick several and{' '}
            <span className="font-medium">Chase carts</span> writes the message once and sends every
            buyer their own email, with their own cart and their own payment link.
            {!recoveryAvailable && (
              <span className="mt-1 block text-amber-700">
                Send history is not being recorded yet — run
                <span className="font-mono"> abandoned-checkout-recovery-migration.sql</span> to
                track which carts have been chased.
              </span>
            )}
          </p>
        </div>
      )}

      {/* Search */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[240px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search email, name, transaction or reference…"
            className="w-full rounded-lg border border-line bg-white py-2.5 pl-10 pr-9 text-sm text-ink placeholder-ink-muted focus:outline-none focus:ring-2 focus:ring-teal/40"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              aria-label="Clear search"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        {hasFilters && (
          <button
            onClick={() => {
              setStatus('paid');
              setSearch('');
            }}
            className="text-xs font-medium text-teal-dark hover:text-teal-dark"
          >
            Reset filters
          </button>
        )}
      </div>

      {/* Bulk actions */}
      {selected.size > 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-teal/30 bg-teal/5 px-4 py-3">
          <span className="text-sm text-ink">
            {selected.size} order{selected.size !== 1 ? 's' : ''} selected
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setSelected(new Set())}
              className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-muted hover:border-ink/20 hover:text-ink"
            >
              Clear
            </button>
            {chaseableRows.length > 0 && (
              <button
                onClick={() => setBulkRecoverTarget(chaseableRows)}
                title={`Email ${chaseableBuyers} buyer${chaseableBuyers === 1 ? '' : 's'} their own cart and payment link — one separate email each`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-teal/40 bg-white px-3 py-1.5 text-sm font-medium text-teal-dark hover:bg-teal/5"
              >
                <ShoppingCart className="h-4 w-4" />
                Chase {chaseableBuyers} cart{chaseableBuyers === 1 ? '' : 's'}
              </button>
            )}
            <button
              onClick={() =>
                syncScope({ ids: selectedRows.map((r) => r.id), label: 'the selected orders' })
              }
              disabled={syncing}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-1.5 text-sm text-ink hover:border-ink/20 disabled:opacity-50"
            >
              {syncing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CloudDownload className="h-4 w-4" />
              )}
              Sync selected
            </button>
            {canDeleteOrders && (
              <button
                onClick={() => setDeleteTarget(selectedRows)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
              >
                <Trash2 className="h-4 w-4" />
                Delete selected
              </button>
            )}
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-line bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ minWidth: `${minWidth}px` }}>
            <thead>
              <tr className="border-b border-line bg-surface">
                <th className="w-10 px-5 py-3">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAll}
                    aria-label="Select all orders on this page"
                    className="h-4 w-4 cursor-pointer rounded border-line text-teal-dark focus:ring-teal/40"
                  />
                </th>
                {shownColumns.map((c) => (
                  <th
                    key={c.key}
                    className={`px-5 py-3 text-xs font-semibold uppercase tracking-wide text-ink-muted ${
                      columnRenderers[c.key].align === 'right' ? 'text-right' : 'text-left'
                    }`}
                  >
                    {c.label}
                  </th>
                ))}
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line/50">
              {loading ? (
                <tr>
                  <td colSpan={colSpan} className="px-5 py-12 text-center text-sm text-ink-muted">
                    <Loader2 className="mr-2 inline-block h-5 w-5 animate-spin align-middle" /> Loading…
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={colSpan} className="px-5 py-12 text-center text-sm text-red-600">{error}</td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={colSpan} className="px-5 py-12 text-center text-sm text-ink-muted">
                    {hasFilters
                      ? `No ${filterLabel.toLowerCase()} orders match this search.`
                      : 'No paid hosted-checkout orders yet.'}
                  </td>
                </tr>
              ) : rows.map((row) => (
                <tr
                  key={row.id}
                  className={`align-top transition-colors hover:bg-surface ${
                    selected.has(row.id) ? 'bg-teal/5' : ''
                  }`}
                >
                  <td className="px-5 py-4">
                    <input
                      type="checkbox"
                      checked={selected.has(row.id)}
                      onChange={() => toggleOne(row.id)}
                      aria-label={`Select order ${row.partner_reference}`}
                      className="h-4 w-4 cursor-pointer rounded border-line text-teal-dark focus:ring-teal/40"
                    />
                  </td>
                  {shownColumns.map((c) => (
                    <td key={c.key} className={`px-5 py-4 ${columnRenderers[c.key].cellClass ?? ''}`}>
                      {columnRenderers[c.key].render(row)}
                    </td>
                  ))}
                  <td className="px-5 py-4 text-right">
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        onClick={() => setQuickview(row)}
                        title="Preview exactly what the customer sees"
                        aria-label="Preview the customer's view"
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface text-ink-muted transition-colors hover:border-ink/20 hover:text-ink"
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </button>
                      {row.status !== 'paid' && (
                        <button
                          onClick={() => setRecoverTarget(row)}
                          title={
                            row.payment_link
                              ? 'Email this cart back to the customer with their payment link'
                              : 'This hand-off has no payment link — the email goes out without a checkout button'
                          }
                          aria-label="Email this abandoned checkout back to the customer"
                          className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border bg-surface transition-colors hover:border-ink/20 hover:text-ink ${
                            (row.recovery_email_count ?? 0) === 0
                              ? 'border-teal/40 text-teal-dark'
                              : 'border-line text-ink-muted'
                          }`}
                        >
                          <ShoppingCart className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        onClick={() => setAddressTarget(row)}
                        title={
                          toShippingAddress(row.shipping_address)
                            ? 'Ask the customer to confirm or correct their shipping address'
                            : 'Email the customer for their shipping address'
                        }
                        aria-label="Ask the customer for their shipping address"
                        className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border bg-surface transition-colors hover:border-ink/20 hover:text-ink ${
                          !toShippingAddress(row.shipping_address) && !row.address_requested_at
                            ? 'border-teal/40 text-teal-dark'
                            : 'border-line text-ink-muted'
                        }`}
                      >
                        <MailPlus className="h-3.5 w-3.5" />
                      </button>
                      {canSendConfirmation && row.status === 'paid' && row.invoice_id && (
                        <button
                          onClick={() => sendConfirmation(row)}
                          disabled={confirmingId === row.id}
                          title={
                            (row.confirmation?.sendCount ?? 0) > 0
                              ? 'Resend the order confirmation email'
                              : 'Send the order confirmation email'
                          }
                          aria-label="Send the order confirmation email"
                          className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border bg-surface transition-colors hover:border-ink/20 hover:text-ink disabled:opacity-40 ${
                            (row.confirmation?.sendCount ?? 0) === 0
                              ? 'border-teal/40 text-teal-dark'
                              : 'border-line text-ink-muted'
                          }`}
                        >
                          {confirmingId === row.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <MailCheck className="h-3.5 w-3.5" />
                          )}
                        </button>
                      )}
                      <button
                        onClick={() => refreshRow(row)}
                        disabled={!row.transaction_id || refreshingId === row.id}
                        title={row.transaction_id ? 'Re-read this order from Stealth Health' : 'No transaction to refresh'}
                        aria-label="Refresh this order from Stealth Health"
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface text-ink-muted transition-colors hover:border-ink/20 hover:text-ink disabled:opacity-40"
                      >
                        <RefreshCw className={`h-3.5 w-3.5 ${refreshingId === row.id ? 'animate-spin' : ''}`} />
                      </button>
                      {canDeleteOrders && (
                        <button
                          onClick={() => setDeleteTarget([row])}
                          title="Delete this hand-off record"
                          aria-label="Delete this hand-off record"
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface text-ink-muted transition-colors hover:border-red-200 hover:text-red-600"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {!loading && !error && total > 0 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-xs text-ink-muted">
            {total} {status === 'all' ? '' : `${filterLabel.toLowerCase()} `}order{total === 1 ? '' : 's'} ·
            Page {page + 1} of {totalPages}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="inline-flex items-center gap-1 rounded-lg border border-line bg-white px-3 py-1.5 text-xs text-ink transition-colors hover:border-ink/20 disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Prev
            </button>
            <button
              onClick={() => setPage((p) => (p + 1 < totalPages ? p + 1 : p))}
              disabled={page + 1 >= totalPages}
              className="inline-flex items-center gap-1 rounded-lg border border-line bg-white px-3 py-1.5 text-xs text-ink transition-colors hover:border-ink/20 disabled:opacity-40"
            >
              Next <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {quickview && (
        <CustomerOrderQuickview
          invoiceId={quickview.invoice_id}
          notLinked={accountVisibility(quickview).notLinked}
          reason={accountVisibility(quickview).reason}
          onClose={() => setQuickview(null)}
        />
      )}

      {recoverTarget && (
        <RecoverCheckoutDialog
          order={recoverTarget}
          onClose={() => setRecoverTarget(null)}
          onSend={(payload) => sendRecovery(recoverTarget, payload)}
        />
      )}

      {bulkRecoverTarget && bulkRecoverTarget.length > 0 && (
        <BulkRecoverDialog
          rows={bulkRecoverTarget}
          onClose={() => setBulkRecoverTarget(null)}
          onSent={() => { load(); }}
        />
      )}

      {addressTarget && (
        <RequestAddressDialog
          order={addressTarget}
          onClose={() => setAddressTarget(null)}
          onSend={(opts) => sendAddressRequest(addressTarget, opts)}
        />
      )}

      {deleteTarget && (
        <DeletePuramassOrdersDialog
          orders={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={(opts) => performDelete(deleteTarget, opts)}
        />
      )}
    </>
  );
}
