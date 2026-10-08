import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function getAffiliateCaller(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return null;
  const { data: customer } = await db
    .from('customers')
    .select('id, first_name, role')
    .eq('id', user.id)
    .single();
  if (!customer || customer.role !== 'affiliate') return null;
  return customer;
}

// GET - affiliate dashboard summary (combines both commission streams)
export async function GET(req: NextRequest) {
  const caller = await getAffiliateCaller(req);
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const uid = caller.id;

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
  const pendingEarnings = all.filter((c) => c.status === 'pending').reduce((s, c) => s + Number(c.amount), 0);
  const paidEarnings = all.filter((c) => c.status === 'paid').reduce((s, c) => s + Number(c.amount), 0);

  return NextResponse.json({
    firstName: caller.first_name,
    referralCode: code?.code ?? null,
    boundCustomers: boundCustomers ?? 0,
    pendingEarnings: Math.round((pendingEarnings + Number.EPSILON) * 100) / 100,
    paidEarnings: Math.round((paidEarnings + Number.EPSILON) * 100) / 100,
    salesPerson: salesPerson ?? null,
  });
}
