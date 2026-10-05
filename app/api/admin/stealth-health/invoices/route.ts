import { todayInAppTz } from '@/lib/datetime';
import { NextRequest, NextResponse } from 'next/server';
import { logAuditServer } from '@/lib/admin/audit';
import {
  db,
  requireReader,
  requireAdmin,
  loadTerms,
  loadLedgerRows,
  settleableSettlements,
  loadPayoutsByInvoice,
  isMissingSchema,
  shapeSettlementInvoice as shapeInvoice,
} from '@/lib/admin/stealth-health-server';
import { sumSettlements, dueDateFor } from '@/lib/admin/stealth-health';

export const dynamic = 'force-dynamic';

const MIGRATION_HINT =
  'Run stealth-health-settlement-migration.sql in Supabase before invoicing Stealth Health.';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function today(): string {
  return todayInAppTz();
}

/**
 * GET /api/admin/stealth-health/invoices — settlement invoices raised against
 * Stealth Health, newest first, each with what has been remitted against it.
 */
export async function GET(req: NextRequest) {
  if (!(await requireReader(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const page = Math.max(0, parseInt(sp.get('page') ?? '0', 10) || 0);
  const pageSize = Math.min(100, Math.max(1, parseInt(sp.get('pageSize') ?? '25', 10) || 25));
  const statuses = (sp.get('status') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  let q = db
    .from('stealth_health_invoices')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(page * pageSize, page * pageSize + pageSize - 1);
  if (statuses.length > 0) q = q.in('status', statuses);

  const { data, count, error } = await q;
  if (error) {
    // Unmigrated → an empty list, so the dashboard renders its own banner.
    if (isMissingSchema(error)) {
      return NextResponse.json({ invoices: [], total: 0, page, pageSize, migrated: false });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as any[];
  const paid = await loadPayoutsByInvoice(rows.map((r) => String(r.id)));

  return NextResponse.json({
    invoices: rows.map((r) => shapeInvoice(r, paid[String(r.id)] ?? 0)),
    total: count ?? rows.length,
    page,
    pageSize,
    migrated: true,
  });
}

/**
 * POST /api/admin/stealth-health/invoices — raise a settlement invoice for a
 * period.
 *
 * It bills every PAID hand-off in the period that is not already on an invoice
 * and not held back, freezing both the money and the terms that produced it
 * onto the row. The orders are then stamped with the invoice id, which is what
 * makes a second run over an overlapping period pick up nothing rather than
 * bill the same sale twice.
 *
 * Admin only.
 */
export async function POST(req: NextRequest) {
  const actor = await requireAdmin(req);
  if (!actor) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const periodStart = String(body.period_start ?? '').trim() || null;
  const periodEnd = String(body.period_end ?? '').trim() || null;
  for (const [label, v] of [['period_start', periodStart], ['period_end', periodEnd]] as const) {
    if (v && !DATE_RE.test(v)) {
      return NextResponse.json({ error: `${label} must be YYYY-MM-DD` }, { status: 400 });
    }
  }
  if (periodStart && periodEnd && periodStart > periodEnd) {
    return NextResponse.json({ error: 'period_start must be on or before period_end' }, { status: 400 });
  }

  const issueDate = DATE_RE.test(String(body.issue_date ?? '')) ? String(body.issue_date) : today();
  const notes = String(body.notes ?? '').trim() || null;

  const { terms, migrated } = await loadTerms();
  if (!migrated) return NextResponse.json({ error: MIGRATION_HINT }, { status: 409 });

  const { rows, settlementColumns } = await loadLedgerRows({
    from: periodStart,
    to: periodEnd,
    unbilledOnly: true,
  });
  if (!settlementColumns) return NextResponse.json({ error: MIGRATION_HINT }, { status: 409 });

  const settlements = settleableSettlements(rows, terms);
  if (settlements.length === 0) {
    return NextResponse.json(
      { error: 'No unbilled paid orders in that period — nothing to invoice.' },
      { status: 400 },
    );
  }

  const totals = sumSettlements(settlements);

  const { data: invoice, error: insertErr } = await db
    .from('stealth_health_invoices')
    .insert({
      status: 'draft',
      currency: terms.currency,
      period_start: periodStart,
      period_end: periodEnd,
      issue_date: issueDate,
      due_date: dueDateFor(issueDate, terms),
      order_count: totals.order_count,
      units: totals.units,
      gross_cents: totals.gross_cents,
      refunds_cents: totals.refunds_cents,
      shipping_cents: totals.shipping_cents,
      fee_cents: totals.fee_cents,
      amount_due_cents: totals.due_cents,
      commission_pct: terms.commission_pct,
      flat_fee_cents: terms.flat_fee_cents,
      shipping_remitted: terms.shipping_remitted,
      notes,
      created_by: actor.id,
      created_by_email: actor.email,
    })
    .select('*')
    .single();

  if (insertErr || !invoice) {
    if (isMissingSchema(insertErr)) {
      return NextResponse.json({ error: MIGRATION_HINT }, { status: 409 });
    }
    console.error('[stealth-health] invoice insert failed:', insertErr);
    return NextResponse.json({ error: insertErr?.message ?? 'Could not create invoice' }, { status: 500 });
  }

  // Claim the orders. Conditional on settlement_invoice_id still being NULL so
  // two admins invoicing at once can't both claim the same hand-off; whatever
  // the second run misses stays unbilled and lands on the next invoice.
  const { data: claimed, error: claimErr } = await db
    .from('puramass_orders')
    .update({ settlement_invoice_id: invoice.id })
    .in('id', settlements.map((s) => s.id))
    .is('settlement_invoice_id', null)
    .select('id');

  if (claimErr) {
    // Nothing was billed — roll the invoice back rather than leave a claim
    // against orders that are still marked unbilled.
    console.error('[stealth-health] order claim failed, rolling back invoice:', claimErr);
    await db.from('stealth_health_invoices').delete().eq('id', invoice.id);
    return NextResponse.json({ error: 'Could not attach orders to the invoice' }, { status: 500 });
  }

  // A concurrent invoice took some of these rows. Re-total from what we
  // actually claimed so the invoice never overstates the claim.
  const claimedIds = new Set((claimed ?? []).map((r: any) => String(r.id)));
  if (claimedIds.size !== settlements.length) {
    const kept = settlements.filter((s) => claimedIds.has(s.id));
    if (kept.length === 0) {
      await db.from('stealth_health_invoices').delete().eq('id', invoice.id);
      return NextResponse.json(
        { error: 'Those orders were invoiced by another run — nothing left to bill.' },
        { status: 409 },
      );
    }
    const revised = sumSettlements(kept);
    const { data: updated } = await db
      .from('stealth_health_invoices')
      .update({
        order_count: revised.order_count,
        units: revised.units,
        gross_cents: revised.gross_cents,
        refunds_cents: revised.refunds_cents,
        shipping_cents: revised.shipping_cents,
        fee_cents: revised.fee_cents,
        amount_due_cents: revised.due_cents,
      })
      .eq('id', invoice.id)
      .select('*')
      .single();
    if (updated) Object.assign(invoice, updated);
  }

  await logAuditServer(db, { actor_id: actor.id, actor_email: actor.email }, {
    action: 'create',
    entity_type: 'stealth_health_invoice',
    entity_id: String(invoice.id),
  });

  return NextResponse.json({ invoice: shapeInvoice(invoice, 0) }, { status: 201 });
}
