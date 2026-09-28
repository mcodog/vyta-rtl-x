import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { logAuditServer } from '@/lib/admin/audit';
import { resolveStaffCaller } from '@/lib/affiliate/route-auth';
import {
  hasRestrictions,
  RESTRICTIONS_NEED_MIGRATION,
  shapeDiscountCodeInput,
  withoutRestrictions,
} from '@/lib/affiliate/discount-codes';
import { isMissingColumnError } from '@/lib/payments/puramass-columns';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * PATCH /api/admin/discount-codes/[id] — edit a code. Admin only.
 *
 * Accepts either a full edit (every field, validated like a create) or just
 * `{ active }` for the list's on/off switch.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const caller = await resolveStaffCaller(db, req);
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });

  const body = (await req.json().catch(() => ({}))) ?? {};
  let update: Record<string, unknown>;

  if (Object.keys(body).length === 1 && typeof body.active === 'boolean') {
    update = { active: body.active };
  } else {
    const shaped = shapeDiscountCodeInput(body);
    if (!shaped.ok) return NextResponse.json({ error: shaped.error }, { status: 400 });
    update = { ...shaped.value };
    if (shaped.value.affiliate_id) {
      const { data: affiliate } = await db
        .from('affiliates')
        .select('id')
        .eq('id', shaped.value.affiliate_id)
        .maybeSingle();
      if (!affiliate) return NextResponse.json({ error: 'Affiliate not found' }, { status: 404 });
    }
  }

  const write = (patch: Record<string, unknown>) =>
    db
      .from('discount_codes')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', params.id)
      .select('*')
      .maybeSingle();
  let { data, error } = await write(update);
  // Same rule as a create: before landing-pages-migration.sql, an edit that
  // sets a restriction is refused, and one that does not is saved without it.
  if (error && isMissingColumnError(error)) {
    if (hasRestrictions(update)) {
      return NextResponse.json({ error: RESTRICTIONS_NEED_MIGRATION }, { status: 400 });
    }
    ({ data, error } = await write(withoutRestrictions(update)));
  }

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'That code is already in use.' }, { status: 409 });
    }
    console.error('[discount-codes] update failed:', error);
    return NextResponse.json({ error: 'Could not update the code' }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: 'Code not found' }, { status: 404 });

  await logAuditServer(
    db,
    { actor_id: caller.staff.id, actor_email: caller.staff.email },
    { action: 'discount_code.update', entity_type: 'discount_code', entity_id: params.id },
  );

  return NextResponse.json({ code: data });
}

/**
 * DELETE /api/admin/discount-codes/[id] — remove a code nobody has used.
 * Admin only. A code with orders or commissions against it is refused:
 * deleting it would orphan the revenue it brought in, so it is switched off
 * instead.
 */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const caller = await resolveStaffCaller(db, req);
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });

  const [{ count: orderCount }, { count: commissionCount }] = await Promise.all([
    db.from('puramass_orders').select('id', { count: 'exact', head: true }).eq('discount_code_id', params.id),
    db.from('commissions').select('id', { count: 'exact', head: true }).eq('discount_code_id', params.id),
  ]);
  if ((orderCount ?? 0) > 0 || (commissionCount ?? 0) > 0) {
    return NextResponse.json(
      { error: 'This code has been used, so its history is kept. Deactivate it instead.' },
      { status: 409 },
    );
  }

  const { error } = await db.from('discount_codes').delete().eq('id', params.id);
  if (error) {
    console.error('[discount-codes] delete failed:', error);
    return NextResponse.json({ error: 'Could not delete the code' }, { status: 500 });
  }

  await logAuditServer(
    db,
    { actor_id: caller.staff.id, actor_email: caller.staff.email },
    { action: 'discount_code.delete', entity_type: 'discount_code', entity_id: params.id },
  );

  return NextResponse.json({ deleted: true });
}
