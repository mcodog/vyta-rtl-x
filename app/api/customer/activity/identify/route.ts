import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  readVisitorContext,
  attributionColumns,
  landingPageOf,
} from '@/lib/analytics/attribution-server';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

/**
 * POST /api/customer/activity/identify
 *
 * Joins an anonymous visitor to the account they just signed in to or created.
 * Called on every `SIGNED_IN` transition; idempotent, so repeats are cheap.
 *
 * Three things happen, in order of how much they matter:
 *
 *   1. The visitor's attribution row gets the customer id and email, which is
 *      what lets a hosted-checkout payment be traced back to the ad that
 *      produced it — Stealth Health only ever tells us an email address.
 *   2. The customer row gets the acquisition channel, frozen. Only if it is
 *      still empty: the campaign that originally won this customer keeps the
 *      credit, and signing in from a later Meta ad must not rewrite history.
 *   3. The event rows recorded before signup are backfilled with the customer
 *      id, so /admin/customers/[id] shows the whole journey including the part
 *      that happened before the account existed.
 *
 * Auth is the customer's own bearer token, so a caller can only ever identify
 * themselves. The visitor id comes from the cookie, never the request body —
 * otherwise anyone could claim another visitor's browsing history.
 */
export async function POST(req: NextRequest) {
  try {
    const token = req.headers.get('authorization')?.replace('Bearer ', '');
    if (!token) return NextResponse.json({ ok: false }, { status: 200 });

    const { data: { user } } = await db.auth.getUser(token);
    if (!user) return NextResponse.json({ ok: false }, { status: 200 });

    const ctx = readVisitorContext(req.cookies);
    if (!ctx.anonymousId) return NextResponse.json({ ok: false }, { status: 200 });

    const [{ data: customer }, { data: visitor }] = await Promise.all([
      db
        .from('customers')
        .select('id, email, created_at, attribution_channel')
        .eq('id', user.id)
        .maybeSingle(),
      db
        .from('visitor_attribution')
        .select('anonymous_id, first_seen_at, signed_up_at')
        .eq('anonymous_id', ctx.anonymousId)
        .maybeSingle(),
    ]);
    if (!customer) return NextResponse.json({ ok: false }, { status: 200 });

    const email = String(customer.email ?? user.email ?? '').trim().toLowerCase() || null;
    const now = new Date().toISOString();

    // 1. Resolve the visitor.
    await db
      .from('visitor_attribution')
      .update({
        customer_id: customer.id,
        ...(email ? { customer_email: email } : {}),
        updated_at: now,
      })
      .eq('anonymous_id', ctx.anonymousId);

    // The signup milestone means "this visit produced an account", not "an
    // account signed in here". An existing customer logging in from a new
    // browser gets a fresh visitor row, and stamping that would report every
    // returning login as an acquisition — inflating the signup rate of
    // whichever channel they happened to arrive from that day.
    //
    // So it is only stamped when the account is younger than the visit that
    // led to it.
    const accountCreated = customer.created_at ? Date.parse(customer.created_at) : NaN;
    const firstSeen = visitor?.first_seen_at ? Date.parse(visitor.first_seen_at) : NaN;
    const registeredDuringThisVisit =
      Number.isFinite(accountCreated) && (!Number.isFinite(firstSeen) || accountCreated >= firstSeen);

    if (registeredDuringThisVisit && !visitor?.signed_up_at) {
      await db
        .from('visitor_attribution')
        .update({ signed_up_at: customer.created_at ?? now })
        .eq('anonymous_id', ctx.anonymousId)
        .is('signed_up_at', null);
    }

    // 2. Freeze the acquisition channel onto the customer, once.
    let stampedChannel: string | null = customer.attribution_channel ?? null;
    if (!customer.attribution_channel) {
      const columns = attributionColumns(ctx);
      if (columns.attribution_channel) {
        const { error } = await db
          .from('customers')
          .update({ ...columns, anonymous_id: ctx.anonymousId })
          .eq('id', customer.id)
          // Concurrent sign-ins from two tabs would otherwise race; whichever
          // lands first wins and the other becomes a no-op.
          .is('attribution_channel', null);
        if (!error) stampedChannel = columns.attribution_channel;
      }
    }

    // 2b. Which landing page won them, frozen the same way — once, and only
    //     for an account this visit actually produced. An existing customer
    //     signing in after clicking through a landing page was not acquired by
    //     it. A separate write rather than a column in the select above: the
    //     column arrives with landing-pages-migration.sql, and naming it there
    //     would fail the whole read — and with it, sign-in identification.
    const landingPage = landingPageOf(ctx);
    if (landingPage && registeredDuringThisVisit) {
      await db
        .from('customers')
        .update({ attribution_landing_page: landingPage })
        .eq('id', customer.id)
        .is('attribution_landing_page', null);
    }

    // 3. Adopt the pre-signup event rows.
    const { count } = await db
      .from('customer_activity')
      .update({ customer_id: customer.id }, { count: 'exact' })
      .eq('anonymous_id', ctx.anonymousId)
      .is('customer_id', null);

    return NextResponse.json({
      ok: true,
      adopted: count ?? 0,
      channel: stampedChannel,
    });
  } catch {
    // Identification is best-effort: a failure here costs reporting accuracy,
    // never the sign-in that triggered it.
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
