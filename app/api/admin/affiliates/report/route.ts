import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function verifyStaff(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return false;
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return false;
  const { data } = await db.from('customers').select('role').eq('id', user.id).single();
  return data?.role === 'admin' || data?.role === 'assistant';
}

function money(n: number) {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(n || 0);
}
function fmtDate(s: string | null) {
  return s ? new Date(s).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
}
function esc(s: string) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

export async function GET(req: NextRequest) {
  if (!(await verifyStaff(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const sp = new URL(req.url).searchParams;
  const statusFilter = sp.get('status');
  const q = (sp.get('q') || '').toLowerCase();

  const { data: affiliates } = await db.from('affiliates').select('*').order('created_at', { ascending: false });

  const enriched = await Promise.all(
    (affiliates || []).map(async (a: any) => {
      const { data: codes } = await db
        .from('referral_codes')
        .select('code, uses_count')
        .eq('affiliate_id', a.id)
        .eq('active', true)
        .limit(1);
      const { data: pending } = await db
        .from('commissions')
        .select('amount')
        .eq('affiliate_id', a.id)
        .eq('status', 'pending');
      return {
        ...a,
        referral_code: codes?.[0]?.code || '—',
        total_referrals: codes?.[0]?.uses_count || 0,
        pending_earnings: (pending || []).reduce((s, c: any) => s + Number(c.amount), 0),
      };
    }),
  );

  let rows = enriched;
  if (statusFilter === 'active') rows = rows.filter((a) => a.active);
  if (statusFilter === 'inactive') rows = rows.filter((a) => !a.active);
  if (q) {
    rows = rows.filter(
      (a) =>
        `${a.first_name} ${a.last_name}`.toLowerCase().includes(q) ||
        (a.email || '').toLowerCase().includes(q) ||
        (a.referral_code || '').toLowerCase().includes(q),
    );
  }

  const tableRows = rows
    .map(
      (a) => `
      <tr>
        <td>${esc(`${a.first_name} ${a.last_name}`)}<div class="muted">${esc(a.email)}</div></td>
        <td class="mono">${esc(a.referral_code)}</td>
        <td class="num">${a.total_referrals}</td>
        <td class="num">${money(a.total_earnings)}</td>
        <td class="num">${money(a.pending_earnings)}</td>
        <td><span class="status ${a.active ? 'active' : 'inactive'}">${a.active ? 'Active' : 'Inactive'}</span></td>
      </tr>`,
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<title>Affiliate Report</title>
<style>
  body { font-family: 'Segoe UI', -apple-system, sans-serif; color: #07203A; margin: 0; padding: 32px; }
  .page { max-width: 900px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0; }
  .logo span { color: #438b9e; }
  .meta { color: #56707F; font-size: 13px; margin: 4px 0 24px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; text-transform: uppercase; font-size: 11px; color: #56707F; border-bottom: 2px solid #DCE7EB; padding: 8px; }
  td { padding: 10px 8px; border-bottom: 1px solid #EDF3F5; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .mono { font-family: monospace; }
  .muted { color: #6E8898; font-size: 11px; }
  .status { padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .status.active { background: #ECFDF5; color: #059669; }
  .status.inactive { background: #FEF2F2; color: #DC2626; }
  @media print { body { padding: 0; } }
</style></head>
<body><div class="page">
  <h1 class="logo">VYTA<span>BIO</span></h1>
  <div class="meta">Affiliate Report &bull; ${rows.length} affiliates &bull; ${fmtDate(new Date().toISOString())}</div>
  <table>
    <thead><tr><th>Affiliate</th><th>Referral Code</th><th class="num">Referrals</th><th class="num">Total Earned</th><th class="num">Pending</th><th>Status</th></tr></thead>
    <tbody>${tableRows || '<tr><td colspan="6" style="text-align:center;color:#6E8898;padding:32px;">No affiliates match the filters</td></tr>'}</tbody>
  </table>
</div></body></html>`;

  return new NextResponse(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
