import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import type { UserRole } from '@/lib/permissions';
import { logAuditServer } from '@/lib/admin/audit';
import { isMissingColumnError } from '@/lib/payments/puramass-columns';
import {
  abandonedCutoff,
  loadAbandonedHours,
  RECOVERABLE_STATUSES,
} from '@/lib/payments/puramass-abandoned';
import { confirmationSummariesByInvoice } from '@/lib/order-confirmation';
import { resolveReferralCodeOwner } from '@/lib/affiliate/commission';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const LEDGER_CORE_COLUMNS =
  'id, partner_reference, transaction_id, payment_link, status, subtotal_cents, ' +
  'customer_id, customer_email, ' +
  'items, referral_code, paid_at, currency, created_at, updated_at, invoice_id';

const ADDRESS_COLUMNS =
  'customer_name, customer_phone, shipping_address, ' +
  'shipping_address_source, shipping_address_updated_at, address_requested_at';

const RECOVERY_COLUMNS =
  'recovery_email_sent_at, recovery_email_count, recovery_promo_code, ' +
  'recovery_discount_type, recovery_discount_value';

/**
 * Column sets to try, widest first.
 *
 * Two independent migrations can each be missing (or still absent from
 * PostgREST's schema cache), so the fallback is a ladder rather than a single
 * legacy list: losing the recovery columns must not also cost the page its
 * shipping addresses, which is what one all-or-nothing fallback would do.
 */
const LEDGER_SELECTS: { columns: string; addresses: boolean; recovery: boolean }[] = [
  { columns: `${LEDGER_CORE_COLUMNS}, ${ADDRESS_COLUMNS}, ${RECOVERY_COLUMNS}`, addresses: true, recovery: true },
  { columns: `${LEDGER_CORE_COLUMNS}, ${ADDRESS_COLUMNS}`, addresses: true, recovery: false },
  { columns: `${LEDGER_CORE_COLUMNS}, ${RECOVERY_COLUMNS}`, addresses: false, recovery: true },
  { columns: LEDGER_CORE_COLUMNS, addresses: false, recovery: false },
];

// The customer-facing invoice a paid hand-off materialised into. Whether the
// order shows on the buyer's account page is decided here (invoice exists +
// linked to a customer + not a draft), so the ledger UI can flag it.
const INVOICE_COLUMNS =
  'id, invoice_number, customer_id, customer_email, status, fulfillment_status, ' +
  'fulfillment_type, due_date, packed_at, fulfilled_at, currency, subtotal, shipping_cost, total, created_at';

async function verifyReadAccess(req: NextRequest): Promise<boolean> {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return false;
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return false;
  const { data } = await db.from('customers').select('role').eq('id', user.id).single();
  const role = (data?.role ?? 'customer') as UserRole;
  return role === 'admin' || role === 'assistant';
}

type DeleteAuth =
  | { ok: false }
  | { ok: true; actorId: string; actorEmail: string | null };

// Deletes are destructive and customer-facing (they can tear down a
// materialised invoice), so — unlike reads/refresh — they are admin-only,
// matching `canDelete()` in lib/permissions.
async function verifyDeleteAccess(req: NextRequest): Promise<DeleteAuth> {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return { ok: false };
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return { ok: false };
  const { data } = await db.from('customers').select('role, email').eq('id', user.id).single();
  const role = (data?.role ?? 'customer') as UserRole;
  if (role !== 'admin') return { ok: false };
  return { ok: true, actorId: user.id, actorEmail: data?.email ?? user.email ?? null };
}

/**
 * GET /api/admin/puramass/orders — paginated hand-off ledger for reconciliation.
 * Admin/assistant read-only.
 */
export async function GET(req: NextRequest) {
  if (!(await verifyReadAccess(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const params = req.nextUrl.searchParams;
  const page = Math.max(0, parseInt(params.get('page') ?? '0', 10) || 0);
  const pageSizeRaw = parseInt(params.get('pageSize') ?? '25', 10) || 25;
  const pageSize = Math.min(100, Math.max(1, pageSizeRaw));

  // `status` is a comma-separated allow-list; absent/empty means every status.
  const statuses = (params.get('status') ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  // `abandoned=1` is the recovery view: an unpaid hand-off that has sat past
  // the configured window. It cuts across the status pills rather than being
  // one of them — an expired link is just as abandoned as a pending one.
  const abandonedOnly = params.get('abandoned') === '1';
  // Free-text match across the identifiers an admin actually has to hand.
  const search = (params.get('q') ?? '').trim().slice(0, 120);

  const from = page * pageSize;
  const to = from + pageSize - 1;

  // PostgREST `or` values can't contain commas or parens unescaped — a search
  // term is user input, so strip the characters that would break out of it.
  const safeSearch = search.replace(/[,()*]/g, ' ').trim();
  const searchColumns = (withAddress: boolean) =>
    [
      'customer_email',
      'partner_reference',
      'transaction_id',
      'referral_code',
      ...(withAddress ? ['customer_name'] : []),
    ]
      .map((c) => `${c}.ilike.%${safeSearch}%`)
      .join(',');

  // Everything abandoned-related shares one cutoff, computed once.
  const abandonedHours = await loadAbandonedHours(db);
  const cutoff = abandonedCutoff(abandonedHours);

  const query = (columns: string, withAddress: boolean) => {
    let q = db
      .from('puramass_orders')
      .select(columns, { count: 'exact' })
      .order('created_at', { ascending: false });
    if (abandonedOnly) {
      q = q.in('status', [...RECOVERABLE_STATUSES]).lte('created_at', cutoff);
    } else if (statuses.length > 0) {
      q = q.in('status', statuses);
    }
    if (safeSearch) q = q.or(searchColumns(withAddress));
    return q.range(from, to);
  };

  // Walk down the column ladder until the database accepts one. A missing
  // column is the only reason to step down — a real query failure is reported.
  let data: any = null;
  let count: number | null = null;
  let error: any = null;
  let addressesAvailable = true;
  let recoveryAvailable = true;
  for (const attempt of LEDGER_SELECTS) {
    ({ data, count, error } = await query(attempt.columns, attempt.addresses));
    if (!error) {
      addressesAvailable = attempt.addresses;
      recoveryAvailable = attempt.recovery;
      break;
    }
    if (!isMissingColumnError(error)) break;
    console.warn('[puramass] column set unavailable, narrowing:', error.message);
  }

  if (error) {
    // Admin/assistant-only route — surface the real reason instead of a generic
    // message, so a schema/permission problem is diagnosable from the UI.
    console.error('[puramass] order list query failed:', error);
    return NextResponse.json(
      { error: `Could not load orders: ${error.message}` },
      { status: 500 },
    );
  }

  // Attach the linked customer-facing invoice (when materialised) so the UI can
  // show whether each order appears on the buyer's account page.
  const invoiceIds = [
    ...new Set((data ?? []).map((r: any) => r.invoice_id).filter(Boolean)),
  ] as string[];
  let invoiceMap: Record<string, any> = {};
  if (invoiceIds.length > 0) {
    const { data: invoices } = await db
      .from('invoices')
      .select(INVOICE_COLUMNS)
      .in('id', invoiceIds);
    invoiceMap = Object.fromEntries((invoices ?? []).map((i: any) => [i.id, i]));
  }
  // Order-confirmation email state per hand-off (logged against its invoice).
  const confirmationByInvoice = await confirmationSummariesByInvoice(db, invoiceIds);

  // Resolve each captured referral code to the affiliate it belongs to. A bare
  // code identifies nobody at a glance, and the two cases an admin most needs
  // to tell apart — a code nobody owns, and one belonging to a deactivated
  // affiliate (which earns no commission) — both look like a plain code
  // otherwise. Best-effort: a failure here costs the label, not the page.
  const codes = [
    ...new Set(
      (data ?? [])
        .map((r: any) => (typeof r.referral_code === 'string' ? r.referral_code.toUpperCase() : null))
        .filter(Boolean),
    ),
  ] as string[];
  let affiliateByCode: Record<string, { id: string; name: string | null; active: boolean }> = {};
  if (codes.length > 0) {
    // Two plain queries rather than a PostgREST embed. `referral_codes` carries
    // TWO foreign keys to `affiliates` — the inline column REFERENCES and the
    // named `fk_affiliate` — and an embed across an ambiguous pair is rejected
    // outright rather than picking one. Joining by hand sidesteps the whole
    // question and cannot break if either constraint is renamed.
    const { data: codeRows, error: codeError } = await db
      .from('referral_codes')
      .select('code, active, affiliate_id')
      .in('code', codes);

    if (codeError) {
      console.warn('[puramass] referral code lookup failed:', codeError.message);
    } else {
      // A code with no referral_codes row may still name an affiliate — their
      // discount code shared as a ?ref= link — and is credited as such (see
      // resolveReferralCodeOwner).
      const known = new Set((codeRows ?? []).map((c: any) => String(c.code).toUpperCase()));
      const fallback = (
        await Promise.all(
          codes
            .filter((c) => !known.has(c))
            .map(async (c) => {
              const owner = await resolveReferralCodeOwner(db, c);
              return owner ? { code: c, active: true, affiliate_id: owner.affiliateId } : null;
            }),
        )
      ).filter(Boolean) as { code: string; active: boolean; affiliate_id: string }[];
      const allCodeRows = [...(codeRows ?? []), ...fallback];

      const affiliateIds = [
        ...new Set(allCodeRows.map((c: any) => c.affiliate_id).filter(Boolean)),
      ] as string[];
      let nameById: Record<string, string | null> = {};
      if (affiliateIds.length > 0) {
        const { data: affiliates, error: affError } = await db
          .from('affiliates')
          .select('id, first_name, last_name')
          .in('id', affiliateIds);
        if (affError) {
          console.warn('[puramass] affiliate lookup failed:', affError.message);
        } else {
          nameById = Object.fromEntries(
            (affiliates ?? []).map((a: any) => [
              a.id,
              `${a.first_name ?? ''} ${a.last_name ?? ''}`.trim() || null,
            ]),
          );
        }
      }
      affiliateByCode = Object.fromEntries(
        allCodeRows.map((c: any) => [
          String(c.code).toUpperCase(),
          {
            id: c.affiliate_id,
            name: nameById[c.affiliate_id] ?? null,
            active: c.active !== false,
          },
        ]),
      );
    }
  }

  const orders = (data ?? []).map((r: any) => ({
    ...r,
    invoice: r.invoice_id ? invoiceMap[r.invoice_id] ?? null : null,
    confirmation: r.invoice_id ? confirmationByInvoice[r.invoice_id] ?? null : null,
    affiliate: r.referral_code
      ? affiliateByCode[String(r.referral_code).toUpperCase()] ?? null
      : null,
  }));

  // Per-status totals for the filter pills. Head-only counts (no rows shipped)
  // and they honour the search box, so each pill shows what clicking it yields.
  const countFor = async (status?: string) => {
    let q = db.from('puramass_orders').select('id', { count: 'exact', head: true });
    if (status) q = q.eq('status', status);
    if (safeSearch) q = q.or(searchColumns(addressesAvailable));
    const { count: n } = await q;
    return n ?? 0;
  };
  // The abandoned pill counts the same set the abandoned view lists.
  const countAbandoned = async () => {
    let q = db
      .from('puramass_orders')
      .select('id', { count: 'exact', head: true })
      .in('status', [...RECOVERABLE_STATUSES])
      .lte('created_at', cutoff);
    if (safeSearch) q = q.or(searchColumns(addressesAvailable));
    const { count: n } = await q;
    return n ?? 0;
  };
  const [all, pendingCount, paidCount, expiredCount, cancelledCount, abandonedCount] =
    await Promise.all([
      countFor(),
      countFor('payment_pending'),
      countFor('paid'),
      countFor('expired'),
      countFor('cancelled'),
      countAbandoned(),
    ]);

  return NextResponse.json({
    orders,
    total: count ?? 0,
    page,
    pageSize,
    // False when the shipping-address migration isn't visible to PostgREST yet;
    // the UI uses it to explain why no addresses are showing.
    addressesAvailable,
    // False when abandoned-checkout-recovery-migration.sql isn't visible yet;
    // the UI uses it to explain why no send history shows against a row.
    recoveryAvailable,
    // The window behind the abandoned view, so the UI can name it ("unpaid for
    // more than 1h") instead of showing an unexplained subset.
    abandonedHours,
    counts: {
      all,
      payment_pending: pendingCount,
      paid: paidCount,
      expired: expiredCount,
      cancelled: cancelledCount,
      abandoned: abandonedCount,
    },
  });
}

/**
 * DELETE /api/admin/puramass/orders — remove hand-off ledger rows, one or many.
 *
 * Body: `{ ids: string[], cascadeInvoice?: boolean }`.
 *
 * By default only the ledger row(s) are deleted — the reconciliation record —
 * leaving any materialised customer invoice (and therefore the buyer's account
 * order and the fulfillment-queue entry) untouched. This is the common case:
 * clearing a duplicate/expired/test hand-off without disturbing the real order.
 *
 * When `cascadeInvoice` is true the linked invoice(s) are deleted too — their
 * line items go via `ON DELETE CASCADE` — which fully removes the order from the
 * customer's account and the fulfillment queue. There is no FK between the
 * ledger and its invoice, so this cascade is done explicitly here.
 *
 * Admin only. Every deleted row is written to the audit log.
 */
export async function DELETE(req: NextRequest) {
  const auth = await verifyDeleteAccess(req);
  if (!auth.ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const ids = Array.isArray(body.ids)
    ? (body.ids as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: 'ids[] is required.' }, { status: 400 });
  }
  const cascadeInvoice = Boolean(body.cascadeInvoice);

  // Read the targets first: confirms they exist and gives us the linked invoice
  // ids to cascade. (Deduped ids so a repeated id can't inflate the count.)
  const uniqueIds = Array.from(new Set(ids));
  const { data: rows, error: readErr } = await db
    .from('puramass_orders')
    .select('id, invoice_id')
    .in('id', uniqueIds);
  if (readErr) {
    return NextResponse.json({ error: 'Could not load the orders to delete.' }, { status: 500 });
  }
  if (!rows || rows.length === 0) {
    return NextResponse.json({ error: 'No matching orders found.' }, { status: 404 });
  }

  const foundIds = rows.map((r) => r.id);
  const invoiceIds = Array.from(
    new Set(rows.map((r) => r.invoice_id).filter(Boolean) as string[]),
  );

  // Remove the ledger rows — the primary target.
  const { error: delErr, count } = await db
    .from('puramass_orders')
    .delete({ count: 'exact' })
    .in('id', foundIds);
  if (delErr) {
    return NextResponse.json({ error: 'Could not delete the orders.' }, { status: 500 });
  }

  // Optionally tear down the materialised customer invoice(s). Best-effort: the
  // ledger rows are already gone, so a failure here is surfaced as a warning
  // rather than faking a rollback the DB can't give us.
  let invoicesDeleted = 0;
  let invoiceWarning: string | null = null;
  if (cascadeInvoice && invoiceIds.length > 0) {
    const { error: invDelErr, count: invCount } = await db
      .from('invoices')
      .delete({ count: 'exact' })
      .in('id', invoiceIds);
    if (invDelErr) {
      invoiceWarning = `Orders deleted, but linked invoice cleanup failed: ${invDelErr.message}`;
    } else {
      invoicesDeleted = invCount ?? 0;
    }
  }

  for (const id of foundIds) {
    await logAuditServer(
      db,
      { actor_id: auth.actorId, actor_email: auth.actorEmail },
      {
        action: cascadeInvoice ? 'puramass.order_delete_cascade' : 'puramass.order_delete',
        entity_type: 'puramass_order',
        entity_id: id,
      },
    );
  }

  return NextResponse.json({
    ok: true,
    deleted: count ?? foundIds.length,
    linkedInvoices: invoiceIds.length,
    invoicesDeleted,
    ...(invoiceWarning ? { warning: invoiceWarning } : {}),
  });
}
