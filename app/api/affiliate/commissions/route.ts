import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { resolveAffiliateCaller } from '@/lib/affiliate/route-auth';
import { normalizeCommissionRate } from '@/lib/affiliate/commission';
import { loadAffiliateReferrals } from '@/lib/admin/affiliate-referrals';
import type { AffiliateCommissionRow } from '@/lib/affiliate/types';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const ROW_LIMIT = 5000;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * GET /api/affiliate/commissions — the signed-in affiliate's commission
 * history from both streams (referral sales and invoices they're the sales
 * person on), with totals and referral counts for the dashboard.
 *
 * The dashboard used to read `commissions` from the browser, which RLS can
 * return empty — so an affiliate with money owed saw $0. This reads with the
 * service role, scoped to the caller, with plain selects (no embedded joins).
 */
export async function GET(req: NextRequest) {
  const caller = await resolveAffiliateCaller(db, req);
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });
  const affiliateId = caller.affiliate.id;

  const [affRes, salesPersonRes, codesRes, affiliateRes] = await Promise.all([
    db
      .from('commissions')
      .select('id, affiliate_id, order_id, invoice_id, amount, order_total, commission_rate, status, paid_at, created_at')
      .eq('affiliate_id', affiliateId)
      .order('created_at', { ascending: false })
      .limit(ROW_LIMIT),
    // Affiliates created through the admin flow share their auth id with a
    // linked sales_persons row.
    db.from('sales_persons').select('id').eq('user_id', affiliateId).maybeSingle(),
    db.from('referral_codes').select('uses_count').eq('affiliate_id', affiliateId),
    db.from('affiliates').select('id, commission_rate').eq('id', affiliateId).maybeSingle(),
  ]);
  if (affRes.error) console.error('[affiliate/commissions] commissions:', affRes.error.message);

  const affRows = (affRes.data ?? []) as any[];

  let salesRows: any[] = [];
  if (salesPersonRes.data?.id) {
    const { data, error } = await db
      .from('sales_commissions')
      .select('id, invoice_id, amount, invoice_total, commission_rate, status, paid_at, created_at')
      .eq('sales_person_id', salesPersonRes.data.id)
      .order('created_at', { ascending: false })
      .limit(ROW_LIMIT);
    if (error) console.error('[affiliate/commissions] sales_commissions:', error.message);
    salesRows = data ?? [];
  }

  // Human-readable references, read in batches rather than embedded.
  const orderIds = [...new Set(affRows.map((c) => c.order_id).filter(Boolean))] as string[];
  const invoiceIds = [
    ...new Set([...affRows, ...salesRows].map((c) => c.invoice_id).filter(Boolean)),
  ] as string[];
  const [ordersRes, invoicesRes, orderInvoicesRes] = await Promise.all([
    orderIds.length
      ? db.from('orders').select('id, order_number').in('id', orderIds)
      : Promise.resolve({ data: [] as any[] }),
    invoiceIds.length
      ? db.from('invoices').select('id, invoice_number').in('id', invoiceIds)
      : Promise.resolve({ data: [] as any[] }),
    orderIds.length
      ? db.from('invoices').select('order_id, invoice_number').in('order_id', orderIds)
      : Promise.resolve({ data: [] as any[] }),
  ]);
  const orderNo = new Map((ordersRes.data ?? []).map((o: any) => [o.id, o.order_number]));
  const invoiceNo = new Map((invoicesRes.data ?? []).map((i: any) => [i.id, i.invoice_number]));
  const orderInvoiceNo = new Map((orderInvoicesRes.data ?? []).map((i: any) => [i.order_id, i.invoice_number]));

  const shortId = (id: string | null | undefined) => (id ? String(id).slice(0, 8) : '—');

  const referral: AffiliateCommissionRow[] = affRows.map((c) => ({
    id: c.id,
    source: 'referral',
    reference:
      (c.invoice_id && invoiceNo.get(c.invoice_id)) ||
      (c.order_id && (orderInvoiceNo.get(c.order_id) || orderNo.get(c.order_id))) ||
      shortId(c.invoice_id ?? c.order_id),
    base: round2(num(c.order_total)),
    amount: round2(num(c.amount)),
    rate: round2(normalizeCommissionRate(c.commission_rate) * 100),
    status: String(c.status ?? 'pending').toLowerCase(),
    created_at: c.created_at,
    paid_at: c.paid_at ?? null,
  }));

  const invoice: AffiliateCommissionRow[] = salesRows.map((c) => {
    const rate = num(c.commission_rate);
    return {
      id: c.id,
      source: 'invoice',
      reference: (c.invoice_id && invoiceNo.get(c.invoice_id)) || shortId(c.invoice_id),
      base: round2(num(c.invoice_total)),
      amount: round2(num(c.amount)),
      rate: round2(rate > 0 && rate <= 1 ? rate * 100 : rate),
      status: String(c.status ?? 'pending').toLowerCase(),
      created_at: c.created_at,
      paid_at: c.paid_at ?? null,
    };
  });

  const rows = [...referral, ...invoice].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  const paid = round2(rows.filter((r) => r.status === 'paid').reduce((s, r) => s + r.amount, 0));
  const pending = round2(rows.filter((r) => r.status === 'pending').reduce((s, r) => s + r.amount, 0));

  // Same referral count the admin affiliates desk shows: customers bound to
  // them plus buyers credited through a commissioned sale.
  const referrals = await loadAffiliateReferrals(db, [{ id: affiliateId }], { commissions: affRows });
  const referred = referrals.get(affiliateId);
  const codeUses = (codesRes.data ?? []).reduce((s: number, c: any) => s + num(c.uses_count), 0);

  return NextResponse.json({
    rows,
    paid,
    pending,
    total: round2(paid + pending),
    commissionCount: rows.filter((r) => r.status !== 'cancelled').length,
    referrals: referred?.customers.length ?? 0,
    referredSales: referred?.revenue ?? 0,
    codeUses,
    commissionRate: round2(normalizeCommissionRate(affiliateRes.data?.commission_rate) * 100),
  });
}
