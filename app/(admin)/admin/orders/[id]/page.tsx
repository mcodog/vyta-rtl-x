'use client';

import React, { useState, useEffect } from 'react';
import { ArrowLeft, Package, User, MapPin, CreditCard, Tag, Truck, Copy, Check, Save, Mail, Printer, PackagePlus, ExternalLink, Loader2, Send, Megaphone } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
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
import { apiFetch } from '@/lib/api-fetch';
import { printPdfBlob } from '@/lib/print-pdf';
import { canEdit } from '@/lib/permissions';
import { useUserRole } from '../../layout';
import OrderConfirmationEmailCard from '@/components/admin/OrderConfirmationEmailCard';
import { channelLabel as acquisitionLabel } from '@/lib/admin/attribution';
import InfoTip from '@/components/admin/InfoTip';
import { OrderAcquisitionTip } from '@/components/admin/AttributionTips';
import type { AttributionTouch } from '@/lib/analytics/attribution';

const statusColors: Record<string, string> = {
  pending: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  received: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
  confirmed: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  processing: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  shipped: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20',
  delivered: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  cancelled: 'bg-red-500/10 text-red-400 border-red-500/20',
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

export default function OrderDetailPage() {
  const { id } = useParams();
  const userRole = useUserRole();
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

  useEffect(() => {
    if (id) {
      getOrderDetail(id as string).then((result) => {
        setData(result);
        setTrackingInput(result?.order?.tracking_number || '');
        setLoading(false);
      });
    }
  }, [id]);

  // Load live courier options BEFORE a shipment exists, so the admin chooses
  // the courier first and it's baked into the shipment at creation.
  useEffect(() => {
    const o = data?.order;
    if (!o || o.easyship_shipment_id || o.fulfillment_type === 'pickup') return;
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
  }, [data?.order?.id, data?.order?.easyship_shipment_id]);

  const handleStatusChange = async (status: string) => {
    if (!data) return;
    setUpdating(true);
    await updateOrderStatus(data.order.id, status as any);
    const updated = await getOrderDetail(id as string);
    setData(updated);
    setUpdating(false);
  };

  const handleSaveTracking = async () => {
    if (!data) return;
    setSavingTracking(true);
    await updateOrderTracking(data.order.id, trackingInput);
    const updated = await getOrderDetail(id as string);
    setData(updated);
    setSavingTracking(false);
  };

  const refreshOrder = async () => {
    const updated = await getOrderDetail(id as string);
    setData(updated);
  };

  // Manually create (or retry) the Easyship shipment record for this order.
  const handleCreateShipment = async () => {
    if (!data) return;
    setShipBusy(true);
    setShipMsg(null);
    try {
      const res = await createOrderShipment(data.order.id, courierId || undefined);
      await refreshOrder();
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
      await refreshOrder();
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
    if (!data || !order.customer_email) return;
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

  if (loading) {
    return <div className="text-center py-20 text-ink-muted text-sm animate-pulse">Loading order...</div>;
  }

  if (!data) {
    return (
      <div className="text-center py-20">
        <p className="text-ink-muted mb-4">Order not found</p>
        <Link href="/admin/orders" className="text-teal-dark hover:text-teal-dark/80 text-sm">Back to Orders</Link>
      </div>
    );
  }

  const { order, items, commission } = data;
  const currentStepIndex = statusSteps.indexOf(order.status);

  // Payment method is driven by the order's source, not `crypto` (e-Transfer
  // orders never set a crypto coin, so the old `crypto || 'Crypto'` fallback
  // mislabeled them as crypto). Amounts for e-Transfer are in CAD.
  const isEtransfer = typeof order.source === 'string' && order.source.startsWith('e-transfer');
  const paymentMethodLabel = isEtransfer
    ? 'e-Transfer'
    : order.crypto && order.crypto !== 'other'
      ? order.crypto.toUpperCase()
      : 'Crypto';
  const amountUnit = isEtransfer ? 'CAD' : order.crypto?.toUpperCase() ?? '';

  // Marketing attribution, read defensively: the columns arrive with
  // marketing-attribution-migration.sql and are absent on older databases and
  // on every order placed before it ran.
  const attributionJson = (order as any).attribution as
    | { first?: AttributionTouch | null; last?: AttributionTouch | null }
    | null
    | undefined;
  const acquisition = {
    channel: ((order as any).attribution_channel as string | null) ?? null,
    campaign: ((order as any).attribution_campaign as string | null) ?? null,
    firstTouch: attributionJson?.first ?? null,
    lastTouch: attributionJson?.last ?? null,
  };

  return (
    <>
      {/* Back + Title */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Link href="/admin/orders" className="text-ink-muted hover:text-ink transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <h1 className="text-xl font-bold text-ink font-mono">{order.order_number}</h1>
            <p className="text-xs text-ink-muted mt-1">
              Created {new Date(order.created_at).toLocaleString()}
            </p>
          </div>
        </div>
        <span className={`inline-flex px-3 py-1 rounded-lg text-sm font-medium border ${statusColors[order.status] || 'bg-gray-500/10 text-ink-muted border-gray-500/20'}`}>
          {order.status}
        </span>
      </div>

      {/* Status Progress */}
      {order.status !== 'cancelled' && (
        <div className="bg-white rounded-xl border border-line p-5 mb-6">
          <div className="flex items-center justify-between">
            {statusSteps.map((step, i) => (
              <React.Fragment key={step}>
                <div className="flex flex-col items-center gap-2">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                    i <= currentStepIndex
                      ? 'bg-ink text-white'
                      : 'bg-surface text-ink-muted'
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
        {/* Left Column */}
        <div className="lg:col-span-2 space-y-6">
          {/* Order Items */}
          <div className="bg-white rounded-xl border border-line overflow-hidden">
            <div className="p-5 border-b border-line flex items-center gap-2">
              <Package className="w-4 h-4 text-ink-muted" />
              <h2 className="font-semibold text-ink">Order Items</h2>
            </div>
            <div className="divide-y divide-line/50">
              {items.map((item: any) => (
                <div key={item.id} className="p-5 flex items-center gap-4">
                  <div className="w-12 h-12 bg-surface rounded-lg flex items-center justify-center flex-shrink-0">
                    {item.product_image ? (
                      <img src={item.product_image} alt="" className="w-full h-full object-contain rounded-lg p-1" />
                    ) : (
                      <Package className="w-5 h-5 text-ink-muted" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-ink text-sm">{item.product_name || 'Unknown Product'}</p>
                    <p className="text-xs text-ink-muted">{item.product_strength}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-ink-muted">x{item.quantity}</p>
                    <p className="font-semibold text-ink tabular-nums">${(Number(item.price_at_time) * item.quantity).toFixed(2)}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="p-5 border-t border-line space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-ink-muted">Subtotal</span>
                <span className="text-ink tabular-nums">
                  ${Number(
                    order.subtotal ??
                      (Number(order.total || 0) -
                        Number(order.shipping_cost || 0) +
                        Number(order.discount_total || 0)),
                  ).toFixed(2)}
                </span>
              </div>
              {Number(order.discount_total ?? order.discount_amount ?? 0) > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-ink-muted">Discount</span>
                  <span className="text-emerald-600 tabular-nums">
                    −${Number(order.discount_total ?? order.discount_amount).toFixed(2)}
                  </span>
                </div>
              )}
              <div className="flex justify-between text-sm">
                <span className="text-ink-muted">Shipping</span>
                <span className="text-ink tabular-nums">${Number(order.shipping_cost || 0).toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-base font-bold pt-2 border-t border-line">
                <span className="text-ink">Total</span>
                <span className="text-ink tabular-nums">${Number(order.total || 0).toFixed(2)} CAD</span>
              </div>
            </div>
          </div>

          {/* Payment Details */}
          <div className="bg-white rounded-xl border border-line p-5">
            <div className="flex items-center gap-2 mb-4">
              <CreditCard className="w-4 h-4 text-ink-muted" />
              <h2 className="font-semibold text-ink">Payment Details</h2>
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-ink-muted mb-1">Payment Method</p>
                <p className="text-ink">{paymentMethodLabel}</p>
              </div>
              <div>
                <p className="text-ink-muted mb-1">Status</p>
                <p className="text-ink">{order.status}</p>
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
                      {copied === 'addr' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
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
                      {copied === 'txn' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Acquisition — the marketing channel that produced this order,
              frozen onto the row when it was placed. Hidden for orders from
              before attribution started collecting, rather than reported as
              "Direct" on no evidence. */}
          {acquisition.channel && (
            <div className="bg-white rounded-xl border border-line p-5">
              <div className="flex items-center gap-2 mb-4">
                <Megaphone className="w-4 h-4 text-teal-dark" />
                <h2 className="font-semibold text-ink">Acquisition</h2>
                <InfoTip label="How this order's channel was decided">
                  <OrderAcquisitionTip />
                </InfoTip>
              </div>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-ink-muted mb-1">Channel</p>
                  <p className="text-ink font-medium">{acquisitionLabel(acquisition.channel)}</p>
                </div>
                {acquisition.campaign && (
                  <div>
                    <p className="text-ink-muted mb-1">Campaign</p>
                    <p className="text-ink">{acquisition.campaign}</p>
                  </div>
                )}
                {acquisition.firstTouch?.landing_path && (
                  <div>
                    <p className="text-ink-muted mb-1">Landed on</p>
                    <p className="text-ink font-mono text-xs break-all">{acquisition.firstTouch.landing_path}</p>
                  </div>
                )}
                {(acquisition.firstTouch?.landing_page || acquisition.lastTouch?.landing_page) && (
                  <div>
                    <p className="text-ink-muted mb-1">Landing page</p>
                    <p className="text-ink font-mono text-xs break-all">
                      {acquisition.firstTouch?.landing_page ?? acquisition.lastTouch?.landing_page}
                    </p>
                  </div>
                )}
                {acquisition.firstTouch?.referrer_host && (
                  <div>
                    <p className="text-ink-muted mb-1">Referrer</p>
                    <p className="text-ink text-xs break-all">{acquisition.firstTouch.referrer_host}</p>
                  </div>
                )}
                {acquisition.firstTouch?.click_id_param && (
                  <div className="col-span-2">
                    <p className="text-ink-muted mb-1">Click ID</p>
                    <p className="text-ink font-mono text-xs break-all">
                      <span className="text-ink-muted">{acquisition.firstTouch.click_id_param}=</span>
                      {acquisition.firstTouch.click_id}
                    </p>
                  </div>
                )}
              </div>
              {acquisition.lastTouch && acquisition.lastTouch.channel !== acquisition.channel && (
                <p className="mt-3 pt-3 border-t border-line text-xs text-ink-muted">
                  Last touch before ordering was{' '}
                  <span className="font-medium text-ink">{acquisitionLabel(acquisition.lastTouch.channel)}</span>.
                  Revenue is credited above to the first touch — the visit that won them.
                </p>
              )}
            </div>
          )}

          {/* Affiliate / Commission */}
          {(commission || order.referral_code) && (
            <div className="bg-white rounded-xl border border-line p-5">
              <div className="flex items-center gap-2 mb-4">
                <Tag className="w-4 h-4 text-teal-dark" />
                <h2 className="font-semibold text-ink">Affiliate Commission</h2>
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
                    <p className="text-emerald-400 font-semibold tabular-nums">${Number(commission.amount || 0).toFixed(2)}</p>
                    <p className="text-ink-muted text-xs">{(commission.commission_rate * 100).toFixed(0)}% rate</p>
                  </div>
                  <div>
                    <p className="text-ink-muted mb-1">Status</p>
                    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${
                      commission.status === 'paid' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'
                    }`}>
                      {commission.status}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Column */}
        <div className="space-y-6">
          {/* Customer Info */}
          <div className="bg-white rounded-xl border border-line p-5">
            <div className="flex items-center gap-2 mb-4">
              <User className="w-4 h-4 text-ink-muted" />
              <h2 className="font-semibold text-ink">Customer</h2>
            </div>
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-ink font-medium">{order.customer_name || 'Guest Checkout'}</p>
                {order.customer_email && (
                  <p className="text-ink-muted">{order.customer_email}</p>
                )}
                {order.customer_phone && (
                  <p className="text-ink-muted">{order.customer_phone}</p>
                )}
              </div>
            </div>
          </div>

          {/* Shipping Address */}
          <div className="bg-white rounded-xl border border-line p-5">
            <div className="flex items-center gap-2 mb-4">
              <MapPin className="w-4 h-4 text-ink-muted" />
              <h2 className="font-semibold text-ink">Shipping Address</h2>
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
              <h2 className="font-semibold text-ink">Easyship Shipment</h2>
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
                      {copied === 'ship' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
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

                {shipMsg && <p className="text-xs text-red-500">{shipMsg}</p>}
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-ink-muted">No Easyship shipment record for this order yet.</p>
                {order.auto_shipment_error && (
                  <p className="text-xs text-red-500">Last auto-create failed: {order.auto_shipment_error}</p>
                )}
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
                {shipMsg && <p className="text-xs text-red-500">{shipMsg}</p>}
              </div>
            )}
          </div>

          {/* Tracking */}
          <div className="bg-white rounded-xl border border-line p-5">
            <div className="flex items-center gap-2 mb-4">
              <Truck className="w-4 h-4 text-ink-muted" />
              <h2 className="font-semibold text-ink">Tracking</h2>
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

          {/* Update Status */}
          <div className="bg-white rounded-xl border border-line p-5">
            <h2 className="font-semibold text-ink mb-4">Update Status</h2>
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
          </div>

          {/* Paid-order confirmation email — status, history, send / resend.
              Keyed on status so confirming re-reads the automatic send. */}
          <OrderConfirmationEmailCard
            key={order.status}
            target={{ orderId: order.id }}
            canSend={canEdit(userRole)}
          />

          {/* Email Notifications */}
          {order.customer_email && (
            <div className="bg-white rounded-xl border border-line p-5">
              <div className="flex items-center gap-2 mb-4">
                <Mail className="w-4 h-4 text-ink-muted" />
                <h2 className="font-semibold text-ink">Email Customer</h2>
              </div>
              <div className="space-y-2">
                <button
                  onClick={sendShippingEmail}
                  disabled={emailSending || !trackingInput}
                  className="w-full px-3 py-2 bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 rounded-lg text-sm hover:bg-indigo-500/20 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
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
        </div>
      </div>
    </>
  );
}
