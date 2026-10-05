'use client';

import { todayInAppTz } from '@/lib/datetime';
import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Search, Plus, X, ChevronDown, ChevronUp, Check, Loader2,
  Package, Building2, Lock, TrendingDown, Truck,
} from 'lucide-react';
import { allocateLandedCost } from '@/lib/admin/po-landed-cost';
import { useRouter } from 'next/navigation';
import {
  createPurchaseOrder, updatePurchaseOrder, getAllSuppliers, createSupplier,
} from '@/lib/admin/purchase-orders';
import { getSupplierPrices, getCheapestSupplierPrices } from '@/lib/admin/supplier-prices';
import { isPoLocked, PO_STATUS_META } from '@/lib/admin/po-status';
import { supabase } from '@/lib/supabase';
import type {
  Supplier, TaxType, DiscountType, ProductChip, PODraftItem,
  PurchaseOrderWithSupplier, CheapestSupplierPrice,
} from '@/lib/types/ecommerce';

const INITIAL_CHIP_COUNT = 12;
const EMPTY_SUPPLIER = { name: '', contact_name: '', email: '', phone: '', lead_time_days: 7 };

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

// Mirror of the server-side summary: subtotal → +shipping → −discount → +tax.
function summarize(
  items: PODraftItem[], shippingFee: number,
  discountType: DiscountType, discountValue: number,
  taxType: TaxType, taxValue: number,
) {
  const subtotal = r2(items.reduce((s, i) => s + i.line_total, 0));
  const shipping = r2(shippingFee);
  const afterShip = subtotal + shipping;
  const discount = r2(discountType === 'percentage' ? afterShip * (discountValue / 100) : Math.min(discountValue, afterShip));
  const taxBase = afterShip - discount;
  const tax = r2(taxType === 'percentage' ? taxBase * (taxValue / 100) : taxValue);
  const total = r2(taxBase + tax);
  return { subtotal, shipping, discount, tax, total };
}

export interface BackorderPrefill {
  backorder_id: string;
  supplier_id?: string;
  items: { product_id: string; description: string; qty: number; unit_price?: number }[];
}

interface Props {
  mode: 'create' | 'edit';
  po?: PurchaseOrderWithSupplier;
  backorder?: BackorderPrefill;
  onUpdated?: (po: PurchaseOrderWithSupplier) => void;
}

export default function PurchaseOrderForm({ mode, po, backorder, onUpdated }: Props) {
  const router = useRouter();
  const locked = mode === 'edit' && po ? isPoLocked(po.status) : false;

  // ---- Supplier state ----
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierQuery, setSupplierQuery] = useState('');
  const [selectedSupplier, setSelectedSupplier] = useState<Supplier | null>(po?.supplier ?? null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [showNewSupplierForm, setShowNewSupplierForm] = useState(false);
  const [newSupplier, setNewSupplier] = useState(EMPTY_SUPPLIER);
  const [creatingSupplier, setCreatingSupplier] = useState(false);
  const supplierWrapRef = useRef<HTMLDivElement>(null);

  // ---- Product / pricing state ----
  const [products, setProducts] = useState<ProductChip[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [productSearch, setProductSearch] = useState('');
  const [chipsShown, setChipsShown] = useState(INITIAL_CHIP_COUNT);
  const [supplierPrices, setSupplierPrices] = useState<Record<string, number>>({});
  const [cheapest, setCheapest] = useState<Record<string, CheapestSupplierPrice>>({});

  const [items, setItems] = useState<PODraftItem[]>(
    (po?.items ?? []).map((i) => ({
      product_id: i.product_id ?? '',
      description: i.description,
      sku_snapshot: i.sku_snapshot ?? '',
      unit_price: Number(i.unit_price),
      qty: i.qty,
      qty_received: i.qty_received,
      line_total: Number(i.line_total),
      price_type: (i as any).price_type === 'vial' ? 'vial' : 'box',
    }))
  );

  // ---- Financials ----
  const [shippingFee, setShippingFee] = useState<number>(Number(po?.shipping_fee ?? 0));
  const [discountType, setDiscountType] = useState<DiscountType>((po?.discount_type as DiscountType) ?? 'percentage');
  const [discountValue, setDiscountValue] = useState<number>(Number(po?.discount_value ?? 0));
  const [taxType, setTaxType] = useState<TaxType>((po?.tax_type as TaxType) ?? 'percentage');
  const [taxValue, setTaxValue] = useState<number>(Number(po?.tax_value ?? 13));

  // ---- Meta ----
  const [notes, setNotes] = useState(po?.notes ?? '');
  const [orderDate, setOrderDate] = useState(po?.order_date ? po.order_date.slice(0, 10) : todayInAppTz());
  const [expectedDate, setExpectedDate] = useState(po?.expected_date ? po.expected_date.slice(0, 10) : '');
  const [createAsFulfilled, setCreateAsFulfilled] = useState(false);

  const [saving, setSaving] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);
  const [error, setError] = useState('');

  // ---- Load suppliers, products, cheapest map ----
  useEffect(() => {
    getAllSuppliers().then(setSuppliers);
    getCheapestSupplierPrices().then(setCheapest);
    supabase
      .from('products')
      .select('id, name, sku, price, stock_quantity')
      .eq('active', true)
      .order('name')
      .then(({ data }) => {
        setProducts((data ?? []).map((p: any) => ({
          id: p.id,
          product_name: p.name,
          sku: p.sku ?? '',
          unit_price: Number(p.price) || 0,
          stock_quantity: Number(p.stock_quantity) || 0,
        })));
        setLoadingProducts(false);
      });
  }, []);

  // ---- Backorder prefill (create mode) ----
  useEffect(() => {
    if (mode !== 'create' || !backorder) return;
    if (backorder.supplier_id && suppliers.length) {
      const s = suppliers.find((x) => x.id === backorder.supplier_id);
      if (s) setSelectedSupplier(s);
    }
    if (items.length === 0 && backorder.items.length) {
      setItems(backorder.items.map((bi) => ({
        product_id: bi.product_id,
        description: bi.description,
        sku_snapshot: '',
        unit_price: Number(bi.unit_price ?? 0),
        qty: bi.qty,
        line_total: r2(bi.qty * Number(bi.unit_price ?? 0)),
      })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backorder, suppliers]);

  // ---- Load the selected supplier's pricelist; default line prices from it ----
  useEffect(() => {
    if (!selectedSupplier) { setSupplierPrices({}); return; }
    getSupplierPrices(selectedSupplier.id)
      .then((rows) => {
        const map: Record<string, number> = {};
        for (const r of rows) {
          if (r.supplier_price != null) map[r.product_id] = Number(r.supplier_price);
        }
        setSupplierPrices(map);
      })
      .catch(() => setSupplierPrices({}));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSupplier?.id]);

  // ---- Close supplier dropdown on outside click ----
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (supplierWrapRef.current && !supplierWrapRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => { setChipsShown(INITIAL_CHIP_COUNT); }, [productSearch]);

  // Price to default a line for a product against the current supplier.
  function defaultPrice(productId: string, fallback: number): number {
    return supplierPrices[productId] ?? fallback;
  }

  // ---- Derived totals ----
  const summary = useMemo(
    () => summarize(items, shippingFee, discountType, discountValue, taxType, taxValue),
    [items, shippingFee, discountType, discountValue, taxType, taxValue]
  );

  // Per-line landed cost, keyed by product_id so the row render is O(1).
  // Recomputes on any item / shipping / discount change so the "Landed"
  // column stays live with what the API will persist on save.
  const landedByRow = useMemo(() => {
    const allocations = allocateLandedCost(
      items.map((i) => ({ qty: i.qty, unit_price: i.unit_price, line_total: i.line_total })),
      { shipping: summary.shipping, discount: summary.discount },
    );
    const map = new Map<string, { landed_unit_cost: number; landed_line_total: number }>();
    items.forEach((it, idx) => {
      map.set(it.product_id, allocations[idx]);
    });
    return map;
  }, [items, summary.shipping, summary.discount]);

  // ---- Cheaper-supplier suggestion ----
  const suggestion = useMemo(() => {
    if (!selectedSupplier || items.length === 0) return null;
    let best: { saving: number; sup: CheapestSupplierPrice } | null = null;
    for (const it of items) {
      const c = cheapest[it.product_id];
      if (!c || c.supplier_id === selectedSupplier.id) continue;
      const saving = (it.unit_price - c.price) * it.qty;
      if (c.price < it.unit_price && (!best || saving > best.saving)) {
        best = { saving, sup: c };
      }
    }
    return best;
  }, [items, cheapest, selectedSupplier]);

  // ---- Supplier helpers ----
  const supplierResults = useMemo(() => {
    const q = supplierQuery.trim().toLowerCase();
    if (!q) return [];
    return suppliers
      .filter((s) => s.name.toLowerCase().includes(q) || (s.email ?? '').toLowerCase().includes(q))
      .slice(0, 8);
  }, [supplierQuery, suppliers]);

  function selectSupplier(s: Supplier) {
    setSelectedSupplier(s);
    setSupplierQuery('');
    setShowDropdown(false);
    setShowNewSupplierForm(false);
  }
  function clearSupplier() { if (!locked) { setSelectedSupplier(null); setSupplierQuery(''); } }

  async function handleCreateSupplier() {
    if (!newSupplier.name.trim()) return;
    setCreatingSupplier(true);
    const res = await createSupplier({
      name: newSupplier.name.trim(),
      contact_name: newSupplier.contact_name.trim() || null,
      email: newSupplier.email.trim() || null,
      phone: newSupplier.phone.trim() || null,
      lead_time_days: newSupplier.lead_time_days,
    });
    setCreatingSupplier(false);
    if (!res.success || !res.supplier) { setError(res.error ?? 'Failed to create supplier'); return; }
    setSuppliers((prev) => [...prev, res.supplier!].sort((a, b) => a.name.localeCompare(b.name)));
    selectSupplier(res.supplier);
    setNewSupplier(EMPTY_SUPPLIER);
  }

  // ---- Switch to the cheaper supplier and re-price every line ----
  async function applySuggestion() {
    if (!suggestion) return;
    const s = suppliers.find((x) => x.id === suggestion.sup.supplier_id);
    if (!s) return;
    setSelectedSupplier(s);
    const rows = await getSupplierPrices(s.id).catch(() => []);
    const map: Record<string, number> = {};
    for (const r of rows) if (r.supplier_price != null) map[r.product_id] = Number(r.supplier_price);
    setSupplierPrices(map);
    setItems((prev) => prev.map((i) => {
      const np = map[i.product_id] ?? i.unit_price;
      return { ...i, unit_price: np, line_total: r2(np * i.qty) };
    }));
  }

  // ---- Line helpers ----
  function toggleProduct(p: ProductChip) {
    if (locked) return;
    const idx = items.findIndex((i) => i.product_id === p.id);
    if (idx !== -1) {
      setItems((prev) => prev.filter((_, i) => i !== idx));
    } else {
      const price = defaultPrice(p.id, p.unit_price);
      setItems((prev) => [...prev, {
        product_id: p.id,
        description: p.product_name,
        sku_snapshot: p.sku,
        unit_price: price,
        qty: 1,
        line_total: r2(price),
        price_type: 'box',
      }]);
    }
  }
  function updateQty(pid: string, qty: number) {
    if (locked || qty < 1) return;
    setItems((prev) => prev.map((i) => i.product_id === pid ? { ...i, qty, line_total: r2(i.unit_price * qty) } : i));
  }
  function updatePrice(pid: string, price: number) {
    if (locked) return;
    const p = Math.max(0, price);
    setItems((prev) => prev.map((i) => i.product_id === pid ? { ...i, unit_price: p, line_total: r2(p * i.qty) } : i));
  }
  /** Toggle a line between box and vial pricing. The unit price is left as-is
   *  — the receiver just needs to know which unit was quoted so the receipt
   *  flow can convert boxes → vials correctly. */
  function updatePriceType(pid: string, type: 'box' | 'vial') {
    if (locked) return;
    setItems((prev) => prev.map((i) => i.product_id === pid ? { ...i, price_type: type } : i));
  }
  function removeItem(pid: string) {
    if (locked) return;
    setItems((prev) => prev.filter((i) => i.product_id !== pid));
  }

  // ---- Product filtering ----
  const filtered = useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) => p.product_name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q));
  }, [productSearch, products]);
  const visible = filtered.slice(0, chipsShown);

  // ---- Save ----
  async function handleSave() {
    if (!selectedSupplier) { setError('Please select a supplier.'); return; }
    if (items.length === 0) { setError('Please add at least one product.'); return; }
    setSaving(true);
    setError('');

    const payloadItems = items.map((i) => ({
      product_id: i.product_id || null,
      description: i.description,
      sku_snapshot: i.sku_snapshot,
      qty: i.qty,
      unit_price: i.unit_price,
      price_type: i.price_type ?? 'box',
    }));

    if (mode === 'create') {
      const res = await createPurchaseOrder({
        supplier_id: selectedSupplier.id,
        status: createAsFulfilled ? 'fulfilled' : 'pending',
        shipping_fee: shippingFee,
        discount_type: discountType,
        discount_value: discountValue,
        tax_type: taxType,
        tax_value: taxValue,
        notes: notes.trim() || undefined,
        order_date: orderDate || undefined,
        expected_date: expectedDate || undefined,
        backorder_id: backorder?.backorder_id,
        items: payloadItems,
      });
      if (!res.success) { setError(res.error ?? 'Failed to create purchase order.'); setSaving(false); return; }
      router.push(`/admin/purchase-orders/${res.purchase_order?.id}`);
      return;
    }

    // edit
    const res = await updatePurchaseOrder(po!.id, {
      supplier_id: selectedSupplier.id,
      shipping_fee: shippingFee,
      discount_type: discountType,
      discount_value: discountValue,
      tax_type: taxType,
      tax_value: taxValue,
      notes: notes.trim() || '',
      order_date: orderDate || undefined,
      expected_date: expectedDate || undefined,
      items: payloadItems,
    });
    setSaving(false);
    if (!res.success) { setError(res.error ?? 'Failed to save purchase order.'); return; }
    if (res.purchase_order) onUpdated?.(res.purchase_order);
  }

  // ---- Manual terminal status (edit mode) ----
  async function setStatus(status: 'paid' | 'cancelled') {
    if (!po) return;
    setStatusSaving(true);
    setError('');
    const res = await updatePurchaseOrder(po.id, { status });
    setStatusSaving(false);
    if (!res.success) { setError(res.error ?? 'Failed to update status'); return; }
    if (res.purchase_order) onUpdated?.(res.purchase_order);
  }

  const dim = locked ? 'opacity-60 pointer-events-none' : '';

  return (
    <>
      {error && (
        <div className="mb-5 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      {locked && po && (
        <div className="mb-5 flex items-center gap-2 px-4 py-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
          <Lock className="w-4 h-4 flex-shrink-0" />
          This purchase order is <strong className="font-semibold">{PO_STATUS_META[po.status].label}</strong> and cannot be edited.
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-6 items-start">
        {/* ========== LEFT COLUMN ========== */}
        <div className="lg:col-span-2 space-y-6">

          {/* ---- 1. SUPPLIER ---- */}
          <div className={`bg-white rounded-xl border border-line p-5 ${dim}`}>
            <h2 className="font-semibold text-ink mb-4 text-sm flex items-center gap-2">
              <Building2 className="w-4 h-4 text-ink-muted" /> Supplier
            </h2>

            {selectedSupplier ? (
              <div className="flex items-start justify-between p-4 bg-surface rounded-xl border border-line">
                <div>
                  <p className="font-semibold text-ink">{selectedSupplier.name}</p>
                  {selectedSupplier.contact_name && <p className="text-xs text-ink-muted mt-0.5">{selectedSupplier.contact_name}</p>}
                  {selectedSupplier.email && <p className="text-xs text-ink-muted">{selectedSupplier.email}</p>}
                  {selectedSupplier.phone && <p className="text-xs text-ink-muted">{selectedSupplier.phone}</p>}
                  {selectedSupplier.lead_time_days != null && <p className="text-xs text-teal-dark mt-1">Lead time: {selectedSupplier.lead_time_days} days</p>}
                </div>
                {!locked && (
                  <button onClick={clearSupplier} className="text-ink-muted hover:text-red-500 transition-colors ml-3 flex-shrink-0">
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            ) : (
              <div ref={supplierWrapRef} className="relative">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                  <input
                    type="text"
                    value={supplierQuery}
                    onChange={(e) => { setSupplierQuery(e.target.value); setShowDropdown(true); }}
                    onFocus={() => supplierResults.length > 0 && setShowDropdown(true)}
                    placeholder="Search suppliers by name or email…"
                    className="w-full pl-10 pr-4 py-2.5 bg-surface border border-line rounded-lg text-sm text-ink placeholder-ink-muted focus:outline-none focus:ring-2 focus:ring-teal/40"
                  />
                </div>
                {showDropdown && supplierResults.length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-xl border border-line shadow-lg z-20 overflow-hidden">
                    {supplierResults.map((s) => (
                      <button key={s.id} onClick={() => selectSupplier(s)} className="w-full px-4 py-3 flex items-center justify-between hover:bg-surface transition-colors text-left">
                        <div>
                          <p className="text-sm font-medium text-ink">{s.name}</p>
                          {s.email && <p className="text-xs text-ink-muted">{s.email}</p>}
                        </div>
                        {s.lead_time_days != null && <span className="text-xs text-ink-muted ml-4 flex-shrink-0">{s.lead_time_days}d lead</span>}
                      </button>
                    ))}
                  </div>
                )}
                <button onClick={() => setShowNewSupplierForm((v) => !v)} className="mt-3 text-sm text-teal-dark hover:text-teal-dark/80 flex items-center gap-1.5 transition-colors">
                  <Plus className="w-3.5 h-3.5" /> Create new supplier
                  {showNewSupplierForm ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </button>
                {showNewSupplierForm && (
                  <div className="mt-3 p-4 bg-surface rounded-xl border border-line space-y-3">
                    <p className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-1">New Supplier</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {[
                        { label: 'Company Name *', key: 'name', type: 'text' },
                        { label: 'Contact Person', key: 'contact_name', type: 'text' },
                        { label: 'Email', key: 'email', type: 'email' },
                        { label: 'Phone', key: 'phone', type: 'tel' },
                      ].map(({ label, key, type }) => (
                        <div key={key}>
                          <label className="block text-xs font-medium text-ink-muted mb-1">{label}</label>
                          <input type={type} value={(newSupplier as any)[key]} onChange={(e) => setNewSupplier((p) => ({ ...p, [key]: e.target.value }))} className="w-full px-3 py-2 bg-white border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40" />
                        </div>
                      ))}
                      <div>
                        <label className="block text-xs font-medium text-ink-muted mb-1">Lead Time (days)</label>
                        <input type="number" min={1} value={newSupplier.lead_time_days} onChange={(e) => setNewSupplier((p) => ({ ...p, lead_time_days: parseInt(e.target.value) || 7 }))} className="w-full px-3 py-2 bg-white border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40" />
                      </div>
                    </div>
                    <div className="flex gap-2 pt-1">
                      <button onClick={() => { setShowNewSupplierForm(false); setNewSupplier(EMPTY_SUPPLIER); }} className="px-3 py-1.5 border border-line rounded-lg text-xs text-ink-muted hover:text-ink">Cancel</button>
                      <button onClick={handleCreateSupplier} disabled={creatingSupplier || !newSupplier.name.trim()} className="px-4 py-1.5 bg-ink text-white rounded-lg text-xs font-medium hover:bg-ink/90 disabled:opacity-50 flex items-center gap-1.5">
                        {creatingSupplier ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Save Supplier
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Cheaper-supplier prompt */}
            {!locked && suggestion && (
              <div className="mt-4 flex items-center justify-between gap-3 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-lg">
                <div className="flex items-center gap-2 text-sm text-emerald-800">
                  <TrendingDown className="w-4 h-4 flex-shrink-0" />
                  <span><strong className="font-semibold">{suggestion.sup.supplier_name}</strong> is cheaper — save up to ${suggestion.saving.toFixed(2)}.</span>
                </div>
                <button onClick={applySuggestion} className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700 transition-colors flex-shrink-0">
                  Switch &amp; re-price
                </button>
              </div>
            )}
          </div>

          {/* ---- 2. PRODUCTS ---- */}
          <div className={`bg-white rounded-xl border border-line overflow-hidden ${dim}`}>
            <div className="p-5 border-b border-line">
              <h2 className="font-semibold text-ink mb-3 text-sm flex items-center gap-2">
                <Package className="w-4 h-4 text-ink-muted" /> Products
              </h2>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted" />
                <input type="text" placeholder="Filter by name or SKU…" value={productSearch} onChange={(e) => setProductSearch(e.target.value)} className="w-full pl-9 pr-4 py-2 bg-surface border border-line rounded-lg text-sm text-ink placeholder-ink-muted focus:outline-none focus:ring-2 focus:ring-teal/40" />
              </div>
            </div>
            <div className="p-5">
              {loadingProducts ? (
                <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-ink-muted" /></div>
              ) : filtered.length === 0 ? (
                <p className="text-center text-ink-muted text-sm py-8">{productSearch ? 'No products match your search' : 'No active products'}</p>
              ) : (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {visible.map((p) => {
                      const isSel = items.some((i) => i.product_id === p.id);
                      const price = defaultPrice(p.id, p.unit_price);
                      const cheaper = cheapest[p.id] && selectedSupplier && cheapest[p.id].supplier_id !== selectedSupplier.id && cheapest[p.id].price < price;
                      return (
                        <button key={p.id} onClick={() => toggleProduct(p)} className={`text-left p-3 rounded-xl border transition-all ${isSel ? 'border-teal bg-teal/5 ring-1 ring-teal/30 shadow-sm' : 'border-line hover:border-ink/20 hover:bg-surface'}`}>
                          <div className="flex items-start justify-between gap-1">
                            <p className="font-medium text-sm text-ink leading-tight truncate flex-1">{p.product_name}</p>
                            {isSel && <Check className="w-3.5 h-3.5 text-teal-dark flex-shrink-0 mt-0.5" />}
                          </div>
                          <p className="text-xs text-ink-muted mt-0.5 truncate">{p.sku || 'No SKU'} · {p.stock_quantity} in stock</p>
                          <p className="text-xs font-semibold text-teal-dark mt-1.5 tabular-nums flex items-center gap-1">
                            ${price.toFixed(2)}
                            {cheaper && <TrendingDown className="w-3 h-3 text-emerald-600" />}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                  {filtered.length > chipsShown && (
                    <button onClick={() => setChipsShown((n) => n + 12)} className="mt-4 w-full py-2 text-sm text-ink-muted hover:text-ink border border-line border-dashed rounded-lg transition-colors">
                      Show more ({filtered.length - chipsShown} remaining)
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {/* ---- 3. SELECTED ITEMS ---- */}
          {items.length > 0 && (
            <div className="bg-white rounded-xl border border-line overflow-hidden">
              <div className="px-5 py-4 border-b border-line">
                <h2 className="font-semibold text-ink text-sm">
                  Selected Products
                  <span className="ml-2 text-xs font-normal text-ink-muted bg-surface px-2 py-0.5 rounded-full">{items.length}</span>
                </h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line bg-surface">
                      <th className="px-4 py-2.5 text-left text-xs text-ink-muted font-semibold uppercase tracking-wide">Product</th>
                      <th className="px-4 py-2.5 text-left text-xs text-ink-muted font-semibold uppercase tracking-wide">SKU</th>
                      <th className="px-4 py-2.5 text-right text-xs text-ink-muted font-semibold uppercase tracking-wide">Unit Price</th>
                      <th className="px-4 py-2.5 text-center text-xs text-ink-muted font-semibold uppercase tracking-wide w-28">Qty</th>
                      <th className="px-4 py-2.5 text-right text-xs text-ink-muted font-semibold uppercase tracking-wide" title="Supplier price + this line's share of shipping − share of discount">Landed / unit</th>
                      <th className="px-4 py-2.5 text-right text-xs text-ink-muted font-semibold uppercase tracking-wide">Total</th>
                      {!locked && <th className="w-10" />}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/50">
                    {items.map((item) => (
                      <tr key={item.product_id}>
                        <td className="px-4 py-3 text-ink font-medium">
                          <div>{item.description}</div>
                          {/* Box vs Vial picker — determines whether the receiver
                              treats the qty as boxes (converts via vials_per_box)
                              or as individual vials. Metadata only; the unit
                              price stays whatever the admin typed. */}
                          {!locked && (
                            <div className="mt-1.5 inline-flex rounded-md border border-line overflow-hidden text-[11px]">
                              {(['box', 'vial'] as const).map((t) => {
                                const active = (item.price_type ?? 'box') === t;
                                return (
                                  <button
                                    key={t}
                                    type="button"
                                    onClick={() => updatePriceType(item.product_id, t)}
                                    className={`px-2 py-0.5 font-medium transition-colors ${
                                      active
                                        ? t === 'vial'
                                          ? 'bg-indigo-500 text-white'
                                          : 'bg-ink text-white'
                                        : 'bg-white text-ink-muted hover:text-ink'
                                    }`}
                                    title={t === 'vial' ? 'Price is per single vial' : 'Price is per box (pack of vials_per_box)'}
                                  >
                                    {t === 'vial' ? 'Vial' : 'Box'}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                          {locked && (
                            <span className="mt-1 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-slate-100 text-slate-600">
                              {(item.price_type ?? 'box') === 'vial' ? 'Vial' : 'Box'}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-ink-muted">{item.sku_snapshot}</td>
                        <td className="px-4 py-3">
                          {locked ? (
                            <span className="text-sm tabular-nums text-ink-muted float-right">${item.unit_price.toFixed(2)}</span>
                          ) : (
                            <div className="relative flex justify-end">
                              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-ink-muted">$</span>
                              <input type="number" min={0} step="0.01" value={item.unit_price} onChange={(e) => updatePrice(item.product_id, parseFloat(e.target.value) || 0)} className="w-24 pl-5 pr-2 py-1 bg-surface border border-line rounded-lg text-sm text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-teal/40" />
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-center gap-1">
                            {locked ? (
                              <span className="text-sm tabular-nums text-ink font-medium">{item.qty}</span>
                            ) : (
                              <>
                                <button onClick={() => updateQty(item.product_id, item.qty - 1)} disabled={item.qty <= 1} className="w-7 h-7 rounded-lg bg-surface border border-line text-ink-muted hover:text-ink transition-colors disabled:opacity-30 flex items-center justify-center font-bold">−</button>
                                <input type="number" min={1} value={item.qty} onChange={(e) => updateQty(item.product_id, parseInt(e.target.value) || 1)} className="w-12 text-center px-1 py-1 bg-surface border border-line rounded-lg text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-teal/40" />
                                <button onClick={() => updateQty(item.product_id, item.qty + 1)} className="w-7 h-7 rounded-lg bg-surface border border-line text-ink-muted hover:text-ink transition-colors flex items-center justify-center font-bold">+</button>
                              </>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-ink-muted">
                          {(() => {
                            const lc = landedByRow.get(item.product_id);
                            const landedUnit = lc?.landed_unit_cost ?? item.unit_price;
                            const share = landedUnit - item.unit_price;
                            return (
                              <span
                                className="inline-flex items-center gap-1 text-sm"
                                title={`Includes ${share >= 0 ? '+' : ''}$${Math.abs(share).toFixed(4)} shipping/discount per unit`}
                              >
                                <Truck className="w-3 h-3 text-teal-dark/70" />
                                ${landedUnit.toFixed(2)}
                              </span>
                            );
                          })()}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold tabular-nums text-ink">${item.line_total.toFixed(2)}</td>
                        {!locked && (
                          <td className="px-4 py-3">
                            <button onClick={() => removeItem(item.product_id)} className="text-ink-muted hover:text-red-500 transition-colors"><X className="w-4 h-4" /></button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* ========== RIGHT COLUMN ========== */}
        <div className="space-y-4">

          {/* ---- Financial Summary ---- */}
          <div className={`bg-white rounded-xl border border-line p-5 ${dim}`}>
            <h2 className="font-semibold text-ink mb-4 text-sm">Financial Summary</h2>

            {/* Shipping */}
            <div className="mb-4">
              <label className="block text-xs font-medium text-ink-muted mb-1">Shipping Fee ($)</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted text-sm">$</span>
                <input type="number" min={0} step="0.01" value={shippingFee} onChange={(e) => setShippingFee(parseFloat(e.target.value) || 0)} className="w-full pl-8 pr-3 py-2 bg-surface border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40" />
              </div>
            </div>

            {/* Discount */}
            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-medium text-ink-muted">Discount</p>
                <div className="flex gap-1 p-0.5 bg-surface rounded-lg">
                  {(['percentage', 'fixed'] as DiscountType[]).map((t) => (
                    <button key={t} onClick={() => setDiscountType(t)} className={`px-2 py-1 rounded-md text-xs font-medium transition-all ${discountType === t ? 'bg-white shadow-sm text-ink border border-line' : 'text-ink-muted hover:text-ink'}`}>{t === 'percentage' ? '%' : '$'}</button>
                  ))}
                </div>
              </div>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted text-sm">{discountType === 'percentage' ? '%' : '$'}</span>
                <input type="number" min={0} step={discountType === 'percentage' ? '0.1' : '0.01'} value={discountValue} onChange={(e) => setDiscountValue(parseFloat(e.target.value) || 0)} className="w-full pl-8 pr-3 py-2 bg-surface border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40" />
              </div>
            </div>

            {/* Tax */}
            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-medium text-ink-muted">Tax</p>
                <div className="flex gap-1 p-0.5 bg-surface rounded-lg">
                  {(['percentage', 'fixed'] as TaxType[]).map((t) => (
                    <button key={t} onClick={() => setTaxType(t)} className={`px-2 py-1 rounded-md text-xs font-medium transition-all ${taxType === t ? 'bg-white shadow-sm text-ink border border-line' : 'text-ink-muted hover:text-ink'}`}>{t === 'percentage' ? '%' : '$'}</button>
                  ))}
                </div>
              </div>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted text-sm">{taxType === 'percentage' ? '%' : '$'}</span>
                <input type="number" min={0} step={taxType === 'percentage' ? '0.1' : '0.01'} value={taxValue} onChange={(e) => setTaxValue(parseFloat(e.target.value) || 0)} className="w-full pl-8 pr-3 py-2 bg-surface border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40" />
              </div>
            </div>

            {/* Breakdown */}
            <div className="space-y-2 border-t border-line pt-4">
              <div className="flex justify-between text-sm"><span className="text-ink-muted">Subtotal</span><span className="tabular-nums font-medium text-ink">${summary.subtotal.toFixed(2)}</span></div>
              {summary.shipping > 0 && <div className="flex justify-between text-sm"><span className="text-ink-muted">Shipping</span><span className="tabular-nums text-ink">${summary.shipping.toFixed(2)}</span></div>}
              {summary.discount > 0 && <div className="flex justify-between text-sm"><span className="text-ink-muted">Discount {discountType === 'percentage' ? `(${discountValue}%)` : ''}</span><span className="tabular-nums text-emerald-600">−${summary.discount.toFixed(2)}</span></div>}
              <div className="flex justify-between text-sm"><span className="text-ink-muted">Tax {taxType === 'percentage' ? `(${taxValue}%)` : '(fixed)'}</span><span className="tabular-nums text-ink">${summary.tax.toFixed(2)}</span></div>
              <div className="flex justify-between font-bold text-base pt-2 border-t border-line"><span className="text-ink">Total</span><span className="tabular-nums text-ink">${summary.total.toFixed(2)}</span></div>
            </div>
          </div>

          {/* ---- Dates ---- */}
          <div className={`bg-white rounded-xl border border-line p-5 space-y-4 ${dim}`}>
            <div>
              <label className="block text-xs font-medium text-ink-muted mb-2">Order Date</label>
              <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} disabled={locked} className="w-full px-3 py-2.5 bg-surface border border-line rounded-lg text-sm text-ink focus:outline-none focus:ring-2 focus:ring-teal/40 disabled:opacity-50" />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-muted mb-2">Expected Delivery Date</label>
              <input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} disabled={locked} className="w-full px-3 py-2.5 bg-surface border border-line rounded-lg text-sm text-ink focus:outline-none focus:ring-2 focus:ring-teal/40 disabled:opacity-50" />
            </div>
          </div>

          {/* ---- Notes ---- */}
          <div className={`bg-white rounded-xl border border-line p-5 ${dim}`}>
            <label className="block text-xs font-medium text-ink-muted mb-2">Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} disabled={locked} placeholder="Payment terms, delivery instructions, references…" className="w-full px-3 py-2.5 bg-surface border border-line rounded-lg text-sm text-ink resize-none focus:outline-none focus:ring-2 focus:ring-teal/40 disabled:opacity-50" />
          </div>

          {/* ---- Create-as-fulfilled (create only) ---- */}
          {mode === 'create' && (
            <label className="flex items-center gap-2 bg-white rounded-xl border border-line p-4 cursor-pointer">
              <input type="checkbox" checked={createAsFulfilled} onChange={(e) => setCreateAsFulfilled(e.target.checked)} className="rounded border-line text-teal-dark focus:ring-teal/40" />
              <span className="text-sm text-ink">Mark as fully received now <span className="text-ink-muted">(applies stock immediately)</span></span>
            </label>
          )}

          {/* ---- Save ---- */}
          {!locked && (
            <button onClick={handleSave} disabled={saving || !selectedSupplier || items.length === 0} className="w-full py-3 bg-ink text-white rounded-xl text-sm font-semibold hover:bg-ink/90 transition-colors disabled:opacity-40 flex items-center justify-center gap-2">
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {saving ? 'Saving…' : mode === 'create' ? 'Create Purchase Order' : 'Save Changes'}
            </button>
          )}

          {/* ---- Manual terminal status (edit) ---- */}
          {mode === 'edit' && po && po.status !== 'cancelled' && (
            <div className="bg-white rounded-xl border border-line p-5 space-y-2">
              <h2 className="font-semibold text-ink text-sm mb-2">Status Actions</h2>
              {po.status !== 'paid' && (
                <button onClick={() => setStatus('paid')} disabled={statusSaving} className="w-full py-2.5 px-4 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 text-sm font-medium hover:bg-emerald-100 transition-colors disabled:opacity-40 flex items-center justify-center gap-2">
                  {statusSaving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Mark as Paid
                </button>
              )}
              <button onClick={() => setStatus('cancelled')} disabled={statusSaving} className="w-full py-2.5 px-4 rounded-lg border border-line bg-surface text-ink-muted text-sm font-medium hover:text-red-600 hover:border-red-200 hover:bg-red-50 transition-colors disabled:opacity-40">
                Cancel Order
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
