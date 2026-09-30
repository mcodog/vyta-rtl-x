import { NextRequest, NextResponse } from 'next/server';
import { db, requireReader, isMissingTableError } from '@/lib/admin/stealth-health-server';
import { listStockLedger, type StockEntryKind } from '@/lib/admin/stock-ledger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS = new Set<StockEntryKind | 'all'>(['all', 'manual', 'automatic', 'untracked']);

/**
 * GET /api/admin/stock-ledger
 *
 * Every stock change, newest first. Query params:
 *   from, to    YYYY-MM-DD, inclusive
 *   product     product id
 *   q           product name / SKU substring
 *   kind        all (default) | manual | automatic | untracked
 *   limit       1–500 (default 100)
 *   offset      for paging
 */
export async function GET(request: NextRequest) {
  if (!(await requireReader(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const sp = request.nextUrl.searchParams;
  const kindParam = (sp.get('kind') ?? 'all') as StockEntryKind | 'all';
  const limit = Number(sp.get('limit') ?? '100');
  const offset = Number(sp.get('offset') ?? '0');

  const { entries, total, error } = await listStockLedger(db, {
    from: sp.get('from'),
    to: sp.get('to'),
    productId: sp.get('product'),
    search: sp.get('q'),
    kind: KINDS.has(kindParam) ? kindParam : 'all',
    limit: Number.isFinite(limit) ? limit : 100,
    offset: Number.isFinite(offset) ? offset : 0,
  });

  if (error) {
    if (isMissingTableError({ message: error })) {
      return NextResponse.json({ entries: [], total: 0, migrated: false });
    }
    return NextResponse.json({ error }, { status: 500 });
  }
  return NextResponse.json({ entries, total, migrated: true });
}
