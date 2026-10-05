'use client';

import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, Package, Clock, CheckCircle, Truck, XCircle, MapPin, Beaker, FileText, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import Navigation from '@/components/Navigation';
import Footer from '@/components/Footer';
import { useCustomer } from '@/contexts/CustomerContext';
import { getOrderWithItems } from '@/lib/customer/api';
import { supabase } from '@/lib/supabase';
import type { Order, OrderItem } from '@/lib/supabase';

const statusConfig: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
  pending: { icon: <Clock className="w-3.5 sm:w-4 h-3.5 sm:h-4" />, color: 'text-amber-700 bg-amber-50 border-amber-100', label: 'Pending' },
  received: { icon: <CheckCircle className="w-3.5 sm:w-4 h-3.5 sm:h-4" />, color: 'text-cyan-700 bg-cyan-50 border-cyan-100', label: 'Payment Received' },
  confirmed: { icon: <CheckCircle className="w-3.5 sm:w-4 h-3.5 sm:h-4" />, color: 'text-blue-700 bg-blue-50 border-blue-100', label: 'Confirmed' },
  processing: { icon: <Package className="w-3.5 sm:w-4 h-3.5 sm:h-4" />, color: 'text-purple-700 bg-purple-50 border-purple-100', label: 'Processing' },
  shipped: { icon: <Truck className="w-3.5 sm:w-4 h-3.5 sm:h-4" />, color: 'text-indigo-700 bg-indigo-50 border-indigo-100', label: 'Shipped' },
  delivered: { icon: <CheckCircle className="w-3.5 sm:w-4 h-3.5 sm:h-4" />, color: 'text-emerald-700 bg-emerald-50 border-emerald-100', label: 'Delivered' },
  cancelled: { icon: <XCircle className="w-3.5 sm:w-4 h-3.5 sm:h-4" />, color: 'text-red-700 bg-red-50 border-red-100', label: 'Cancelled' },
};

export default function OrderDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { customer, isLoading: authLoading } = useCustomer();
  // Set when the "View Order Details" link from the confirmation email could
  // not attach this order to the signed-in account.
  const [claimError, setClaimError] = useState<string | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [items, setItems] = useState<(OrderItem & { product_name?: string; product_strength?: string })[]>([]);
  const [loading, setLoading] = useState(true);
  const [invoiceLoading, setInvoiceLoading] = useState(false);
  const [invoiceError, setInvoiceError] = useState<string | null>(null);
  // Order lines only store the product reference, not its artwork — resolve
  // image URLs from the catalog (keyed by product id) for both order shapes.
  const [productImages, setProductImages] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!order) return;
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const ids = Array.from(
      new Set(
        [
          ...items.map((it) => it.product_id),
          ...((order.items as any[]) ?? []).map((it) => it?.id),
        ].filter((id): id is string => typeof id === 'string' && UUID_RE.test(id)),
      ),
    );
    if (ids.length === 0) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('products')
        .select('id, image_url')
        .in('id', ids);
      if (cancelled || !data) return;
      const map: Record<string, string> = {};
      for (const p of data) if (p.image_url) map[p.id] = p.image_url;
      setProductImages(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [order, items]);

  // Fetch the printer-ready invoice (Bearer-authenticated, so a plain <a>
  // can't do it) and hand it to a tab opened synchronously inside the click —
  // popup blockers only allow windows opened during the user gesture.
  const downloadInvoice = async () => {
    if (!order || invoiceLoading) return;
    const win = window.open('about:blank', '_blank');
    setInvoiceLoading(true);
    setInvoiceError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Please sign in again to download your invoice.');
      const res = await fetch(`/api/customer/orders/${order.id}/invoice?download=1`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error || 'Could not load your invoice. Please try again.');
      }
      const html = await res.text();
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      if (win) {
        win.location.href = url;
      } else {
        const a = document.createElement('a');
        a.href = url;
        a.download = `invoice-${order.order_number}.html`;
        a.click();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e: any) {
      win?.close();
      setInvoiceError(e?.message || 'Could not load your invoice. Please try again.');
    } finally {
      setInvoiceLoading(false);
    }
  };

  useEffect(() => {
    if (authLoading) return;
    if (!customer) {
      // Come back here (claim token and all) once signed in.
      const here = `${window.location.pathname}${window.location.search}`;
      router.replace(`/login?redirect=${encodeURIComponent(here)}`);
      return;
    }
    const signedIn = customer;

    // Arrived from the confirmation email: link a guest order to this account
    // first (the server checks the token was issued for this email address).
    async function claimFromEmail(): Promise<string | null> {
      const url = new URL(window.location.href);
      const claim = url.searchParams.get('claim');
      if (!claim) return null;
      let error: string | null = null;
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const res = await fetch(`/api/customer/orders/${encodeURIComponent(params.id as string)}/claim`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session?.access_token ?? ''}`,
          },
          body: JSON.stringify({ token: claim }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => null);
          error = j?.error || 'We couldn’t link this order to your account.';
        }
      } catch {
        error = 'We couldn’t link this order to your account. Please try again.';
      }
      // Drop the token from the address bar either way.
      url.searchParams.delete('claim');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      setClaimError(error);
      return error;
    }

    async function loadOrder() {
      const claimFailed = await claimFromEmail();
      const result = await getOrderWithItems(params.id as string);
      if (result) {
        if (result.order.customer_id !== signedIn.id) {
          // Show why the emailed link didn't work instead of bouncing away.
          if (claimFailed) {
            setLoading(false);
            return;
          }
          router.push('/account/dashboard');
          return;
        }
        setOrder(result.order);
        setItems(result.items);
      }
      setLoading(false);
    }

    loadOrder();
  }, [params.id, customer, authLoading, router]);

  if (!customer || loading) {
    return (
      <main className="min-h-screen bg-white">
        <Navigation showTicker={false} />
        <div className="pt-28 sm:pt-32 md:pt-44 pb-16 sm:pb-20 text-center">
          <div className="animate-pulse text-slate-500 text-xs sm:text-sm">Loading...</div>
        </div>
      </main>
    );
  }

  if (!order) {
    return (
      <main className="min-h-screen bg-white">
        <Navigation showTicker={false} />
        <div className="pt-28 sm:pt-32 md:pt-44 pb-16 sm:pb-20 md:pb-28 px-4 sm:px-8">
          <div className="max-w-md mx-auto text-center">
            <div className="w-12 sm:w-14 h-12 sm:h-14 bg-slate-100 rounded-xl flex items-center justify-center mx-auto mb-3 sm:mb-4">
              <Beaker className="w-6 sm:w-7 h-6 sm:h-7 text-slate-400" />
            </div>
            <h1 className="text-xl sm:text-2xl font-bold text-slate-900 mb-2 sm:mb-3">Order Not Found</h1>
            <p className="text-slate-500 text-xs sm:text-sm mb-4 sm:mb-6">
              {claimError ?? <>This order doesn&apos;t exist or you don&apos;t have access to it.</>}
            </p>
            <Link
              href="/account/dashboard"
              className="inline-flex items-center gap-2 text-cyan-600 hover:text-cyan-700 font-semibold text-xs sm:text-sm"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Dashboard
            </Link>
          </div>
        </div>
        <Footer />
      </main>
    );
  }

  const status = statusConfig[order.status] || statusConfig.pending;

  // Items may live in a separate order_items table or, for storefront orders,
  // in the orders.items JSONB. Normalize both into one display shape.
  const lineItems =
    items.length > 0
      ? items.map((it, i) => ({
          key: it.id ?? String(i),
          productId: it.product_id ?? undefined,
          name: it.product_name || `Product ${i + 1}`,
          strength: it.product_strength,
          quantity: it.quantity,
          price: it.price_at_time,
          unit: (it as any).unit as string | undefined,
          packSize: Number((it as any).pack_size) > 0 ? Number((it as any).pack_size) : 0,
          vialsPerBox:
            Number((it as any).vials_per_box) > 0 ? Number((it as any).vials_per_box) : 10,
        }))
      : (((order.items as any[]) ?? []).map((it, i) => ({
          // JSONB `id` is the product UUID, shared by a vial line and a case
          // line of the same product — suffix the index to keep keys unique.
          key: `${it.id ?? 'item'}-${i}`,
          productId: typeof it.id === 'string' ? (it.id as string) : undefined,
          name: it.name ?? `Product ${i + 1}`,
          strength: it.strength,
          quantity: it.quantity,
          price: it.price,
          unit: it.unit as string | undefined,
          // `pack_size` lands on orders placed after pack options shipped;
          // older rows fall back to the unit + case size they stored.
          packSize: Number(it.packSize ?? it.pack_size) > 0
            ? Number(it.packSize ?? it.pack_size)
            : 0,
          vialsPerBox:
            Number(it.vialsPerBox ?? it.vials_per_box) > 0
              ? Number(it.vialsPerBox ?? it.vials_per_box)
              : 10,
        })));

  // shipping_address is a JSONB object ({firstName,address,city,...}); render
  // its fields rather than the object itself (which would crash React).
  const addr = order.shipping_address as
    | {
        firstName?: string;
        lastName?: string;
        address?: string;
        city?: string;
        state?: string;
        postalCode?: string;
        country?: string;
        phone?: string;
      }
    | string
    | null;
  const addressLines =
    addr && typeof addr === 'object'
      ? [
          [addr.firstName, addr.lastName].filter(Boolean).join(' '),
          addr.address,
          [addr.city, addr.state, addr.postalCode].filter(Boolean).join(', '),
          addr.country,
          addr.phone,
        ].filter(Boolean)
      : addr
        ? [String(addr)]
        : [];

  const subtotal = (order as any).subtotal as number | null | undefined;
  const shippingCost = (order as any).shipping_cost as number | null | undefined;

  return (
    <main className="min-h-screen bg-white">
      <Navigation showTicker={false} />

      <div className="pt-28 sm:pt-32 md:pt-44 pb-16 sm:pb-20 md:pb-28">
        <div className="max-w-4xl mx-auto px-4 sm:px-8 lg:px-12">
          {/* Back Link */}
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-4 sm:mb-6">
            <Link
              href="/account/dashboard"
              className="inline-flex items-center gap-2 text-slate-500 hover:text-slate-900 transition-colors text-xs sm:text-sm"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Dashboard
            </Link>
          </motion.div>

          {/* Order Header */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5 md:p-6 mb-4 sm:mb-5 md:mb-6"
          >
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 sm:gap-4">
              <div>
                <span className="text-[10px] sm:text-xs font-semibold text-cyan-600 uppercase tracking-[0.2em] mb-1 sm:mb-2 block">
                  Order Details
                </span>
                <h1 className="text-xl sm:text-2xl md:text-3xl font-bold text-slate-900">#{order.order_number}</h1>
                <p className="text-slate-500 text-[10px] sm:text-xs md:text-sm mt-1">
                  Placed on{' '}
                  {new Date(order.created_at).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
              </div>
              <div className="flex flex-col items-start md:items-end gap-2">
                <div className={`inline-flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-3 py-1 sm:py-1.5 rounded-lg text-xs sm:text-sm font-medium border ${status.color}`}>
                  {status.icon}
                  <span>{status.label}</span>
                </div>
                {/* Stealth Health sales are paid + receipted on the
                    partner's hosted page — our invoice route only serves native
                    orders, so show a note instead of a broken download. */}
                {(order as any).source === 'stealth_health' ? (
                  <span className="inline-flex items-center gap-2 px-3 sm:px-3.5 py-1.5 sm:py-2 rounded-lg border border-slate-200 bg-slate-50 text-slate-500 text-xs sm:text-sm">
                    <FileText className="w-4 h-4 text-cyan-600" />
                    <span>Receipt emailed by our checkout partner</span>
                  </span>
                ) : (
                  <button
                    onClick={downloadInvoice}
                    disabled={invoiceLoading}
                    className="inline-flex items-center gap-2 px-3 sm:px-3.5 py-1.5 sm:py-2 rounded-lg border border-slate-200 bg-white hover:border-slate-400 text-slate-700 text-xs sm:text-sm font-semibold transition-colors disabled:opacity-60 disabled:cursor-wait"
                  >
                    {invoiceLoading ? (
                      <Loader2 className="w-4 h-4 animate-spin text-cyan-600" />
                    ) : (
                      <FileText className="w-4 h-4 text-cyan-600" />
                    )}
                    <span>{invoiceLoading ? 'Preparing…' : 'Download Invoice'}</span>
                  </button>
                )}
              </div>
            </div>
            {invoiceError && (
              <p className="mt-3 text-xs sm:text-sm text-red-600 md:text-right">{invoiceError}</p>
            )}

            {order.tracking_number && (
              <div className="mt-3 sm:mt-4 pt-3 sm:pt-4 border-t border-slate-100">
                <p className="text-xs sm:text-sm text-slate-500">
                  <span className="font-medium text-slate-700">Tracking Number:</span>{' '}
                  <span className="font-mono">{order.tracking_number}</span>
                </p>
              </div>
            )}
          </motion.div>

          <div className="grid md:grid-cols-3 gap-4 sm:gap-5 md:gap-6">
            {/* Order Items */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="md:col-span-2"
            >
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <div className="p-4 sm:p-5 md:p-6 border-b border-slate-100">
                  <h2 className="text-sm sm:text-base font-bold text-slate-900">Order Items</h2>
                </div>
                <div className="divide-y divide-slate-100">
                  {lineItems.map((item) => (
                    <div key={item.key} className="p-3 sm:p-4 md:p-5 flex items-center gap-3 sm:gap-4">
                      <div className="w-12 sm:w-14 h-12 sm:h-14 bg-slate-100 rounded-xl flex items-center justify-center flex-shrink-0 overflow-hidden">
                        {item.productId && productImages[item.productId] ? (
                          <img
                            src={productImages[item.productId]}
                            alt={item.name}
                            className="w-full h-full object-contain p-1"
                          />
                        ) : (
                          <Beaker className="w-5 sm:w-6 h-5 sm:h-6 text-cyan-500" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-slate-900 text-xs sm:text-sm">
                          {item.name}
                        </h3>
                        {item.strength && (
                          <p className="text-[10px] sm:text-xs text-slate-500 mt-0.5">{item.strength}</p>
                        )}
                        <p className="text-[10px] sm:text-xs text-slate-400 mt-1 flex items-center gap-1.5 flex-wrap">
                          <span>Qty: {item.quantity}</span>
                          {(item.packSize > 0 || item.unit) && (
                            <span className="inline-flex items-center rounded-full bg-slate-50 border border-slate-200 px-1.5 py-0.5 text-[9px] sm:text-[10px] font-medium text-slate-500">
                              {(() => {
                                const size = item.packSize > 0
                                  ? item.packSize
                                  : item.unit === 'case' ? item.vialsPerBox : 1;
                                return size > 1 ? `Pack of ${size}` : 'Single vial';
                              })()}
                            </span>
                          )}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-slate-900 text-xs sm:text-sm tabular-nums">
                          ${(Number(item.price) * Number(item.quantity)).toFixed(2)}
                        </p>
                        <p className="text-[10px] sm:text-xs text-slate-500 tabular-nums">${Number(item.price).toFixed(2)} each</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>

            {/* Order Summary */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="space-y-4 sm:space-y-5"
            >
              {/* Totals */}
              <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5 md:p-6">
                <h3 className="text-sm sm:text-base font-bold text-slate-900 mb-3 sm:mb-4">Order Summary</h3>
                <div className="space-y-2 sm:space-y-3 text-xs sm:text-sm">
                  <div className="flex justify-between text-slate-500">
                    <span>Subtotal</span>
                    <span className="tabular-nums">
                      ${Number(subtotal ?? order.total).toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between text-slate-500">
                    <span>Shipping</span>
                    {shippingCost != null ? (
                      <span className="tabular-nums">${Number(shippingCost).toFixed(2)}</span>
                    ) : (
                      <span className="text-emerald-600 font-medium">Free</span>
                    )}
                  </div>
                  <div className="border-t border-slate-100 pt-2 sm:pt-3">
                    <div className="flex justify-between">
                      <span className="font-bold text-slate-900">Total</span>
                      <span className="font-bold text-base sm:text-lg text-slate-900 tabular-nums">
                        ${Number(order.total).toFixed(2)}
                        {(order as any).currency && (order as any).currency !== 'CAD' && (
                          <span className="text-slate-400 text-xs sm:text-sm font-medium ml-1">
                            {(order as any).currency}
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Shipping Address */}
              {addressLines.length > 0 && (
                <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5 md:p-6">
                  <h3 className="text-sm sm:text-base font-bold text-slate-900 flex items-center gap-2 mb-3 sm:mb-4">
                    <MapPin className="w-4 h-4 text-cyan-600" />
                    Shipping Address
                  </h3>
                  <div className="text-slate-500 text-xs sm:text-sm leading-relaxed space-y-0.5">
                    {addressLines.map((line, i) => (
                      <p key={i}>{line}</p>
                    ))}
                  </div>
                </div>
              )}
            </motion.div>
          </div>
        </div>
      </div>

      <Footer />
    </main>
  );
}
