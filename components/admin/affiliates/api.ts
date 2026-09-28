/**
 * Browser-side calls for discount codes and affiliate payouts. Every request
 * carries the admin's bearer token; the routes decide who may do what.
 */
import { supabase } from '@/lib/supabase';

export async function adminFetch<T = any>(
  url: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export interface DiscountCodeStats {
  orders: number;
  revenue: number;
  discount_given: number;
  commission: number;
  commission_pending: number;
}

export interface AdminDiscountCode {
  id: string;
  code: string;
  affiliate_id: string | null;
  affiliate_name: string | null;
  affiliate_email: string | null;
  discount_type: 'percent' | 'fixed';
  discount_value: number;
  commission_rate: number | null;
  min_subtotal: number | null;
  max_uses: number | null;
  starts_at: string | null;
  expires_at: string | null;
  active: boolean;
  notes: string | null;
  created_at: string;
  stats: DiscountCodeStats;
  /** Refused to buyers who have ordered before. False until migrated. */
  first_order_only?: boolean;
  /** Products the code takes nothing off. */
  excluded_product_ids?: string[];
  /** Slug of the landing page this code is the offer for, if any. */
  landing_page?: string | null;
}

export interface AffiliateOption {
  id: string;
  name: string;
  email: string;
  active: boolean;
}

export async function loadAffiliateOptions(): Promise<AffiliateOption[]> {
  const { ok, data } = await adminFetch<{ affiliates?: any[] }>('/api/admin/affiliates/directory');
  if (!ok) return [];
  return (data.affiliates ?? [])
    .map((a) => ({
      id: a.id,
      name: `${a.first_name ?? ''} ${a.last_name ?? ''}`.trim() || a.email,
      email: a.email,
      active: a.active !== false,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const fmtMoney = (n: number) =>
  `$${(Number(n) || 0).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function describeCode(c: Pick<AdminDiscountCode, 'discount_type' | 'discount_value'>): string {
  return c.discount_type === 'fixed'
    ? `${fmtMoney(c.discount_value)} off`
    : `${+Number(c.discount_value).toFixed(2)}% off`;
}

/** Where a code stands right now, for the status pill. */
export function codeStatus(c: AdminDiscountCode, now = Date.now()): {
  label: string;
  tone: 'green' | 'gray' | 'amber' | 'red';
} {
  if (!c.active) return { label: 'Inactive', tone: 'gray' };
  if (c.expires_at && Date.parse(c.expires_at) <= now) return { label: 'Expired', tone: 'red' };
  if (c.starts_at && Date.parse(c.starts_at) > now) return { label: 'Scheduled', tone: 'amber' };
  if (c.max_uses != null && c.stats.orders >= c.max_uses) return { label: 'Used up', tone: 'red' };
  return { label: 'Active', tone: 'green' };
}

export function shareLink(code: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}/checkout?discount=${encodeURIComponent(code)}`;
}
