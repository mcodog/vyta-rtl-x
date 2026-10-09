'use client';

import { addDays, todayInAppTz } from '@/lib/datetime';
import React, { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Plus, Trash2, Loader2, Save, Search, X, User, Link2, UserPlus, Briefcase, PackageX, Truck, Store, Tag, Beaker, Package, Check, MapPin } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import {
  createInvoice, replaceInvoice,
  listCustomerClients, createCustomerClient,
  shippingReadiness,
  type CustomerClient,
  type ShippingReadinessResult, type ShippingReadinessRate,
} from '@/lib/admin/invoices';
import { createCustomerRecord, updateCustomerRecord } from '@/lib/admin/customers';
import AddressAutocomplete from '@/components/AddressAutocomplete';
import { searchSalesPersons, createSalesPerson } from '@/lib/admin/sales-persons';
import { getActivePricelist } from '@/lib/admin/pricelists';
import type { SalesPerson, InvoiceLineItem, Invoice } from '@/lib/types/ecommerce';
import { formatMoney, normalizeCurrency, DEFAULT_CURRENCY, type Currency } from '@/lib/currency';
import { vialPriceFor as catalogVialPrice } from '@/lib/pricing';
import { DEFAULT_COURIER_PREFERENCE, type CourierPreference } from '@/lib/shipping/courier-pick';

interface CustomerRef {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone?: string | null;
  preferred_currency?: string | null;
}

interface SearchItem {
  id: string;                // product id
  label: string;
  sku: string;
  unit_price: number;        // canonical box price
  vial_price: number | null; // explicit vial price, if set
  stock_quantity: number;    // current stock on the product
}

interface LineItemDraft {
  description: string;
  qty: string;
  unit_price: string;
  discount_pct: string;
  showVariantDrop: boolean;
  product_id: string | null; // populated when an item is selected from the picker
  stock_quantity: number;    // -1 = untracked / no product linked
  price_type: 'box' | 'vial';
  /** Original per-unit prices captured at pick time so we can re-price
   *  cleanly when the admin toggles Box/Vial without losing either side. */
  box_price: number | null;
  vial_price: number | null;
}

function calcLineTotal(li: LineItemDraft) {
  const qty = parseFloat(li.qty) || 0;
  const price = parseFloat(li.unit_price) || 0;
  const disc = parseFloat(li.discount_pct) || 0;
  return price * qty * (1 - disc / 100);
}

const EMPTY_LINE = (): LineItemDraft => ({
  description: '', qty: '1', unit_price: '0', discount_pct: '0',
  showVariantDrop: false, product_id: null, stock_quantity: -1,
  price_type: 'box', box_price: null, vial_price: null,
});

/** Where a server-resolved destination came from. An address Stealth Health reported
 *  and one typed into this admin must never read the same to whoever packs the
 *  parcel. */
const DESTINATION_SOURCE_LABEL: Record<string, string> = {
  order: 'from the linked order',
  puramass: 'reported by Stealth Health on the hosted checkout',
  client: 'from the drop-ship client',
  customer: 'from the customer profile',
};

/** Vial price for an invoice line — the same rule the storefront quotes:
 *  the product's explicit vial_price when set, otherwise the box price ÷ 10
 *  (a box holds ten vials). */
function vialPriceFor(boxPrice: number, explicitVial: number | null): number {
  return catalogVialPrice({ price: boxPrice, vial_price: explicitVial });
}

export interface InvoiceFormInitial {
  invoice: Invoice & {
    customer_name?: string | null;
    customer_email?: string | null;
    customer_phone?: string | null;
    sales_person_name?: string | null;
    sales_person_email?: string | null;
  };
  line_items: InvoiceLineItem[];
}

export interface InvoiceFormProps {
  mode: 'create' | 'edit';
  invoiceId?: string;
  initial?: InvoiceFormInitial;
}

export default function InvoiceForm({ mode, invoiceId, initial }: InvoiceFormProps) {
  const router = useRouter();
  const isEdit = mode === 'edit';

  // ---- Customer ----
  const [customerQuery, setCustomerQuery] = useState('');
  const [customerResults, setCustomerResults] = useState<CustomerRef[]>([]);
  const [customerSearched, setCustomerSearched] = useState(false);
  const [linkedCustomer, setLinkedCustomer] = useState<CustomerRef | null>(null);
  const [showCustomerDrop, setShowCustomerDrop] = useState(false);
  const customerWrapRef = useRef<HTMLDivElement>(null);

  // ---- Create-customer modal ----
  const [showNewCustomer, setShowNewCustomer] = useState(false);
  const [newCust, setNewCust] = useState({
    first_name: '', last_name: '', email: '', phone: '',
    address: '', city: '', state: '', postal_code: '', country: 'CA',
  });
  // Optional address sub-panel inside the New Customer modal — seeds the
  // customer's shipping profile and (via the profile-load effect) pre-fills
  // the Ship-to destination once the new customer is linked.
  const [showNewCustAddr, setShowNewCustAddr] = useState(false);
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [newCustErr, setNewCustErr] = useState('');

  // ---- Sales person ----
  const [salesQuery, setSalesQuery] = useState('');
  const [salesResults, setSalesResults] = useState<SalesPerson[]>([]);
  const [linkedSalesPerson, setLinkedSalesPerson] = useState<SalesPerson | null>(null);
  const [showSalesDrop, setShowSalesDrop] = useState(false);
  const [salesCommissionRate, setSalesCommissionRate] = useState('0');
  const salesWrapRef = useRef<HTMLDivElement>(null);

  // ---- Create-sales-person modal ----
  const [showNewSales, setShowNewSales] = useState(false);
  const [newSales, setNewSales] = useState({ first_name: '', last_name: '', email: '', phone: '', commission_rate: '5' });
  const [creatingSales, setCreatingSales] = useState(false);
  const [newSalesErr, setNewSalesErr] = useState('');

  // ---- Product search items ----
  const [searchItems, setSearchItems] = useState<SearchItem[]>([]);

  // Hybrid H chain prices for the picked customer (override > active pricelist).
  // Keyed by product_id. Falls back to SearchItem.unit_price for products
  // outside the chain. Refreshes whenever the linked customer changes.
  const [chainPrices, setChainPrices] = useState<Record<string, number>>({});

  // ---- Invoice fields ----
  const [dueDate, setDueDate] = useState(
    addDays(todayInAppTz(), 30),
  );
  const [notes, setNotes] = useState('');
  const [currency, setCurrency] = useState<Currency>(DEFAULT_CURRENCY);
  const [taxPct, setTaxPct] = useState('13');
  const [shippingCost, setShippingCost] = useState('0');
  const [items, setItems] = useState<LineItemDraft[]>([EMPTY_LINE()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showBackorderConfirm, setShowBackorderConfirm] = useState(false);

  // ---- Fulfillment / labels / processing fee (spec §6) ----
  const [fulfillmentType, setFulfillmentType] = useState<'shipment' | 'pickup'>('shipment');
  const [withLabels, setWithLabels] = useState(true);
  const [processingFee, setProcessingFee] = useState('0');
  const [showProcessingFee, setShowProcessingFee] = useState(true);

  // ---- Ships to a Client (drop-ship) ----
  // When enabled, the invoice bills the customer but the order ships to one
  // of the customer's saved clients (or a brand-new one captured inline).
  const [shipsToClient, setShipsToClient] = useState(false);
  const [savedClients, setSavedClients] = useState<CustomerClient[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [newClient, setNewClient] = useState({
    first_name: '', last_name: '', address: '', city: '', state: '',
    postal_code: '', country: 'CA', phone: '', email: '',
  });
  const [creatingClient, setCreatingClient] = useState(false);
  const [clientError, setClientError] = useState('');

  // ---- Ship to (destination for a direct shipment) ----
  // Create + shipment only, and only when NOT drop-shipping to a client. The
  // parcel destination for an invoice that ships straight to the customer. It
  // has no column of its own on the invoice (a manual invoice has no order
  // yet), so its durable home is the customer's profile — the same place the
  // Easyship readiness check and label creation already read from. Blank
  // phone/email fall back to a house default on the label and can be filled
  // in later from the order's Shipping Label panel.
  const emptyShipTo = {
    first_name: '', last_name: '', address: '', city: '', state: '',
    postal_code: '', country: 'CA', phone: '', email: '',
  };
  const [shipTo, setShipTo] = useState({ ...emptyShipTo });
  // Snapshot of the linked customer's saved profile address, used to decide
  // whether the typed Ship-to differs enough to offer a "Save to profile".
  const [profileAddr, setProfileAddr] = useState<null | {
    address: string; city: string; state: string; postal_code: string;
    country: string; phone: string;
  }>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savedProfile, setSavedProfile] = useState(false);
  const [profileErr, setProfileErr] = useState('');

  // ---- Easyship Shipment card (shipping-readiness pre-flight) ----
  const [readiness, setReadiness] = useState<ShippingReadinessResult | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [selectedRateId, setSelectedRateId] = useState<string | null>(null);
  const [shippingCostAutoFilled, setShippingCostAutoFilled] = useState(false);
  // Opt-in: create the Easyship shipment record after the invoice saves.
  // When on, the picked rate's courier id, handover, insurance, and optional
  // buy-label are sent with the invoice payload and fired via after() on the
  // server so the save never blocks on Easyship.
  const [createShipment, setCreateShipment] = useState(false);
  // Carrier choice when no specific live rate is picked. 'best_value' (the
  // default) books the cheapest UPS / Canada Post service that arrives within
  // 2 days; 'ups' / 'canada_post' pin the carrier and take its best-value
  // service from a fresh quote at creation time.
  const [courierPreference, setCourierPreference] =
    useState<CourierPreference>(DEFAULT_COURIER_PREFERENCE);
  const [handover, setHandover] = useState<'dropoff' | 'collection' | 'free_collection'>('dropoff');
  const [insured, setInsured] = useState(false);
  const [buyLabel, setBuyLabel] = useState(false);

  // ---- Hydrate from `initial` for edit mode ----
  useEffect(() => {
    if (!initial) return;
    const inv = initial.invoice;

    // Customer
    if (inv.customer_id) {
      setLinkedCustomer({
        id: inv.customer_id,
        first_name: (inv.customer_name ?? '').split(' ')[0] || '',
        last_name: (inv.customer_name ?? '').split(' ').slice(1).join(' '),
        email: inv.customer_email ?? '',
        phone: inv.customer_phone ?? null,
      });
    } else if (inv.customer_name) {
      setCustomerQuery(inv.customer_name);
    }

    // Sales person
    if (inv.sales_person_id && inv.sales_person_name) {
      setLinkedSalesPerson({
        id: inv.sales_person_id,
        first_name: inv.sales_person_name.split(' ')[0] || '',
        last_name: inv.sales_person_name.split(' ').slice(1).join(' '),
        email: inv.sales_person_email ?? null,
        phone: null,
        commission_rate: Number(inv.sales_person_commission_rate ?? 0),
        notes: null,
        active: true,
        total_earnings: 0,
        created_at: '',
        updated_at: '',
      });
      setSalesCommissionRate(String(inv.sales_person_commission_rate ?? 0));
    }

    // Dates / notes
    setDueDate(inv.due_date?.slice(0, 10) || dueDate);
    setNotes(inv.notes ?? '');
    setCurrency(normalizeCurrency(inv.currency));
    setShippingCost(String(inv.shipping_cost ?? 0));

    // Fulfillment / labels / processing fee — hydrate from saved invoice.
    setFulfillmentType((inv as any).fulfillment_type === 'pickup' ? 'pickup' : 'shipment');
    setWithLabels((inv as any).with_labels !== false);
    setProcessingFee(String((inv as any).processing_fee ?? 0));
    setShowProcessingFee((inv as any).show_processing_fee !== false);

    // Ships-to-Client (drop-ship) — hydrate binding and pre-fill selection.
    setShipsToClient(!!(inv as any).ships_to_client);
    setSelectedClientId((inv as any).client_id ?? null);

    // Derive tax pct from existing values to preserve rate
    const sub = Number(inv.subtotal) || 0;
    const tax = Number(inv.tax_total) || 0;
    const pct = sub > 0 ? +((tax / sub) * 100).toFixed(3) : 13;
    setTaxPct(String(pct));

    // Line items — stock figures get backfilled once `searchItems` loads.
    // box_price/vial_price seed from the persisted unit_price so future
    // price_type toggles stay coherent for lines saved before the toggle
    // existed.
    if (initial.line_items.length > 0) {
      setItems(
        initial.line_items.map((li: any) => {
          const pt: 'box' | 'vial' = li.price_type === 'vial' ? 'vial' : 'box';
          const unit = Number(li.unit_price) || 0;
          return {
            description: li.description,
            qty: String(li.qty),
            unit_price: String(li.unit_price),
            discount_pct: String(li.discount_pct ?? 0),
            showVariantDrop: false,
            product_id: li.product_id ?? null,
            stock_quantity: -1,
            price_type: pt,
            box_price: pt === 'box' ? unit : null,
            vial_price: pt === 'vial' ? unit : null,
          };
        }),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  // Backfill stock_quantity on existing line items once products load
  useEffect(() => {
    if (searchItems.length === 0) return;
    setItems((prev) => prev.map((li) => {
      if (!li.product_id) return li;
      const match = searchItems.find((s) => s.id === li.product_id);
      if (!match) return li;
      return { ...li, stock_quantity: match.stock_quantity };
    }));
  }, [searchItems]);

  // ---- Load products on mount (stock tracked on products.stock_quantity) ----
  useEffect(() => {
    // Load the product catalog for the per-line autocomplete. Try a direct
    // Supabase SELECT first (fast, cheap), but fall back to /api/products
    // when the anon client returns nothing (RLS misconfig, session hiccup,
    // network blip). Without the fallback a failing fetch left `searchItems`
    // empty and every product search silently returned zero results —
    // "retatrutide" never showing was the reported symptom.
    (async () => {
      const mapRows = (rows: any[]): SearchItem[] => rows.map((p) => ({
        id: p.id,
        sku: p.sku ?? '',
        label: p.strength ? `${p.name} — ${p.strength}` : p.name,
        unit_price: Number(p.sale_price ?? p.price ?? p.cost_price ?? 0),
        vial_price: p.vial_price != null ? Number(p.vial_price) : null,
        stock_quantity: Number(p.stock_quantity ?? 0),
      }));

      const { data, error } = await supabase
        .from('products')
        .select('id, name, sku, stock_quantity, cost_price, price, strength, vial_price')
        .order('name');
      if (error) {
        console.error('[InvoiceForm] direct products fetch failed:', error.message);
      }
      if (Array.isArray(data) && data.length > 0) {
        setSearchItems(mapRows(data));
        return;
      }

      // Fallback: hit the public route (service-role, RLS bypassed). Same
      // shape as the direct query so the mapper doesn't need to branch.
      try {
        const res = await fetch('/api/products', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const fallback = Array.isArray(body?.products) ? body.products : Array.isArray(body) ? body : [];
        if (fallback.length === 0) {
          console.warn('[InvoiceForm] product catalog is empty — search will show no matches');
        }
        setSearchItems(mapRows(fallback));
      } catch (fallbackErr) {
        console.error('[InvoiceForm] fallback products fetch failed:', fallbackErr);
        setSearchItems([]);
      }
    })();
  }, []);

  // Refresh the customer's saved clients (ship-to address book) whenever the
  // customer selection changes. Reset any stale picked client id if it no
  // longer belongs to the newly-selected customer.
  useEffect(() => {
    let cancelled = false;
    if (!linkedCustomer?.id) {
      setSavedClients([]);
      return;
    }
    listCustomerClients(linkedCustomer.id).then((clients) => {
      if (cancelled) return;
      setSavedClients(clients);
      if (selectedClientId && !clients.some((c) => c.id === selectedClientId)) {
        setSelectedClientId(null);
      }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedCustomer?.id]);

  // ---- Hybrid H: fetch chain prices when the customer selection changes ----
  // override > active pricelist > products.price. The fetched map seeds new
  // line items via selectSearchItem; existing lines keep their admin-edited
  // prices.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { prices } = await getActivePricelist(linkedCustomer?.id ?? null);
      if (!cancelled) setChainPrices(prices ?? {});
    })();
    return () => {
      cancelled = true;
    };
  }, [linkedCustomer?.id]);

  // Load the linked customer's saved shipping address so the Ship-to block
  // pre-fills (and we can tell later whether the typed address diverged from
  // their profile). Create mode only — on edit the destination is owned by
  // the already-linked order, not this form. Guest invoices (no linked
  // customer) keep whatever was typed and start with no profile snapshot.
  useEffect(() => {
    if (isEdit) return;
    let cancelled = false;
    setSavedProfile(false);
    setProfileErr('');
    if (!linkedCustomer?.id) {
      setProfileAddr(null);
      return;
    }
    (async () => {
      const { data } = await supabase
        .from('customers')
        .select('first_name, last_name, phone, shipping_address, shipping_city, shipping_state, shipping_postal_code, shipping_country')
        .eq('id', linkedCustomer.id)
        .maybeSingle();
      if (cancelled) return;
      const snap = {
        address: data?.shipping_address ?? '',
        city: data?.shipping_city ?? '',
        state: data?.shipping_state ?? '',
        postal_code: data?.shipping_postal_code ?? '',
        country: data?.shipping_country ?? 'CA',
        phone: data?.phone ?? '',
      };
      setProfileAddr(snap);
      // Prefill the Ship-to from the profile, but never clobber anything the
      // admin has already typed for this invoice.
      setShipTo((prev) => {
        const untouched =
          !prev.address.trim() && !prev.city.trim() && !prev.postal_code.trim() &&
          !prev.phone.trim() && !prev.email.trim() &&
          !prev.first_name.trim() && !prev.last_name.trim();
        if (!untouched) return prev;
        return {
          first_name: data?.first_name ?? '',
          last_name: data?.last_name ?? '',
          address: snap.address,
          city: snap.city,
          state: snap.state,
          postal_code: snap.postal_code,
          country: snap.country || 'CA',
          phone: snap.phone,
          email: linkedCustomer.email ?? '',
        };
      });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedCustomer?.id]);

  // New invoices inherit the linked customer's billing currency. Edit mode
  // keeps whatever currency the invoice was saved with.
  useEffect(() => {
    if (isEdit) return;
    if (linkedCustomer?.preferred_currency) {
      setCurrency(normalizeCurrency(linkedCustomer.preferred_currency));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedCustomer?.id]);

  // When the customer changes, re-price any product-linked line items into the
  // new customer's pricing (override > pricelist > list price, denominated in
  // their currency). The first chainPrices load in edit mode is skipped so a
  // saved invoice keeps its historical prices until the customer is changed.
  const skipRepriceRef = useRef(isEdit);
  useEffect(() => {
    if (skipRepriceRef.current) {
      skipRepriceRef.current = false;
      return;
    }
    if (Object.keys(chainPrices).length === 0) return;
    setItems((prev) => prev.map((li) => {
      if (!li.product_id) return li;
      const cp = chainPrices[li.product_id];
      if (cp == null) return li;
      // The chain price is the box price. Recompute the vial price against it
      // and honor the row's current price_type so a re-price doesn't silently
      // flip a Vial line back to Box pricing.
      const nextBox = cp;
      const nextVial = vialPriceFor(nextBox, li.vial_price);
      return {
        ...li,
        box_price: nextBox,
        vial_price: nextVial,
        unit_price: String(li.price_type === 'vial' ? nextVial : nextBox),
      };
    }));
  }, [chainPrices]);

  // Currency toggle re-prices product-linked lines from products.price_usd /
  // vial_price_usd when available, or scales by an exchange rate otherwise.
  // Skips custom (untyped) lines and always honors each row's price_type.
  const lastCurrencyRef = useRef<Currency>(currency);
  useEffect(() => {
    const from = lastCurrencyRef.current;
    const to = currency;
    if (from === to) return;
    lastCurrencyRef.current = to;
    // No product data loaded yet — nothing to re-price.
    if (searchItems.length === 0) return;
    setItems((prev) => prev.map((li) => {
      if (!li.product_id) return li;
      const match = searchItems.find((s) => s.id === li.product_id);
      if (!match) return li;
      const nextBox = match.unit_price;
      const nextVial = vialPriceFor(nextBox, match.vial_price);
      return {
        ...li,
        box_price: nextBox,
        vial_price: nextVial,
        unit_price: String(li.price_type === 'vial' ? nextVial : nextBox),
      };
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currency]);

  // ---- Customer search debounce ----
  useEffect(() => {
    if (linkedCustomer) return;
    if (!customerQuery.trim()) {
      setCustomerResults([]);
      setCustomerSearched(false);
      setShowCustomerDrop(false);
      return;
    }
    const t = setTimeout(async () => {
      const q = customerQuery.trim();
      const { data } = await supabase
        .from('customers')
        .select('id, first_name, last_name, email, phone, preferred_currency')
        .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,email.ilike.%${q}%`)
        .eq('active', true)
        .limit(8);
      setCustomerResults(data ?? []);
      setCustomerSearched(true);
      setShowCustomerDrop(true);
    }, 220);
    return () => clearTimeout(t);
  }, [customerQuery, linkedCustomer]);

  // ---- Sales person search debounce ----
  useEffect(() => {
    if (linkedSalesPerson) return;
    if (!salesQuery.trim()) {
      setSalesResults([]);
      setShowSalesDrop(false);
      return;
    }
    const t = setTimeout(async () => {
      const results = await searchSalesPersons(salesQuery);
      setSalesResults(results);
      setShowSalesDrop(true);
    }, 220);
    return () => clearTimeout(t);
  }, [salesQuery, linkedSalesPerson]);

  // ---- Close dropdowns on outside click ----
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (customerWrapRef.current && !customerWrapRef.current.contains(e.target as Node)) {
        setShowCustomerDrop(false);
      }
      if (salesWrapRef.current && !salesWrapRef.current.contains(e.target as Node)) {
        setShowSalesDrop(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ---- Create customer ----
  async function handleCreateCustomer() {
    setNewCustErr('');
    if (!newCust.first_name.trim() || !newCust.last_name.trim() || !newCust.email.trim()) {
      setNewCustErr('First name, last name and email are required');
      return;
    }
    setCreatingCustomer(true);
    const result = await createCustomerRecord({
      first_name: newCust.first_name.trim(),
      last_name: newCust.last_name.trim(),
      email: newCust.email.trim(),
      phone: newCust.phone.trim() || undefined,
      // Optional shipping address — persisted on the customer so it becomes
      // the Ship-to default (the profile-load effect reads it back).
      shipping_address: newCust.address.trim() || undefined,
      shipping_city: newCust.city.trim() || undefined,
      shipping_state: newCust.state.trim() || undefined,
      shipping_postal_code: newCust.postal_code.trim() || undefined,
      shipping_country: newCust.country.trim() || undefined,
    });
    setCreatingCustomer(false);
    if (!result.success || !result.customer) {
      setNewCustErr(result.error ?? 'Failed to create customer');
      return;
    }
    setLinkedCustomer({
      id: result.customer.id,
      first_name: result.customer.first_name,
      last_name: result.customer.last_name,
      email: result.customer.email,
      phone: result.customer.phone ?? undefined,
    });
    setCustomerQuery('');
    setShowNewCustomer(false);
    setShowNewCustAddr(false);
    setNewCust({
      first_name: '', last_name: '', email: '', phone: '',
      address: '', city: '', state: '', postal_code: '', country: 'CA',
    });
  }

  // ---- Create sales person ----
  async function handleCreateSalesPerson() {
    setNewSalesErr('');
    if (!newSales.first_name.trim() || !newSales.last_name.trim()) {
      setNewSalesErr('First and last name required');
      return;
    }
    const rate = parseFloat(newSales.commission_rate);
    if (isNaN(rate) || rate < 0 || rate > 100) {
      setNewSalesErr('Commission rate must be between 0 and 100');
      return;
    }
    setCreatingSales(true);
    const result = await createSalesPerson({
      first_name: newSales.first_name.trim(),
      last_name: newSales.last_name.trim(),
      email: newSales.email.trim() || undefined,
      phone: newSales.phone.trim() || undefined,
      commission_rate: rate,
    });
    setCreatingSales(false);
    if (!result.success || !result.sales_person) {
      setNewSalesErr(result.error ?? 'Failed to create sales person');
      return;
    }
    setLinkedSalesPerson(result.sales_person);
    setSalesCommissionRate(String(result.sales_person.commission_rate));
    setSalesQuery('');
    setShowNewSales(false);
    setNewSales({ first_name: '', last_name: '', email: '', phone: '', commission_rate: '5' });
  }

  // ---- Create ship-to client on the fly ----
  async function handleCreateClient() {
    setClientError('');
    if (!linkedCustomer?.id) {
      setClientError('Pick a customer first — clients are saved under a customer.');
      return;
    }
    if (!newClient.address.trim()) {
      setClientError('A ship-to address is required.');
      return;
    }
    setCreatingClient(true);
    const res = await createCustomerClient({
      customer_id: linkedCustomer.id,
      first_name: newClient.first_name.trim() || undefined,
      last_name: newClient.last_name.trim() || undefined,
      address: newClient.address.trim(),
      city: newClient.city.trim() || undefined,
      state: newClient.state.trim() || undefined,
      postal_code: newClient.postal_code.trim() || undefined,
      country: newClient.country.trim() || 'CA',
      phone: newClient.phone.trim() || undefined,
      email: newClient.email.trim() || undefined,
    });
    setCreatingClient(false);
    if (!res.success || !res.client) {
      setClientError(res.error ?? 'Failed to save client');
      return;
    }
    setSavedClients((prev) => [res.client!, ...prev]);
    setSelectedClientId(res.client.id);
    setNewClient({
      first_name: '', last_name: '', address: '', city: '', state: '',
      postal_code: '', country: 'CA', phone: '', email: '',
    });
  }

  // ---- Save the typed Ship-to address onto the linked customer's profile ----
  // Persists the destination so future invoices pre-fill it and the Easyship
  // label can read it once an order exists. Best-effort; failures surface a
  // small inline error but never block invoice creation.
  async function handleSaveShipToProfile() {
    if (!linkedCustomer?.id) return;
    setProfileErr('');
    setSavingProfile(true);
    const res = await updateCustomerRecord(linkedCustomer.id, {
      phone: shipTo.phone.trim() || null,
      shipping_address: shipTo.address.trim() || null,
      shipping_city: shipTo.city.trim() || null,
      shipping_state: shipTo.state.trim() || null,
      shipping_postal_code: shipTo.postal_code.trim() || null,
      shipping_country: shipTo.country.trim() || null,
    });
    setSavingProfile(false);
    if (!res.success) {
      setProfileErr(res.error ?? 'Could not save to profile');
      return;
    }
    // Refresh the snapshot so the "differs from profile" prompt clears.
    setProfileAddr({
      address: shipTo.address.trim(),
      city: shipTo.city.trim(),
      state: shipTo.state.trim(),
      postal_code: shipTo.postal_code.trim(),
      country: shipTo.country.trim() || 'CA',
      phone: shipTo.phone.trim(),
    });
    setLinkedCustomer((prev) => prev ? { ...prev, phone: shipTo.phone.trim() || prev.phone } : prev);
    setSavedProfile(true);
  }

  // ---- Easyship shipping-readiness pre-flight ----
  //
  // Deliberately does NOT require a picked customer. A Stealth Health /
  // Stealth Health hand-off has no customer to pick — Stealth Health collected the buyer's
  // details on its own checkout page and reported the address onto the hand-off
  // ledger — so when the form has no destination of its own the server resolves
  // the invoice's (ledger → drop-ship client → customer profile) and says which
  // it used.
  async function runReadiness() {
    setReadinessLoading(true);
    try {
      // The destination is the ship-to client's address when Ships-to-Client
      // is on; otherwise fall back to the customer's shipping profile if we
      // have it. We only carry postal/city/country here — the readiness
      // route doesn't need the full address to price a shipment.
      const dest = selectedClient
        ? {
            country: selectedClient.country ?? 'CA',
            postal_code: selectedClient.postal_code,
            city: selectedClient.city,
            state: selectedClient.state,
          }
        : {
            // Direct shipment → the customer's Ship-to destination.
            country: shipTo.country || 'CA',
            postal_code: shipTo.postal_code.trim() || null,
            city: shipTo.city.trim() || null,
            state: shipTo.state.trim() || null,
          };
      const res = await shippingReadiness({
        destination: dest,
        // Edit mode only: lets the server fall back to the invoice's own
        // address when nothing above is filled in.
        invoice_id: isEdit ? (invoiceId ?? null) : null,
        items: items.map((li) => ({ qty: parseFloat(li.qty) || 0 })),
      });
      setReadiness(res);
      // If Easyship returned rates, offer the cheapest by default.
      if (res.ready && res.rates.length > 0 && !selectedRateId) {
        setSelectedRateId(res.rates[0].courier_id);
      }
    } catch (e: any) {
      setReadiness({
        ready: false,
        checks: [{ key: 'network', label: 'Rate quote failed', ok: false, detail: e?.message }],
        rates: [],
        ratesNote: null,
      });
    } finally {
      setReadinessLoading(false);
    }
  }

  function applyRate(rate: ShippingReadinessRate) {
    setSelectedRateId(rate.courier_id);
    setShippingCost(rate.total_charge.toFixed(2));
    setShippingCostAutoFilled(true);
  }

  // Courier picker in the shipment card. Two kinds of choice share one control:
  // a specific quoted service (`rate:<courier_id>`, which also auto-fills the
  // shipping fee) or a carrier preference (`pref:best_value|ups|canada_post`) that the
  // server resolves against a fresh quote when the shipment is created — so a
  // courier can be chosen even before/without running the readiness check.
  function selectCourierOption(value: string) {
    if (value.startsWith('rate:')) {
      const rate = readiness?.rates.find((r) => r.courier_id === value.slice(5));
      if (rate) applyRate(rate);
      return;
    }
    setSelectedRateId(null);
    setCourierPreference(value.slice(5) as CourierPreference);
  }

  function selectSalesPerson(s: SalesPerson) {
    setLinkedSalesPerson(s);
    setSalesCommissionRate(String(s.commission_rate));
    setSalesQuery('');
    setShowSalesDrop(false);
  }

  // ---- Line item helpers ----
  function updateItem(index: number, patch: Partial<LineItemDraft>) {
    setItems((prev) => prev.map((it, i) => i === index ? { ...it, ...patch } : it));
  }
  function addItem() { setItems((prev) => [...prev, EMPTY_LINE()]); }
  function removeItem(index: number) { setItems((prev) => prev.filter((_, i) => i !== index)); }
  function selectSearchItem(index: number, item: SearchItem) {
    const chainPrice = chainPrices[item.id];
    const box = chainPrice ?? item.unit_price;
    const vial = vialPriceFor(box, item.vial_price);
    // Preserve the current row's price_type when the admin swaps products
    // — the toggle state is a per-line choice, not a per-product default.
    const current = items[index];
    const pt = current?.price_type ?? 'box';
    updateItem(index, {
      description: item.label,
      unit_price: String(pt === 'vial' ? vial : box),
      showVariantDrop: false,
      product_id: item.id,
      stock_quantity: item.stock_quantity,
      box_price: box,
      vial_price: vial,
    });
  }

  /** Flip a line between Box and Vial pricing. Re-prices from the captured
   *  box/vial values so a toggle round-trip is lossless — the admin doesn't
   *  have to remember to re-enter the price. Custom (non-product) lines
   *  just switch the label; the admin's typed price stays intact. */
  function switchPriceType(index: number, next: 'box' | 'vial') {
    setItems((prev) => prev.map((li, i) => {
      if (i !== index) return li;
      if (li.price_type === next) return li;
      if (!li.product_id) return { ...li, price_type: next };
      const box = li.box_price ?? (parseFloat(li.unit_price) || 0);
      const vial = li.vial_price ?? vialPriceFor(box, null);
      return {
        ...li,
        price_type: next,
        unit_price: String(next === 'vial' ? vial : box),
        box_price: box,
        vial_price: vial,
      };
    }));
  }
  function getMatches(query: string): SearchItem[] {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return searchItems
      .filter((v) => v.label.toLowerCase().includes(q) || v.sku.toLowerCase().includes(q))
      .slice(0, 8);
  }

  // ---- Derived totals ----
  const subtotal = items.reduce((s, li) => s + calcLineTotal(li), 0);
  const taxTotal = subtotal * ((parseFloat(taxPct) || 0) / 100);
  // Processing fee only applies to pickup, and only when the admin has
  // explicitly opted to show it on the invoice. Shipment invoices always
  // send 0 so the total matches the printed PDF exactly.
  const effectiveFee =
    fulfillmentType === 'pickup' && showProcessingFee
      ? parseFloat(processingFee) || 0
      : 0;
  const total =
    subtotal +
    taxTotal +
    (fulfillmentType === 'shipment' ? parseFloat(shippingCost) || 0 : 0) +
    effectiveFee;

  const effectiveCustomerName = linkedCustomer
    ? `${linkedCustomer.first_name} ${linkedCustomer.last_name}`.trim()
    : customerQuery.trim() || undefined;

  const selectedClient = selectedClientId
    ? savedClients.find((c) => c.id === selectedClientId) ?? null
    : null;

  // The generic Ship-to block is for a direct-to-customer shipment: create
  // mode, shipment fulfillment, and NOT drop-shipping (the drop-ship card
  // owns the destination in that case).
  const showShipTo = !isEdit && fulfillmentType === 'shipment' && !shipsToClient;

  // Whether the typed Ship-to has an address worth persisting, and whether it
  // diverges from the linked customer's saved profile (drives the Save/Update
  // prompt + which verb it uses).
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const shipToHasAddress = shipTo.address.trim().length > 0;
  const profileHasAddress = !!profileAddr?.address.trim();
  const shipToDiffersFromProfile =
    !!linkedCustomer &&
    shipToHasAddress &&
    (!profileAddr ||
      norm(shipTo.address) !== norm(profileAddr.address) ||
      norm(shipTo.postal_code) !== norm(profileAddr.postal_code) ||
      norm(shipTo.city) !== norm(profileAddr.city) ||
      norm(shipTo.phone) !== norm(profileAddr.phone));

  // Sum qty per product so multiple lines hitting the same SKU are
  // checked against stock together.
  const qtyByProduct = items.reduce<Record<string, number>>((acc, li) => {
    if (li.product_id) {
      acc[li.product_id] = (acc[li.product_id] ?? 0) + (parseFloat(li.qty) || 0);
    }
    return acc;
  }, {});

  const stockErrors = items
    .map((li) => {
      if (!li.product_id || li.stock_quantity < 0) return null;
      const requested = qtyByProduct[li.product_id] ?? 0;
      if (requested > li.stock_quantity) {
        return {
          description: li.description,
          requested,
          available: li.stock_quantity,
        };
      }
      return null;
    })
    .filter((e): e is { description: string; requested: number; available: number } => e !== null);

  const uniqueStockErrors = Array.from(
    new Map(stockErrors.map((e) => [e.description, e])).values(),
  );

  const hasStockError = uniqueStockErrors.length > 0;

  // ---- Submit ----
  // Sending an invoice with over-stock lines creates a backorder — warn and
  // confirm first. Drafts (and edits) proceed without the prompt.
  function handleSubmit(action: 'draft' | 'sent' | 'save') {
    if (action === 'sent' && hasStockError) {
      setShowBackorderConfirm(true);
      return;
    }
    void doSubmit(action);
  }

  async function doSubmit(action: 'draft' | 'sent' | 'save') {
    setShowBackorderConfirm(false);
    if (items.some((li) => !li.description.trim())) {
      setError('All line items need a description');
      return;
    }
    setSaving(true);
    setError('');

    const linePayload = items.map((li) => ({
      description: li.description,
      qty: parseFloat(li.qty) || 1,
      unit_price: parseFloat(li.unit_price) || 0,
      discount_pct: parseFloat(li.discount_pct) || 0,
      product_id: li.product_id ?? undefined,
      price_type: li.price_type,
    }));

    if (isEdit && invoiceId) {
      const result = await replaceInvoice(invoiceId, {
        customer_id: linkedCustomer?.id ?? null,
        customer_name: effectiveCustomerName ?? null,
        customer_email: linkedCustomer?.email ?? null,
        customer_phone: linkedCustomer?.phone ?? null,
        due_date: dueDate,
        subtotal,
        tax_total: taxTotal,
        shipping_cost: fulfillmentType === 'shipment' ? parseFloat(shippingCost) || 0 : 0,
        total,
        currency,
        notes: notes.trim() || null,
        sales_person_id: linkedSalesPerson?.id ?? null,
        sales_person_commission_rate: linkedSalesPerson ? parseFloat(salesCommissionRate) || 0 : 0,
        line_items: linePayload,
        // Spec §6: currency, labels, fulfillment, processing fee — all live
        // on the invoice header so the printed PDF stays canonical.
        with_labels: withLabels,
        fulfillment_type: fulfillmentType,
        processing_fee: fulfillmentType === 'pickup' ? parseFloat(processingFee) || 0 : 0,
        show_processing_fee: showProcessingFee,
        ships_to_client: fulfillmentType === 'shipment' && shipsToClient,
        client_id: fulfillmentType === 'shipment' && shipsToClient ? selectedClientId : null,
        // Easyship auto-shipment on save. Only honored server-side when the
        // invoice is bound to an order and fulfillment_type is shipment.
        create_easyship_shipment: fulfillmentType === 'shipment' && createShipment,
        easyship_courier_id: createShipment ? selectedRateId : null,
        easyship_courier_preference:
          createShipment && !selectedRateId ? courierPreference : null,
        easyship_buy_label: createShipment && buyLabel,
        easyship_insured: createShipment && insured,
        easyship_handover: createShipment ? handover : null,
      } as any);
      setSaving(false);
      if (!result.success) {
        setError(result.error ?? 'Failed to save invoice');
        return;
      }
      router.push(`/admin/invoices/${invoiceId}`);
      return;
    }

    // For a direct shipment the Ship-to block can supply contact details the
    // customer picker didn't — fall back to them so the invoice still has an
    // email to send to and a phone for the courier.
    const shipToActive = fulfillmentType === 'shipment' && !shipsToClient;
    const result = await createInvoice({
      customer_id: linkedCustomer?.id,
      customer_name:
        effectiveCustomerName ??
        (shipToActive
          ? `${shipTo.first_name} ${shipTo.last_name}`.trim() || undefined
          : undefined),
      customer_email:
        linkedCustomer?.email ??
        (shipToActive ? shipTo.email.trim() || undefined : undefined),
      customer_phone:
        linkedCustomer?.phone ??
        (shipToActive ? shipTo.phone.trim() || undefined : undefined),
      due_date: dueDate,
      subtotal,
      tax_total: taxTotal,
      shipping_cost: fulfillmentType === 'shipment' ? parseFloat(shippingCost) || 0 : 0,
      total,
      currency,
      notes: notes.trim() || undefined,
      status: action === 'sent' ? 'sent' : 'draft',
      sales_person_id: linkedSalesPerson?.id,
      sales_person_commission_rate: linkedSalesPerson
        ? parseFloat(salesCommissionRate) || 0
        : undefined,
      line_items: linePayload,
      with_labels: withLabels,
      fulfillment_type: fulfillmentType,
      processing_fee: fulfillmentType === 'pickup' ? parseFloat(processingFee) || 0 : 0,
      show_processing_fee: showProcessingFee,
      ships_to_client: fulfillmentType === 'shipment' && shipsToClient,
      client_id: fulfillmentType === 'shipment' && shipsToClient ? selectedClientId : null,
      create_easyship_shipment: fulfillmentType === 'shipment' && createShipment,
      easyship_courier_id: createShipment ? selectedRateId : null,
      easyship_courier_preference:
        createShipment && !selectedRateId ? courierPreference : null,
      easyship_buy_label: createShipment && buyLabel,
      easyship_insured: createShipment && insured,
      easyship_handover: createShipment ? handover : null,
    } as any);

    if (!result.success) {
      setError(result.error ?? 'Failed to create invoice');
      setSaving(false);
      return;
    }

    // Split orders land on the backorders worklist; otherwise the new invoice.
    if (result.split && result.backorder_invoice) {
      router.push('/admin/backorders');
      return;
    }
    router.push(`/admin/invoices/${result.invoice?.id}`);
  }

  const backHref = isEdit && invoiceId
    ? `/admin/invoices/${invoiceId}`
    : '/admin/invoices';
  const heading = isEdit
    ? `Edit Invoice ${initial?.invoice.invoice_number ?? ''}`
    : 'New Invoice';

  return (
    <>
      <div className="flex items-center gap-4 mb-6">
        <Link href={backHref} className="text-ink-muted hover:text-ink transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <h1 className="text-xl font-bold text-ink">{heading}</h1>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
      )}

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">

          {/* ---- Customer + Dates ---- */}
          <div className="bg-white rounded-xl border border-line p-5">
            <h2 className="font-semibold text-ink mb-4 text-sm">Invoice Details</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-ink-muted mb-1">Customer</label>

                {linkedCustomer ? (
                  <div className="flex items-center justify-between px-4 py-3 bg-surface rounded-xl border border-line">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-teal/10 flex items-center justify-center flex-shrink-0">
                        <User className="w-4 h-4 text-teal-dark" />
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5">
                          <p className="text-sm font-medium text-ink">
                            {linkedCustomer.first_name} {linkedCustomer.last_name}
                          </p>
                          <span className="text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded font-medium flex items-center gap-0.5">
                            <Link2 className="w-2.5 h-2.5" /> Linked
                          </span>
                        </div>
                        <p className="text-xs text-ink-muted">{linkedCustomer.email}</p>
                      </div>
                    </div>
                    <button
                      onClick={() => { setLinkedCustomer(null); setCustomerQuery(''); }}
                      className="text-ink-muted hover:text-red-500 transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <div ref={customerWrapRef} className="relative">
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                      <input
                        type="text"
                        value={customerQuery}
                        onChange={(e) => setCustomerQuery(e.target.value)}
                        onFocus={() => customerResults.length > 0 && setShowCustomerDrop(true)}
                        placeholder="Customer name or search by email…"
                        className="w-full pl-10 pr-4 py-2.5 bg-surface border border-line rounded-lg text-sm text-ink placeholder-ink-muted focus:outline-none focus:ring-2 focus:ring-teal/40"
                      />
                    </div>

                    {showCustomerDrop && customerSearched && (
                      <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-xl border border-line shadow-lg z-20 overflow-hidden">
                        {customerResults.length > 0 && (
                          <>
                            <p className="px-4 pt-2.5 pb-1 text-xs text-ink-muted font-medium">Link to existing customer</p>
                            {customerResults.map((c) => (
                              <button
                                key={c.id}
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  setLinkedCustomer(c);
                                  setCustomerQuery('');
                                  setShowCustomerDrop(false);
                                }}
                                className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-surface transition-colors text-left"
                              >
                                <div className="w-7 h-7 rounded-full bg-teal/10 flex items-center justify-center flex-shrink-0">
                                  <User className="w-3.5 h-3.5 text-teal-dark" />
                                </div>
                                <div>
                                  <p className="text-sm font-medium text-ink">
                                    {c.first_name} {c.last_name}
                                  </p>
                                  <p className="text-xs text-ink-muted">{c.email}</p>
                                </div>
                              </button>
                            ))}
                          </>
                        )}

                        {customerResults.length === 0 && (
                          <p className="px-4 pt-2.5 pb-1 text-xs text-ink-muted">
                            No customers match "{customerQuery.trim()}"
                          </p>
                        )}

                        <button
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            const parts = customerQuery.trim().split(/\s+/);
                            const isEmail = customerQuery.includes('@');
                            setNewCust({
                              first_name: !isEmail && parts[0] ? parts[0] : '',
                              last_name: !isEmail && parts.length > 1 ? parts.slice(1).join(' ') : '',
                              email: isEmail ? customerQuery.trim() : '',
                              phone: '',
                              address: '', city: '', state: '', postal_code: '', country: 'CA',
                            });
                            setShowNewCustAddr(false);
                            setShowNewCustomer(true);
                            setShowCustomerDrop(false);
                          }}
                          className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-emerald-50 transition-colors text-left border-t border-line"
                        >
                          <div className="w-7 h-7 rounded-full bg-emerald-100 flex items-center justify-center flex-shrink-0">
                            <UserPlus className="w-3.5 h-3.5 text-emerald-600" />
                          </div>
                          <div>
                            <p className="text-sm font-medium text-emerald-700">Create new customer</p>
                            <p className="text-xs text-ink-muted">Add a customer record on the fly</p>
                          </div>
                        </button>
                      </div>
                    )}

                    {customerQuery.trim() && !showCustomerDrop && (
                      <p className="mt-1 text-xs text-ink-muted">
                        <span className="font-medium text-ink">"{customerQuery.trim()}"</span> will be saved as the customer name.
                        {' '}Type more to search existing records.
                      </p>
                    )}
                    {!customerQuery && (
                      <p className="mt-1 text-xs text-ink-muted">
                        Type a name for offline/guest, or search to link an account.
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1">Issue Date</label>
                <input
                  type="date"
                  value={isEdit && initial ? initial.invoice.issue_date.slice(0, 10) : todayInAppTz()}
                  readOnly
                  className="w-full px-3 py-2.5 bg-surface border border-line rounded-lg text-sm text-ink-muted"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1">Due Date</label>
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="w-full px-3 py-2.5 bg-surface border border-line rounded-lg text-sm text-ink focus:outline-none focus:ring-2 focus:ring-teal/40"
                />
              </div>

              {/* Fulfillment toggle — controls whether shipping cost or the
                  pickup processing fee applies. Swap zeroes out the other. */}
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-ink-muted mb-1">Fulfillment</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setFulfillmentType('shipment')}
                    className={`flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                      fulfillmentType === 'shipment'
                        ? 'bg-ink text-white border-ink'
                        : 'bg-surface text-ink-muted border-line hover:text-ink'
                    }`}
                  >
                    <Truck className="w-4 h-4" /> Shipment
                  </button>
                  <button
                    type="button"
                    onClick={() => setFulfillmentType('pickup')}
                    className={`flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                      fulfillmentType === 'pickup'
                        ? 'bg-ink text-white border-ink'
                        : 'bg-surface text-ink-muted border-line hover:text-ink'
                    }`}
                  >
                    <Store className="w-4 h-4" /> Self-Pickup
                  </button>
                </div>
              </div>

              {/* ---- Ship to (direct shipment destination) ----
                  Create + shipment + not drop-shipping. The parcel goes
                  straight to the customer. Address feeds the Easyship
                  readiness/label; blank phone/email fall back to a house
                  default and can be completed later on the order. */}
              {showShipTo && (
                <div className="sm:col-span-2">
                  <div className="rounded-xl border border-line bg-surface/50 p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <MapPin className="w-4 h-4 text-teal-dark" />
                      <h3 className="text-xs font-semibold text-ink">Ship to</h3>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="text"
                        placeholder="First name"
                        value={shipTo.first_name}
                        onChange={(e) => setShipTo({ ...shipTo, first_name: e.target.value })}
                        className="px-3 py-2 bg-white border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                      />
                      <input
                        type="text"
                        placeholder="Last name"
                        value={shipTo.last_name}
                        onChange={(e) => setShipTo({ ...shipTo, last_name: e.target.value })}
                        className="px-3 py-2 bg-white border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                      />
                    </div>

                    <AddressAutocomplete
                      value={shipTo.address}
                      onChange={(next) => setShipTo((prev) => ({ ...prev, address: next }))}
                      onPick={(s) => setShipTo((prev) => ({
                        ...prev,
                        address: s.address,
                        city: s.city || prev.city,
                        state: s.state || prev.state,
                        postal_code: s.postalCode || prev.postal_code,
                        country: s.country || prev.country || 'CA',
                      }))}
                      placeholder="Street address"
                    />

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      <input
                        type="text"
                        placeholder="City"
                        value={shipTo.city}
                        onChange={(e) => setShipTo({ ...shipTo, city: e.target.value })}
                        className="px-3 py-2 bg-white border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                      />
                      <input
                        type="text"
                        placeholder="Prov/State"
                        value={shipTo.state}
                        onChange={(e) => setShipTo({ ...shipTo, state: e.target.value })}
                        className="px-3 py-2 bg-white border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                      />
                      <input
                        type="text"
                        placeholder="Postal"
                        value={shipTo.postal_code}
                        onChange={(e) => setShipTo({ ...shipTo, postal_code: e.target.value })}
                        className="px-3 py-2 bg-white border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                      />
                      <input
                        type="text"
                        placeholder="Country"
                        value={shipTo.country}
                        onChange={(e) => setShipTo({ ...shipTo, country: e.target.value.toUpperCase().slice(0, 2) })}
                        maxLength={2}
                        className="px-3 py-2 bg-white border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="tel"
                        placeholder="Phone (for the courier)"
                        value={shipTo.phone}
                        onChange={(e) => setShipTo({ ...shipTo, phone: e.target.value })}
                        className="px-3 py-2 bg-white border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                      />
                      <input
                        type="email"
                        placeholder="Email (for tracking)"
                        value={shipTo.email}
                        onChange={(e) => { setShipTo({ ...shipTo, email: e.target.value }); }}
                        className="px-3 py-2 bg-white border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                      />
                    </div>

                    <p className="text-[11px] text-ink-muted leading-snug">
                      Phone &amp; email are optional — a house default is used on the
                      Easyship label when blank, and either can be completed later from
                      the order&apos;s Shipping Label panel.
                    </p>

                    {shipToDiffersFromProfile && (
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={handleSaveShipToProfile}
                          disabled={savingProfile}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-line rounded-lg text-xs font-medium text-ink hover:bg-surface disabled:opacity-50"
                        >
                          {savingProfile && <Loader2 className="w-3 h-3 animate-spin" />}
                          {profileHasAddress
                            ? `Update ${linkedCustomer!.first_name}'s profile`
                            : `Save to ${linkedCustomer!.first_name}'s profile`}
                        </button>
                        <span className="text-[11px] text-ink-muted">
                          {profileHasAddress
                            ? 'This address differs from their saved profile.'
                            : 'Keep this address on the customer for next time.'}
                        </span>
                      </div>
                    )}
                    {savedProfile && !shipToDiffersFromProfile && (
                      <p className="text-[11px] text-emerald-600 inline-flex items-center gap-1">
                        <Check className="w-3 h-3" /> Saved to {linkedCustomer?.first_name}&apos;s profile.
                      </p>
                    )}
                    {profileErr && (
                      <p className="text-[11px] text-red-600">{profileErr}</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ---- Sales Person ---- */}
          <div className="bg-white rounded-xl border border-line p-5">
            <h2 className="font-semibold text-ink mb-4 text-sm flex items-center gap-2">
              <Briefcase className="w-4 h-4 text-ink-muted" /> Sales Person
            </h2>

            {linkedSalesPerson ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between px-4 py-3 bg-surface rounded-xl border border-line">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-purple-100 flex items-center justify-center flex-shrink-0">
                      <Briefcase className="w-4 h-4 text-purple-600" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-ink">
                        {linkedSalesPerson.first_name} {linkedSalesPerson.last_name}
                      </p>
                      {linkedSalesPerson.email && (
                        <p className="text-xs text-ink-muted">{linkedSalesPerson.email}</p>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setLinkedSalesPerson(null); setSalesCommissionRate('0'); }}
                    className="text-ink-muted hover:text-red-500 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-ink-muted mb-1">Commission %</label>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.1"
                      value={salesCommissionRate}
                      onChange={(e) => setSalesCommissionRate(e.target.value)}
                      className="w-full px-3 py-2 bg-surface border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-ink-muted mb-1">Commission Amount</label>
                    <p className="px-3 py-2 bg-surface/60 rounded-lg text-sm font-semibold text-purple-700 tabular-nums">
                      {formatMoney(((parseFloat(salesCommissionRate) || 0) / 100) * total, currency)}
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div ref={salesWrapRef} className="relative">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                  <input
                    type="text"
                    value={salesQuery}
                    onChange={(e) => setSalesQuery(e.target.value)}
                    onFocus={() => salesResults.length > 0 && setShowSalesDrop(true)}
                    placeholder="Search sales person by name or email…"
                    className="w-full pl-10 pr-4 py-2.5 bg-surface border border-line rounded-lg text-sm text-ink placeholder-ink-muted focus:outline-none focus:ring-2 focus:ring-teal/40"
                  />
                </div>

                {showSalesDrop && salesQuery.trim() && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-xl border border-line shadow-lg z-20 overflow-hidden">
                    {salesResults.length > 0 && (
                      <>
                        <p className="px-4 pt-2.5 pb-1 text-xs text-ink-muted font-medium">Link sales person</p>
                        {salesResults.map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            onMouseDown={(e) => { e.preventDefault(); selectSalesPerson(s); }}
                            className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-surface transition-colors text-left"
                          >
                            <div className="w-7 h-7 rounded-full bg-purple-100 flex items-center justify-center flex-shrink-0">
                              <Briefcase className="w-3.5 h-3.5 text-purple-600" />
                            </div>
                            <div className="flex-1">
                              <p className="text-sm font-medium text-ink">{s.first_name} {s.last_name}</p>
                              {s.email && <p className="text-xs text-ink-muted">{s.email}</p>}
                            </div>
                            <span className="text-xs text-ink-muted tabular-nums">{s.commission_rate}%</span>
                          </button>
                        ))}
                      </>
                    )}

                    {salesResults.length === 0 && (
                      <p className="px-4 pt-2.5 pb-1 text-xs text-ink-muted">
                        No sales person matches "{salesQuery.trim()}"
                      </p>
                    )}

                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        const parts = salesQuery.trim().split(/\s+/);
                        const isEmail = salesQuery.includes('@');
                        setNewSales({
                          first_name: !isEmail && parts[0] ? parts[0] : '',
                          last_name: !isEmail && parts.length > 1 ? parts.slice(1).join(' ') : '',
                          email: isEmail ? salesQuery.trim() : '',
                          phone: '',
                          commission_rate: '5',
                        });
                        setShowNewSales(true);
                        setShowSalesDrop(false);
                      }}
                      className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-emerald-50 transition-colors text-left border-t border-line"
                    >
                      <div className="w-7 h-7 rounded-full bg-emerald-100 flex items-center justify-center flex-shrink-0">
                        <UserPlus className="w-3.5 h-3.5 text-emerald-600" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-emerald-700">Create new sales person</p>
                        <p className="text-xs text-ink-muted">Add a sales person on the fly</p>
                      </div>
                    </button>
                  </div>
                )}

                <p className="mt-1 text-xs text-ink-muted">
                  Optional. A commission will be recorded under Commissions.
                </p>
              </div>
            )}
          </div>

          {/* ---- Ships to a Client (drop-ship) ----
              Shipment-only. Bills the customer, but ships to one of their
              saved recipients (or a new one entered inline). */}
          {fulfillmentType === 'shipment' && (
            <div className="bg-white rounded-xl border border-line p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold text-ink text-sm flex items-center gap-2">
                  <Truck className="w-4 h-4 text-ink-muted" /> Ships to a Client
                </h2>
                <label className="inline-flex items-center gap-2 text-xs text-ink-muted cursor-pointer">
                  <input
                    type="checkbox"
                    checked={shipsToClient}
                    onChange={(e) => {
                      setShipsToClient(e.target.checked);
                      if (!e.target.checked) setSelectedClientId(null);
                    }}
                    disabled={!linkedCustomer}
                  />
                  <span>Enable drop-ship</span>
                </label>
              </div>

              {!linkedCustomer && (
                <p className="text-xs text-ink-muted">
                  Pick a customer above — clients are saved under a customer.
                </p>
              )}

              {linkedCustomer && shipsToClient && (
                <div className="space-y-3">
                  {savedClients.length > 0 && (
                    <div>
                      <label className="block text-xs font-medium text-ink-muted mb-1">
                        Saved clients
                      </label>
                      <select
                        value={selectedClientId ?? ''}
                        onChange={(e) => setSelectedClientId(e.target.value || null)}
                        className="w-full px-3 py-2 bg-surface border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                      >
                        <option value="">— New client below —</option>
                        {savedClients.map((c) => (
                          <option key={c.id} value={c.id}>
                            {[c.first_name, c.last_name].filter(Boolean).join(' ').trim() || '(no name)'}
                            {' — '}
                            {[c.address, c.city, c.postal_code].filter(Boolean).join(', ')}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {!selectedClientId && (
                    <div className="rounded-lg border border-dashed border-line p-3 space-y-2 bg-surface/50">
                      <p className="text-xs font-medium text-ink-muted">New client (saved under {linkedCustomer.first_name} {linkedCustomer.last_name})</p>
                      {clientError && (
                        <p className="px-2 py-1.5 bg-red-50 border border-red-200 rounded text-[11px] text-red-700">{clientError}</p>
                      )}
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          type="text"
                          placeholder="First name"
                          value={newClient.first_name}
                          onChange={(e) => setNewClient({ ...newClient, first_name: e.target.value })}
                          className="px-2 py-1.5 bg-white border border-line rounded text-xs focus:outline-none focus:ring-2 focus:ring-teal/40"
                        />
                        <input
                          type="text"
                          placeholder="Last name"
                          value={newClient.last_name}
                          onChange={(e) => setNewClient({ ...newClient, last_name: e.target.value })}
                          className="px-2 py-1.5 bg-white border border-line rounded text-xs focus:outline-none focus:ring-2 focus:ring-teal/40"
                        />
                      </div>
                      <input
                        type="text"
                        placeholder="Street address *"
                        value={newClient.address}
                        onChange={(e) => setNewClient({ ...newClient, address: e.target.value })}
                        className="w-full px-2 py-1.5 bg-white border border-line rounded text-xs focus:outline-none focus:ring-2 focus:ring-teal/40"
                      />
                      <div className="grid grid-cols-3 gap-2">
                        <input
                          type="text"
                          placeholder="City"
                          value={newClient.city}
                          onChange={(e) => setNewClient({ ...newClient, city: e.target.value })}
                          className="px-2 py-1.5 bg-white border border-line rounded text-xs focus:outline-none focus:ring-2 focus:ring-teal/40"
                        />
                        <input
                          type="text"
                          placeholder="State"
                          value={newClient.state}
                          onChange={(e) => setNewClient({ ...newClient, state: e.target.value })}
                          className="px-2 py-1.5 bg-white border border-line rounded text-xs focus:outline-none focus:ring-2 focus:ring-teal/40"
                        />
                        <input
                          type="text"
                          placeholder="Postal"
                          value={newClient.postal_code}
                          onChange={(e) => setNewClient({ ...newClient, postal_code: e.target.value })}
                          className="px-2 py-1.5 bg-white border border-line rounded text-xs focus:outline-none focus:ring-2 focus:ring-teal/40"
                        />
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <input
                          type="text"
                          placeholder="Country (2-letter)"
                          value={newClient.country}
                          onChange={(e) => setNewClient({ ...newClient, country: e.target.value.toUpperCase().slice(0, 2) })}
                          maxLength={2}
                          className="px-2 py-1.5 bg-white border border-line rounded text-xs focus:outline-none focus:ring-2 focus:ring-teal/40"
                        />
                        <input
                          type="tel"
                          placeholder="Phone"
                          value={newClient.phone}
                          onChange={(e) => setNewClient({ ...newClient, phone: e.target.value })}
                          className="px-2 py-1.5 bg-white border border-line rounded text-xs focus:outline-none focus:ring-2 focus:ring-teal/40"
                        />
                        <input
                          type="email"
                          placeholder="Email"
                          value={newClient.email}
                          onChange={(e) => setNewClient({ ...newClient, email: e.target.value })}
                          className="px-2 py-1.5 bg-white border border-line rounded text-xs focus:outline-none focus:ring-2 focus:ring-teal/40"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={handleCreateClient}
                        disabled={creatingClient || !newClient.address.trim()}
                        className="w-full inline-flex items-center justify-center gap-2 px-3 py-1.5 bg-ink text-white rounded-lg text-xs font-medium hover:bg-ink/90 disabled:opacity-50"
                      >
                        {creatingClient && <Loader2 className="w-3 h-3 animate-spin" />}
                        Save client
                      </button>
                    </div>
                  )}

                  {selectedClient && (
                    <div className="rounded-lg bg-surface/60 border border-line p-3 text-xs text-ink-muted">
                      <div className="font-medium text-ink">
                        {[selectedClient.first_name, selectedClient.last_name].filter(Boolean).join(' ').trim() || '(no name)'}
                      </div>
                      <div>{selectedClient.address}</div>
                      <div>
                        {[selectedClient.city, selectedClient.state, selectedClient.postal_code, selectedClient.country]
                          .filter(Boolean)
                          .join(', ')}
                      </div>
                      {(selectedClient.email || selectedClient.phone) && (
                        <div className="mt-1">
                          {selectedClient.email && <span>{selectedClient.email}</span>}
                          {selectedClient.email && selectedClient.phone && <span> · </span>}
                          {selectedClient.phone && <span>{selectedClient.phone}</span>}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ---- Line Items ---- */}
          <div className="bg-white rounded-xl border border-line">
            <div className="flex items-center justify-between p-5 border-b border-line">
              <h2 className="font-semibold text-ink text-sm">Line Items</h2>
              <button
                onClick={addItem}
                className="text-xs text-teal-dark hover:text-teal-dark/80 flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" /> Add Item
              </button>
            </div>
            <div className="divide-y divide-line/50">
              {items.map((li, i) => {
                const matches = getMatches(li.description);
                return (
                  <div key={i} className="p-4 space-y-3">
                    <div className="flex items-start gap-2">
                      <div className="flex-1 relative">
                        <div className="relative">
                          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted" />
                          <input
                            type="text"
                            value={li.description}
                            onChange={(e) =>
                              updateItem(i, { description: e.target.value, showVariantDrop: true })
                            }
                            onFocus={() => updateItem(i, { showVariantDrop: true })}
                            onBlur={() => setTimeout(() => updateItem(i, { showVariantDrop: false }), 150)}
                            placeholder="Description, or search products…"
                            className="w-full pl-8 pr-3 py-2 bg-surface rounded-lg border border-line text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                          />
                        </div>
                        {li.showVariantDrop && matches.length > 0 && (
                          <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-xl border border-line shadow-lg z-20 overflow-hidden">
                            {matches.map((item) => (
                              <button
                                key={item.id}
                                onMouseDown={(e) => { e.preventDefault(); selectSearchItem(i, item); }}
                                className="w-full px-3 py-2.5 flex items-center justify-between hover:bg-surface transition-colors text-left"
                              >
                                <div>
                                  <p className="text-sm font-medium text-ink">{item.label}</p>
                                  {item.sku && (
                                    <p className="text-xs text-ink-muted font-mono">{item.sku}</p>
                                  )}
                                </div>
                                <span className="text-xs font-semibold text-teal-dark ml-4 flex-shrink-0 tabular-nums">
                                  ${item.unit_price.toFixed(2)}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      {items.length > 1 && (
                        <button
                          onClick={() => removeItem(i)}
                          className="text-ink-muted hover:text-red-500 transition-colors mt-2 flex-shrink-0"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>

                    {/* Box / Vial price-type toggle. Product-linked lines re-price
                        losslessly (captured box_price / vial_price); custom
                        lines just switch the label. */}
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-ink-muted">Price for</span>
                      <div className="inline-flex rounded-lg border border-line bg-surface p-0.5 text-xs">
                        <button
                          type="button"
                          onClick={() => switchPriceType(i, 'box')}
                          className={`flex items-center gap-1 rounded-md px-2 py-1 font-medium transition-colors ${
                            li.price_type === 'box'
                              ? 'bg-ink text-white'
                              : 'text-ink-muted hover:text-ink'
                          }`}
                          aria-pressed={li.price_type === 'box'}
                        >
                          <Package className="w-3 h-3" /> Box
                        </button>
                        <button
                          type="button"
                          onClick={() => switchPriceType(i, 'vial')}
                          className={`flex items-center gap-1 rounded-md px-2 py-1 font-medium transition-colors ${
                            li.price_type === 'vial'
                              ? 'bg-teal-dark text-white'
                              : 'text-ink-muted hover:text-ink'
                          }`}
                          aria-pressed={li.price_type === 'vial'}
                        >
                          <Beaker className="w-3 h-3" /> Vial
                        </button>
                      </div>
                      {li.product_id && li.price_type === 'vial' && li.vial_price != null && (
                        <span className="text-[11px] text-ink-muted tabular-nums">
                          vial ref: {formatMoney(li.vial_price, currency)}
                        </span>
                      )}
                      {li.product_id && li.price_type === 'box' && li.box_price != null && (
                        <span className="text-[11px] text-ink-muted tabular-nums">
                          box ref: {formatMoney(li.box_price, currency)}
                        </span>
                      )}
                    </div>

                    <div className="grid grid-cols-4 gap-2">
                      <div>
                        <label className="block text-xs text-ink-muted mb-1 flex items-center justify-between gap-2">
                          <span>Qty</span>
                          {li.stock_quantity >= 0 && (
                            <span
                              className={`text-[10px] font-medium tabular-nums px-1.5 py-0.5 rounded ${
                                li.stock_quantity === 0
                                  ? 'bg-red-100 text-red-700'
                                  : li.stock_quantity < 5
                                  ? 'bg-amber-100 text-amber-700'
                                  : 'bg-emerald-100 text-emerald-700'
                              }`}
                              title="Stock on hand"
                            >
                              stock: {li.stock_quantity}
                            </span>
                          )}
                        </label>
                        <input
                          type="number"
                          min="1"
                          value={li.qty}
                          onChange={(e) => updateItem(i, { qty: e.target.value })}
                          className={`w-full px-2 py-1.5 bg-surface rounded-lg border text-sm text-center focus:outline-none focus:ring-2 focus:ring-teal/40 ${
                            li.stock_quantity >= 0 && (parseFloat(li.qty) || 0) > li.stock_quantity
                              ? 'border-red-400 ring-1 ring-red-300'
                              : 'border-line'
                          }`}
                        />
                        {li.stock_quantity >= 0 && (parseFloat(li.qty) || 0) > li.stock_quantity && (
                          <p className="text-[10px] text-amber-600 mt-1 leading-tight">
                            Only {li.stock_quantity} in stock — will backorder
                          </p>
                        )}
                      </div>
                      <div>
                        <label className="block text-xs text-ink-muted mb-1">Unit Price</label>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={li.unit_price}
                          onChange={(e) => updateItem(i, { unit_price: e.target.value })}
                          className="w-full px-2 py-1.5 bg-surface rounded-lg border border-line text-sm text-right focus:outline-none focus:ring-2 focus:ring-teal/40"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-ink-muted mb-1">Disc %</label>
                        <input
                          type="number"
                          min="0"
                          max="100"
                          value={li.discount_pct}
                          onChange={(e) => updateItem(i, { discount_pct: e.target.value })}
                          className="w-full px-2 py-1.5 bg-surface rounded-lg border border-line text-sm text-center focus:outline-none focus:ring-2 focus:ring-teal/40"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-ink-muted mb-1">Total</label>
                        <p className="px-2 py-1.5 text-sm font-semibold text-ink tabular-nums text-right">
                          {formatMoney(calcLineTotal(li), currency)}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="px-4 pb-4">
              <button
                onClick={addItem}
                className="w-full py-2 border border-dashed border-line rounded-lg text-xs text-ink-muted hover:text-ink hover:border-ink/30 transition-colors flex items-center justify-center gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" /> Add another item
              </button>
            </div>
          </div>

          {/* Notes */}
          <div className="bg-white rounded-xl border border-line p-5">
            <label className="block text-xs font-medium text-ink-muted mb-2">Notes (optional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Payment terms, instructions..."
              className="w-full px-3 py-2.5 bg-surface border border-line rounded-lg text-sm text-ink resize-none focus:outline-none focus:ring-2 focus:ring-teal/40"
            />
          </div>
        </div>

        {/* Right: Totals + Actions */}
        <div className="space-y-4">
          {/* Easyship Shipment card — shipment-only. Two decoupled pieces:
              1) Readiness check — verifies origin/destination and fetches
                 live UPS / Canada Post rates so admin can auto-fill the shipping fee.
              2) "Create shipment record" toggle — when on, the invoice save
                 also schedules an Easyship shipment (via after()) using the
                 picked rate, handover method, insurance and optional buy-label. */}
          {fulfillmentType === 'shipment' && (
            <div className="bg-white rounded-xl border border-line p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold text-ink text-sm flex items-center gap-2">
                  <Truck className="w-4 h-4 text-ink-muted" /> Easyship Shipment
                </h2>
                <button
                  type="button"
                  onClick={runReadiness}
                  disabled={readinessLoading}
                  className="text-xs text-ink-muted hover:text-ink disabled:opacity-50 inline-flex items-center gap-1"
                >
                  {readinessLoading
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <Search className="w-3.5 h-3.5" />}
                  Check readiness
                </button>
              </div>

              <label className="mb-3 flex items-center gap-2 text-xs text-ink cursor-pointer">
                <input
                  type="checkbox"
                  checked={createShipment}
                  onChange={(e) => setCreateShipment(e.target.checked)}
                />
                <span>Create Easyship shipment record when this invoice saves</span>
              </label>

              {!readiness && (
                <p className="text-xs text-ink-muted">
                  Click "Check readiness" to verify origin/destination and fetch
                  live UPS / Canada Post rates.
                </p>
              )}

              {readiness && (
                <div className="space-y-3">
                  <ul className="space-y-1">
                    {readiness.checks.map((c) => (
                      <li key={c.key} className="flex items-start gap-2 text-xs">
                        {c.ok ? (
                          <Check className="w-3.5 h-3.5 text-emerald-600 mt-0.5 flex-shrink-0" />
                        ) : (
                          <X className="w-3.5 h-3.5 text-red-500 mt-0.5 flex-shrink-0" />
                        )}
                        <span className={c.ok ? 'text-ink' : 'text-red-700'}>
                          {c.label}
                          {c.detail && !c.ok && (
                            <span className="block text-[11px] text-ink-muted mt-0.5">{c.detail}</span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>

                  {readiness.ready && readiness.rates.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                        Live rates
                      </p>
                      {readiness.rates.map((r) => (
                        <label
                          key={r.courier_id}
                          className={`flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg border cursor-pointer text-xs transition-colors ${
                            selectedRateId === r.courier_id
                              ? 'border-teal bg-teal/5'
                              : 'border-line hover:border-ink/20'
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <input
                              type="radio"
                              name="ez-rate"
                              checked={selectedRateId === r.courier_id}
                              onChange={() => applyRate(r)}
                              className="text-teal-dark"
                            />
                            <div className="min-w-0">
                              <div className="font-medium text-ink truncate">{r.courier_name}</div>
                              <div className="text-[11px] text-ink-muted truncate">{r.service_name}</div>
                            </div>
                          </div>
                          <div className="text-right flex-shrink-0">
                            <div className="font-semibold text-ink tabular-nums">${r.total_charge.toFixed(2)}</div>
                            <div className="text-[10px] text-ink-muted">{r.min_delivery_time}-{r.max_delivery_time}d</div>
                          </div>
                        </label>
                      ))}
                      {shippingCostAutoFilled && (
                        <button
                          type="button"
                          onClick={() => { setShippingCost('0'); setShippingCostAutoFilled(false); setSelectedRateId(null); }}
                          className="text-[11px] text-ink-muted hover:text-ink underline"
                        >
                          Reset shipping cost
                        </button>
                      )}
                    </div>
                  )}

                  {readiness.destination && readiness.destination_source && (
                    <p className="text-[11px] text-ink-muted">
                      Shipping to{' '}
                      <span className="text-ink">
                        {[
                          readiness.destination.city,
                          readiness.destination.state,
                          readiness.destination.postal_code,
                          readiness.destination.country,
                        ]
                          .filter(Boolean)
                          .join(', ')}
                      </span>{' '}
                      — {DESTINATION_SOURCE_LABEL[readiness.destination_source]}.
                    </p>
                  )}

                  {readiness.ratesNote && (
                    <p className="text-[11px] text-amber-600">{readiness.ratesNote}</p>
                  )}
                </div>
              )}

              {/* Handover / insurance / buy-label options — only relevant when
                  the admin has opted in to shipment creation. Handover has
                  three modes: dropoff (default), collection (courier picks
                  up, standard fee), free_collection (courier picks up at no
                  extra charge — account-dependent). */}
              {createShipment && (
                <div className="mt-4 pt-4 border-t border-line/60 space-y-3">
                  {/* Courier — pick a quoted service (auto-fills the shipping
                      fee) or pin a carrier the server resolves at creation
                      time, so a courier can be chosen without live rates. */}
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-1.5">
                      Courier
                    </label>
                    <select
                      value={selectedRateId ? `rate:${selectedRateId}` : `pref:${courierPreference}`}
                      onChange={(e) => selectCourierOption(e.target.value)}
                      className="w-full px-3 py-2 bg-surface border border-line rounded-lg text-xs text-ink focus:outline-none focus:ring-2 focus:ring-teal/40"
                    >
                      <option value="pref:best_value">Best value — cheapest UPS / Canada Post within 2 days</option>
                      <option value="pref:ups">UPS — best-value UPS service</option>
                      <option value="pref:canada_post">Canada Post — best-value Canada Post service</option>
                      {readiness && readiness.rates.length > 0 && (
                        <optgroup label="Quoted services">
                          {readiness.rates.map((r) => (
                            <option key={r.courier_id} value={`rate:${r.courier_id}`}>
                              {r.courier_name} · {r.service_name} — ${r.total_charge.toFixed(2)}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                    <p className="mt-1 text-[10px] text-ink-muted">
                      {selectedRateId
                        ? 'This exact service is booked and its price fills the shipping fee.'
                        : 'Run "Check readiness" to pick an exact service and price. Otherwise Easyship re-quotes at creation and takes this carrier’s cheapest service.'}
                    </p>
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-1.5">
                      Handover
                    </label>
                    <div className="grid grid-cols-3 gap-1.5">
                      {[
                        { v: 'dropoff', l: 'Drop off' },
                        { v: 'collection', l: 'Collection' },
                        { v: 'free_collection', l: 'Free pickup' },
                      ].map((h) => (
                        <button
                          key={h.v}
                          type="button"
                          onClick={() => setHandover(h.v as any)}
                          className={`px-2 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                            handover === h.v
                              ? 'bg-ink text-white border-ink'
                              : 'bg-surface text-ink-muted border-line hover:text-ink'
                          }`}
                        >
                          {h.l}
                        </button>
                      ))}
                    </div>
                    <p className="mt-1 text-[10px] text-ink-muted">
                      Drop off at a courier location, request a paid pickup, or
                      opt for a free collection when the courier supports it.
                    </p>
                  </div>

                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={insured}
                      onChange={(e) => setInsured(e.target.checked)}
                    />
                    <span className="text-ink">Insure this shipment</span>
                    <span className="text-[10px] text-ink-muted">(Easyship parcel insurance)</span>
                  </label>

                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={buyLabel}
                      onChange={(e) => setBuyLabel(e.target.checked)}
                    />
                    <span className="text-ink">Buy label now</span>
                    <span className="text-[10px] text-amber-600">Charges Easyship wallet</span>
                  </label>

                  {!selectedRateId && (
                    <p className="text-[11px] text-amber-600">
                      {courierPreference === 'ups' || courierPreference === 'canada_post'
                        ? `No exact rate picked — the best-value ${courierPreference === 'ups' ? 'UPS' : 'Canada Post'} service (cheapest within 2 days) is booked at creation, and the shipping fee stays as typed.`
                        : 'No exact rate picked — the cheapest UPS / Canada Post service that arrives within 2 days is booked at creation.'}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="bg-white rounded-xl border border-line p-5">
            <h2 className="font-semibold text-ink mb-4 text-sm">Summary</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1">Currency</label>
                <div className="grid grid-cols-2 gap-2">
                  {(['CAD', 'USD'] as const).map((cur) => (
                    <button
                      key={cur}
                      type="button"
                      onClick={() => setCurrency(cur)}
                      className={`px-3 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                        currency === cur
                          ? 'bg-teal-dark text-white border-teal'
                          : 'bg-surface text-ink-muted border-line hover:text-ink'
                      }`}
                    >
                      {cur === 'CAD' ? '🇨🇦 CAD' : '🇺🇸 USD'}
                    </button>
                  ))}
                </div>
                {linkedCustomer?.preferred_currency && normalizeCurrency(linkedCustomer.preferred_currency) !== currency && (
                  <p className="mt-1 text-[11px] text-amber-600">
                    This customer is usually billed in {normalizeCurrency(linkedCustomer.preferred_currency)}.
                  </p>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1">Tax Rate (%)</label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  value={taxPct}
                  onChange={(e) => setTaxPct(e.target.value)}
                  className="w-full px-3 py-2 bg-surface border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                />
              </div>
              {fulfillmentType === 'shipment' && (
                <div>
                  <label className="block text-xs font-medium text-ink-muted mb-1">Shipping ($)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={shippingCost}
                    onChange={(e) => setShippingCost(e.target.value)}
                    className="w-full px-3 py-2 bg-surface border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                  />
                </div>
              )}

              {fulfillmentType === 'pickup' && (
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-ink-muted">Processing Fee ($)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={processingFee}
                    onChange={(e) => setProcessingFee(e.target.value)}
                    className="w-full px-3 py-2 bg-surface border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                  />
                  <label className="flex items-center gap-2 text-xs text-ink-muted">
                    <input
                      type="checkbox"
                      checked={showProcessingFee}
                      onChange={(e) => setShowProcessingFee(e.target.checked)}
                    />
                    <span>Show processing fee on the invoice</span>
                  </label>
                </div>
              )}

              {/* Labels toggle — controls whether "With labels" is printed on
                  the invoice and packing list. Defaults to true. */}
              <div>
                <label className="flex items-center gap-2 text-xs text-ink-muted cursor-pointer">
                  <input
                    type="checkbox"
                    checked={withLabels}
                    onChange={(e) => setWithLabels(e.target.checked)}
                  />
                  <Tag className="w-3.5 h-3.5" />
                  <span>Ship with labels</span>
                </label>
              </div>
            </div>

            <div className="mt-4 space-y-2 border-t border-line pt-4">
              {[
                { label: 'Subtotal', value: subtotal },
                { label: `Tax (${taxPct}%)`, value: taxTotal },
                ...(fulfillmentType === 'shipment'
                  ? [{ label: 'Shipping', value: parseFloat(shippingCost) || 0 }]
                  : []),
                ...(fulfillmentType === 'pickup' && showProcessingFee
                  ? [{ label: 'Processing Fee', value: parseFloat(processingFee) || 0 }]
                  : []),
              ].map(({ label, value }) => (
                <div key={label} className="flex justify-between text-sm">
                  <span className="text-ink-muted">{label}</span>
                  <span className="tabular-nums text-ink">{formatMoney(value, currency)}</span>
                </div>
              ))}
              <div className="flex justify-between text-base font-bold pt-2 border-t border-line">
                <span>Total</span>
                <span className="tabular-nums">{formatMoney(total, currency)} <span className="text-xs font-medium text-ink-muted">{currency}</span></span>
              </div>
            </div>
          </div>

          {isEdit ? (
            <div className="space-y-2">
              <button
                onClick={() => handleSubmit('save')}
                disabled={saving}
                className="w-full px-4 py-2.5 bg-ink text-white rounded-lg text-sm font-medium hover:bg-ink/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Save Changes
              </button>
              <Link
                href={backHref}
                className="block w-full px-4 py-2.5 bg-white border border-line rounded-lg text-sm text-center text-ink hover:bg-surface transition-colors"
              >
                Cancel
              </Link>
            </div>
          ) : (
            <div className="space-y-2">
              <button
                onClick={() => handleSubmit('sent')}
                disabled={saving}
                className="w-full px-4 py-2.5 bg-ink text-white rounded-lg text-sm font-medium hover:bg-ink/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Create & Send
              </button>
              <button
                onClick={() => handleSubmit('draft')}
                disabled={saving}
                className="w-full px-4 py-2.5 bg-white border border-line rounded-lg text-sm text-ink hover:bg-surface transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <Save className="w-4 h-4" /> Save as Draft
              </button>
            </div>
          )}
        </div>
      </div>

      {/* New Customer Modal */}
      {showNewCustomer && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl w-full max-w-md p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-ink flex items-center gap-2">
                <UserPlus className="w-4 h-4 text-emerald-600" /> New Customer
              </h3>
              <button onClick={() => setShowNewCustomer(false)}>
                <X className="w-4 h-4 text-ink-muted" />
              </button>
            </div>
            {newCustErr && (
              <p className="mb-3 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">{newCustErr}</p>
            )}
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-ink-muted mb-1">First name *</label>
                  <input
                    type="text"
                    value={newCust.first_name}
                    onChange={(e) => setNewCust({ ...newCust, first_name: e.target.value })}
                    className="w-full px-3 py-2 bg-surface border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-ink-muted mb-1">Last name *</label>
                  <input
                    type="text"
                    value={newCust.last_name}
                    onChange={(e) => setNewCust({ ...newCust, last_name: e.target.value })}
                    className="w-full px-3 py-2 bg-surface border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1">Email *</label>
                <input
                  type="email"
                  value={newCust.email}
                  onChange={(e) => setNewCust({ ...newCust, email: e.target.value })}
                  className="w-full px-3 py-2 bg-surface border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1">Phone</label>
                <input
                  type="tel"
                  value={newCust.phone}
                  onChange={(e) => setNewCust({ ...newCust, phone: e.target.value })}
                  className="w-full px-3 py-2 bg-surface border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                />
              </div>

              {/* Optional shipping address — seeds the customer profile and
                  pre-fills the invoice's Ship-to destination. */}
              {!showNewCustAddr ? (
                <button
                  type="button"
                  onClick={() => setShowNewCustAddr(true)}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-teal-dark hover:text-teal-dark/80"
                >
                  <Plus className="w-3.5 h-3.5" /> Add shipping address (optional)
                </button>
              ) : (
                <div className="rounded-lg border border-line bg-surface/50 p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <MapPin className="w-3.5 h-3.5 text-teal-dark" />
                    <p className="text-xs font-medium text-ink">Shipping address</p>
                  </div>
                  <AddressAutocomplete
                    value={newCust.address}
                    onChange={(next) => setNewCust((prev) => ({ ...prev, address: next }))}
                    onPick={(s) => setNewCust((prev) => ({
                      ...prev,
                      address: s.address,
                      city: s.city || prev.city,
                      state: s.state || prev.state,
                      postal_code: s.postalCode || prev.postal_code,
                      country: s.country || prev.country || 'CA',
                    }))}
                    placeholder="Street address"
                  />
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <input
                      type="text"
                      placeholder="City"
                      value={newCust.city}
                      onChange={(e) => setNewCust({ ...newCust, city: e.target.value })}
                      className="px-3 py-2 bg-white border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                    />
                    <input
                      type="text"
                      placeholder="Prov/State"
                      value={newCust.state}
                      onChange={(e) => setNewCust({ ...newCust, state: e.target.value })}
                      className="px-3 py-2 bg-white border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                    />
                    <input
                      type="text"
                      placeholder="Postal"
                      value={newCust.postal_code}
                      onChange={(e) => setNewCust({ ...newCust, postal_code: e.target.value })}
                      className="px-3 py-2 bg-white border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                    />
                    <input
                      type="text"
                      placeholder="Country"
                      value={newCust.country}
                      onChange={(e) => setNewCust({ ...newCust, country: e.target.value.toUpperCase().slice(0, 2) })}
                      maxLength={2}
                      className="px-3 py-2 bg-white border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                    />
                  </div>
                  <p className="text-[11px] text-ink-muted">
                    Optional — becomes this customer's default Ship-to on new invoices.
                  </p>
                </div>
              )}
            </div>
            <div className="flex gap-3 mt-5">
              <button
                onClick={() => setShowNewCustomer(false)}
                className="flex-1 px-4 py-2 border border-line rounded-lg text-sm text-ink-muted hover:text-ink"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateCustomer}
                disabled={creatingCustomer}
                className="flex-1 px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {creatingCustomer && <Loader2 className="w-4 h-4 animate-spin" />}
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New Sales Person Modal */}
      {showNewSales && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl w-full max-w-md p-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-ink flex items-center gap-2">
                <Briefcase className="w-4 h-4 text-purple-600" /> New Sales Person
              </h3>
              <button onClick={() => setShowNewSales(false)}>
                <X className="w-4 h-4 text-ink-muted" />
              </button>
            </div>
            {newSalesErr && (
              <p className="mb-3 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">{newSalesErr}</p>
            )}
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-ink-muted mb-1">First name *</label>
                  <input
                    type="text"
                    value={newSales.first_name}
                    onChange={(e) => setNewSales({ ...newSales, first_name: e.target.value })}
                    className="w-full px-3 py-2 bg-surface border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-ink-muted mb-1">Last name *</label>
                  <input
                    type="text"
                    value={newSales.last_name}
                    onChange={(e) => setNewSales({ ...newSales, last_name: e.target.value })}
                    className="w-full px-3 py-2 bg-surface border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-muted mb-1">Email</label>
                <input
                  type="email"
                  value={newSales.email}
                  onChange={(e) => setNewSales({ ...newSales, email: e.target.value })}
                  className="w-full px-3 py-2 bg-surface border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-ink-muted mb-1">Phone</label>
                  <input
                    type="tel"
                    value={newSales.phone}
                    onChange={(e) => setNewSales({ ...newSales, phone: e.target.value })}
                    className="w-full px-3 py-2 bg-surface border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-ink-muted mb-1">Commission %</label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    value={newSales.commission_rate}
                    onChange={(e) => setNewSales({ ...newSales, commission_rate: e.target.value })}
                    className="w-full px-3 py-2 bg-surface border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal/40"
                  />
                </div>
              </div>
            </div>
            <div className="flex gap-3 mt-5">
              <button
                onClick={() => setShowNewSales(false)}
                className="flex-1 px-4 py-2 border border-line rounded-lg text-sm text-ink-muted hover:text-ink"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateSalesPerson}
                disabled={creatingSales}
                className="flex-1 px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {creatingSales && <Loader2 className="w-4 h-4 animate-spin" />}
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Backorder confirmation */}
      {showBackorderConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl w-full max-w-md p-6 shadow-xl">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                <PackageX className="w-4 h-4 text-amber-600" />
              </div>
              <h3 className="font-bold text-ink">Backorder confirmation</h3>
            </div>
            <p className="text-sm text-ink-muted mb-4">
              One or more line items exceed available stock. Sending this invoice now will create a
              backorder for the exceeding quantities.
            </p>
            <ul className="mb-5 space-y-1">
              {uniqueStockErrors.map((e) => (
                <li key={e.description} className="text-xs text-ink flex justify-between gap-3">
                  <span className="truncate">{e.description}</span>
                  <span className="tabular-nums text-ink-muted flex-shrink-0">
                    need {e.requested}, have {e.available}
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex gap-3">
              <button
                onClick={() => setShowBackorderConfirm(false)}
                className="flex-1 px-4 py-2 border border-line rounded-lg text-sm text-ink-muted hover:text-ink"
              >
                Cancel
              </button>
              <button
                onClick={() => doSubmit('sent')}
                disabled={saving}
                className="flex-1 px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                Send and backorder
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
