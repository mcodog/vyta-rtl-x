import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { resolveAffiliateCaller } from '@/lib/affiliate/route-auth';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// GET - affiliate dashboard summary (combines both commission streams)
export async function GET(req: NextRequest) {
  // Resolves legacy affiliates (own uuid, matched by email) as well as ones
  // that share the auth user's id — a role check alone missed the former.
  const caller = await resolveAffiliateCaller(db, req);
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });

  const uid = caller.affiliate.id;

  const [{ data: code }, { count: boundCustomers }, { data: affCommissions }, { data: salesPerson }] =
    await Promise.all([
      db.from('referral_codes').select('code').eq('affiliate_id', uid).eq('active', true).limit(1).maybeSingle(),
      // Their own account is bound to itself; that isn't a referral.
      db.from('customers').select('id', { count: 'exact', head: true }).eq('affiliate_id', uid).neq('id', uid),
      db.from('commissions').select('amount, status').eq('affiliate_id', uid),
      db.from('sales_persons').select('id, first_name, last_name, commission_rate, total_earnings').eq('user_id', uid).maybeSingle(),
    ]);

  let salesCommissions: { amount: number; status: string }[] = [];
  if (salesPerson?.id) {
    const { data } = await db
      .from('sales_commissions')
      .select('amount, status')
      .eq('sales_person_id', salesPerson.id);
    salesCommissions = data || [];
  }

  const all = [...(affCommissions || []), ...salesCommissions];
  const pendingEarnings = all.filter((c) => String(c.status).toLowerCase() === 'pending').reduce((s, c) => s + Number(c.amount), 0);
  const paidEarnings = all.filter((c) => String(c.status).toLowerCase() === 'paid').reduce((s, c) => s + Number(c.amount), 0);

  return NextResponse.json({
    firstName: caller.affiliate.first_name,
    referralCode: code?.code ?? null,
    boundCustomers: boundCustomers ?? 0,
    pendingEarnings: Math.round((pendingEarnings + Number.EPSILON) * 100) / 100,
    paidEarnings: Math.round((paidEarnings + Number.EPSILON) * 100) / 100,
    salesPerson: salesPerson ?? null,
  });
}
