/**
 * POST /api/site/visit — count one storefront visitor for today.
 *
 * Sent by the storefront (lib/analytics/site-visit.ts) once per browser per
 * day. Only an anonymous tally is written — one more visitor today — and
 * nothing identifies the browser, so unlike the per-visitor journey this is
 * recorded whether or not the cookie banner was accepted. That is what makes
 * the Visitors figure in Admin → Analytics count everyone.
 *
 * Always 204: a counter must never surface an error on a page that works.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// A browser reports once a day; a burst from one IP is a script, and dropping
// it keeps the tally honest. Generous enough for a shared office or carrier IP.
const LIMIT = { max: 20, windowMs: 60_000 };

// Crawlers that run JavaScript would otherwise count as visitors.
const BOT_UA = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|monitor/i;

export async function POST(req: NextRequest) {
  const done = new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  if (BOT_UA.test(req.headers.get('user-agent') ?? '')) return done;
  if (!checkRateLimit(`site-visit:${getClientIp(req)}`, LIMIT).allowed) return done;

  try {
    const { error } = await db.rpc('site_traffic_bump');
    // Before site-traffic-counters-migration.sql the function does not exist;
    // that is expected and not worth a log line per visit.
    if (error && !/site_traffic_bump|function|schema cache/i.test(error.message ?? '')) {
      console.error('[site-visit] counter bump failed:', error.message);
    }
  } catch {
    /* best-effort */
  }
  return done;
}
