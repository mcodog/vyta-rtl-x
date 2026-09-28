import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { logAuditServer } from '@/lib/admin/audit';
import { resolveStaffCaller } from '@/lib/affiliate/route-auth';
import { shapeLandingPageInput } from '@/lib/promos/landing';
import type { LandingPageRow } from '@/lib/promos/landing-server';
import { offerToCode, writeCode } from '../shared';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

type Params = { params: Promise<{ id: string }> };

async function loadLanding(id: string): Promise<LandingPageRow | null> {
  const { data } = await db.from('landing_pages').select('*').eq('id', id).maybeSingle();
  return (data as LandingPageRow | null) ?? null;
}

/**
 * PATCH /api/admin/landing-pages/[id] — edit a landing page and its offer, or
 * just `{ active }` for the list's on/off switch. Admin only.
 *
 * The offer is the page's discount code, edited in place so its revenue
 * history stays with it. Removing the offer switches that code off rather than
 * leaving a live percentage behind that nothing advertises.
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const caller = await resolveStaffCaller(db, req);
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });
  const { id } = await params;

  const existing = await loadLanding(id);
  if (!existing) return NextResponse.json({ error: 'Landing page not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) ?? {};
  const now = new Date().toISOString();

  if (Object.keys(body).length === 1 && typeof body.active === 'boolean') {
    const { error } = await db.from('landing_pages').update({ active: body.active, updated_at: now }).eq('id', id);
    if (error) return NextResponse.json({ error: 'Could not update the landing page' }, { status: 500 });
    await logAuditServer(
      db,
      { actor_id: caller.staff.id, actor_email: caller.staff.email },
      { action: 'landing_page.update', entity_type: 'landing_page', entity_id: id },
    );
    return NextResponse.json({ ok: true });
  }

  const shaped = shapeLandingPageInput(body);
  if (!shaped.ok) return NextResponse.json({ error: shaped.error }, { status: 400 });
  const input = shaped.value;

  let codeId = existing.discount_code_id;
  if (input.offer) {
    const codeInput = offerToCode(input.slug, input.offer);
    if (!codeInput.ok) return NextResponse.json({ error: codeInput.error }, { status: 400 });
    const v = codeInput.value;
    // Only the fields the landing form owns. Anything else set on the code
    // from the Discount Codes page (a minimum, notes) is left as it is.
    const patch: Record<string, unknown> = {
      code: v.code,
      discount_type: 'percent',
      discount_value: v.discount_value,
      max_uses: v.max_uses,
      starts_at: v.starts_at,
      expires_at: v.expires_at,
      active: true,
      first_order_only: v.first_order_only,
      excluded_product_ids: v.excluded_product_ids,
      updated_at: now,
    };
    const updated = codeId
      ? await writeCode(patch, (row) =>
          db.from('discount_codes').update(row).eq('id', codeId!).select('id').maybeSingle(),
        )
      : null;
    if (updated?.message) return NextResponse.json({ error: updated.message }, { status: updated.status ?? 400 });
    if (updated?.error) {
      console.error('[landing-pages] code update failed:', updated.error);
      return NextResponse.json({ error: 'Could not update the discount code' }, { status: 500 });
    }
    // No code yet, or the one it had was deleted from the Discount Codes page.
    if (!updated?.data) {
      const created = await writeCode({ ...v, created_by: caller.staff.id }, (row) =>
        db.from('discount_codes').insert(row).select('id').single(),
      );
      if (created.message) return NextResponse.json({ error: created.message }, { status: created.status ?? 400 });
      if (created.error || !created.data) {
        console.error('[landing-pages] code create failed:', created.error);
        return NextResponse.json({ error: 'Could not create the discount code' }, { status: 500 });
      }
      codeId = created.data.id;
    }
  } else if (codeId) {
    await db.from('discount_codes').update({ active: false, updated_at: now }).eq('id', codeId);
    codeId = null;
  }

  const { offer: _offer, ...landing } = input;
  const { error } = await db
    .from('landing_pages')
    .update({ ...landing, discount_code_id: codeId, updated_at: now })
    .eq('id', id);
  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: `The slug "${input.slug}" is already in use.` }, { status: 409 });
    }
    console.error('[landing-pages] update failed:', error);
    return NextResponse.json({ error: 'Could not update the landing page' }, { status: 500 });
  }

  await logAuditServer(
    db,
    { actor_id: caller.staff.id, actor_email: caller.staff.email },
    { action: 'landing_page.update', entity_type: 'landing_page', entity_id: id },
  );
  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/admin/landing-pages/[id] — remove a landing page no order came
 * through. Admin only. One with orders is refused (switch it off instead) so
 * its revenue keeps a name in the report. Its code is deleted too when nothing
 * used it, and switched off when something did.
 */
export async function DELETE(req: NextRequest, { params }: Params) {
  const caller = await resolveStaffCaller(db, req);
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });
  const { id } = await params;

  const existing = await loadLanding(id);
  if (!existing) return NextResponse.json({ error: 'Landing page not found' }, { status: 404 });

  const { count: orderCount } = await db
    .from('puramass_orders')
    .select('id', { count: 'exact', head: true })
    .eq('landing_page', existing.slug);
  if ((orderCount ?? 0) > 0) {
    return NextResponse.json(
      { error: 'Orders came through this landing page, so its history is kept. Switch it off instead.' },
      { status: 409 },
    );
  }

  const { error } = await db.from('landing_pages').delete().eq('id', id);
  if (error) {
    console.error('[landing-pages] delete failed:', error);
    return NextResponse.json({ error: 'Could not delete the landing page' }, { status: 500 });
  }

  if (existing.discount_code_id) {
    const { count: uses } = await db
      .from('puramass_orders')
      .select('id', { count: 'exact', head: true })
      .eq('discount_code_id', existing.discount_code_id);
    if ((uses ?? 0) > 0) {
      await db
        .from('discount_codes')
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq('id', existing.discount_code_id);
    } else {
      await db.from('discount_codes').delete().eq('id', existing.discount_code_id);
    }
  }

  await logAuditServer(
    db,
    { actor_id: caller.staff.id, actor_email: caller.staff.email },
    { action: 'landing_page.delete', entity_type: 'landing_page', entity_id: id },
  );
  return NextResponse.json({ deleted: true });
}
