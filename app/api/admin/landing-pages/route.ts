import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { logAuditServer } from '@/lib/admin/audit';
import { resolveStaffCaller } from '@/lib/affiliate/route-auth';
import { shapeLandingPageInput } from '@/lib/promos/landing';
import type { LandingPageRow } from '@/lib/promos/landing-server';
import type { DiscountCodeRow } from '@/lib/affiliate/discount-codes';
import {
  isMissingTable,
  landingStats,
  MIGRATION_MESSAGE,
  offerToCode,
  presentLanding,
  writeCode,
} from './shared';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/admin/landing-pages[?days=30] — every landing page, the offer it is
 * making, and the funnel it has produced. Staff (admin + assistant).
 */
export async function GET(req: NextRequest) {
  const caller = await resolveStaffCaller(db, req, { allowAssistant: true });
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });

  const days = Number(req.nextUrl.searchParams.get('days'));
  const since =
    Number.isFinite(days) && days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : null;

  const { data, error } = await db
    .from('landing_pages')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) {
    if (isMissingTable(error)) return NextResponse.json({ landingPages: [], migrationNeeded: true });
    console.error('[landing-pages] list failed:', error);
    return NextResponse.json({ error: 'Could not load landing pages' }, { status: 500 });
  }

  const rows = (data ?? []) as LandingPageRow[];
  const codeIds = rows.map((r) => r.discount_code_id).filter(Boolean) as string[];
  const [{ data: codes }, { stats, countersMissing }] = await Promise.all([
    codeIds.length
      ? db.from('discount_codes').select('*').in('id', codeIds)
      : Promise.resolve({ data: [] as DiscountCodeRow[] }),
    landingStats(db, rows.map((r) => r.slug), since),
  ]);
  const codeById = new Map(((codes ?? []) as DiscountCodeRow[]).map((c) => [c.id, c]));

  return NextResponse.json({
    countersMissing,
    landingPages: rows.map((r) =>
      presentLanding(r, r.discount_code_id ? codeById.get(r.discount_code_id) ?? null : null, stats.get(r.slug)),
    ),
  });
}

/**
 * POST /api/admin/landing-pages — create a landing page and, when it makes an
 * offer, the discount code that is that offer. Admin only.
 *
 * The code is created first and removed again if the landing page cannot be,
 * so a failed create never leaves a live code behind with nothing pointing at
 * it.
 */
export async function POST(req: NextRequest) {
  const caller = await resolveStaffCaller(db, req);
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });

  const body = (await req.json().catch(() => ({}))) ?? {};
  const shaped = shapeLandingPageInput(body);
  if (!shaped.ok) return NextResponse.json({ error: shaped.error }, { status: 400 });
  const input = shaped.value;

  // The table has to exist before anything is created against it.
  const probe = await db.from('landing_pages').select('id').limit(1);
  if (probe.error && isMissingTable(probe.error)) {
    return NextResponse.json({ error: MIGRATION_MESSAGE }, { status: 400 });
  }

  let codeId: string | null = null;
  if (input.offer) {
    const codeInput = offerToCode(input.slug, input.offer);
    if (!codeInput.ok) return NextResponse.json({ error: codeInput.error }, { status: 400 });
    const created = await writeCode({ ...codeInput.value, created_by: caller.staff.id }, (row) =>
      db.from('discount_codes').insert(row).select('id').single(),
    );
    if (created.error || !created.data) {
      if (created.message) return NextResponse.json({ error: created.message }, { status: created.status ?? 400 });
      console.error('[landing-pages] code create failed:', created.error);
      return NextResponse.json({ error: 'Could not create the discount code' }, { status: 500 });
    }
    codeId = created.data.id;
  }

  const { offer: _offer, ...landing } = input;
  const { data, error } = await db
    .from('landing_pages')
    .insert({ ...landing, discount_code_id: codeId, created_by: caller.staff.id })
    .select('*')
    .single();

  if (error || !data) {
    if (codeId) await db.from('discount_codes').delete().eq('id', codeId);
    if (error?.code === '23505') {
      return NextResponse.json({ error: `The slug "${input.slug}" is already in use.` }, { status: 409 });
    }
    console.error('[landing-pages] create failed:', error);
    return NextResponse.json({ error: 'Could not create the landing page' }, { status: 500 });
  }

  await logAuditServer(
    db,
    { actor_id: caller.staff.id, actor_email: caller.staff.email },
    { action: 'landing_page.create', entity_type: 'landing_page', entity_id: (data as any).id },
  );

  return NextResponse.json({ landingPage: data }, { status: 201 });
}
