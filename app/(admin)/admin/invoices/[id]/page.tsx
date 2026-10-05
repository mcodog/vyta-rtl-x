'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  ArrowLeft, FileText, CreditCard, Check, DollarSign,
  Edit2, Loader2, X, Download, Eye, Briefcase, Pencil, Send, Trash2,
  Truck, RefreshCw, Package, Beaker, Store,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useUserRole } from '../../layout';
import { canEdit, canDelete } from '@/lib/permissions';
import {
  getInvoice, updateInvoice, recordPayment,
  getInvoiceTracking, deleteInvoice, emailInvoice, getInvoicePuramass,
  type InvoiceTrackingSnapshot,
} from '@/lib/admin/invoices';
import {
  InvoiceSourceBadge,
  InvoiceTotalAmount,
  PuramassOrderPanel,
  PuramassShipTo,
  PuramassShipToPanel,
} from '@/components/admin/PuramassInvoiceBlocks';
import {
  isPuramassInvoice,
  puramassMoneySplit,
  type PuramassInvoiceContext,
} from '@/lib/admin/puramass-invoice';
import type { Invoice, InvoiceLineItem, Payment, InvoiceStatus, PaymentMethod } from '@/lib/types/ecommerce';
import { formatMoney, normalizeCurrency, type Currency } from '@/lib/currency';
import OrderManagementPanel from '@/components/admin/OrderManagementPanel';
import LiveShipmentTracking from '@/components/admin/LiveShipmentTracking';
import InvoiceEasyshipPanel from '@/components/admin/InvoiceEasyshipPanel';
import OrderConfirmationEmailCard from '@/components/admin/OrderConfirmationEmailCard';
import AdminPaidAlertEmailCard from '@/components/admin/AdminPaidAlertEmailCard';
import { formatAppDate } from '@/lib/datetime';

const statusColors: Record<InvoiceStatus, string> = {
  draft: 'bg-gray-500/10 text-gray-600 border-gray-300',
  sent: 'bg-blue-500/10 text-blue-600 border-blue-200',
  paid: 'bg-emerald-500/10 text-emerald-600 border-emerald-200',
  partial: 'bg-amber-500/10 text-amber-600 border-amber-200',
  overdue: 'bg-red-500/10 text-red-600 border-red-200',
  cancelled: 'bg-gray-500/10 text-gray-500 border-gray-200 line-through',
  pending_payment: 'bg-amber-500/10 text-amber-700 border-amber-200',
  expired: 'bg-gray-200 text-gray-600 border-gray-300',
};

export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const userRole = useUserRole();
  const editable = canEdit(userRole);
  const deletable = canDelete(userRole);

  const [data, setData] = useState<{
    invoice: Invoice & {
      customer_name?: string;
      customer_email?: string;
      customer_phone?: string;
      sales_person_name?: string;
      sales_person_email?: string;
      /** 'stealth_health' for an invoice materialised from a Stealth Health hand-off. */
      source?: string | null;
    };
    line_items: InvoiceLineItem[];
    payments: Payment[];
    amount_paid: number;
    amount_due: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  // Payment modal
  const [showPayment, setShowPayment] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState<PaymentMethod>('card');
  const [payRef, setPayRef] = useState('');
  const [paying, setPaying] = useState(false);
  const [msg, setMsg] = useState('');

  // Status edit
  const [editingStatus, setEditingStatus] = useState(false);
  const [newStatus, setNewStatus] = useState<InvoiceStatus>('draft');

  // Order & shipping tracking snapshot
  const [tracking, setTracking] = useState<InvoiceTrackingSnapshot | null>(null);
  const [refreshingTracking, setRefreshingTracking] = useState(false);

  // The Stealth Health hand-off behind this invoice, when it is a Stealth Health sale.
  // Fetched separately: the invoice itself is read under the caller's RLS, but
  // the hand-off ledger (buyer phone, ship-to address) is service-role only.
  const [puramass, setPuramass] = useState<PuramassInvoiceContext | null>(null);
  const [puramassLoading, setPuramassLoading] = useState(false);

  // Send email modal
  const [showEmail, setShowEmail] = useState(false);
  const [emailTo, setEmailTo] = useState('');
  const [emailSending, setEmailSending] = useState(false);

  // Delete confirmation
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await getInvoice(id);
    setData(result);
    if (result) setNewStatus(result.invoice.status);
    setLoading(false);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Only Stealth Health invoices have a hand-off to fetch; everything else skips the
  // round-trip entirely.
  useEffect(() => {
    let cancelled = false;
    if (!data || !isPuramassInvoice(data.invoice)) {
      setPuramass(null);
      return;
    }
    setPuramassLoading(true);
    getInvoicePuramass(id)
      .then((ctx) => { if (!cancelled) setPuramass(ctx); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setPuramassLoading(false); });
    return () => { cancelled = true; };
  }, [data, id]);

  // Load the cached tracking snapshot on mount (no live Easyship hit).
  useEffect(() => {
    let cancelled = false;
    getInvoiceTracking(id)
      .then((snap) => { if (!cancelled) setTracking(snap); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [id]);

  // Then auto-pull the live journey once per invoice when a shipment exists, so
  // the tracking timeline + map populate without the admin clicking "Refresh".
  // Guarded by a ref (reset per invoice) so it fires exactly once and can't loop
  // off its own setTracking. Checkpoints only arrive on a live refresh, so their
  // absence is the "not yet pulled" signal.
  const autoRefreshedRef = useRef(false);
  useEffect(() => { autoRefreshedRef.current = false; }, [id]);
  useEffect(() => {
    if (autoRefreshedRef.current) return;
    if (!tracking?.hasShipment) return;
    if (tracking.tracking?.checkpoints) return;
    autoRefreshedRef.current = true;
    getInvoiceTracking(id, { refresh: true })
      .then((snap) => setTracking(snap))
      .catch(() => {});
  }, [tracking, id]);

  // After any order-side mutation in the OrderManagementPanel, refresh the
  // invoice header and re-pull the cached tracking snapshot (no live Easyship
  // hit) so the "Order & Shipping" summary reflects the change.
  const handleOrderChange = useCallback(() => {
    load();
    getInvoiceTracking(id).then(setTracking).catch(() => {});
  }, [load, id]);

  async function refreshTracking() {
    setRefreshingTracking(true);
    try {
      const snap = await getInvoiceTracking(id, { refresh: true });
      setTracking(snap);
      if (snap.tracking?.refresh_error) {
        flash(snap.tracking.refresh_error);
      } else {
        flash('Tracking refreshed');
      }
    } catch (e: any) {
      flash(e?.message ?? 'Refresh failed');
    } finally {
      setRefreshingTracking(false);
    }
  }

  async function handleSendEmail() {
    setEmailSending(true);
    const result = await emailInvoice(id, emailTo ? { to: emailTo } : undefined);
    setEmailSending(false);
    if (result.success) {
      setShowEmail(false);
      setEmailTo('');
      await load();
      flash('Invoice email sent');
    } else {
      flash(result.error ?? 'Failed to send invoice email');
    }
  }

  async function handleDelete() {
    if (!window.confirm(
      'Delete this invoice? Line items, payments and email history will be removed. The linked order is left intact. This cannot be undone.',
    )) return;
    setDeleting(true);
    const result = await deleteInvoice(id);
    setDeleting(false);
    if (result.success) {
      router.push('/admin/invoices');
    } else {
      flash(result.error ?? 'Delete failed');
    }
  }

  async function handleRecordPayment() {
    const amount = parseFloat(payAmount);
    if (!amount || amount <= 0) return;
    setPaying(true);
    const result = await recordPayment(id, amount, payMethod, payRef || undefined);
    setPaying(false);
    if (result.success) {
      setShowPayment(false);
      setPayAmount('');
      setPayRef('');
      await load();
      flash('Payment recorded');
    } else {
      flash(result.error ?? 'Failed to record payment');
    }
  }

  async function handleStatusChange() {
    const result = await updateInvoice(id, { status: newStatus });
    setEditingStatus(false);
    if (result.success) {
      await load();
      flash('Status updated');
    } else {
      flash(result.error ?? 'Failed to update status');
    }
  }

  function flash(text: string) {
    setMsg(text);
    setTimeout(() => setMsg(''), 3000);
  }

  async function openPdf(autoPrint: boolean) {
    const { data: { session } } = await supabase.auth.getSession();
    const qs = autoPrint ? '?download=1' : '';
    const res = await fetch(`/api/admin/invoices/${id}/pdf${qs}`, {
      headers: session?.access_token
        ? { Authorization: `Bearer ${session.access_token}` }
        : {},
    });
    if (!res.ok) { flash('Could not load PDF'); return; }
    const html = await res.text();
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  if (loading) {
    return <div className="flex justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-ink-muted" /></div>;
  }

  if (!data) {
    return (
      <div className="text-center py-20">
        <p className="text-ink-muted mb-4">Invoice not found</p>
        <Link href="/admin/invoices" className="text-teal-dark hover:text-teal-dark/80 text-sm">Back to Invoices</Link>
      </div>
    );
  }

  const { invoice, line_items, payments, amount_paid, amount_due } = data;
  const cur = normalizeCurrency(invoice.currency);
  const money = (n: number) => formatMoney(n, cur);
  // A Stealth Health hand-off can carry two currencies at once: the goods as Stealth Health
  // charged them, and our shipment fee, which is USD and is what `cur` actually
  // describes. When the two differ, anything on the goods side has to be
  // formatted in Stealth Health's currency instead — otherwise a CAD sale reads as a
  // USD one. Null for every ordinary invoice, where `cur` covers everything.
  const split = puramassMoneySplit(invoice, puramass);
  const goodsCur: Currency = split?.goodsCurrency ?? cur;
  const goodsMoney = (n: number) => formatMoney(n, goodsCur);

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Link href="/admin/invoices" className="text-ink-muted hover:text-ink transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold font-mono text-ink">{invoice.invoice_number}</h1>
              <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-teal/10 text-teal-dark border border-teal/20">
                {cur}
              </span>
              {/* Where this invoice came from: a Stealth Health hand-off, or raised here. */}
              <InvoiceSourceBadge source={invoice.source} />
            </div>
            <p className="text-xs text-ink-muted">
              Created {new Date(invoice.created_at).toLocaleDateString()}
              {puramass && ' · Payment collected by Stealth Health'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => openPdf(false)}
            className="px-3 py-2 bg-white border border-line rounded-lg text-sm text-ink-muted hover:text-ink transition-colors flex items-center gap-2"
            title="View invoice as PDF"
          >
            <Eye className="w-4 h-4" /> View PDF
          </button>
          <button
            onClick={() => openPdf(true)}
            className="px-3 py-2 bg-white border border-line rounded-lg text-sm text-ink-muted hover:text-ink transition-colors flex items-center gap-2"
            title="Open print dialog — choose 'Save as PDF' to download"
          >
            <Download className="w-4 h-4" /> Download PDF
          </button>
          {editable && (
            <Link
              href={`/admin/invoices/${id}/edit`}
              className="px-3 py-2 bg-white border border-line rounded-lg text-sm text-ink-muted hover:text-ink transition-colors flex items-center gap-2"
              title="Edit invoice details, line items, customer, sales person"
            >
              <Pencil className="w-4 h-4" /> Edit
            </Link>
          )}
          {editable && (
            <button
              onClick={() => {
                setEmailTo(invoice.customer_email ?? '');
                setShowEmail(true);
              }}
              className="px-3 py-2 bg-teal-dark text-white rounded-lg text-sm font-medium hover:bg-teal/90 transition-colors flex items-center gap-2"
              title="Email the invoice PDF to the customer"
            >
              <Send className="w-4 h-4" /> Send Email
            </button>
          )}
          {editable && invoice.status !== 'paid' && (
            <button
              onClick={() => setShowPayment(true)}
              className="px-3 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 transition-colors flex items-center gap-2"
            >
              <DollarSign className="w-4 h-4" /> Record Payment
            </button>
          )}
        </div>
      </div>

      {msg && (
        <div className="mb-4 px-4 py-2 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-700">{msg}</div>
      )}

      {/* At-a-glance summary — 4 cells, joined by a hairline (gap-px on line bg).
          Status / Amount Due / Customer / Shipping. Status has an inline edit
          affordance and Amount Due offers Record Payment when unpaid. */}
      <div className="mb-6 grid grid-cols-2 lg:grid-cols-4 gap-px bg-line rounded-xl overflow-hidden border border-line">
        {/* Status cell */}
        <div className="bg-white p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">Status</span>
            {editable && !editingStatus && (
              <button onClick={() => setEditingStatus(true)} className="text-ink-muted hover:text-ink" title="Change status">
                <Edit2 className="w-3 h-3" />
              </button>
            )}
          </div>
          {editingStatus ? (
            <div className="flex gap-1">
              <select
                value={newStatus}
                onChange={(e) => setNewStatus(e.target.value as InvoiceStatus)}
                className="flex-1 px-2 py-1 bg-surface border border-line rounded text-xs focus:outline-none focus:ring-2 focus:ring-teal/40"
              >
                {(['draft', 'sent', 'paid', 'partial', 'overdue', 'cancelled'] as InvoiceStatus[]).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <button onClick={handleStatusChange} className="px-2 bg-ink text-white rounded text-xs" title="Apply">
                <Check className="w-3 h-3" />
              </button>
              <button onClick={() => setEditingStatus(false)} className="px-2 border border-line rounded text-xs text-ink-muted" title="Cancel">
                <X className="w-3 h-3" />
              </button>
            </div>
          ) : (
            <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium border ${statusColors[invoice.status] ?? statusColors.draft}`}>
              {invoice.status}
            </span>
          )}
          {(newStatus === 'paid' && invoice.status !== 'paid') && (
            <p className="mt-2 text-[10px] text-amber-600">Marking paid will decrement stock.</p>
          )}
          {(newStatus === 'cancelled' && invoice.status !== 'cancelled' && (invoice as any).stock_adjusted) && (
            <p className="mt-2 text-[10px] text-emerald-600">Cancelling will restore stock.</p>
          )}
        </div>

        {/* Amount Due cell */}
        <div className="bg-white p-4">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted mb-2">
            {invoice.status === 'paid' ? 'Paid in full' : 'Amount Due'}
          </div>
          {invoice.status === 'paid' ? (
            <div className="flex items-center gap-1.5 text-emerald-600">
              <Check className="w-4 h-4" />
              <InvoiceTotalAmount
                invoice={invoice}
                puramass={puramass}
                align="left"
                className="text-lg font-bold"
              />
            </div>
          ) : (
            <div>
              <div className="text-lg font-bold text-teal-dark tabular-nums">{money(amount_due)}</div>
              <div className="text-[11px] text-ink-muted tabular-nums">
                of {money(Number(invoice.total))}
                {amount_paid > 0 && <> · {money(amount_paid)} paid</>}
              </div>
              {editable && (
                <button
                  onClick={() => setShowPayment(true)}
                  className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-emerald-700 hover:text-emerald-800"
                >
                  <DollarSign className="w-3 h-3" /> Record Payment
                </button>
              )}
            </div>
          )}
        </div>

        {/* Customer cell */}
        <div className="bg-white p-4">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted mb-2">Customer</div>
          {(invoice.customer_name ?? puramass?.customer_name) ? (
            <div>
              <div className="text-sm font-medium text-ink truncate">
                {invoice.customer_name ?? puramass?.customer_name}
              </div>
              {(invoice.customer_email ?? puramass?.customer_email) && (
                <div className="text-[11px] text-ink-muted truncate">
                  {invoice.customer_email ?? puramass?.customer_email}
                </div>
              )}
              {(invoice.customer_phone ?? puramass?.customer_phone) && (
                <div className="text-[11px] text-ink-muted truncate">
                  {invoice.customer_phone ?? puramass?.customer_phone}
                </div>
              )}
              {puramass && (
                <div className="mt-1 text-[10px] uppercase tracking-wider text-teal-dark">
                  Captured by Stealth Health
                </div>
              )}
            </div>
          ) : (
            <div className="text-sm text-ink-muted">Guest / offline</div>
          )}
        </div>

        {/* Shipping cell */}
        <div className="bg-white p-4">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted mb-2">Shipping</div>
          {(() => {
            const ft = (invoice as any).fulfillment_type ?? 'shipment';
            if (ft === 'pickup') {
              return (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800">
                  <Store className="w-3 h-3" /> Pickup
                </span>
              );
            }
            // A Stealth Health sale has no local order — it is shipped off the
            // invoice itself — so "no linked order" would read as a fault.
            // Show where it is going until a shipment exists to report on.
            if (puramass && !tracking?.hasShipment) {
              return <PuramassShipTo puramass={puramass} compact />;
            }
            if (!tracking?.hasShipment) {
              return (
                <div className="text-sm text-ink-muted">
                  {tracking?.hasOrder ? 'Not shipped yet' : 'No shipment yet'}
                </div>
              );
            }
            return (
              <div>
                {tracking.tracking?.status && (
                  <div className="text-sm font-medium text-ink truncate">{tracking.tracking.status}</div>
                )}
                {tracking.tracking?.number && (
                  <div className="text-[11px] font-mono text-ink-muted truncate">
                    {tracking.tracking.number}
                  </div>
                )}
                {tracking.tracking?.url && (
                  <a
                    href={tracking.tracking.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] text-teal-dark hover:text-teal-dark/80"
                  >
                    Track shipment →
                  </a>
                )}
              </div>
            );
          })()}
        </div>
      </div>

      {/* Live shipment tracking — stage bar + Easyship checkpoint journey.
          Sits directly under the shipping summary; only shown once a shipment
          exists on the linked order. */}
      <LiveShipmentTracking
        tracking={tracking}
        refreshing={refreshingTracking}
        onRefresh={refreshTracking}
        editable={editable}
      />

      {/* `items-start` lets the left column stick: a stretched grid item can't.
          The details rail on the right runs much longer than the line items, so
          without this the main area is blank white for most of the scroll. */}
      <div className="grid lg:grid-cols-3 gap-6 items-start">
        {/* Left: Line Items + Payments — pinned while the rail scrolls past.
            Capped to the viewport with its own scroll so a long invoice can
            still be read to the end (a taller-than-screen sticky element would
            pin its top and put its bottom permanently out of reach). */}
        <div className="lg:col-span-2 space-y-6 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto">
          {/* Line Items */}
          <div className="bg-white rounded-xl border border-line overflow-hidden">
            <div className="flex items-center gap-2 p-5 border-b border-line">
              <FileText className="w-4 h-4 text-ink-muted" />
              <h2 className="font-semibold text-ink text-sm">Line Items</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface">
                    <th className="px-4 py-2.5 text-left text-xs text-ink-muted font-semibold uppercase">Description</th>
                    <th className="px-4 py-2.5 text-center text-xs text-ink-muted font-semibold uppercase">Qty</th>
                    <th className="px-4 py-2.5 text-right text-xs text-ink-muted font-semibold uppercase">Unit Price</th>
                    <th className="px-4 py-2.5 text-center text-xs text-ink-muted font-semibold uppercase">Disc.</th>
                    <th className="px-4 py-2.5 text-right text-xs text-ink-muted font-semibold uppercase">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/50">
                  {line_items.map((li) => {
                    const pt = (li as any).price_type === 'vial' ? 'vial' : 'box';
                    // Stealth Health lines were materialised from the partner's own
                    // item list — show the SKU it charged against, so a line can
                    // be traced back to Stealth Health without leaving this page.
                    const pmSku = puramass?.items.find(
                      (it) => it.name && it.name.toLowerCase() === (li.description ?? '').toLowerCase(),
                    )?.sku;
                    return (
                      <tr key={li.id}>
                        <td className="px-4 py-3 text-ink">
                          <span>{li.description}</span>
                          <span
                            className={`ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide align-middle ${
                              pt === 'vial'
                                ? 'bg-teal/10 text-teal-dark'
                                : 'bg-slate-100 text-slate-600'
                            }`}
                          >
                            {pt === 'vial' ? <Beaker className="w-3 h-3" /> : <Package className="w-3 h-3" />}
                            {pt === 'vial' ? 'Vial' : 'Box'}
                          </span>
                          {pmSku && (
                            <div className="mt-0.5 font-mono text-[10px] text-ink-light" title="Stealth Health SKU">
                              {pmSku}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center tabular-nums text-ink-muted">{li.qty}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-ink-muted">{goodsMoney(Number(li.unit_price))}</td>
                        <td className="px-4 py-3 text-center text-ink-muted">
                          {li.discount_pct > 0 ? `${li.discount_pct}%` : '—'}
                        </td>
                        <td className="px-4 py-3 text-right font-medium tabular-nums text-ink">{goodsMoney(Number(li.line_total))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="p-5 border-t border-line space-y-2">
              {(() => {
                const ft = (invoice as any).fulfillment_type ?? 'shipment';
                const showFee = ft === 'pickup' && (invoice as any).show_processing_fee !== false && Number((invoice as any).processing_fee ?? 0) > 0;
                // Goods sit in Stealth Health's currency on a split invoice; the
                // shipment fee and anything we add here sit in ours.
                const rows: Array<{ label: string; value: number; currency: Currency }> = [
                  {
                    label: 'Subtotal',
                    value: split ? split.goods : Number(invoice.subtotal) || 0,
                    currency: goodsCur,
                  },
                  { label: 'Tax', value: Number(invoice.tax_total) || 0, currency: goodsCur },
                ];
                if (ft === 'shipment') rows.push({ label: 'Shipping', value: Number(invoice.shipping_cost) || 0, currency: cur });
                if (showFee) rows.push({ label: 'Processing Fee', value: Number((invoice as any).processing_fee) || 0, currency: cur });
                return rows.map(({ label, value, currency }) => (
                  <div key={label} className="flex justify-between text-sm">
                    <span className="text-ink-muted">{label}</span>
                    <span className="tabular-nums text-ink">
                      {formatMoney(value, currency)}
                      {split && (
                        <span className="ml-1 text-[10px] font-medium text-ink-muted">{currency}</span>
                      )}
                    </span>
                  </div>
                ));
              })()}
              <div className="flex justify-between font-bold text-base pt-2 border-t border-line">
                <span>Total</span>
                <InvoiceTotalAmount invoice={invoice} puramass={puramass} />
              </div>
              {amount_paid > 0 && (
                <>
                  <div className="flex justify-between text-sm text-emerald-600">
                    <span>Paid</span>
                    <span className="tabular-nums">– {money(amount_paid)}</span>
                  </div>
                  <div className="flex justify-between font-bold text-teal-dark">
                    <span>Amount Due</span>
                    <span className="tabular-nums">{money(amount_due)}</span>
                  </div>
                </>
              )}
              {/* Refunds happen on the Stealth Health side, so they never reduce the
                  invoice total — show them against it instead of hiding them. */}
              {(puramass?.refunded_total_cents ?? 0) > 0 && (
                <>
                  <div className="flex justify-between text-sm text-amber-700">
                    <span>Refunded by Stealth Health</span>
                    <span className="tabular-nums">– {goodsMoney(puramass!.refunded_total_cents / 100)}</span>
                  </div>
                  <div className="flex justify-between font-bold text-ink">
                    <span>Net of refunds</span>
                    {/* Stealth Health refunds the goods, so on a split invoice they
                        come off the goods half only — the shipping fee we
                        charged is untouched and still shown beside it. */}
                    <InvoiceTotalAmount
                      invoice={{
                        ...invoice,
                        total: Number(invoice.total) - puramass!.refunded_total_cents / 100,
                        subtotal: Number(invoice.subtotal) - puramass!.refunded_total_cents / 100,
                      }}
                      puramass={{
                        ...puramass!,
                        subtotal_cents:
                          puramass!.subtotal_cents == null
                            ? null
                            : puramass!.subtotal_cents - puramass!.refunded_total_cents,
                      }}
                      className="font-bold text-ink"
                    />
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Payments */}
          {payments.length > 0 && (
            <div className="bg-white rounded-xl border border-line overflow-hidden">
              <div className="flex items-center gap-2 p-5 border-b border-line">
                <CreditCard className="w-4 h-4 text-ink-muted" />
                <h2 className="font-semibold text-ink text-sm">Payment History</h2>
              </div>
              <div className="divide-y divide-line/50">
                {payments.map((p) => (
                  <div key={p.id} className="px-5 py-4 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-ink capitalize">{p.method.replace('-', ' ')}</p>
                      {p.reference_note && (
                        <p className="text-xs text-ink-muted">{p.reference_note}</p>
                      )}
                      <p className="text-xs text-ink-muted">{new Date(p.paid_at).toLocaleString()}</p>
                    </div>
                    <span className="font-bold tabular-nums text-emerald-600">
                      {money(Number(p.amount))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right: Details */}
        <div className="space-y-4">
          {/* Status */}
          <div className="bg-white rounded-xl border border-line p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold text-ink text-sm">Status</h2>
              {editable && !editingStatus && (
                <button onClick={() => setEditingStatus(true)} className="text-xs text-ink-muted hover:text-ink">
                  <Edit2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            {editingStatus ? (
              <div className="flex gap-2">
                <select
                  value={newStatus}
                  onChange={(e) => setNewStatus(e.target.value as InvoiceStatus)}
                  className="flex-1 px-3 py-2 bg-surface border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                >
                  {(['draft', 'sent', 'paid', 'partial', 'overdue'] as InvoiceStatus[]).map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <button onClick={handleStatusChange} className="px-3 py-2 bg-ink text-white rounded-lg text-sm">
                  <Check className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => setEditingStatus(false)} className="px-3 py-2 border border-line rounded-lg text-sm text-ink-muted">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <span className={`inline-flex px-3 py-1 rounded-lg text-sm font-medium border ${statusColors[invoice.status]}`}>
                {invoice.status}
              </span>
            )}
          </div>

          {/* Customer */}
          <div className="bg-white rounded-xl border border-line p-5">
            <h2 className="font-semibold text-ink mb-3 text-sm">Customer</h2>
            {(invoice.customer_name ?? puramass?.customer_name) ? (
              <div className="space-y-1 text-sm">
                <p className="font-medium text-ink">{invoice.customer_name ?? puramass?.customer_name}</p>
                {(invoice.customer_email ?? puramass?.customer_email) && (
                  <p className="text-ink-muted">{invoice.customer_email ?? puramass?.customer_email}</p>
                )}
                {(invoice.customer_phone ?? puramass?.customer_phone) && (
                  <p className="text-ink-muted">{invoice.customer_phone ?? puramass?.customer_phone}</p>
                )}
                {puramass && (
                  <p className="pt-2 text-[11px] text-ink-muted">
                    Entered by the buyer on the Stealth Health checkout page — not editable here.
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-ink-muted">Guest / Offline customer</p>
            )}
          </div>

          {/* Stealth Health hand-off — the partner's own record of this sale, and the
              ship-to it captured. Read-only here: Stealth Health Orders is where it
              gets re-synced or the customer gets asked for a missing address. */}
          {puramass && <PuramassShipToPanel puramass={puramass} />}
          {puramass && <PuramassOrderPanel puramass={puramass} />}

          {/* Paid-order emails for a Stealth Health hand-off or a manual
              invoice: the customer's confirmation and the team's "order paid"
              notification. Stealth Health sends both on payment; a manual
              invoice only ever sends them from these buttons. An invoice with
              an order shows the confirmation in the order panel instead. */}
          {!invoice.order_id && (
            <>
              <OrderConfirmationEmailCard
                key={`confirmation-${invoice.status}`}
                target={{ invoiceId: invoice.id }}
                canSend={editable}
              />
              <AdminPaidAlertEmailCard
                key={`admin-alert-${invoice.status}`}
                invoiceId={invoice.id}
                canSend={editable}
              />
            </>
          )}

          {/* Easyship — set up, follow and print the shipment for this
              invoice without leaving the page. Anchored on the invoice's order
              when it has one, on the invoice itself when it doesn't. */}
          <InvoiceEasyshipPanel
            invoiceId={id}
            tracking={tracking}
            items={line_items.map((li) => ({ qty: Number(li.qty) || 0 }))}
            fulfillmentType={(invoice as any).fulfillment_type ?? 'shipment'}
            editable={editable}
            refreshing={refreshingTracking}
            onRefresh={refreshTracking}
            onChanged={async () => {
              const snap = await getInvoiceTracking(id);
              setTracking(snap);
            }}
            flash={flash}
          />

          {/* Sales Person */}
          {invoice.sales_person_name && (
            <div className="bg-white rounded-xl border border-line p-5">
              <h2 className="font-semibold text-ink mb-3 text-sm flex items-center gap-2">
                <Briefcase className="w-4 h-4 text-purple-600" /> Sales Person
              </h2>
              <div className="space-y-1 text-sm">
                <p className="font-medium text-ink">{invoice.sales_person_name}</p>
                {invoice.sales_person_email && (
                  <p className="text-ink-muted">{invoice.sales_person_email}</p>
                )}
                <div className="flex justify-between mt-3 pt-3 border-t border-line/60">
                  <span className="text-xs text-ink-muted">Commission</span>
                  <span className="text-sm font-semibold tabular-nums text-purple-700">
                    {money(Number(invoice.sales_person_commission_amount ?? 0))}
                    {' '}<span className="text-xs text-ink-muted">({invoice.sales_person_commission_rate}%)</span>
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Dates */}
          <div className="bg-white rounded-xl border border-line p-5 space-y-3">
            <div>
              <p className="text-xs text-ink-muted mb-1">Source</p>
              <p className="text-sm text-ink">
                {isPuramassInvoice(invoice) ? 'Stealth Health hosted checkout' : 'Created in this admin'}
              </p>
              {isPuramassInvoice(invoice) && !puramass && !puramassLoading && (
                <p className="mt-1 text-[11px] text-amber-600">
                  No matching Stealth Health hand-off found — the ledger row may have
                  been removed. Check Stealth Health Orders.
                </p>
              )}
            </div>
            <div>
              <p className="text-xs text-ink-muted mb-1">Issue Date</p>
              <p className="text-sm text-ink">{formatAppDate(invoice.issue_date, {})}</p>
            </div>
            <div>
              <p className="text-xs text-ink-muted mb-1">Due Date</p>
              <p className={`text-sm font-medium ${
                invoice.status === 'overdue' ? 'text-red-500' : 'text-ink'
              }`}>
                {formatAppDate(invoice.due_date, {})}
              </p>
            </div>
          </div>

          {/* Notes */}
          {invoice.notes && (
            <div className="bg-white rounded-xl border border-line p-5">
              <h2 className="font-semibold text-ink mb-2 text-sm">Notes</h2>
              <p className="text-sm text-ink-muted whitespace-pre-wrap">{invoice.notes}</p>
            </div>
          )}

          {/* Delete invoice — admin-only, single-invoice DELETE leaves the
              linked order intact. */}
          {deletable && (
            <div className="bg-white rounded-xl border border-red-200 p-5">
              <h2 className="font-semibold text-red-700 mb-2 text-sm">Danger zone</h2>
              <p className="text-xs text-ink-muted mb-3">
                Delete this invoice permanently. The linked order is untouched.
              </p>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-white border border-red-200 text-red-700 rounded-lg text-sm font-medium hover:bg-red-50 disabled:opacity-50 transition-colors"
              >
                {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                Delete invoice
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Merged order surface — everything the standalone /admin/orders detail
          page offered (payment, commission, shipment/label, order status,
          order emails, refund), shown for any invoice with a linked order. */}
      {invoice.order_id && (
        <OrderManagementPanel
          orderId={invoice.order_id}
          editable={editable}
          onOrderChange={handleOrderChange}
        />
      )}

      {/* Send Email Modal */}
      {showEmail && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl w-full max-w-md p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-ink flex items-center gap-2">
                <Send className="w-4 h-4 text-teal-dark" /> Send invoice email
              </h3>
              <button onClick={() => setShowEmail(false)}>
                <X className="w-4 h-4 text-ink-muted" />
              </button>
            </div>
            <p className="text-sm text-ink-muted mb-4">
              We&apos;ll email the PDF as an attachment. BCCs from Site Settings are
              added automatically.
            </p>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1">Send to</label>
                <input
                  type="email"
                  value={emailTo}
                  onChange={(e) => setEmailTo(e.target.value)}
                  placeholder={invoice.customer_email ?? 'customer@example.com'}
                  className="w-full px-3 py-2.5 bg-surface border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                />
                <p className="mt-1 text-[11px] text-ink-muted">
                  Leaving this blank sends to the invoice&apos;s customer email.
                </p>
              </div>
            </div>
            <div className="flex gap-3 mt-5">
              <button
                onClick={() => setShowEmail(false)}
                className="flex-1 px-4 py-2 border border-line rounded-lg text-sm text-ink-muted hover:text-ink"
              >
                Cancel
              </button>
              <button
                onClick={handleSendEmail}
                disabled={emailSending}
                className="flex-1 px-4 py-2 bg-teal-dark text-white rounded-lg text-sm font-medium hover:bg-teal/90 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {emailSending && <Loader2 className="w-4 h-4 animate-spin" />}
                Send
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Payment Modal */}
      {showPayment && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl w-full max-w-sm p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-ink">Record Payment</h3>
              <button onClick={() => setShowPayment(false)}>
                <X className="w-4 h-4 text-ink-muted" />
              </button>
            </div>
            <p className="text-sm text-ink-muted mb-4">
              Outstanding: {money(amount_due)} <span className="text-xs">{cur}</span>
            </p>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1">Amount ({cur})</label>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  placeholder={amount_due.toFixed(2)}
                  className="w-full px-3 py-2.5 bg-surface border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1">Method</label>
                <select
                  value={payMethod}
                  onChange={(e) => setPayMethod(e.target.value as PaymentMethod)}
                  className="w-full px-3 py-2.5 bg-surface border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                >
                  <option value="card">Card</option>
                  <option value="cash">Cash</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1">Reference (optional)</label>
                <input
                  type="text"
                  value={payRef}
                  onChange={(e) => setPayRef(e.target.value)}
                  placeholder="Transaction ID, cheque #..."
                  className="w-full px-3 py-2.5 bg-surface border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                />
              </div>
            </div>
            <div className="flex gap-3 mt-5">
              <button
                onClick={() => setShowPayment(false)}
                className="flex-1 px-4 py-2 border border-line rounded-lg text-sm text-ink-muted hover:text-ink"
              >
                Cancel
              </button>
              <button
                onClick={handleRecordPayment}
                disabled={paying || !payAmount}
                className="flex-1 px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
              >
                {paying ? 'Saving...' : 'Record'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
