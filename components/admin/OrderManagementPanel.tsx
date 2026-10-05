'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Package, CreditCard, Tag, Truck, Copy, Check, Save, Mail,
  Printer, PackagePlus, ExternalLink, Loader2, X, Send,
  MapPin, RotateCcw, AlertTriangle,
} from 'lucide-react';
import {
  getOrderDetail,
  updateOrderStatus,
  updateOrderTracking,
  createOrderShipment,
  buyOrderLabel,
  fetchLabelBlob,
  getOrderRates,
  type OrderRateOption,
} from '@/lib/admin/api';
import { processRefund } from '@/lib/admin/orders-extended';
import { apiFetch } from '@/lib/api-fetch';
import { printPdfBlob } from '@/lib/print-pdf';
import OrderConfirmationEmailCard from '@/components/admin/OrderConfirmationEmailCard';

// Order lifecycle status → badge styling. Mirrors the standalone orders detail
// page so the merged surface reads identically.
const statusColors: Record<string, string> = {
  pending: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
  received: 'bg-cyan-500/10 text-cyan-600 border-cyan-500/20',
  confirmed: 'bg-blue-500/10 text-blue-600 border-blue-500/20',
  processing: 'bg-purple-500/10 text-purple-600 border-purple-500/20',
  shipped: 'bg-indigo-500/10 text-indigo-600 border-indigo-500/20',
  delivered: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  completed: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  cancelled: 'bg-red-500/10 text-red-600 border-red-500/20',
  refunded: 'bg-red-500/10 text-red-600 border-red-500/20',
};

// Easyship label lifecycle badge. Mirrors EasyshipLabelInfo['state'].
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

const statusSteps = ['pending', 'received', 'confirmed', 'processing', 'shipped', 'delivered'];

// Statuses from which the order's refund endpoint will accept a refund.
const REFUNDABLE = ['confirmed', 'processing', 'packed', 'shipped', 'delivered', 'completed'];

interface Props {
  orderId: string;
  /** When false (read-only roles), interactive controls are hidden. */
  editable: boolean;
  /** Fired after any mutation so the parent invoice page can refresh. */
  onOrderChange?: () => void;
}

/**
 * The full order-management surface, mounted on the invoice detail page for any
 * invoice with a linked order. It ports every capability the standalone
 * /admin/orders/[id] page had — crypto/e-Transfer payment details, affiliate
 * commission, order-status lifecycle + progress, Easyship shipment/label
 * actions, manual tracking, order emails — and adds a Refund action.
 */
export default function OrderManagementPanel({ orderId, editable, onOrderChange }: Props) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [trackingInput, setTrackingInput] = useState('');
  const [savingTracking, setSavingTracking] = useState(false);
  const [copied, setCopied] = useState('');
  const [emailSending, setEmailSending] = useState(false);
  const [emailSent, setEmailSent] = useState('');


  const [shipBusy, setShipBusy] = useState(false);
  const [shipMsg, setShipMsg] = useState<string | null>(null);
  const [rates, setRates] = useState<OrderRateOption[]>([]);
  const [ratesLoading, setRatesLoading] = useState(false);
  const [courierId, setCourierId] = useState('');

  // Refund modal state.
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundReason, setRefundReason] = useState('');
  const [fullRefund, setFullRefund] = useState(true);
  const [refundLines, setRefundLines] = useState<
    Record<string, { selected: boolean; qty: number; max: number; name: string }>
  >({});
  const [refunding, setRefunding] = useState(false);
  const [refundMsg, setRefundMsg] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const result = await getOrderDetail(orderId);
    setData(result);
    setTrackingInput(result?.order?.tracking_number || '');
    return result;
  }, [orderId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getOrderDetail(orderId).then((result) => {
      if (cancelled) return;
      setData(result);
      setTrackingInput(result?.order?.tracking_number || '');
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [orderId]);

  // Load live courier options BEFORE a shipment exists, so the admin chooses
  // the courier first and it's baked into the shipment at creation.
  useEffect(() => {
    const o = data?.order;
    if (!editable || !o || o.easyship_shipment_id || o.fulfillment_type === 'pickup') return;
    let cancelled = false;
    setRatesLoading(true);
    getOrderRates(o.id)
      .then((r) => {
        if (cancelled) return;
        setRates(r);
        setCourierId((prev) => prev || o.easyship_courier_id || r[0]?.courier_id || '');
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setRatesLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.order?.id, data?.order?.easyship_shipment_id, editable]);

  const notify = () => onOrderChange?.();

  const handleStatusChange = async (status: string) => {
    if (!data) return;
    setUpdating(true);
    await updateOrderStatus(data.order.id, status as any);
    await reload();
    setUpdating(false);
    notify();
  };

  const handleSaveTracking = async () => {
    if (!data) return;
    setSavingTracking(true);
    await updateOrderTracking(data.order.id, trackingInput);
    await reload();
    setSavingTracking(false);
    notify();
  };

  // Manually create (or retry) the Easyship shipment record for this order.
  const handleCreateShipment = async () => {
    if (!data) return;
    setShipBusy(true);
    setShipMsg(null);
    try {
      const res = await createOrderShipment(data.order.id, courierId || undefined);
      await reload();
      notify();
      if (!res.easyship_shipment_id) {
        setShipMsg(res.auto_shipment_error || 'Shipment was not created — check Easyship settings (enabled, API key, origin address).');
      }
    } catch (e: any) {
      setShipMsg(e?.message || 'Failed to create shipment');
    } finally {
      setShipBusy(false);
    }
  };

  // Print an already-purchased label (no new tab).
  const handlePrintLabel = async () => {
    if (!data) return;
    setShipBusy(true);
    setShipMsg(null);
    try {
      const blob = await fetchLabelBlob(data.order.id);
      printPdfBlob(blob);
    } catch (e: any) {
      setShipMsg(e?.message || 'Failed to load label');
    } finally {
      setShipBusy(false);
    }
  };

  // Buy the label, then immediately print it (no new tab).
  const handleBuyAndPrint = async () => {
    if (!data) return;
    setShipBusy(true);
    setShipMsg(null);
    try {
      const label = await buyOrderLabel(data.order.id);
      await reload();
      notify();
      if (label.state === 'generated' && label.url) {
        const blob = await fetchLabelBlob(data.order.id);
        printPdfBlob(blob);
      } else {
        setShipMsg('Label is being generated by the courier — it will appear here shortly; click Print Label once ready.');
      }
    } catch (e: any) {
      setShipMsg(e?.message || 'Failed to buy label');
    } finally {
      setShipBusy(false);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  };

  const sendShippingEmail = async () => {
    if (!data || !data.order.customer_email) return;
    const order = data.order;
    setEmailSending(true);
    try {
      await apiFetch('/api/email', {
        method: 'POST',
        body: JSON.stringify({
          type: 'shipping_notification',
          to: order.customer_email,
          customerName: order.customer_name || 'Customer',
          orderNumber: order.order_number,
          trackingNumber: trackingInput || order.tracking_number || 'Pending',
        }),
      });
      setEmailSent('shipping');
      setTimeout(() => setEmailSent(''), 3000);
    } catch (err) {
      console.error('Failed to send email:', err);
    }
    setEmailSending(false);
  };

  // ---- Refund ----
  const openRefund = () => {
    const restockable = (data?.items || []).filter((i: any) => i.product_variant_id && !i.restocked);
    const init: Record<string, { selected: boolean; qty: number; max: number; name: string }> = {};
    restockable.forEach((i: any) => {
      const max = Number(i.qty ?? i.quantity ?? 1);
      init[i.id] = {
        selected: true,
        qty: max,
        max,
        name: i.name_snapshot || i.product_name || 'Item',
      };
    });
    setRefundLines(init);
    setFullRefund(true);
    setRefundReason('');
    setRefundMsg(null);
    setRefundOpen(true);
  };

  const submitRefund = async () => {
    if (!data) return;
    setRefunding(true);
    setRefundMsg(null);
    const line_items = fullRefund
      ? []
      : Object.entries(refundLines)
          .filter(([, v]) => v.selected)
          .map(([order_item_id, v]) => ({ order_item_id, qty: v.qty, restock: true }));
    const res = await processRefund({
      order_id: data.order.id,
      full_refund: fullRefund,
      line_items,
      reason: refundReason,
    });
    setRefunding(false);
    if (res.success) {
      setRefundOpen(false);
      await reload();
      notify();
    } else {
      setRefundMsg(res.error || 'Refund failed');
    }
  };

  if (loading) {
    return (
      <section className="mt-8 flex items-center justify-center gap-2 rounded-xl border border-line bg-white py-10 text-sm text-ink-muted">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading order…
      </section>
    );
  }

  // No order data (deleted / inaccessible) — render nothing.
  if (!data?.order) return null;

  const { order, items, commission } = data;
  const currentStepIndex = statusSteps.indexOf(order.status);

  // Payment method is driven by the order's source, not `crypto` (e-Transfer
  // orders never set a crypto coin). Amounts for e-Transfer are in CAD.
  const isEtransfer = typeof order.source === 'string' && order.source.startsWith('e-transfer');
  const paymentMethodLabel = isEtransfer
    ? 'e-Transfer'
    : order.crypto && order.crypto !== 'other'
      ? order.crypto.toUpperCase()
      : 'Crypto';
  const amountUnit = isEtransfer ? 'CAD' : order.crypto?.toUpperCase() ?? '';
  const restockableCount = (items || []).filter((i: any) => i.product_variant_id && !i.restocked).length;

  return (
    <section className="mt-8">
      {/* Section header */}
      <div className="flex items-center justify-between mb-4 pt-6 border-t border-line">
        <div className="flex items-center gap-2">
          <Package className="w-5 h-5 text-teal-dark" />
          <h2 className="text-lg font-bold text-ink">Order &amp; Fulfillment</h2>
          <span className="font-mono text-sm text-ink-muted">{order.order_number}</span>
        </div>
        <span className={`inline-flex px-3 py-1 rounded-lg text-sm font-medium border ${statusColors[order.status] || 'bg-gray-500/10 text-ink-muted border-gray-500/20'}`}>
          {order.status}
        </span>
      </div>

      {/* Status Progress */}
      {order.status !== 'cancelled' && order.status !== 'refunded' && (
        <div className="bg-white rounded-xl border border-line p-5 mb-6">
          <div className="flex items-center justify-between">
            {statusSteps.map((step, i) => (
              <React.Fragment key={step}>
                <div className="flex flex-col items-center gap-2">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                    i <= currentStepIndex ? 'bg-ink text-white' : 'bg-surface text-ink-muted'
                  }`}>
                    {i <= currentStepIndex ? <Check className="w-4 h-4" /> : i + 1}
                  </div>
                  <span className={`text-[10px] uppercase tracking-wider ${i <= currentStepIndex ? 'text-teal-dark' : 'text-ink-muted'}`}>
                    {step}
                  </span>
                </div>
                {i < statusSteps.length - 1 && (
                  <div className={`flex-1 h-px mx-2 ${i < currentStepIndex ? 'bg-ink' : 'bg-surface'}`} />
                )}
              </React.Fragment>
            ))}
          </div>
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Left column */}
        <div className="lg:col-span-2 space-y-6">
          {/* Payment Details */}
          <div className="bg-white rounded-xl border border-line p-5">
            <div className="flex items-center gap-2 mb-4">
              <CreditCard className="w-4 h-4 text-ink-muted" />
              <h3 className="font-semibold text-ink">Payment Details</h3>
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-ink-muted mb-1">Payment Method</p>
                <p className="text-ink">{paymentMethodLabel}</p>
              </div>
              <div>
                <p className="text-ink-muted mb-1">Order Status</p>
                <p className="text-ink capitalize">{order.status}</p>
              </div>
              {order.payment_amount_expected && (
                <div>
                  <p className="text-ink-muted mb-1">Expected Amount</p>
                  <p className="text-ink tabular-nums">{order.payment_amount_expected} {amountUnit}</p>
                </div>
              )}
              {order.payment_amount_received && (
                <div>
                  <p className="text-ink-muted mb-1">Received Amount</p>
                  <p className="text-ink tabular-nums">{order.payment_amount_received} {amountUnit}</p>
                </div>
              )}
              {order.payment_address && (
                <div className="col-span-2">
                  <p className="text-ink-muted mb-1">Payment Address</p>
                  <div className="flex items-center gap-2">
                    <p className="text-ink font-mono text-xs break-all">{order.payment_address}</p>
                    <button onClick={() => copyToClipboard(order.payment_address, 'addr')} className="text-ink-muted hover:text-ink flex-shrink-0">
                      {copied === 'addr' ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
              )}
              {order.payment_tx_hash && (
                <div className="col-span-2">
                  <p className="text-ink-muted mb-1">Transaction Hash</p>
                  <div className="flex items-center gap-2">
                    <p className="text-ink font-mono text-xs break-all">{order.payment_tx_hash}</p>
                    <button onClick={() => copyToClipboard(order.payment_tx_hash, 'txn')} className="text-ink-muted hover:text-ink flex-shrink-0">
                      {copied === 'txn' ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Affiliate / Commission */}
          {(commission || order.referral_code) && (
            <div className="bg-white rounded-xl border border-line p-5">
              <div className="flex items-center gap-2 mb-4">
                <Tag className="w-4 h-4 text-teal-dark" />
                <h3 className="font-semibold text-ink">Affiliate Commission</h3>
              </div>
              {order.referral_code && (
                <div className="mb-3">
                  <p className="text-ink-muted text-sm mb-1">Referral Code Used</p>
                  <span className="font-mono text-teal-dark bg-teal/10 px-2 py-0.5 rounded text-sm">{order.referral_code}</span>
                </div>
              )}
              {commission && (
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-ink-muted mb-1">Affiliate</p>
                    <p className="text-ink">{commission.affiliate_name}</p>
                    <p className="text-ink-muted text-xs">{commission.affiliate_email}</p>
                  </div>
                  <div>
                    <p className="text-ink-muted mb-1">Commission</p>
                    <p className="text-emerald-600 font-semibold tabular-nums">${Number(commission.amount || 0).toFixed(2)}</p>
                    <p className="text-ink-muted text-xs">{(commission.commission_rate * 100).toFixed(0)}% rate</p>
                  </div>
                  <div>
                    <p className="text-ink-muted mb-1">Status</p>
                    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${
                      commission.status === 'paid' ? 'bg-emerald-500/10 text-emerald-600' : 'bg-amber-500/10 text-amber-600'
                    }`}>
                      {commission.status}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right column */}
        <div className="space-y-6">
          {/* Shipping Address */}
          <div className="bg-white rounded-xl border border-line p-5">
            <div className="flex items-center gap-2 mb-4">
              <MapPin className="w-4 h-4 text-ink-muted" />
              <h3 className="font-semibold text-ink">Shipping Address</h3>
            </div>
            <div className="text-sm text-ink space-y-1">
              {order.shipping_address && typeof order.shipping_address === 'object' ? (
                <>
                  {order.shipping_address.firstName && <p>{order.shipping_address.firstName} {order.shipping_address.lastName}</p>}
                  <p>{order.shipping_address.address}</p>
                  <p>{order.shipping_address.city}, {order.shipping_address.state} {order.shipping_address.postalCode}</p>
                  <p>{order.shipping_address.country}</p>
                  {order.shipping_address.phone && <p className="text-ink-muted">{order.shipping_address.phone}</p>}
                </>
              ) : order.shipping_address ? (
                <p className="whitespace-pre-line">{String(order.shipping_address)}</p>
              ) : order.customer_shipping ? (
                <>
                  <p>{order.customer_shipping.address}</p>
                  <p>{order.customer_shipping.city}, {order.customer_shipping.state}</p>
                  <p>{order.customer_shipping.postal_code}</p>
                  <p>{order.customer_shipping.country}</p>
                </>
              ) : (
                <p className="text-ink-muted">No address on file</p>
              )}
            </div>
          </div>

          {/* Easyship Shipment */}
          <div className="bg-white rounded-xl border border-line p-5">
            <div className="flex items-center gap-2 mb-4">
              <Truck className="w-4 h-4 text-ink-muted" />
              <h3 className="font-semibold text-ink">Easyship Shipment</h3>
            </div>

            {order.fulfillment_type === 'pickup' ? (
              <p className="text-sm text-ink-muted">Pickup order — no shipment needed.</p>
            ) : order.easyship_shipment_id ? (
              <div className="space-y-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-ink-muted">Label status</span>
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${labelStateStyles[order.label_state || 'not_created'] || labelStateStyles.not_created}`}>
                    <Truck className="w-3 h-3" />
                    {labelStateText[order.label_state || 'not_created'] || 'Shipment created'}
                  </span>
                </div>

                <div>
                  <p className="text-ink-muted mb-1">Shipment ID</p>
                  <div className="flex items-center gap-2">
                    <p className="text-ink font-mono text-xs break-all">{order.easyship_shipment_id}</p>
                    <button onClick={() => copyToClipboard(order.easyship_shipment_id, 'ship')} className="text-ink-muted hover:text-ink flex-shrink-0">
                      {copied === 'ship' ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                {order.carrier && (
                  <div>
                    <p className="text-ink-muted mb-1">Carrier</p>
                    <p className="text-ink">{order.carrier}</p>
                  </div>
                )}

                {order.tracking_number && (
                  <div>
                    <p className="text-ink-muted mb-1">Tracking</p>
                    {order.tracking_url ? (
                      <a
                        href={order.tracking_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-teal-dark hover:underline inline-flex items-center gap-1 font-mono text-xs break-all"
                      >
                        {order.tracking_number}
                        <ExternalLink className="w-3 h-3 flex-shrink-0" />
                      </a>
                    ) : (
                      <p className="text-ink font-mono text-xs break-all">{order.tracking_number}</p>
                    )}
                    {order.tracking_status && (
                      <p className="text-xs text-ink-muted capitalize mt-1">{order.tracking_status}</p>
                    )}
                  </div>
                )}

                {editable && (
                  <div className="pt-1">
                    {order.label_state === 'generated' ? (
                      <button
                        onClick={handlePrintLabel}
                        disabled={shipBusy}
                        className="w-full px-3 py-2 bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 rounded-lg text-sm font-medium hover:bg-emerald-500/20 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                      >
                        {shipBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
                        Print Label
                      </button>
                    ) : (
                      <button
                        onClick={handleBuyAndPrint}
                        disabled={shipBusy}
                        className="w-full px-3 py-2 bg-teal/10 border border-teal/20 text-teal-dark rounded-lg text-sm font-medium hover:bg-teal/20 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                      >
                        {shipBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
                        Buy &amp; Print Label
                      </button>
                    )}
                  </div>
                )}

                {shipMsg && <p className="text-xs text-red-500">{shipMsg}</p>}
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-ink-muted">No Easyship shipment record for this order yet.</p>
                {order.auto_shipment_error && (
                  <p className="text-xs text-red-500">Last auto-create failed: {order.auto_shipment_error}</p>
                )}
                {editable && (
                  <>
                    {/* Choose the courier BEFORE creating the shipment — it's baked
                        into the shipment and used when the label is bought. */}
                    <div>
                      <p className="text-ink-muted mb-1 text-xs">Courier</p>
                      <select
                        value={courierId}
                        onChange={(e) => setCourierId(e.target.value)}
                        disabled={shipBusy || ratesLoading}
                        className="w-full px-3 py-2 bg-surface border border-line text-ink rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40 disabled:opacity-50"
                      >
                        {ratesLoading && <option value="">Loading couriers…</option>}
                        {!ratesLoading && rates.length === 0 && (
                          <option value="">Easyship default (cheapest)</option>
                        )}
                        {rates.map((r) => (
                          <option key={r.courier_id} value={r.courier_id}>
                            {r.courier_name}
                            {r.service_name ? ` · ${r.service_name}` : ''} — ${Number(r.total_charge).toFixed(2)} {r.currency}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      onClick={handleCreateShipment}
                      disabled={shipBusy}
                      className="w-full px-3 py-2 bg-teal/10 border border-teal/20 text-teal-dark rounded-lg text-sm font-medium hover:bg-teal/20 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      {shipBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <PackagePlus className="w-4 h-4" />}
                      Create Shipment with Courier
                    </button>
                  </>
                )}
                {shipMsg && <p className="text-xs text-red-500">{shipMsg}</p>}
              </div>
            )}
          </div>

          {/* Tracking */}
          {editable && (
            <div className="bg-white rounded-xl border border-line p-5">
              <div className="flex items-center gap-2 mb-4">
                <Truck className="w-4 h-4 text-ink-muted" />
                <h3 className="font-semibold text-ink">Tracking</h3>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={trackingInput}
                  onChange={(e) => setTrackingInput(e.target.value)}
                  placeholder="Enter tracking number"
                  className="flex-1 px-3 py-2 bg-surface border border-line rounded-lg text-sm text-ink placeholder-ink-muted focus:outline-none focus:ring-2 focus:ring-teal/40"
                />
                <button
                  onClick={handleSaveTracking}
                  disabled={savingTracking}
                  className="px-3 py-2 bg-teal/10 border border-teal/20 text-teal-dark rounded-lg text-sm hover:bg-teal/20 transition-colors disabled:opacity-50"
                >
                  {savingTracking ? '...' : <Save className="w-4 h-4" />}
                </button>
              </div>
            </div>
          )}

          {/* Update Status */}
          {editable && (
            <div className="bg-white rounded-xl border border-line p-5">
              <h3 className="font-semibold text-ink mb-4">Update Order Status</h3>
              <select
                value={order.status}
                onChange={(e) => handleStatusChange(e.target.value)}
                disabled={updating}
                className="w-full px-3 py-2.5 bg-surface border border-line text-ink rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40 disabled:opacity-50"
              >
                <option value="pending">Pending</option>
                <option value="received">Payment Received</option>
                <option value="confirmed">Confirmed</option>
                <option value="processing">Processing</option>
                <option value="shipped">Shipped</option>
                <option value="delivered">Delivered</option>
                <option value="cancelled">Cancelled</option>
              </select>
              <p className="mt-2 text-[10px] text-ink-muted">
                Confirming decrements stock; cancelling restores it. Separate from the invoice&apos;s billing status above.
              </p>
            </div>
          )}

          {/* Paid-order confirmation email — status, history, send / resend.
              Keyed on status so confirming re-reads the automatic send. */}
          <OrderConfirmationEmailCard key={order.status} target={{ orderId }} canSend={editable} />

          {/* Email Notifications */}
          {editable && order.customer_email && (
            <div className="bg-white rounded-xl border border-line p-5">
              <div className="flex items-center gap-2 mb-4">
                <Mail className="w-4 h-4 text-ink-muted" />
                <h3 className="font-semibold text-ink">Email Customer</h3>
              </div>
              <div className="space-y-2">
                <button
                  onClick={sendShippingEmail}
                  disabled={emailSending || !trackingInput}
                  className="w-full px-3 py-2 bg-indigo-500/10 border border-indigo-500/20 text-indigo-600 rounded-lg text-sm hover:bg-indigo-500/20 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {emailSent === 'shipping' ? (
                    <><Check className="w-3.5 h-3.5" /> Sent!</>
                  ) : (
                    <><Truck className="w-3.5 h-3.5" /> Send Shipping Notification</>
                  )}
                </button>
                {!trackingInput && (
                  <p className="text-[10px] text-ink-muted">Add tracking number to enable shipping email</p>
                )}
              </div>
            </div>
          )}

          {/* Refund */}
          {editable && (
            <div className="bg-white rounded-xl border border-red-200 p-5">
              <div className="flex items-center gap-2 mb-2">
                <RotateCcw className="w-4 h-4 text-red-600" />
                <h3 className="font-semibold text-red-700">Refund</h3>
              </div>
              {order.status === 'refunded' ? (
                <p className="text-sm text-emerald-600 flex items-center gap-1.5">
                  <Check className="w-4 h-4" />
                  Order refunded{order.refunded_at ? ` on ${new Date(order.refunded_at).toLocaleDateString()}` : ''}
                </p>
              ) : REFUNDABLE.includes(order.status) ? (
                <>
                  <p className="text-xs text-ink-muted mb-3">
                    Issue a full or partial refund. Restockable items are returned to inventory and the order is marked refunded.
                  </p>
                  <button
                    onClick={openRefund}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-white border border-red-200 text-red-700 rounded-lg text-sm font-medium hover:bg-red-50 transition-colors"
                  >
                    <RotateCcw className="w-4 h-4" /> Refund order
                  </button>
                </>
              ) : (
                <p className="text-xs text-ink-muted">
                  Refunds become available once the order is confirmed.
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Refund modal */}
      {refundOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-8"
          onClick={() => !refunding && setRefundOpen(false)}
        >
          <div
            className="w-full max-w-lg my-auto bg-white border border-line rounded-xl shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-line">
              <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
                <RotateCcw className="w-4 h-4 text-red-600" /> Refund order {order.order_number}
              </h3>
              <button
                onClick={() => !refunding && setRefundOpen(false)}
                className="text-ink-muted hover:text-ink transition-colors disabled:opacity-50"
                disabled={refunding}
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={fullRefund}
                  onChange={(e) => setFullRefund(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium text-ink">Full refund</span>
                  <span className="block text-xs text-ink-muted">
                    Marks the order refunded and restocks all remaining items.
                  </span>
                </span>
              </label>

              {!fullRefund && (
                <div className="rounded-lg border border-line divide-y divide-line/60">
                  {restockableCount === 0 ? (
                    <p className="px-3 py-3 text-xs text-ink-muted">
                      This order has no relational line items to restock individually. Use a full refund.
                    </p>
                  ) : (
                    Object.entries(refundLines).map(([itemId, v]) => (
                      <div key={itemId} className="flex items-center gap-3 px-3 py-2.5">
                        <input
                          type="checkbox"
                          checked={v.selected}
                          onChange={(e) =>
                            setRefundLines((prev) => ({
                              ...prev,
                              [itemId]: { ...prev[itemId], selected: e.target.checked },
                            }))
                          }
                        />
                        <span className="flex-1 text-sm text-ink truncate">{v.name}</span>
                        <span className="text-xs text-ink-muted">Qty</span>
                        <input
                          type="number"
                          min={1}
                          max={v.max}
                          value={v.qty}
                          disabled={!v.selected}
                          onChange={(e) =>
                            setRefundLines((prev) => ({
                              ...prev,
                              [itemId]: {
                                ...prev[itemId],
                                qty: Math.max(1, Math.min(v.max, Number(e.target.value) || 1)),
                              },
                            }))
                          }
                          className="w-16 px-2 py-1 bg-surface border border-line rounded text-sm text-ink disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-teal/40"
                        />
                        <span className="text-xs text-ink-muted">/ {v.max}</span>
                      </div>
                    ))
                  )}
                </div>
              )}

              <div>
                <label className="block text-[11px] uppercase tracking-wide text-ink-muted mb-1">Reason (optional)</label>
                <textarea
                  value={refundReason}
                  onChange={(e) => setRefundReason(e.target.value)}
                  rows={3}
                  placeholder="Recorded on the inventory log entry"
                  className="w-full px-3 py-2 bg-surface border border-line rounded-lg text-sm text-ink placeholder-ink-muted focus:outline-none focus:ring-2 focus:ring-teal/40 resize-y"
                />
              </div>

              <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[11px] text-amber-700">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <span>This marks the order as <strong>refunded</strong> and cannot be undone. It does not delete the invoice.</span>
              </div>

              {refundMsg && <p className="text-xs text-red-500">{refundMsg}</p>}

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-line">
                <button
                  onClick={() => setRefundOpen(false)}
                  disabled={refunding}
                  className="px-4 py-2 text-sm text-ink-muted hover:text-ink transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={submitRefund}
                  disabled={refunding || (!fullRefund && Object.values(refundLines).every((v) => !v.selected))}
                  className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 transition-colors disabled:opacity-50 flex items-center gap-2"
                >
                  {refunding ? (
                    <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Processing…</>
                  ) : (
                    <><RotateCcw className="w-3.5 h-3.5" /> Process refund</>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
