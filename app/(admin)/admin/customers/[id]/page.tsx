'use client';

import { formatAppDate } from '@/lib/datetime';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft, User, Mail, Phone, MapPin, Calendar, Clock, Search, Eye,
  ShoppingCart, ShieldCheck, Loader2, CheckCircle2, XCircle, Sparkles,
  CreditCard, FileText, Package, BarChart3, Shield, ShieldOff, Pencil, Trash2,
  ExternalLink, Copy, Wallet, TrendingUp, AlertTriangle, Boxes,
  Send, Route, History, AlertCircle, Megaphone, KeyRound,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useToast } from '@/contexts/ToastContext';
import { useUserRole } from '../../layout';
// Aliased: this file already has a `channelLabel` for the sales channel a
// purchase came through (store / invoice / Stealth Health), which is a
// different axis from the marketing channel that acquired the customer.
import InfoTip from '@/components/admin/InfoTip';
import { CustomerAcquisitionTip } from '@/components/admin/AttributionTips';
import { channelLabel as acquisitionLabel } from '@/lib/admin/attribution';
import { canDelete, canEdit, getRoleBadgeClasses } from '@/lib/permissions';
import type { UserRole } from '@/lib/permissions';
import { toggleCustomerAdmin } from '@/lib/admin/api';
import type { Customer } from '@/lib/supabase';
import EditUserModal from '../../users/_components/EditUserModal';
import LeadPanel from '../../_components/LeadPanel';
import EmailComposer from '../../_components/EmailComposer';
import { OrderConfirmationCell } from '@/components/admin/OrderConfirmationEmailCard';
import type { ConfirmationSummary } from '@/lib/order-confirmation-data';
import {
  emptyLead,
  type ContactMethod,
  type Lead,
  type LeadStatus,
} from '@/lib/admin/customer-leads';
import {
  mergeTemplates,
  PROMO_TEMPLATES,
  RECOVERY_TEMPLATES,
  type CartSummary,
  type CheckoutCta,
  type DiscountType,
  type PromoTemplateKey,
} from '@/lib/customer/promo-email';
import {
  cartAmount,
  cartStatusLabel,
  timeAgo as cartTimeAgo,
  type OutreachRecipient,
  type OutreachSendResult,
} from '@/lib/customer/outreach-types';

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

interface Agg {
  key: string;
  label: string;
  productId: string | null;
  count: number;
  lastAt: string;
  lastQuantity?: number;
}

interface ProductPurchase {
  key: string;
  name: string;
  quantity: number;
  spend: Record<string, number>;
  orders: number;
  firstAt: string;
  lastAt: string;
  channels: string[];
}

interface InvoiceRow {
  id: string;
  invoice_number: string;
  status: string;
  fulfillment_status: string | null;
  fulfillment_type: string | null;
  source: string | null;
  currency: string | null;
  subtotal: number | null;
  shipping_cost: number | null;
  total: number | null;
  issue_date: string | null;
  due_date: string | null;
  created_at: string;
  is_backorder: boolean;
}

interface OrderRow {
  id: string;
  order_number: string;
  status: string;
  total: number | null;
  items: { name?: string; quantity?: number; price?: number; strength?: string }[] | null;
  source: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  carrier: string | null;
  created_at: string;
  shipped_at: string | null;
  delivered_at: string | null;
  refunded_at: string | null;
  /** Order-confirmation email state; null = never sent. */
  confirmation?: ConfirmationSummary | null;
}

interface PuramassRow {
  id: string;
  partner_reference: string;
  transaction_id: string | null;
  payment_link: string | null;
  status: string;
  subtotal_cents: number | null;
  currency: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  shipping_address: any;
  items: { sku?: string; quantity?: number }[];
  invoice_id: string | null;
  paid_at: string | null;
  created_at: string;
  /** Order-confirmation email state (keyed by the hand-off's invoice). */
  confirmation?: ConfirmationSummary | null;
}

interface Stats {
  orderCount: number;
  invoiceCount: number;
  puramassCount: number;
  puramassPaidCount: number;
  purchaseCount: number;
  spendByCurrency: Record<string, number>;
  outstandingByCurrency: Record<string, number>;
  firstPurchaseAt: string | null;
  lastPurchaseAt: string | null;
  distinctProducts: number;
  unitsBought: number;
}

/** One page a customer opened, newest first. */
interface PageVisit {
  path: string;
  title: string | null;
  at: string;
}

/** One outreach email an admin sent from this page. */
interface SentEmail {
  id: string;
  to_email: string;
  cc_emails: string[] | null;
  subject: string;
  template: string | null;
  promo_code: string | null;
  promo_details: string | null;
  promo_expires: string | null;
  sent_by_name: string | null;
  sent_by_email: string | null;
  success: boolean;
  error: string | null;
  created_at: string;
}

interface Insights {
  source: 'account' | 'puramass';
  /** What this database supports — see customer-crm-migration.sql. */
  capabilities?: { claims: boolean; activity: boolean; emailLog?: boolean };
  lead?: Lead | null;
  emails?: SentEmail[];
  pages?: Agg[];
  journey?: PageVisit[];
  customer: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string;
    phone: string | null;
    shipping_address: string | null;
    shipping_city: string | null;
    shipping_state: string | null;
    shipping_postal_code: string | null;
    shipping_country: string | null;
    preferred_currency: string | null;
    role: string | null;
    active: boolean;
    created_at: string;
    last_login_at: string | null;
    email_verified?: boolean;
    contact_consent: boolean;
    allow_pickup?: boolean;
    allow_shipping?: boolean;
    affiliate_id?: string | null;
    /** marketing-attribution-migration.sql — absent on older databases. */
    attribution_channel?: string | null;
    attribution_campaign?: string | null;
    attribution_landing_page?: string | null;
    claimed_by_id: string | null;
    claimed_by_email: string | null;
    claimed_by_name: string | null;
    claimed_at: string | null;
  };
  hasCheckedOut: boolean;
  stats: Stats;
  products: ProductPurchase[];
  invoices: InvoiceRow[];
  orders: OrderRow[];
  puramassOrders: PuramassRow[];
  searches: Agg[];
  views: Agg[];
  cart: Agg[];
}

const fmtDateTime = (s: string | null) =>
  s ? new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

const fmtDate = (s: string | null) => formatAppDate(s);

function fmtMoney(amount: number | null | undefined, currency: string | null | undefined): string {
  if (amount == null) return '—';
  const cur = (currency || 'CAD').toUpperCase();
  try {
    return new Intl.NumberFormat(cur === 'USD' ? 'en-US' : 'en-CA', {
      style: 'currency',
      currency: cur,
      currencyDisplay: 'narrowSymbol',
    }).format(amount);
  } catch {
    return `${cur} ${amount.toFixed(2)}`;
  }
}

/** "CA$1,240.00 · US$667.00" — spend is never converted between currencies. */
function fmtSpend(byCurrency: Record<string, number>): string {
  const entries = Object.entries(byCurrency).filter(([, v]) => v > 0);
  if (entries.length === 0) return '—';
  return entries.map(([cur, v]) => fmtMoney(v, cur)).join(' · ');
}

const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-gray-500/10 text-gray-600',
  sent: 'bg-blue-500/10 text-blue-600',
  partial: 'bg-amber-500/10 text-amber-600',
  paid: 'bg-emerald-500/10 text-emerald-600',
  overdue: 'bg-red-500/10 text-red-600',
  void: 'bg-gray-500/10 text-gray-500',
  payment_pending: 'bg-amber-500/10 text-amber-700',
  pending_payment: 'bg-amber-500/10 text-amber-700',
  expired: 'bg-gray-200 text-gray-600',
  cancelled: 'bg-red-500/10 text-red-700',
  pending: 'bg-amber-500/10 text-amber-700',
  confirmed: 'bg-blue-500/10 text-blue-600',
  processing: 'bg-blue-500/10 text-blue-600',
  shipped: 'bg-emerald-500/10 text-emerald-600',
  delivered: 'bg-emerald-500/10 text-emerald-700',
  refunded: 'bg-red-500/10 text-red-600',
};

const statusBadge = (s: string) => STATUS_BADGE[s?.toLowerCase()] ?? 'bg-gray-500/10 text-gray-600';
const statusLabel = (s: string) => String(s ?? '').replace(/_/g, ' ');

/** What /api/admin/customers/outreach?ids= gives the composer to draft from. */
interface OutreachContext {
  recipient: OutreachRecipient | null;
  cart: CartSummary | null;
  checkout: CheckoutCta | null;
  reference: string | null;
  status: string | null;
}

export default function CustomerDetailPage() {
  const params = useParams();
  const router = useRouter();
  const toast = useToast();
  const userRole = useUserRole();
  const editable = canEdit(userRole);
  const deletable = canDelete(userRole);

  // Stealth Health ids are `pm:<email>` — decode before use, encode to fetch.
  // A stray `%` in an email would make decodeURIComponent throw, so it degrades
  // to the raw segment rather than blowing up the page.
  const id = safeDecode(String(params.id));
  const encodedId = encodeURIComponent(id);

  const [data, setData] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [meId, setMeId] = useState<string | null>(null);
  const [meName, setMeName] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [composing, setComposing] = useState(false);
  /**
   * The abandoned-cart context for this customer, fetched when the composer
   * opens: their newest pending/expired Stealth Health checkout, its basket and
   * the hosted payment link that still takes payment for it.
   *
   * Loaded lazily rather than with the page — most visits here are not about
   * writing an email, and the ledger read is not free.
   */
  const [outreach, setOutreach] = useState<OutreachContext | null>(null);
  const [outreachLoading, setOutreachLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/customers/${encodedId}/insights`, {
        cache: 'no-store',
        headers: await authHeaders(),
      });
      if (res.status === 404) { setNotFound(true); return; }
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to load');
      setData(json);
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to load customer');
    } finally {
      setLoading(false);
    }
  }, [encodedId, toast]);

  useEffect(() => {
    load();
  }, [load]);

  // Who is looking: drives the "that's you" marker, edit rights on a claimed
  // lead, and the signature on outgoing email.
  useEffect(() => {
    supabase.auth.getUser().then(async ({ data }) => {
      const user = data.user;
      if (!user) return;
      setMeId(user.id);
      const { data: me } = await supabase
        .from('customers')
        .select('first_name, last_name')
        .eq('id', user.id)
        .maybeSingle();
      const name = `${me?.first_name ?? ''} ${me?.last_name ?? ''}`.trim();
      setMeName(name || user.email || null);
    });
  }, []);

  const isPuramassOnly = data?.source === 'puramass';

  /* ---------------- actions ---------------- */

  const runAction = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e: any) {
      toast.error(e.message ?? 'Something went wrong');
    } finally {
      setBusy(null);
    }
  };

  const claim = () => runAction('claim', async () => {
    const res = await fetch(`/api/admin/customers/${encodedId}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? 'Failed to claim');
    toast.success('Customer claimed — you own this lead');
    await load();
  });

  const release = () => runAction('claim', async () => {
    const res = await fetch(`/api/admin/customers/${encodedId}/claim`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? 'Failed to release');
    toast.success('Claim released — the lead history stays');
    await load();
  });

  const saveLead = (patch: {
    status: LeadStatus;
    contact_method: ContactMethod | '';
    notes: string;
    last_contacted_at: string;
    next_follow_up_at: string;
  }) => runAction('lead', async () => {
    const res = await fetch(`/api/admin/customers/${encodedId}/lead`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(patch),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? 'Failed to save the lead');
    toast.success('Lead updated');
    await load();
  });

  /**
   * Open the composer, pulling this customer's abandoned checkout in first.
   *
   * The composer only offers to attach a cart and a payment link once we know
   * there is one, so the draft is never built around a checkout that has since
   * been paid.
   */
  const openComposer = async () => {
    setComposing(true);
    setOutreachLoading(true);
    try {
      const res = await fetch(
        `/api/admin/customers/outreach?ids=${encodeURIComponent(id)}`,
        { cache: 'no-store', headers: await authHeaders() },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not load this customer.');
      setOutreach({
        recipient: json.recipients?.[0] ?? null,
        cart: json.primary?.cart ?? null,
        checkout: json.primary?.checkout ?? null,
        reference: json.primary?.reference ?? null,
        status: json.primary?.status ?? null,
      });
    } catch {
      // A failed lookup costs the cart block, not the email: the admin can
      // still write to this customer, just without the payment link.
      setOutreach({ recipient: null, cart: null, checkout: null, reference: null, status: null });
    } finally {
      setOutreachLoading(false);
    }
  };

  const closeComposer = () => {
    setComposing(false);
    setOutreach(null);
  };

  /** Candidates for the "also send to other customers" tool. */
  const searchRecipients = useCallback(
    async (query: string, opts: { abandonedOnly: boolean }): Promise<OutreachRecipient[]> => {
      const params = new URLSearchParams({
        q: query,
        abandoned: opts.abandonedOnly ? '1' : '0',
        exclude: id,
      });
      const res = await fetch(`/api/admin/customers/outreach?${params}`, {
        cache: 'no-store',
        headers: await authHeaders(),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not search customers.');
      return json.candidates ?? [];
    },
    [id],
  );

  /**
   * Send the draft — one email per recipient.
   *
   * Every extra customer gets their own message with their own name, cart and
   * payment link; the route resolves those per person. Nobody is CC'd on
   * anybody else.
   */
  const sendEmail = async (payload: {
    templateKey: PromoTemplateKey;
    subject: string;
    body: string;
    promoCode: string;
    promoDetails: string;
    promoExpires: string;
    cc: string[];
    discountType: DiscountType | null;
    discountValue: number | null;
    attachCheckout: boolean;
    extraRecipients: OutreachRecipient[];
  }) => {
    await runAction('email', async () => {
      const { extraRecipients, ...draft } = payload;
      const res = await fetch('/api/admin/customers/outreach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({
          ...draft,
          // The customer whose page this is always goes first — they are the
          // one the composer previewed and the only one the CC applies to.
          recipients: [id, ...extraRecipients.map((r) => r.id)],
        }),
      });
      const json: OutreachSendResult & { error?: string } = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to send');

      closeComposer();
      // A partial failure is reported as a partial failure — "sent" on a batch
      // where four bounced is how a customer quietly never gets chased.
      if (json.failed > 0) {
        const firstError = json.results.find((r) => !r.success)?.error;
        toast.error(
          `Sent ${json.sent} of ${json.sent + json.failed}. ${json.failed} could not be sent${
            firstError ? `: ${firstError}` : '.'
          }`,
        );
      } else if (json.logged === false) {
        toast.success(
          `${json.sent === 1 ? 'Email sent' : `Sent ${json.sent} emails`} — but it will not appear in the history until customer-crm-migration.sql runs`,
        );
      } else {
        toast.success(
          json.sent === 1
            ? 'Email sent'
            : `Sent ${json.sent} emails — one to each customer.`,
        );
      }
      await load();
    });
  };

  // Both buttons mint the same Supabase recovery link; `purpose` only decides
  // whether the customer reads welcome copy or plain password-reset copy.
  const sendAccountLink = (purpose: 'welcome' | 'reset') => {
    const label = purpose === 'reset' ? 'Password reset link' : 'Sign-in link';
    return runAction(purpose === 'reset' ? 'reset' : 'magic', async () => {
      const res = await fetch(`/api/admin/customers/${encodedId}/magic-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ redirectPath: '/reset-password', purpose }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to send link');
      if (json.emailed) toast.success(`${label} emailed to the customer`);
      else if (json.action_link) {
        await navigator.clipboard?.writeText(json.action_link).catch(() => {});
        toast.success(`Mailer not configured — ${label.toLowerCase()} copied to clipboard`);
      } else toast.success(`${label} generated`);
    });
  };

  const sendSignInLink = () => sendAccountLink('welcome');
  const sendResetLink = () => sendAccountLink('reset');

  const setCurrency = (currency: 'CAD' | 'USD') => runAction('currency', async () => {
    if (!data || data.customer.preferred_currency === currency) return;
    // Optimistic — the toggle should feel instant.
    setData((prev) => (prev ? { ...prev, customer: { ...prev.customer, preferred_currency: currency } } : prev));
    const res = await fetch(`/api/admin/customers/${encodedId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ preferred_currency: currency }),
    });
    const json = await res.json();
    if (!res.ok) { await load(); throw new Error(json.error ?? 'Failed to update currency'); }
    toast.success(`Billing currency set to ${currency}`);
  });

  const toggleAdmin = () => runAction('admin', async () => {
    if (!data) return;
    const makeAdmin = data.customer.role !== 'admin';
    const result = await toggleCustomerAdmin(data.customer.id, makeAdmin);
    if (!result.success) throw new Error(result.error ?? 'Failed to update role');
    toast.success(makeAdmin ? 'Customer is now an admin' : 'Admin access removed');
    await load();
  });

  const openEdit = () => runAction('edit', async () => {
    const res = await fetch(`/api/admin/customers/${encodedId}`, {
      cache: 'no-store',
      headers: await authHeaders(),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? 'Failed to load customer');
    setEditing(json.customer as Customer);
  });

  const remove = () => runAction('delete', async () => {
    if (!data) return;
    const name = `${data.customer.first_name ?? ''} ${data.customer.last_name ?? ''}`.trim() || data.customer.email;
    if (!window.confirm(`Delete ${name}? This removes their price overrides and cannot be undone.`)) return;
    const res = await fetch(`/api/admin/customers/${encodedId}`, {
      method: 'DELETE',
      headers: await authHeaders(),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? 'Failed to delete');
    toast.success('Customer deleted');
    router.push('/admin/customers');
  });

  const copyEmail = () => runAction('copy', async () => {
    if (!data) return;
    await navigator.clipboard?.writeText(data.customer.email);
    toast.success('Email copied');
  });

  /* ---------------- render ---------------- */

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-sm text-ink-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading customer…
      </div>
    );
  }

  if (notFound || !data) {
    return (
      <div className="max-w-3xl">
        <BackLink />
        <div className="mt-6 rounded-xl border border-line bg-white p-10 text-center text-sm text-ink-muted">
          Customer not found.
        </div>
      </div>
    );
  }

  const c = data.customer;
  // Their newest pending/expired Stealth Health checkout, once the composer has
  // asked for it. Null means "no open cart", which is why the attach switch and
  // the recovery templates simply are not offered.
  const abandoned = outreach?.recipient?.abandoned ?? null;
  const name = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || 'Unnamed customer';
  const claimed = Boolean(c.claimed_by_id);
  const claimedByMe = claimed && c.claimed_by_id === meId;
  const location = [c.shipping_city, c.shipping_state, c.shipping_country].filter(Boolean).join(', ');
  const addressLines = [
    c.shipping_address,
    [c.shipping_city, c.shipping_state, c.shipping_postal_code].filter(Boolean).join(', '),
    c.shipping_country,
  ].filter(Boolean) as string[];

  return (
    <div className="max-w-6xl space-y-6">
      <BackLink />

      {isPuramassOnly && <StealthHealthBanner email={c.email} orders={data.stats.puramassCount} />}

      {/* Header */}
      <div className="rounded-xl border border-line bg-white p-5 md:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-4">
            <div
              className={`flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl ${
                isPuramassOnly ? 'bg-indigo-500/10' : 'bg-teal/10'
              }`}
            >
              {isPuramassOnly
                ? <CreditCard className="h-6 w-6 text-indigo-600" />
                : <User className="h-6 w-6 text-teal-dark" />}
            </div>
            <div>
              <h1 className="text-xl font-bold text-ink sm:text-2xl">{name}</h1>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-muted">
                <span className="inline-flex items-center gap-1.5"><Mail className="h-3.5 w-3.5" />{c.email}</span>
                {c.phone && <span className="inline-flex items-center gap-1.5"><Phone className="h-3.5 w-3.5" />{c.phone}</span>}
                {location && <span className="inline-flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" />{location}</span>}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {isPuramassOnly ? (
                  <Badge tone="indigo"><CreditCard className="h-3.5 w-3.5" />Stealth Health — no account</Badge>
                ) : (
                  <>
                    {c.role && c.role !== 'customer' && (
                      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${getRoleBadgeClasses(c.role as UserRole)}`}>
                        {c.role}
                      </span>
                    )}
                    {data.stats.puramassCount > 0 && (
                      <Badge tone="indigo"><CreditCard className="h-3.5 w-3.5" />{data.stats.puramassCount} Stealth Health order{data.stats.puramassCount === 1 ? '' : 's'}</Badge>
                    )}
                  </>
                )}
                <Badge tone={data.hasCheckedOut ? 'green' : 'amber'}>
                  {data.hasCheckedOut ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                  {data.hasCheckedOut ? 'Has checked out' : 'Not checked out'}
                </Badge>
                {!isPuramassOnly && (
                  <Badge tone={c.contact_consent ? 'green' : 'gray'}>
                    <ShieldCheck className="h-3.5 w-3.5" />
                    {c.contact_consent ? 'Contact consent given' : 'No contact consent'}
                  </Badge>
                )}
                {!isPuramassOnly && !c.active && <Badge tone="red">Inactive</Badge>}
              </div>

              {!isPuramassOnly && (
                <div className="mt-3 flex items-center gap-2">
                  <span className="text-xs text-ink-muted">Billing currency</span>
                  <div className="inline-flex overflow-hidden rounded-lg border border-line">
                    {(['CAD', 'USD'] as const).map((cur) => {
                      const active = (c.preferred_currency === 'USD' ? 'USD' : 'CAD') === cur;
                      return (
                        <button
                          key={cur}
                          onClick={() => setCurrency(cur)}
                          disabled={busy === 'currency' || !editable}
                          className={`px-3 py-1 text-xs font-semibold transition-colors disabled:opacity-60 ${
                            active ? 'bg-teal-dark text-white' : 'bg-white text-ink-muted hover:bg-surface hover:text-ink'
                          }`}
                        >
                          {cur}
                        </button>
                      );
                    })}
                  </div>
                  <span className="text-xs text-ink-muted">
                    {(c.preferred_currency === 'USD' ? 'USD' : 'CAD') === 'USD' ? '🇺🇸 American' : '🇨🇦 Canadian'}
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-1 text-sm sm:block">
            <MetaRow
              icon={<Calendar className="h-3.5 w-3.5" />}
              label={isPuramassOnly ? 'First order' : 'Joined'}
              value={fmtDate(c.created_at)}
            />
            <MetaRow
              icon={<Clock className="h-3.5 w-3.5" />}
              label="Last sign-in"
              value={isPuramassOnly ? 'No account' : fmtDateTime(c.last_login_at)}
            />
            <MetaRow
              icon={<TrendingUp className="h-3.5 w-3.5" />}
              label="Last purchase"
              value={fmtDate(data.stats.lastPurchaseAt)}
            />
            {/* How we won them. Absent for anyone who signed up before
                attribution started collecting, so the row hides rather than
                claiming "Direct" for a customer we simply have no data on. */}
            {c.attribution_channel && (
              <MetaRow
                icon={<Megaphone className="h-3.5 w-3.5" />}
                label="Came from"
                hint={<CustomerAcquisitionTip />}
                value={[
                  acquisitionLabel(c.attribution_channel),
                  c.attribution_campaign,
                  c.attribution_landing_page ? `landing page ${c.attribution_landing_page}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
            )}
          </div>
        </div>

        {/* Action bar */}
        <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
          <ActionButton onClick={copyEmail} busy={busy === 'copy'} icon={<Copy className="h-4 w-4" />}>
            Copy email
          </ActionButton>
          {editable && (
            <button
              onClick={openComposer}
              className="inline-flex items-center gap-2 rounded-lg bg-teal-dark px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-teal/90"
            >
              <Send className="h-4 w-4" /> Send email
            </button>
          )}
          <a
            href={`mailto:${c.email}`}
            className="inline-flex items-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-surface"
          >
            <Mail className="h-4 w-4" /> Open in mail app
          </a>
          {!isPuramassOnly && editable && (
            <>
              <ActionButton onClick={sendSignInLink} busy={busy === 'magic'} icon={<Mail className="h-4 w-4" />}>
                Send sign-in link
              </ActionButton>
              <ActionButton onClick={sendResetLink} busy={busy === 'reset'} icon={<KeyRound className="h-4 w-4" />}>
                Send password reset link
              </ActionButton>
              <ActionButton onClick={openEdit} busy={busy === 'edit'} icon={<Pencil className="h-4 w-4" />}>
                Edit profile
              </ActionButton>
              <ActionButton
                onClick={toggleAdmin}
                busy={busy === 'admin'}
                icon={c.role === 'admin' ? <ShieldOff className="h-4 w-4" /> : <Shield className="h-4 w-4" />}
              >
                {c.role === 'admin' ? 'Remove admin' : 'Make admin'}
              </ActionButton>
              <Link
                href={`/admin/pricing/customers/${c.id}`}
                className="inline-flex items-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-surface"
              >
                <Wallet className="h-4 w-4" /> Price overrides
              </Link>
            </>
          )}
          {data.stats.puramassCount > 0 && (
            <Link
              href="/admin/stealth-health?tab=orders"
              className="inline-flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700 transition-colors hover:bg-indigo-100"
            >
              <CreditCard className="h-4 w-4" /> Stealth Health ledger
            </Link>
          )}
          {!isPuramassOnly && deletable && (
            <ActionButton onClick={remove} busy={busy === 'delete'} tone="danger" icon={<Trash2 className="h-4 w-4" />}>
              Delete customer
            </ActionButton>
          )}
        </div>
      </div>

      {/* Lifetime stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={<Wallet className="h-4 w-4 text-teal-dark" />}
          label="Lifetime spend"
          value={fmtSpend(data.stats.spendByCurrency)}
          hint={`${data.stats.purchaseCount} paid ${data.stats.purchaseCount === 1 ? 'order' : 'orders'}`}
        />
        <StatCard
          icon={<AlertTriangle className="h-4 w-4 text-amber-600" />}
          label="Outstanding"
          value={fmtSpend(data.stats.outstandingByCurrency)}
          hint="Unpaid or partially paid invoices"
        />
        <StatCard
          icon={<Boxes className="h-4 w-4 text-teal-dark" />}
          label="Units bought"
          value={String(data.stats.unitsBought)}
          hint={`${data.stats.distinctProducts} distinct product${data.stats.distinctProducts === 1 ? '' : 's'}`}
        />
        <StatCard
          icon={<Calendar className="h-4 w-4 text-teal-dark" />}
          label="First purchase"
          value={fmtDate(data.stats.firstPurchaseAt)}
          hint={data.stats.lastPurchaseAt ? `Latest ${fmtDate(data.stats.lastPurchaseAt)}` : 'No purchases yet'}
        />
      </div>

      {/* Lead desk — claim, status, contact method, notes. Works for Stealth
          Health buyers too: lead records are keyed by email, not account. */}
      <LeadPanel
        lead={data.lead ?? emptyLead(c.email, isPuramassOnly ? null : c.id)}
        meId={meId}
        available={data.capabilities?.claims !== false}
        claiming={busy === 'claim'}
        saving={busy === 'lead'}
        onClaim={claim}
        onRelease={release}
        onSave={saveLead}
      />

      {/* Contact + shipping */}
      <div className="grid gap-5 md:grid-cols-2">
        <Panel icon={<MapPin className="h-4 w-4 text-teal-dark" />} title="Shipping address">
          {addressLines.length > 0 ? (
            <div className="px-4 py-3 text-sm text-ink">
              {addressLines.map((line) => <p key={line}>{line}</p>)}
            </div>
          ) : (
            <Empty>
              {isPuramassOnly
                ? 'Stealth Health never reported an address for this buyer.'
                : 'No shipping address on file.'}
            </Empty>
          )}
        </Panel>

        <Panel icon={<User className="h-4 w-4 text-teal-dark" />} title="Account details">
          <dl className="divide-y divide-line/60">
            <DetailRow label="Customer ID" value={<span className="font-mono text-xs">{c.id}</span>} />
            <DetailRow label="Role" value={isPuramassOnly ? 'No account' : (c.role ?? 'customer')} />
            <DetailRow label="Email verified" value={isPuramassOnly ? '—' : c.email_verified ? 'Yes' : 'No'} />
            <DetailRow label="Created" value={fmtDateTime(c.created_at)} />
            <DetailRow label="Last sign-in" value={isPuramassOnly ? 'No account' : fmtDateTime(c.last_login_at)} />
            {!isPuramassOnly && (
              <DetailRow
                label="Fulfilment"
                value={[c.allow_shipping ? 'Shipping' : null, c.allow_pickup ? 'Pickup' : null]
                  .filter(Boolean).join(' + ') || 'None enabled'}
              />
            )}
          </dl>
        </Panel>
      </div>

      {/* What they buy */}
      <ProductsPanel products={data.products} />

      {/* Invoices */}
      <Panel
        icon={<FileText className="h-4 w-4 text-teal-dark" />}
        title="Invoices"
        count={data.invoices.length}
      >
        {data.invoices.length === 0 ? (
          <Empty>No invoices raised for this customer yet.</Empty>
        ) : (
          <TableScroll>
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-ink-muted">
                <th className="px-4 py-2 font-semibold">Invoice</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2 font-semibold">Fulfilment</th>
                <th className="px-4 py-2 font-semibold">Issued</th>
                <th className="px-4 py-2 text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/60">
              {data.invoices.map((inv) => (
                <tr key={inv.id} className="hover:bg-surface">
                  <td className="px-4 py-3">
                    <Link href={`/admin/invoices/${inv.id}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-ink hover:text-teal-dark">
                      {inv.invoice_number}
                      <ExternalLink className="h-3 w-3" />
                    </Link>
                    {inv.source === 'stealth_health' && (
                      <span className="ml-2 inline-flex rounded bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700">
                        Stealth Health
                      </span>
                    )}
                    {inv.is_backorder && (
                      <span className="ml-2 inline-flex rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                        Backorder
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded px-2 py-0.5 text-[11px] font-medium capitalize ${statusBadge(inv.status)}`}>
                      {statusLabel(inv.status)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm capitalize text-ink-muted">
                    {statusLabel(inv.fulfillment_status ?? '—')}
                  </td>
                  <td className="px-4 py-3 text-sm text-ink-muted">{fmtDate(inv.issue_date ?? inv.created_at)}</td>
                  <td className="px-4 py-3 text-right text-sm font-medium tabular-nums text-ink">
                    {fmtMoney(inv.total, inv.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Panel>

      {/* Native orders */}
      <Panel icon={<Package className="h-4 w-4 text-teal-dark" />} title="Store orders" count={data.orders.length}>
        {data.orders.length === 0 ? (
          <Empty>No storefront orders — this customer has only ever bought another way.</Empty>
        ) : (
          <TableScroll>
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-ink-muted">
                <th className="px-4 py-2 font-semibold">Order</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2 font-semibold">Confirmation</th>
                <th className="px-4 py-2 font-semibold">Items</th>
                <th className="px-4 py-2 font-semibold">Placed</th>
                <th className="px-4 py-2 text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/60">
              {data.orders.map((o) => (
                <tr key={o.id} className="hover:bg-surface">
                  <td className="px-4 py-3">
                    <Link href={`/admin/orders/${o.id}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-ink hover:text-teal-dark">
                      {o.order_number}
                      <ExternalLink className="h-3 w-3" />
                    </Link>
                    {o.tracking_number && (
                      <span className="mt-0.5 block text-xs text-ink-muted">
                        {o.carrier ? `${o.carrier} · ` : ''}{o.tracking_number}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded px-2 py-0.5 text-[11px] font-medium capitalize ${statusBadge(o.status)}`}>
                      {statusLabel(o.status)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <OrderConfirmationCell
                      summary={o.confirmation}
                      target={{ orderId: o.id }}
                      canSend={editable}
                    />
                  </td>
                  <td className="px-4 py-3 text-sm text-ink-muted">
                    {(o.items ?? []).reduce((n, it) => n + (Number(it.quantity) || 0), 0) || '—'}
                  </td>
                  <td className="px-4 py-3 text-sm text-ink-muted">{fmtDate(o.created_at)}</td>
                  <td className="px-4 py-3 text-right text-sm font-medium tabular-nums text-ink">
                    {fmtMoney(o.total, c.preferred_currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Panel>

      {/* Stealth Health hand-offs */}
      {data.puramassOrders.length > 0 && (
        <Panel
          icon={<CreditCard className="h-4 w-4 text-indigo-600" />}
          title="Stealth Health orders"
          count={data.puramassOrders.length}
          accent="indigo"
        >
          <TableScroll>
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-ink-muted">
                <th className="px-4 py-2 font-semibold">Reference</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2 font-semibold">Confirmation</th>
                <th className="px-4 py-2 font-semibold">Items</th>
                <th className="px-4 py-2 font-semibold">Placed</th>
                <th className="px-4 py-2 text-right font-semibold">Subtotal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/60">
              {data.puramassOrders.map((p) => (
                <tr key={p.id} className="hover:bg-indigo-50/60">
                  <td className="px-4 py-3">
                    <span className="block font-mono text-xs text-ink">
                      {p.transaction_id ?? p.partner_reference}
                    </span>
                    {p.payment_link && (
                      <a
                        href={p.payment_link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-0.5 inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline"
                      >
                        Payment page <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded px-2 py-0.5 text-[11px] font-medium capitalize ${statusBadge(p.status)}`}>
                      {statusLabel(p.status)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {p.status === 'paid' && p.invoice_id ? (
                      <OrderConfirmationCell
                        summary={p.confirmation}
                        target={{ puramassOrderId: p.id }}
                        canSend={editable}
                      />
                    ) : (
                      <span className="text-[11px] text-ink-light">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-ink-muted">
                    {p.items.reduce((n, it) => n + (Number(it.quantity) || 0), 0) || '—'}
                  </td>
                  <td className="px-4 py-3 text-sm text-ink-muted">{fmtDate(p.created_at)}</td>
                  <td className="px-4 py-3 text-right text-sm font-medium tabular-nums text-ink">
                    {p.subtotal_cents == null
                      ? '—'
                      : fmtMoney(p.subtotal_cents / 100, p.currency ?? 'USD')}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        </Panel>
      )}

      {/* Site journey */}
      {!isPuramassOnly && (
        <div className="grid gap-5 md:grid-cols-2">
          <Panel
            icon={<Route className="h-4 w-4 text-teal-dark" />}
            title="Most visited pages"
            count={data.pages?.length ?? 0}
          >
            {(data.pages ?? []).length === 0 ? (
              <Empty>
                {data.capabilities?.activity === false
                  ? 'Journey tracking is not set up on this database yet — run customer-crm-migration.sql.'
                  : 'No page visits recorded yet. Only signed-in visits are tracked.'}
              </Empty>
            ) : (
              <div className="max-h-80 divide-y divide-line/60 overflow-y-auto">
                {(data.pages ?? []).map((p) => (
                  <div key={p.key} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">{p.label}</p>
                      <p className="truncate font-mono text-[11px] text-ink-muted">{p.key}</p>
                    </div>
                    <span className="shrink-0 text-xs tabular-nums text-ink-muted">
                      {p.count}× · {fmtDate(p.lastAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel
            icon={<History className="h-4 w-4 text-teal-dark" />}
            title="Recent journey"
            count={data.journey?.length ?? 0}
          >
            {(data.journey ?? []).length === 0 ? (
              <Empty>Nothing recorded yet.</Empty>
            ) : (
              <ol className="max-h-80 divide-y divide-line/60 overflow-y-auto">
                {(data.journey ?? []).map((v, i) => (
                  <li key={`${v.at}-${i}`} className="flex items-baseline gap-3 px-4 py-2.5">
                    <span className="w-28 shrink-0 text-[11px] tabular-nums text-ink-muted">
                      {fmtDateTime(v.at)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">
                      {v.title || v.path}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>
      )}

      {/* Outreach history */}
      <Panel
        icon={<Send className="h-4 w-4 text-teal-dark" />}
        title="Emails sent"
        count={data.emails?.length ?? 0}
      >
        {(data.emails ?? []).length === 0 ? (
          <Empty>
            {data.capabilities?.emailLog === false
              ? 'The email log is not set up on this database yet — run customer-crm-migration.sql.'
              : 'No emails sent to this customer from here yet.'}
          </Empty>
        ) : (
          <div className="divide-y divide-line/60">
            {(data.emails ?? []).map((e) => (
              <div key={e.id} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium text-ink">{e.subject}</p>
                  <span className="text-xs text-ink-muted">{fmtDateTime(e.created_at)}</span>
                </div>
                <p className="mt-0.5 text-xs text-ink-muted">
                  Sent by {e.sent_by_name || e.sent_by_email || 'an admin'}
                  {e.cc_emails && e.cc_emails.length > 0
                    ? ` · CC ${e.cc_emails.join(', ')}`
                    : ''}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {e.promo_code && (
                    <span className="inline-flex items-center gap-1 rounded bg-teal/10 px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wide text-teal-dark">
                      {e.promo_code}
                    </span>
                  )}
                  {e.promo_details && (
                    <span className="text-[11px] text-ink-muted">{e.promo_details}</span>
                  )}
                  {!e.success && (
                    <span className="inline-flex items-center gap-1 rounded bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-600">
                      <AlertCircle className="h-3 w-3" />
                      Failed{e.error ? `: ${e.error}` : ''}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* Browsing activity */}
      <div className="grid gap-5 md:grid-cols-3">
        <ActivityCard
          icon={<Search className="h-4 w-4 text-teal-dark" />}
          title="Searched for"
          empty={isPuramassOnly ? 'No account, so no browsing history.' : 'No searches recorded yet.'}
          items={data.searches.map((s) => ({ key: s.key, primary: `“${s.label}”`, meta: `${s.count}× · ${fmtDate(s.lastAt)}` }))}
        />
        <ActivityCard
          icon={<Eye className="h-4 w-4 text-teal-dark" />}
          title="Viewed products"
          empty={isPuramassOnly ? 'No account, so no browsing history.' : 'No product views recorded yet.'}
          items={data.views.map((v) => ({
            key: v.key,
            primary: v.label,
            meta: `${v.count} view${v.count === 1 ? '' : 's'} · ${fmtDate(v.lastAt)}`,
          }))}
        />
        <ActivityCard
          icon={<ShoppingCart className="h-4 w-4 text-teal-dark" />}
          title="Added to cart"
          empty={isPuramassOnly ? 'No account, so no cart history.' : 'Nothing added to cart yet.'}
          items={data.cart.map((v) => ({
            key: v.key,
            primary: v.label,
            meta: `last qty ${v.lastQuantity ?? 1} · ${v.count}× · ${fmtDate(v.lastAt)}`,
          }))}
        />
      </div>

      <p className="flex items-center gap-1.5 text-xs text-ink-muted">
        <Sparkles className="h-3.5 w-3.5" />
        {data.capabilities?.activity === false && !isPuramassOnly
          ? 'Activity tracking is not set up on this database — run registration-alerts-migration.sql to start recording searches, views and cart adds.'
          : 'Activity is collected while the customer is signed in. Searches, views and cart adds only.'}
      </p>

      {composing && (
        outreachLoading ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="flex items-center gap-3 rounded-xl border border-line bg-white px-6 py-5 shadow-xl">
              <Loader2 className="h-5 w-5 animate-spin text-ink-muted" />
              <span className="text-sm text-ink-muted">Checking for an open checkout…</span>
            </div>
          </div>
        ) : (
          <EmailComposer
            toEmail={c.email}
            firstName={c.first_name}
            senderName={meName}
            sending={busy === 'email'}
            onClose={closeComposer}
            onSend={sendEmail}
            // The recovery wording is only worth offering when there is a cart
            // to recover; otherwise this is the ordinary outreach composer.
            templates={
              abandoned ? mergeTemplates(RECOVERY_TEMPLATES, PROMO_TEMPLATES) : PROMO_TEMPLATES
            }
            showDiscount={Boolean(abandoned)}
            cart={outreach?.cart ?? null}
            checkout={outreach?.checkout ?? null}
            // So the composer can say "you already wrote to them on Tuesday"
            // about this customer, not only about anyone added below.
            primaryRecipient={outreach?.recipient ?? null}
            attachable={
              abandoned
                ? {
                    label: 'Attach their abandoned cart and payment link',
                    description: (
                      <>
                        <span className="font-mono">{abandoned.reference}</span> ·{' '}
                        {cartStatusLabel(abandoned.status)}
                        {cartAmount(abandoned) ? ` · ${cartAmount(abandoned)}` : ''} · started{' '}
                        {cartTimeAgo(abandoned.createdAt)}
                        {abandoned.chased > 0 ? ` · already chased ${abandoned.chased}×` : ''}
                        {abandoned.hasPaymentLink
                          ? '. The email carries the Stealth Health link that still takes payment for it.'
                          : '. Stealth Health gave us no link for this one, so no button can be sent.'}
                      </>
                    ),
                    defaultOn: true,
                  }
                : null
            }
            bulk={{
              search: searchRecipients,
              excludeIds: [id],
              // Chasing carts is what this tool is for, so it opens on the
              // buyers who have one — "Everyone" is one click away.
              defaultAbandonedOnly: Boolean(abandoned),
            }}
            promoNote={
              abandoned
                ? 'Promo codes are generated in app.vytabio.com (the Stealth Health platform). ' +
                  'Create the code there first, then paste it below — the type and amount you pick ' +
                  'only decide how the offer is worded; Stealth Health applies the real discount when the ' +
                  'customer enters the code at checkout.'
                : undefined
            }
          />
        )
      )}

      {editing && (
        <EditUserModal
          user={editing}
          onClose={() => setEditing(null)}
          onSuccess={async () => { setEditing(null); await load(); toast.success('Customer updated'); }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Products bought                                                     */
/* ------------------------------------------------------------------ */

function ProductsPanel({ products }: { products: ProductPurchase[] }) {
  const [showAll, setShowAll] = useState(false);
  const max = useMemo(
    () => products.reduce((m, p) => Math.max(m, p.quantity), 0),
    [products],
  );
  const shown = showAll ? products : products.slice(0, 8);

  return (
    <Panel
      icon={<BarChart3 className="h-4 w-4 text-teal-dark" />}
      title="Products bought"
      count={products.length}
    >
      {products.length === 0 ? (
        <Empty>Nothing purchased yet — no products to chart.</Empty>
      ) : (
        <>
          <div className="space-y-3 px-4 py-4">
            {shown.map((p) => {
              const pct = max > 0 ? Math.max(4, Math.round((p.quantity / max) * 100)) : 0;
              const spend = fmtSpend(p.spend);
              return (
                <div key={p.key}>
                  <div className="mb-1 flex items-baseline justify-between gap-3">
                    <span className="truncate text-sm font-medium text-ink">{p.name}</span>
                    <span className="shrink-0 text-xs tabular-nums text-ink-muted">
                      {p.quantity} unit{p.quantity === 1 ? '' : 's'}
                      {spend !== '—' && <span className="ml-2 text-ink">{spend}</span>}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-surface">
                    <div
                      className={`h-full rounded-full ${
                        p.channels.includes('puramass') && p.channels.length === 1
                          ? 'bg-indigo-500'
                          : 'bg-teal'
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <p className="mt-1 text-[11px] text-ink-muted">
                    {p.orders} order{p.orders === 1 ? '' : 's'} · last {fmtDate(p.lastAt)} ·{' '}
                    {p.channels.map(channelLabel).join(', ')}
                  </p>
                </div>
              );
            })}
          </div>
          {products.length > 8 && (
            <button
              onClick={() => setShowAll((v) => !v)}
              className="w-full border-t border-line py-2.5 text-xs font-medium text-ink-muted transition-colors hover:bg-surface hover:text-ink"
            >
              {showAll ? 'Show top 8' : `Show all ${products.length} products`}
            </button>
          )}
        </>
      )}
    </Panel>
  );
}

function channelLabel(channel: string): string {
  return channel === 'puramass' ? 'Stealth Health' : channel === 'invoice' ? 'Invoice' : 'Store order';
}

/* ------------------------------------------------------------------ */
/* Presentational pieces                                               */
/* ------------------------------------------------------------------ */

function BackLink() {
  return (
    <Link href="/admin/customers"
      className="inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink">
      <ArrowLeft className="h-4 w-4" /> Back to customers
    </Link>
  );
}

function StealthHealthBanner({ email, orders }: { email: string; orders: number }) {
  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 md:p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-indigo-100">
          <CreditCard className="h-5 w-5 text-indigo-700" />
        </div>
        <div className="text-sm">
          <h2 className="font-bold text-indigo-900">Stealth Health buyer — no account here</h2>
          <p className="mt-0.5 text-indigo-800/90">
            Everything below is reconstructed from {orders} Stealth Health hand-off{orders === 1 ? '' : 's'} for{' '}
            <span className="font-medium">{email}</span>. Stealth Health reports the buyer&apos;s name,
            email, phone and shipping address progressively, so blanks are expected — there is no
            sign-in history, browsing activity, or price overrides to show, and account actions are
            unavailable. They can still be claimed, tagged and emailed.
          </p>
        </div>
      </div>
    </div>
  );
}

function MetaRow({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  /** Optional explanation of where the value came from. */
  hint?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 py-0.5 sm:justify-end sm:gap-3">
      <span className="inline-flex items-center gap-1.5 text-ink-muted">
        {icon}{label}
        {hint && <InfoTip label={`About ${label}`}>{hint}</InfoTip>}
      </span>
      <span className="font-medium text-ink">{value}</span>
    </div>
  );
}

function Badge({ tone, children }: { tone: 'green' | 'amber' | 'red' | 'gray' | 'indigo'; children: React.ReactNode }) {
  const cls: Record<string, string> = {
    green: 'bg-emerald-100 text-emerald-700',
    amber: 'bg-amber-100 text-amber-700',
    red: 'bg-red-100 text-red-700',
    gray: 'bg-gray-100 text-ink-muted',
    indigo: 'bg-indigo-100 text-indigo-700',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${cls[tone]}`}>
      {children}
    </span>
  );
}

function ActionButton({
  onClick, children, icon, busy, tone = 'neutral',
}: {
  onClick: () => void;
  children: React.ReactNode;
  icon: React.ReactNode;
  busy?: boolean;
  tone?: 'neutral' | 'danger';
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
        tone === 'danger'
          ? 'border-red-200 bg-white text-red-600 hover:bg-red-50'
          : 'border-line bg-white text-ink hover:bg-surface'
      }`}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

function StatCard({
  icon, label, value, hint,
}: { icon: React.ReactNode; label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-white p-4">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-muted">
        {icon}{label}
      </div>
      <p className="mt-2 text-lg font-bold text-ink">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-muted">{hint}</p>}
    </div>
  );
}

function Panel({
  icon, title, count, children, accent,
}: {
  icon: React.ReactNode;
  title: string;
  count?: number;
  children: React.ReactNode;
  accent?: 'indigo';
}) {
  return (
    <div className={`overflow-hidden rounded-xl border bg-white ${accent === 'indigo' ? 'border-indigo-200' : 'border-line'}`}>
      <div className={`flex items-center justify-between border-b px-4 py-3 ${accent === 'indigo' ? 'border-indigo-200 bg-indigo-50/50' : 'border-line'}`}>
        <div className="flex items-center gap-2">
          <div className={`flex h-7 w-7 items-center justify-center rounded-md ${accent === 'indigo' ? 'bg-indigo-500/10' : 'bg-teal/10'}`}>
            {icon}
          </div>
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
        </div>
        {count !== undefined && <span className="text-xs tabular-nums text-ink-muted">{count}</span>}
      </div>
      {children}
    </div>
  );
}

function TableScroll({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full">{children}</table>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="truncate text-sm font-medium capitalize text-ink">{value}</dd>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-8 text-center text-xs text-ink-muted">{children}</p>;
}

interface ActivityItem { key: string; primary: string; meta: string }

function ActivityCard({
  icon, title, items, empty,
}: { icon: React.ReactNode; title: string; items: ActivityItem[]; empty: string }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-line bg-white">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-teal/10">{icon}</div>
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
        </div>
        <span className="text-xs tabular-nums text-ink-muted">{items.length}</span>
      </div>
      <div className="max-h-96 divide-y divide-line/60 overflow-y-auto">
        {items.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-ink-muted">{empty}</p>
        ) : (
          items.map((it) => (
            <div key={it.key} className="px-4 py-3">
              <p className="break-words text-sm font-medium text-ink">{it.primary}</p>
              <p className="mt-0.5 text-xs text-ink-muted">{it.meta}</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
