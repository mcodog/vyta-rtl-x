// ============================================================
// ECOMMERCE BACKEND — SHARED TYPES
// ============================================================

// ---- MODULE 1: INVENTORY ----

export interface Supplier {
  id: string;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  lead_time_days: number;
  notes: string | null;
  created_at: string;
  updated_at?: string;
}

export interface ProductVariant {
  id: string;
  product_id: string;
  sku: string;
  option_name: string;
  option_value: string;
  qty_on_hand: number;
  reorder_threshold: number;
  created_at: string;
  updated_at: string;
}

export interface InventoryLog {
  id: string;
  variant_id: string;
  change_qty: number;
  reason: 'sale' | 'return' | 'adjustment' | 'restock';
  reference_id: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

export interface LowStockAlert {
  variant_id: string;
  product_id: string;
  product_name: string;
  sku: string;
  option_name: string;
  option_value: string;
  qty_on_hand: number;
  reorder_threshold: number;
}

export interface ValuationRow {
  product_id: string;
  product_name: string;
  sku: string;
  option_name: string;
  option_value: string;
  qty_on_hand: number;
  cost_price: number;
  line_value: number;
}

export interface ValuationResult {
  rows: ValuationRow[];
  total_value: number;
  total_units: number;
}

// ---- MODULE 2: INVOICING ----

export type InvoiceStatus =
  | 'draft'
  | 'sent'
  | 'paid'
  | 'partial'
  | 'overdue'
  | 'cancelled'
  // Stealth Health hand-offs: invoiced when the buyer is sent to pay, then
  // flipped to `paid` — or to `expired` if the payment link lapses unpaid.
  | 'pending_payment'
  | 'expired';
// 'e-transfer' is no longer accepted for new payments; kept so historical rows still type-check.
export type PaymentMethod = 'card' | 'e-transfer' | 'cash' | 'other';

export interface Invoice {
  id: string;
  invoice_number: string;
  order_id: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  issue_date: string;
  due_date: string;
  subtotal: number;
  tax_total: number;
  shipping_cost: number;
  total: number;
  currency: string;
  status: InvoiceStatus;
  notes: string | null;
  sales_person_id: string | null;
  sales_person_commission_rate: number;
  sales_person_commission_amount: number;
  created_at: string;
  updated_at: string;
}

export interface SalesPerson {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  commission_rate: number;
  notes: string | null;
  active: boolean;
  total_earnings: number;
  created_at: string;
  updated_at: string;
}

export interface SalesCommission {
  id: string;
  sales_person_id: string;
  invoice_id: string | null;
  amount: number;
  invoice_total: number;
  commission_rate: number;
  status: 'pending' | 'paid' | 'cancelled';
  paid_at: string | null;
  created_at: string;
}

export interface InvoiceLineItem {
  id: string;
  invoice_id: string;
  product_id: string | null;
  product_variant_id: string | null;
  description: string;
  qty: number;
  unit_price: number;
  discount_pct: number;
  line_total: number;
}

export interface Payment {
  id: string;
  invoice_id: string;
  amount: number;
  method: PaymentMethod;
  reference_note: string | null;
  paid_at: string;
  recorded_by: string | null;
}

export interface AgingBucket {
  label: string;
  count: number;
  total: number;
  invoices: (Invoice & { customer_name?: string })[];
}

export interface AgingReport {
  current: AgingBucket;
  days_1_30: AgingBucket;
  days_31_60: AgingBucket;
  days_61_90: AgingBucket;
  days_90_plus: AgingBucket;
  grand_total: number;
}

// ---- MODULE 3: ORDERS ----

export type AdminOrderStatus =
  | 'pending'
  | 'confirmed'
  | 'processing'
  | 'packed'
  | 'shipped'
  | 'delivered'
  | 'completed'
  | 'cancelled'
  | 'refunded';

export interface ShippingAddress {
  firstName: string;
  lastName: string;
  address: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone?: string;
}

export interface AdminOrderItem {
  id: string;
  order_id: string;
  product_variant_id: string | null;
  sku_snapshot: string | null;
  name_snapshot: string | null;
  qty: number;
  unit_price: number;
  discount_pct: number;
  line_total: number;
  restocked: boolean;
}

export interface AdminOrder {
  id: string;
  order_number: string;
  customer_id: string | null;
  status: AdminOrderStatus;
  billing_address: ShippingAddress | null;
  shipping_address: ShippingAddress | null;
  subtotal: number;
  discount_total: number;
  tax_total: number;
  shipping_cost: number;
  shipping_method: string | null;
  shipping_carrier: string | null;
  tracking_number: string | null;
  easyship_shipment_id: string | null;
  notes: string | null;
  staff_notes: string | null;
  packed_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  refunded_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RefundLineItem {
  order_item_id: string;
  qty: number;
  restock: boolean;
}

export interface RefundRequest {
  order_id: string;
  line_items: RefundLineItem[];
  reason: string;
  full_refund: boolean;
}

// ---- EASYSHIP ----

export interface EasyshipRateRequest {
  origin_country_alpha2: string;
  origin_postal_code: string;
  origin_state?: string;
  origin_city?: string;
  destination_country_alpha2: string;
  destination_postal_code: string;
  destination_city: string;
  destination_state?: string;
  /** Whole-parcel weight (kg). Split evenly over `quantity` units. */
  total_actual_weight: number;
  /**
   * Units in the parcel (default 1). The quote's only real-valued item field:
   * category, declared value and dimensions are fixed — see "Parcel contents"
   * in lib/easyship.ts.
   */
  quantity?: number;
  declared_currency?: string;
  boxes: Array<{
    length: number;
    width: number;
    height: number;
    weight: number;
  }>;
}

export interface EasyshipRate {
  courier_id: string;
  courier_name: string;
  service_name: string;
  min_delivery_time: number;
  max_delivery_time: number;
  total_charge: number;
  currency: string;
  tracking_rating: number;
}

export type EasyshipHandover = 'dropoff' | 'collection' | 'free_collection';

export interface EasyshipShipmentRequest {
  order_id: string;
  selected_courier_id: string;
  origin: {
    name: string;
    company?: string;
    phone?: string;
    email?: string;
    address: string;
    city: string;
    state?: string;
    postal_code: string;
    country_alpha2: string;
  };
  destination: ShippingAddress & { country_alpha2: string; email?: string };
  /**
   * One parcel per entry. Description, category (supplements) and declared
   * value (1 per unit) are fixed by createEasyshipShipment; blank dimensions
   * fall back to 1 cm.
   */
  parcels: Array<{
    /** Units in the parcel. */
    quantity: number;
    /** Per-unit weight (kg). */
    actual_weight: number;
    height?: number | null;
    width?: number | null;
    length?: number | null;
    declared_currency?: string;
  }>;
  /** Purchase Easyship parcel insurance for this shipment (default false). */
  insured?: boolean;
  /** How the parcel gets to the courier: dropoff (default), collection, or
   *  free_collection where the courier picks up at no extra charge. */
  handover?: EasyshipHandover;
}

export interface EasyshipShipmentResponse {
  easyship_shipment_id: string;
  tracking_number: string | null;
  label_url: string | null;
  courier_name: string | null;
  total_charge: number | null;
  currency: string | null;
}

// ---- PURCHASE ORDERS ----

export type PurchaseOrderStatus = 'pending' | 'partially_fulfilled' | 'fulfilled' | 'paid' | 'cancelled';
export type TaxType = 'percentage' | 'fixed';
// Discount shares the same percentage/fixed input shape as tax.
export type DiscountType = TaxType;
// Alias used by lib/supabase.ts re-export per architecture doc.
export type PurchaseOrderTaxType = TaxType;

export interface PurchaseOrder {
  id: string;
  po_number: string;
  supplier_id: string;
  status: PurchaseOrderStatus;
  subtotal: number;
  shipping_fee: number;
  discount_type: DiscountType;
  discount_value: number;
  discount: number;
  tax_type: TaxType;
  tax_value: number;
  tax_total: number;
  total: number;
  notes: string | null;
  order_date: string | null;
  expected_date: string | null;
  inventory_applied: boolean;
  inventory_applied_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PurchaseOrderItem {
  id: string;
  purchase_order_id: string;
  product_id: string | null;
  product_variant_id: string | null;
  description: string;
  sku_snapshot: string | null;
  qty: number;
  qty_received: number;
  unit_price: number;
  line_total: number;
  created_at?: string;
}

export interface PurchaseOrderReceiptItem {
  id: string;
  receipt_id: string;
  po_item_id: string;
  product_id: string | null;
  qty: number;
  created_at: string;
}

export interface PurchaseOrderReceipt {
  id: string;
  purchase_order_id: string;
  note: string | null;
  created_by: string | null;
  created_at: string;
  items?: PurchaseOrderReceiptItem[];
}

export interface PurchaseOrderWithSupplier extends PurchaseOrder {
  supplier: Supplier;
  items: PurchaseOrderItem[];
  receipts?: PurchaseOrderReceipt[];
}

// ---- SUPPLIER PRICELISTS ----

export interface SupplierPrice {
  id: string;
  supplier_id: string;
  product_id: string;
  price: number;
  created_at: string;
  updated_at: string;
}

// One row of the per-supplier price editor: a product joined with this
// supplier's negotiated price (null ⇒ falls back to original_price).
export interface SupplierPriceRow {
  product_id: string;
  product_name: string;
  sku: string | null;
  original_price: number;
  supplier_price: number | null;
}

// Cheapest known supplier for a product, keyed by product_id.
export interface CheapestSupplierPrice {
  product_id: string;
  supplier_id: string;
  supplier_name: string;
  price: number;
}

// Chip shape used in the create/edit form (product-based).
export interface ProductChip {
  id: string;          // product_id
  product_name: string;
  sku: string;
  unit_price: number;  // default cost — supplier price or products.price
  stock_quantity: number;
}

// In-form line item (before saving). Keyed on product_id.
export interface PODraftItem {
  product_id: string;
  description: string;
  sku_snapshot: string;
  unit_price: number;
  qty: number;
  qty_received?: number;
  line_total: number;
  /** Box (pack of `vials_per_box`) or vial (single) pricing. Defaults to 'box'. */
  price_type?: 'box' | 'vial';
}
