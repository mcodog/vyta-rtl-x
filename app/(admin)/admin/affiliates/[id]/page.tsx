'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft, Users, Mail, Phone, Calendar, Clock, Loader2, Copy, Send, Power,
  Pencil, Wallet, Tag, DollarSign, TrendingUp, BarChart3, ExternalLink,
  AlertCircle, CheckCircle2, XCircle, UserPlus, Percent, Package, Route, History,
  KeyRound,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useToast } from '@/contexts/ToastContext';
import { useUserRole } from '../../layout';
import { canEdit } from '@/lib/permissions';
import { toggleAffiliateActive } from '@/lib/admin/api';
import LeadPanel from '../../_components/LeadPanel';
import EmailComposer from '../../_components/EmailComposer';
import EditAffiliateModal from '../_components/EditAffiliateModal';
import AffiliateCodesPayouts from '@/components/admin/affiliates/AffiliateCodesPayouts';
import EditReferralCodeModal from '../_components/EditReferralCodeModal';
import DeclineReferralCodeDialog from '../_components/DeclineReferralCodeDialog';
import {
  decideReferralCodeRequest,
  getReferralCodeRequests,
  type AdminReferralCodeRequest,
} from '@/lib/admin/referral-codes';
import {
  emptyLead,
  type ContactMethod,
  type Lead,
  type LeadStatus,
} from '@/lib/admin/customer-leads';
import type { PromoTemplateKey } from '@/lib/customer/promo-email';

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

interface SentEmail {
  id: string;
  cc_emails: string[] | null;
  subject: string;
  promo_code: string | null;
  promo_details: string | null;
  sent_by_name: string | null;
  sent_by_email: string | null;
  success: boolean;
  error: string | null;
  created_at: string;
}

interface Insights {
  affiliate: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string;
    wallet_address: string | null;
    active: boolean;
    commission_rate: number | null;
    created_at: string | null;
    updated_at: string | null;
  };
  account: {
    id: string;
    role: string;
    active: boolean;
    last_login_at: string | null;
    phone: string | null;
    preferred_currency: string | null;
  } | null;
  lead: Lead | null;
  emails: SentEmail[];
  capabilities: { claims: boolean; emailLog: boolean; activity?: boolean };
  codes: { id: string; code: string; active: boolean; uses_count: number; created_at: string }[];
  commissions: {
    id: string;
    order_id: string | null;
    invoice_id: string | null;
    amount: number;
    order_total: number;
    commission_rate: number;
    status: string;
    paid_at: string | null;
    created_at: string;
  }[];
  customers: {
    key: string;
    /** Null for a guest buyer credited through a sale, with no account. */
    id: string | null;
    name: string;
    email: string | null;
    created_at: string | null;
    /** False when they were only credited through a sale, never bound. */
    bound: boolean;
    has_ordered: boolean;
    orders: number;
    revenue: number;
  }[];
  /** What this affiliate's referrals actually buy. */
  products: { key: string; name: string; quantity: number; revenue: number; orders: number; lastAt: string }[];
  pages: { key: string; label: string; count: number; lastAt: string }[];
  journey: { path: string; title: string | null; at: string }[];
  earningsByMonth: { month: string; earned: number; count: number }[];
  stats: {
    totalEarnings: number;
    pendingEarnings: number;
    paidEarnings: number;
    commissionCount: number;
    referralUses: number;
    activeCodes: number;
    boundCustomers: number;
    convertedCustomers: number;
    customerRevenue: number;
    lastCommissionAt: string | null;
  };
}

const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—';

const fmtDateTime = (s: string | null) =>
  s ? new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

// The affiliate tables carry no currency column, so amounts are shown the way
// the rest of the affiliate admin shows them — a bare $ — rather than claiming
// a currency the data doesn't record.
const fmtAmount = (n: number) => `$${(n ?? 0).toFixed(2)}`;

/** "2026-08" → "Aug 2026" */
function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) return month;
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

const STATUS_BADGE: Record<string, string> = {
  pending: 'bg-amber-500/10 text-amber-700',
  approved: 'bg-blue-500/10 text-blue-600',
  paid: 'bg-emerald-500/10 text-emerald-600',
  cancelled: 'bg-red-500/10 text-red-600',
  rejected: 'bg-red-500/10 text-red-600',
};

export default function AffiliateProfilePage() {
  const params = useParams();
  const router = useRouter();
  const toast = useToast();
  const userRole = useUserRole();
  const editable = canEdit(userRole);

  const id = String(params.id);

  const [data, setData] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [meId, setMeId] = useState<string | null>(null);
  const [meName, setMeName] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [codeRequests, setCodeRequests] = useState<AdminReferralCodeRequest[]>([]);
  const [editingCode, setEditingCode] = useState(false);
  const [decliningCode, setDecliningCode] = useState<AdminReferralCodeRequest | null>(null);
  const [notifyOnCodeApprove, setNotifyOnCodeApprove] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/affiliates/${id}/insights`, {
        cache: 'no-store',
        headers: await authHeaders(),
      });
      if (res.status === 404) { setNotFound(true); return; }
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to load');
      setData(json);
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to load affiliate');
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => { load(); }, [load]);

  const loadCodeRequests = useCallback(async () => {
    setCodeRequests(await getReferralCodeRequests({ affiliateId: id, status: 'all', limit: 20 }));
  }, [id]);

  useEffect(() => { loadCodeRequests(); }, [loadCodeRequests]);

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
    const res = await fetch(`/api/admin/affiliates/${id}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? 'Failed to claim');
    toast.success('Affiliate claimed — you own this relationship');
    await load();
  });

  const release = () => runAction('claim', async () => {
    const res = await fetch(`/api/admin/affiliates/${id}/claim`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? 'Failed to release');
    toast.success('Claim released — the history stays');
    await load();
  });

  const saveLead = (patch: {
    status: LeadStatus;
    contact_method: ContactMethod | '';
    notes: string;
    last_contacted_at: string;
    next_follow_up_at: string;
  }) => runAction('lead', async () => {
    const res = await fetch(`/api/admin/affiliates/${id}/lead`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(patch),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? 'Failed to save');
    toast.success('Lead updated');
    await load();
  });

  const sendEmail = async (payload: {
    templateKey: PromoTemplateKey;
    subject: string;
    body: string;
    promoCode: string;
    promoDetails: string;
    promoExpires: string;
    cc: string[];
  }) => {
    await runAction('email', async () => {
      const res = await fetch(`/api/admin/affiliates/${id}/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to send');
      setComposing(false);
      toast.success(
        json.logged === false
          ? 'Email sent — but it will not appear in the history until customer-crm-migration.sql runs'
          : 'Email sent',
      );
      await load();
    });
  };

  const toggleActive = () => runAction('active', async () => {
    if (!data) return;
    const result = await toggleAffiliateActive(id, !data.affiliate.active);
    if (!result?.success) throw new Error(result?.error ?? 'Failed to update');
    toast.success(data.affiliate.active ? 'Affiliate deactivated' : 'Affiliate activated');
    await load();
  });

  // Affiliates sign in through Supabase auth (the `password_hash` column on the
  // affiliates row is legacy and unused), so both buttons mint the same
  // recovery link — `purpose` only picks welcome vs password-reset copy.
  const sendAccountLink = (purpose: 'welcome' | 'reset') => {
    const label = purpose === 'reset' ? 'Password reset link' : 'Sign-in link';
    return runAction(purpose === 'reset' ? 'reset' : 'magic', async () => {
      const res = await fetch(`/api/admin/affiliates/${id}/magic-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ redirectPath: '/reset-password', purpose }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to send link');
      if (json.emailed) toast.success(`${label} emailed to the affiliate`);
      else if (json.action_link) {
        await navigator.clipboard?.writeText(json.action_link).catch(() => {});
        toast.success(`Mailer not configured — ${label.toLowerCase()} copied to clipboard`);
      } else toast.success(`${label} generated`);
    });
  };

  const sendSignInLink = () => sendAccountLink('welcome');
  const sendResetLink = () => sendAccountLink('reset');

  const copy = (value: string, label: string) => runAction('copy', async () => {
    await navigator.clipboard?.writeText(value);
    toast.success(`${label} copied`);
  });

  const decideCode = (
    request: AdminReferralCodeRequest,
    action: 'approve' | 'reject',
    notes?: string,
  ) => runAction('code', async () => {
    const result = await decideReferralCodeRequest(request.id, action, notes, notifyOnCodeApprove);
    if (!result.success) throw new Error(result.error ?? 'Could not record the decision');
    setDecliningCode(null);
    if (action === 'reject') {
      toast.success(`${request.requested_code} declined.`);
    } else if (notifyOnCodeApprove && !result.notified) {
      // The code is live either way — a failed send is a warning, not a failure.
      toast.error(
        `${request.requested_code} is live, but the email did not go out: ${result.notifyError}`,
      );
    } else {
      toast.success(`${request.requested_code} is now live`);
    }
    await Promise.all([load(), loadCodeRequests()]);
  });

  const maxMonth = useMemo(
    () => (data?.earningsByMonth ?? []).reduce((m, e) => Math.max(m, e.earned), 0),
    [data],
  );
  const maxProduct = useMemo(
    () => (data?.products ?? []).reduce((m, p) => Math.max(m, p.quantity), 0),
    [data],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-sm text-ink-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading affiliate…
      </div>
    );
  }

  if (notFound || !data) {
    return (
      <div className="max-w-3xl">
        <BackLink />
        <div className="mt-6 rounded-xl border border-line bg-white p-10 text-center text-sm text-ink-muted">
          Affiliate not found.
        </div>
      </div>
    );
  }

  const a = data.affiliate;
  const name = `${a.first_name ?? ''} ${a.last_name ?? ''}`.trim() || 'Unnamed affiliate';
  const activeCode = data.codes.find((c) => c.active) ?? data.codes[0] ?? null;
  const pendingCodeRequest = codeRequests.find((r) => r.status === 'pending') ?? null;
  const codeHistory = codeRequests.filter((r) => r.status !== 'pending').slice(0, 5);
  const referralLink = activeCode
    ? `${typeof window === 'undefined' ? '' : window.location.origin}?ref=${activeCode.code}`
    : null;
  const conversion =
    data.stats.boundCustomers > 0
      ? Math.round((data.stats.convertedCustomers / data.stats.boundCustomers) * 100)
      : 0;

  return (
    <div className="max-w-6xl space-y-6">
      <BackLink />

      {/* Header */}
      <div className="rounded-xl border border-line bg-white p-5 md:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-teal/10">
              <Users className="h-6 w-6 text-teal-dark" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-ink sm:text-2xl">{name}</h1>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-muted">
                <span className="inline-flex items-center gap-1.5"><Mail className="h-3.5 w-3.5" />{a.email}</span>
                {data.account?.phone && (
                  <span className="inline-flex items-center gap-1.5"><Phone className="h-3.5 w-3.5" />{data.account.phone}</span>
                )}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Badge tone={a.active ? 'green' : 'red'}>
                  {a.active ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                  {a.active ? 'Active' : 'Inactive'}
                </Badge>
                {activeCode && (
                  <Badge tone="teal">
                    <Tag className="h-3.5 w-3.5" />
                    <span className="font-mono">{activeCode.code}</span>
                  </Badge>
                )}
                {a.commission_rate != null && (
                  <Badge tone="gray">
                    <Percent className="h-3.5 w-3.5" />
                    {(a.commission_rate <= 1 ? a.commission_rate * 100 : a.commission_rate).toFixed(0)}% commission
                  </Badge>
                )}
              </div>
              {a.wallet_address && (
                <p className="mt-2 flex items-center gap-1.5 font-mono text-xs text-ink-muted">
                  <Wallet className="h-3.5 w-3.5" />
                  <span className="break-all">{a.wallet_address}</span>
                </p>
              )}
            </div>
          </div>

          <div className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-1 text-sm sm:block">
            <MetaRow icon={<Calendar className="h-3.5 w-3.5" />} label="Joined" value={fmtDate(a.created_at)} />
            <MetaRow
              icon={<Clock className="h-3.5 w-3.5" />}
              label="Last sign-in"
              value={data.account ? fmtDateTime(data.account.last_login_at) : 'No account'}
            />
            <MetaRow
              icon={<DollarSign className="h-3.5 w-3.5" />}
              label="Last commission"
              value={fmtDate(data.stats.lastCommissionAt)}
            />
          </div>
        </div>

        {/* Actions */}
        <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
          <ActionButton onClick={() => copy(a.email, 'Email')} busy={busy === 'copy'} icon={<Copy className="h-4 w-4" />}>
            Copy email
          </ActionButton>
          {activeCode && (
            <ActionButton
              onClick={() => copy(activeCode.code, 'Referral code')}
              busy={busy === 'copy'}
              icon={<Tag className="h-4 w-4" />}
            >
              Copy code
            </ActionButton>
          )}
          {editable && (
            <>
              <button
                onClick={() => setComposing(true)}
                className="inline-flex items-center gap-2 rounded-lg bg-teal-dark px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-teal/90"
              >
                <Send className="h-4 w-4" /> Send email
              </button>
              <ActionButton onClick={sendSignInLink} busy={busy === 'magic'} icon={<Mail className="h-4 w-4" />}>
                Send sign-in link
              </ActionButton>
              <ActionButton onClick={sendResetLink} busy={busy === 'reset'} icon={<KeyRound className="h-4 w-4" />}>
                Send password reset link
              </ActionButton>
              <ActionButton onClick={() => setEditing(true)} busy={false} icon={<Pencil className="h-4 w-4" />}>
                Edit affiliate
              </ActionButton>
              <ActionButton
                onClick={toggleActive}
                busy={busy === 'active'}
                tone={a.active ? 'danger' : 'neutral'}
                icon={<Power className="h-4 w-4" />}
              >
                {a.active ? 'Deactivate' : 'Activate'}
              </ActionButton>
            </>
          )}
          <a
            href={`mailto:${a.email}`}
            className="inline-flex items-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-surface"
          >
            <Mail className="h-4 w-4" /> Open in mail app
          </a>
        </div>
      </div>

      {/* Performance */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={<DollarSign className="h-4 w-4 text-emerald-600" />}
          label="Total earned"
          value={fmtAmount(data.stats.totalEarnings)}
          hint={`${fmtAmount(data.stats.paidEarnings)} paid · ${fmtAmount(data.stats.pendingEarnings)} pending`}
        />
        <StatCard
          icon={<UserPlus className="h-4 w-4 text-teal-dark" />}
          label="Customers referred"
          value={String(data.stats.boundCustomers)}
          hint={`${data.stats.convertedCustomers} have ordered (${conversion}%)`}
        />
        <StatCard
          icon={<TrendingUp className="h-4 w-4 text-teal-dark" />}
          label="Customer sales"
          value={fmtAmount(data.stats.customerRevenue)}
          hint="Spend by everyone they referred"
        />
        <StatCard
          icon={<Tag className="h-4 w-4 text-teal-dark" />}
          label="Referral uses"
          value={String(data.stats.referralUses)}
          hint={`${data.stats.activeCodes} active code${data.stats.activeCodes === 1 ? '' : 's'} · ${data.stats.commissionCount} commissions`}
        />
      </div>

      {/* Lead desk */}
      <LeadPanel
        lead={data.lead ?? emptyLead(a.email, data.account?.id ?? null, 'affiliate')}
        meId={meId}
        available={data.capabilities?.claims !== false}
        claiming={busy === 'claim'}
        saving={busy === 'lead'}
        subjectLabel="affiliate"
        onClaim={claim}
        onRelease={release}
        onSave={saveLead}
      />

      {/* Payout + account */}
      <div className="grid gap-5 md:grid-cols-2">
        <Panel icon={<Wallet className="h-4 w-4 text-teal-dark" />} title="Payout details">
          <dl className="divide-y divide-line/60">
            <DetailRow
              label="Wallet address"
              value={
                a.wallet_address
                  ? <span className="break-all font-mono text-xs">{a.wallet_address}</span>
                  : 'Not set'
              }
            />
            <DetailRow
              label="Commission rate"
              value={
                a.commission_rate == null
                  ? 'Default'
                  : `${(a.commission_rate <= 1 ? a.commission_rate * 100 : a.commission_rate).toFixed(0)}%`
              }
            />
            <DetailRow label="Paid out" value={fmtAmount(data.stats.paidEarnings)} />
            <DetailRow label="Owed" value={fmtAmount(data.stats.pendingEarnings)} />
            <DetailRow
              label="Commissions"
              value={`${data.stats.commissionCount} recorded`}
            />
          </dl>
        </Panel>

        <Panel icon={<Users className="h-4 w-4 text-teal-dark" />} title="Account details">
          <dl className="divide-y divide-line/60">
            <DetailRow label="Affiliate ID" value={<span className="font-mono text-xs">{a.id}</span>} />
            <DetailRow label="Email" value={a.email} />
            <DetailRow label="Status" value={a.active ? 'Active' : 'Inactive'} />
            <DetailRow label="Joined" value={fmtDateTime(a.created_at)} />
            <DetailRow
              label="Site sign-in"
              value={data.account ? fmtDateTime(data.account.last_login_at) : 'No site account'}
            />
            <DetailRow label="Last updated" value={fmtDateTime(a.updated_at)} />
          </dl>
        </Panel>
      </div>

      {/* Discount codes, revenue and payments */}
      <AffiliateCodesPayouts affiliateId={a.id} affiliateName={name} editable={editable} />

      {/* What their referrals buy */}
      <Panel
        icon={<Package className="h-4 w-4 text-teal-dark" />}
        title="What their referrals buy"
        count={data.products?.length ?? 0}
      >
        {(data.products ?? []).length === 0 ? (
          <Empty>
            Nothing bought by their referrals yet — nothing to tell them to push.
          </Empty>
        ) : (
          <div className="space-y-3 px-4 py-4">
            {(data.products ?? []).slice(0, 12).map((p) => {
              const pct = maxProduct > 0 ? Math.max(4, Math.round((p.quantity / maxProduct) * 100)) : 0;
              return (
                <div key={p.key}>
                  <div className="mb-1 flex items-baseline justify-between gap-3">
                    <span className="truncate text-sm font-medium text-ink">{p.name}</span>
                    <span className="shrink-0 text-xs tabular-nums text-ink-muted">
                      {p.quantity} unit{p.quantity === 1 ? '' : 's'}
                      <span className="ml-2 text-ink">{fmtAmount(p.revenue)}</span>
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-surface">
                    <div className="h-full rounded-full bg-teal" style={{ width: `${pct}%` }} />
                  </div>
                  <p className="mt-1 text-[11px] text-ink-muted">
                    across {p.orders} order{p.orders === 1 ? '' : 's'} · last {fmtDate(p.lastAt)}
                  </p>
                </div>
              );
            })}
            {(data.products ?? []).length > 12 && (
              <p className="pt-1 text-center text-[11px] text-ink-muted">
                Showing the top 12 of {data.products.length}.
              </p>
            )}
          </div>
        )}
      </Panel>

      {/* Their own site journey */}
      <div className="grid gap-5 md:grid-cols-2">
        <Panel
          icon={<Route className="h-4 w-4 text-teal-dark" />}
          title="Pages they visit"
          count={data.pages?.length ?? 0}
        >
          {(data.pages ?? []).length === 0 ? (
            <Empty>
              {data.capabilities?.activity === false
                ? 'No site account, so nothing is recorded for them.'
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

      {/* Earnings over time */}
      <Panel
        icon={<BarChart3 className="h-4 w-4 text-teal-dark" />}
        title="Earnings by month"
        count={data.earningsByMonth.length}
      >
        {data.earningsByMonth.length === 0 ? (
          <Empty>No commissions earned yet.</Empty>
        ) : (
          <div className="space-y-3 px-4 py-4">
            {data.earningsByMonth.map((m) => {
              const pct = maxMonth > 0 ? Math.max(4, Math.round((m.earned / maxMonth) * 100)) : 0;
              return (
                <div key={m.month}>
                  <div className="mb-1 flex items-baseline justify-between gap-3">
                    <span className="text-sm font-medium text-ink">{monthLabel(m.month)}</span>
                    <span className="shrink-0 text-xs tabular-nums text-ink-muted">
                      <span className="text-ink">{fmtAmount(m.earned)}</span> · {m.count} commission{m.count === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-surface">
                    <div className="h-full rounded-full bg-teal" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {/* Referral link */}
      <Panel icon={<Tag className="h-4 w-4 text-teal-dark" />} title="Referral link">
        <div className="space-y-4 px-4 py-4">
          {activeCode ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="rounded bg-surface px-2.5 py-1 font-mono text-sm font-semibold text-ink">
                {activeCode.code}
              </span>
              <span className="text-xs text-ink-muted">
                {activeCode.uses_count} use{activeCode.uses_count === 1 ? '' : 's'}
              </span>
              {referralLink && (
                <button
                  onClick={() => copy(referralLink, 'Referral link')}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[11px] font-medium text-ink-muted transition-colors hover:border-teal/40 hover:text-ink"
                >
                  <Copy className="h-3 w-3" /> {referralLink}
                </button>
              )}
              {editable && (
                <button
                  onClick={() => setEditingCode(true)}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[11px] font-medium text-ink-muted transition-colors hover:border-teal/40 hover:text-ink"
                >
                  <Pencil className="h-3 w-3" /> Change
                </button>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-ink-muted">No referral code has been issued yet.</span>
              {editable && (
                <button
                  onClick={() => setEditingCode(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[11px] font-medium text-ink-muted transition-colors hover:border-teal/40 hover:text-ink"
                >
                  <Tag className="h-3 w-3" /> Set code
                </button>
              )}
            </div>
          )}

          {/* The one thing on this card waiting on somebody — decidable here
              rather than sending the admin back to the queue on the list page. */}
          {pendingCodeRequest && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <p className="text-sm font-semibold text-amber-800">
                Asked for <span className="font-mono">{pendingCodeRequest.requested_code}</span>
              </p>
              <p className="mt-0.5 text-[11px] text-amber-700">
                {fmtDate(pendingCodeRequest.created_at)}
              </p>
              {editable && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => decideCode(pendingCodeRequest, 'approve')}
                    disabled={busy === 'code'}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-600 disabled:opacity-50"
                  >
                    {busy === 'code' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    )}
                    Approve
                  </button>
                  <button
                    onClick={() => setDecliningCode(pendingCodeRequest)}
                    disabled={busy === 'code'}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 transition-colors hover:border-red-300 hover:text-red-500 disabled:opacity-50"
                  >
                    <XCircle className="h-3.5 w-3.5" /> Decline
                  </button>
                  <label className="ml-auto flex items-center gap-2 text-[11px] text-amber-800">
                    <input
                      type="checkbox"
                      checked={notifyOnCodeApprove}
                      onChange={(e) => setNotifyOnCodeApprove(e.target.checked)}
                      className="accent-teal"
                    />
                    Email on approve
                  </label>
                </div>
              )}
            </div>
          )}

          {codeHistory.length > 0 && (
            <ul className="divide-y divide-line/60 border-t border-line pt-2">
              {codeHistory.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2 py-2 text-xs">
                  <span className="font-mono font-medium text-ink">{r.requested_code}</span>
                  <span className="text-ink-muted">
                    {r.source === 'admin'
                      ? 'set by'
                      : r.status === 'approved'
                        ? 'approved by'
                        : r.status === 'rejected'
                          ? 'declined by'
                          : 'withdrawn'}
                    {r.decided_by_name ? ` ${r.decided_by_name}` : ''}
                  </span>
                  {r.decision_notes && (
                    <span className="text-ink-muted">· {r.decision_notes}</span>
                  )}
                  <span className="ml-auto text-[10px] text-ink-muted">
                    {fmtDate(r.decided_at ?? r.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Panel>

      {/* Referred customers */}
      <Panel icon={<UserPlus className="h-4 w-4 text-teal-dark" />} title="Customers referred" count={data.customers.length}>
        {data.customers.length === 0 ? (
          <Empty>Nobody has been referred by this affiliate yet.</Empty>
        ) : (
          <TableScroll>
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-ink-muted">
                <th className="px-4 py-2 font-semibold">Customer</th>
                <th className="px-4 py-2 font-semibold">Joined</th>
                <th className="px-4 py-2 text-right font-semibold">Orders</th>
                <th className="px-4 py-2 text-right font-semibold">Spend</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/60">
              {data.customers.map((c) => (
                <tr key={c.key} className="hover:bg-surface">
                  <td className="px-4 py-3">
                    {c.id ? (
                      <Link
                        href={`/admin/customers/${c.id}`}
                        className="inline-flex items-center gap-1.5 text-sm font-medium text-ink hover:text-teal-dark"
                      >
                        {c.name}
                        <ExternalLink className="h-3 w-3" />
                      </Link>
                    ) : (
                      <span className="text-sm font-medium text-ink">{c.name}</span>
                    )}
                    <span className="mt-0.5 block text-xs text-ink-muted">
                      {c.email}
                      {!c.bound && (
                        <span className="ml-1.5 text-ink-light" title="Credited to this affiliate through a sale; not bound to them">
                          · via code
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-ink-muted">{fmtDate(c.created_at)}</td>
                  <td className="px-4 py-3 text-right text-sm tabular-nums text-ink-muted">
                    {c.orders || '—'}
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-medium tabular-nums text-ink">
                    {c.revenue > 0 ? fmtAmount(c.revenue) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Panel>

      {/* Commissions */}
      <Panel icon={<DollarSign className="h-4 w-4 text-teal-dark" />} title="Commissions" count={data.stats.commissionCount}>
        {data.commissions.length === 0 ? (
          <Empty>No commissions recorded yet.</Empty>
        ) : (
          <TableScroll>
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-ink-muted">
                <th className="px-4 py-2 font-semibold">Earned</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2 font-semibold">Order total</th>
                <th className="px-4 py-2 font-semibold">Rate</th>
                <th className="px-4 py-2 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/60">
              {data.commissions.map((c) => (
                <tr key={c.id} className="hover:bg-surface">
                  <td className="px-4 py-3 text-sm text-ink-muted">{fmtDate(c.created_at)}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded px-2 py-0.5 text-[11px] font-medium capitalize ${
                        STATUS_BADGE[String(c.status).toLowerCase()] ?? 'bg-gray-500/10 text-gray-600'
                      }`}
                    >
                      {c.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm tabular-nums text-ink-muted">{fmtAmount(c.order_total)}</td>
                  <td className="px-4 py-3 text-sm tabular-nums text-ink-muted">
                    {(c.commission_rate <= 1 ? c.commission_rate * 100 : c.commission_rate).toFixed(0)}%
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-semibold tabular-nums text-emerald-600">
                    {fmtAmount(c.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
        {data.stats.commissionCount > data.commissions.length && (
          <p className="border-t border-line px-4 py-2 text-center text-xs text-ink-muted">
            Showing the most recent {data.commissions.length} of {data.stats.commissionCount}.
          </p>
        )}
      </Panel>

      {/* Outreach history */}
      <Panel icon={<Send className="h-4 w-4 text-teal-dark" />} title="Emails sent" count={data.emails?.length ?? 0}>
        {(data.emails ?? []).length === 0 ? (
          <Empty>
            {data.capabilities?.emailLog === false
              ? 'The email log is not set up on this database yet — run customer-crm-migration.sql.'
              : 'No emails sent to this affiliate from here yet.'}
          </Empty>
        ) : (
          <div className="divide-y divide-line/60">
            {data.emails.map((e) => (
              <div key={e.id} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium text-ink">{e.subject}</p>
                  <span className="text-xs text-ink-muted">{fmtDateTime(e.created_at)}</span>
                </div>
                <p className="mt-0.5 text-xs text-ink-muted">
                  Sent by {e.sent_by_name || e.sent_by_email || 'an admin'}
                  {e.cc_emails && e.cc_emails.length > 0 ? ` · CC ${e.cc_emails.join(', ')}` : ''}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {e.promo_code && (
                    <span className="inline-flex items-center gap-1 rounded bg-teal/10 px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wide text-teal-dark">
                      {e.promo_code}
                    </span>
                  )}
                  {e.promo_details && <span className="text-[11px] text-ink-muted">{e.promo_details}</span>}
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

      {composing && (
        <EmailComposer
          toEmail={a.email}
          firstName={a.first_name}
          senderName={meName}
          recipientLabel="affiliate"
          sending={busy === 'email'}
          onClose={() => setComposing(false)}
          onSend={sendEmail}
        />
      )}

      {editing && (
        <EditAffiliateModal
          affiliate={{
            id: a.id,
            first_name: a.first_name ?? '',
            last_name: a.last_name ?? '',
            email: a.email,
            wallet_address: a.wallet_address,
            active: a.active,
          }}
          onClose={() => setEditing(false)}
          onSaved={async () => { setEditing(false); await load(); toast.success('Affiliate updated'); }}
        />
      )}

      {editingCode && (
        <EditReferralCodeModal
          affiliateId={id}
          affiliateName={a.first_name || name}
          currentCode={activeCode?.code ?? null}
          onClose={() => setEditingCode(false)}
          onSaved={async ({ code, notified, notifyError }) => {
            setEditingCode(false);
            await Promise.all([load(), loadCodeRequests()]);
            // The save and the send are reported separately: the code is live
            // either way.
            if (notified) toast.success(`${code} is now live — affiliate emailed`);
            else if (notifyError) toast.error(`${code} is live, but the email did not go out: ${notifyError}`);
            else toast.success(`${code} is now live`);
          }}
        />
      )}

      {decliningCode && (
        <DeclineReferralCodeDialog
          affiliateName={name}
          code={decliningCode.requested_code}
          busy={busy === 'code'}
          onClose={() => setDecliningCode(null)}
          onConfirm={(notes) => decideCode(decliningCode, 'reject', notes)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Presentational pieces                                               */
/* ------------------------------------------------------------------ */

function BackLink() {
  return (
    <Link
      href="/admin/affiliates"
      className="inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
    >
      <ArrowLeft className="h-4 w-4" /> Back to affiliates
    </Link>
  );
}

function MetaRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 py-0.5 sm:justify-end sm:gap-3">
      <span className="inline-flex items-center gap-1.5 text-ink-muted">{icon}{label}</span>
      <span className="font-medium text-ink">{value}</span>
    </div>
  );
}

function Badge({ tone, children }: { tone: 'green' | 'red' | 'gray' | 'teal'; children: React.ReactNode }) {
  const cls: Record<string, string> = {
    green: 'bg-emerald-100 text-emerald-700',
    red: 'bg-red-100 text-red-700',
    gray: 'bg-gray-100 text-ink-muted',
    teal: 'bg-teal/10 text-teal-dark',
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
          ? 'border-amber-200 bg-white text-amber-700 hover:bg-amber-50'
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
  icon, title, count, children,
}: { icon: React.ReactNode; title: string; count?: number; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-white">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-teal/10">{icon}</div>
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
      <dt className="shrink-0 text-xs text-ink-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right text-sm font-medium text-ink">{value}</dd>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-8 text-center text-xs text-ink-muted">{children}</p>;
}
