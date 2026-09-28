import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { logAuditServer } from '@/lib/admin/audit';
import { resolveStaffCaller } from '@/lib/affiliate/route-auth';
import {
  hasRestrictions,
  PAID_ORDER_STATUSES,
  RESTRICTIONS_NEED_MIGRATION,
  shapeDiscountCodeInput,
  shapeDiscountCodeRow,
  withoutRestrictions,
  type DiscountCodeRow,
} from '@/lib/affiliate/discount-codes';
import { isMissingColumnError } from '@/lib/payments/puramass-columns';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export interface DiscountCodeStats {
  /** Paid orders that used the code. */
  orders: number;
  /** Goods revenue from those orders (after the discount), CAD. */
  revenue: number;
  /** What the code itself took off, CAD. */
  discount_given: number;
  /** Commission booked on it (cancelled excluded), CAD. */
  commission: number;
  /** Of which still unpaid, CAD. */
  commission_pending: number;
}

export interface AdminDiscountCode extends DiscountCodeRow {
  affiliate_name: string | null;
  affiliate_email: string | null;
  stats: DiscountCodeStats;
  /** Slug of the landing page this code is the offer for, if any. */
  landing_page: string | null;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Per-code revenue, discount and commission, keyed by code id. */
async function statsFor(ids: string[]): Promise<Map<string, DiscountCodeStats>> {
  const stats = new Map<string, DiscountCodeStats>();
  for (const id of ids) {
    stats.set(id, { orders: 0, revenue: 0, discount_given: 0, commission: 0, commission_pending: 0 });
  }
  if (ids.length === 0) return stats;

  const [{ data: orders }, { data: commissions }] = await Promise.all([
    db
      .from('puramass_orders')
      .select('discount_code_id, subtotal_cents, discount_code_cents, status')
      .in('discount_code_id', ids)
      .in('status', PAID_ORDER_STATUSES),
    db
      .from('commissions')
      .select('discount_code_id, amount, status')
      .in('discount_code_id', ids)
      .neq('status', 'cancelled'),
  ]);

  for (const o of orders ?? []) {
    const s = stats.get(o.discount_code_id as string);
    if (!s) continue;
    s.orders += 1;
    s.revenue += (Number(o.subtotal_cents) || 0) / 100;
    s.discount_given += (Number(o.discount_code_cents) || 0) / 100;
  }
  for (const c of commissions ?? []) {
    const s = stats.get(c.discount_code_id as string);
    if (!s) continue;
    s.commission += Number(c.amount) || 0;
    if (c.status === 'pending') s.commission_pending += Number(c.amount) || 0;
  }
  for (const s of stats.values()) {
    s.revenue = round2(s.revenue);
    s.discount_given = round2(s.discount_given);
    s.commission = round2(s.commission);
    s.commission_pending = round2(s.commission_pending);
  }
  return stats;
}

/**
 * GET /api/admin/discount-codes[?affiliate_id=…] — every code with who it is
 * assigned to and what it has brought in. Staff (admin + assistant).
 */
export async function GET(req: NextRequest) {
  const caller = await resolveStaffCaller(db, req, { allowAssistant: true });
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });

  const affiliateId = req.nextUrl.searchParams.get('affiliate_id');
  // `*` so the restriction columns come back once they exist, without naming
  // them in a query an unmigrated install would fail.
  let query = db.from('discount_codes').select('*').order('created_at', { ascending: false });
  if (affiliateId) query = query.eq('affiliate_id', affiliateId);

  const { data, error } = await query;
  if (error) {
    // 42P01 = undefined table: the migration has not been run yet.
    if (error.code === '42P01' || /discount_codes/.test(error.message ?? '')) {
      return NextResponse.json({ codes: [], migrationNeeded: true });
    }
    console.error('[discount-codes] list failed:', error);
    return NextResponse.json({ error: 'Could not load discount codes' }, { status: 500 });
  }

  const rows = ((data ?? []) as unknown as DiscountCodeRow[]).map(shapeDiscountCodeRow);
  const affiliateIds = [...new Set(rows.map((r) => r.affiliate_id).filter(Boolean))] as string[];
  const [stats, { data: affiliates }, { data: landings }] = await Promise.all([
    statsFor(rows.map((r) => r.id)),
    affiliateIds.length
      ? db.from('affiliates').select('id, first_name, last_name, email').in('id', affiliateIds)
      : Promise.resolve({ data: [] as { id: string; first_name: string | null; last_name: string | null; email: string }[] }),
    // Which codes are a landing page's offer. The table arrives with
    // landing-pages-migration.sql; until then this read errors and no code
    // is tagged.
    rows.length
      ? db.from('landing_pages').select('slug, discount_code_id').in('discount_code_id', rows.map((r) => r.id))
      : Promise.resolve({ data: [] as { slug: string; discount_code_id: string }[] }),
  ]);
  const byId = new Map((affiliates ?? []).map((a) => [a.id, a]));
  const landingByCode = new Map(
    ((landings ?? []) as { slug: string; discount_code_id: string }[]).map((l) => [l.discount_code_id, l.slug]),
  );

  const codes: AdminDiscountCode[] = rows.map((r) => {
    const a = r.affiliate_id ? byId.get(r.affiliate_id) : null;
    return {
      ...r,
      discount_value: Number(r.discount_value),
      commission_rate: r.commission_rate == null ? null : Number(r.commission_rate),
      min_subtotal: r.min_subtotal == null ? null : Number(r.min_subtotal),
      affiliate_name: a ? `${a.first_name ?? ''} ${a.last_name ?? ''}`.trim() || a.email : null,
      affiliate_email: a?.email ?? null,
      stats: stats.get(r.id)!,
      landing_page: landingByCode.get(r.id) ?? null,
    };
  });

  return NextResponse.json({ codes });
}

/** POST /api/admin/discount-codes — create a code. Admin only. */
export async function POST(req: NextRequest) {
  const caller = await resolveStaffCaller(db, req);
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });

  const body = await req.json().catch(() => ({}));
  const shaped = shapeDiscountCodeInput(body ?? {});
  if (!shaped.ok) return NextResponse.json({ error: shaped.error }, { status: 400 });
  const input = shaped.value;

  if (input.affiliate_id) {
    const { data: affiliate } = await db
      .from('affiliates')
      .select('id')
      .eq('id', input.affiliate_id)
      .maybeSingle();
    if (!affiliate) return NextResponse.json({ error: 'Affiliate not found' }, { status: 404 });
  }

  const insert = (row: Record<string, unknown>) =>
    db.from('discount_codes').insert(row).select('*').single();
  let { data, error } = await insert({ ...input, created_by: caller.staff.id });
  // Before landing-pages-migration.sql there is nowhere to store a restriction.
  // A code without one is created as before; one with one is refused rather
  // than saved as a looser code than the admin asked for.
  if (error && isMissingColumnError(error)) {
    if (hasRestrictions(input)) {
      return NextResponse.json({ error: RESTRICTIONS_NEED_MIGRATION }, { status: 400 });
    }
    ({ data, error } = await insert({ ...withoutRestrictions({ ...input }), created_by: caller.staff.id }));
  }

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: `${input.code} is already in use.` }, { status: 409 });
    }
    console.error('[discount-codes] create failed:', error);
    return NextResponse.json({ error: 'Could not create the code' }, { status: 500 });
  }

  await logAuditServer(
    db,
    { actor_id: caller.staff.id, actor_email: caller.staff.email },
    { action: 'discount_code.create', entity_type: 'discount_code', entity_id: (data as any).id },
  );

  return NextResponse.json({ code: data }, { status: 201 });
}
