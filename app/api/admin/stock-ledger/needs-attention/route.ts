import { NextRequest, NextResponse } from 'next/server';
import { db, requireAdmin, requireReader } from '@/lib/admin/stealth-health-server';
import { logAuditServer } from '@/lib/admin/audit';
import { checkLowStockForProducts } from '@/lib/admin/low-stock';
import { findUnstockedInvoices, isMissingFunctionError } from '@/lib/admin/stock-ledger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/admin/stock-ledger/needs-attention
 *
 * Paid Stealth Health invoices (last 90 days) whose stock was not fully taken,
 * with a best guess at the product behind each unlinked line, plus the
 * product list to pick from.
 */
export async function GET(request: NextRequest) {
  if (!(await requireReader(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }
  const [{ invoices, error }, { data: products }] = await Promise.all([
    findUnstockedInvoices(db, { days: 90 }),
    db.from('products').select('id, name, vials_per_box').order('name'),
  ]);
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ invoices, products: products ?? [] });
}

/**
 * POST /api/admin/stock-ledger/needs-attention
 * Body: { invoice_id, links: [{ line_id, product_id, vials_per_unit }] }
 *
 * Links each line to its product and takes its stock, recorded on the ledger
 * against the invoice and the admin who did it. With no links, just runs the
 * invoice's pending stock pass. Only still-unlinked lines are touched, so a
 * double click takes nothing twice.
 */
export async function POST(request: NextRequest) {
  const actor = await requireAdmin(request);
  if (!actor) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const invoiceId = String(body?.invoice_id ?? '');
  if (!UUID_RE.test(invoiceId)) {
    return NextResponse.json({ error: 'invoice_id is required' }, { status: 400 });
  }

  const links: { line_id: string; product_id: string; vials_per_unit: number }[] = [];
  for (const l of Array.isArray(body?.links) ? body.links : []) {
    const lineId = String(l?.line_id ?? '');
    const productId = String(l?.product_id ?? '');
    const vials = Math.round(Number(l?.vials_per_unit));
    if (!UUID_RE.test(lineId) || !UUID_RE.test(productId)) continue;
    if (!Number.isFinite(vials) || vials < 1 || vials > 1000) {
      return NextResponse.json({ error: 'Vials per unit must be between 1 and 1000' }, { status: 400 });
    }
    links.push({ line_id: lineId, product_id: productId, vials_per_unit: vials });
  }

  const { data: linked, error } = await db.rpc('take_stock_for_invoice_lines', {
    p_invoice_id: invoiceId,
    p_links: links,
    p_actor_id: actor.id,
    p_actor_email: actor.email,
  });
  if (error) {
    if (isMissingFunctionError(error)) {
      return NextResponse.json(
        { error: 'Run stock-ledger-migration.sql in the Supabase SQL editor first.' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  const productIds = [...new Set(links.map((l) => l.product_id))];
  if (productIds.length > 0) await checkLowStockForProducts(db, productIds);

  await logAuditServer(db, { actor_id: actor.id, actor_email: actor.email }, {
    action: 'invoice.stock_taken',
    entity_type: 'invoice',
    entity_id: invoiceId,
  });

  return NextResponse.json({ success: true, linked: Number(linked) || 0 });
}
