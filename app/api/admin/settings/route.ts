import { revalidatePath } from 'next/cache';
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { canAccessAdmin, type UserRole } from '@/lib/permissions';
import { isPuramassConfigured } from '@/lib/payments/puramass';
import { shapeHostedShippingSettings } from '@/lib/payments/puramass-settings';
import { clampDiscountPercent, shapeAdDiscountSettings } from '@/lib/promos/ad-discount';
import {
  clampMinItems,
  MAX_DISCOUNT_PERCENT,
  shapeCartOfferSettings,
} from '@/lib/promos/cart-offer';
import {
  DEFAULT_CUSTOMER_SUBJECT,
  DEFAULT_CUSTOMER_BODY,
  DEFAULT_ADMIN_SUBJECT,
  DEFAULT_ADMIN_BODY,
} from '@/lib/invoice-email-templates';
import {
  KLAVIYO_LIST_ID_RE,
  KLAVIYO_PUBLIC_KEY_RE,
  shapeKlaviyoSettings,
} from '@/lib/klaviyo/settings';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Read every column with select('*') so optional/late-migration columns
// (easyship_*, shipping_handling_fee_*) can't make the query fail — shape()
// defaults anything absent.
const SETTINGS_COLUMNS = '*';

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate + normalise a list of email addresses. Returns the cleaned array,
 * or `{ error }` if any entry is malformed.
 */
function normaliseEmailList(value: unknown): string[] | { error: string } {
  if (!Array.isArray(value)) return { error: 'Expected a list of emails' };
  const out: string[] = [];
  for (const raw of value) {
    const email = String(raw ?? '').trim();
    if (!email) continue;
    if (!emailRegex.test(email)) return { error: `Invalid email: ${email}` };
    if (!out.includes(email)) out.push(email);
  }
  return out;
}

function coerceOrigin(value: unknown) {
  const v = (value ?? {}) as Record<string, unknown>;
  return {
    line_1: String(v.line_1 ?? '').trim(),
    city: String(v.city ?? '').trim(),
    state: String(v.state ?? '').trim(),
    postal_code: String(v.postal_code ?? '').trim(),
    country_alpha2: String(v.country_alpha2 ?? '').trim().toUpperCase().slice(0, 2),
    // Sender contact — Easyship requires these on the origin address.
    company: String(v.company ?? '').trim(),
    phone: String(v.phone ?? '').trim(),
    email: String(v.email ?? '').trim(),
  };
}

function coerceBox(value: unknown) {
  const v = (value ?? {}) as Record<string, unknown>;
  const num = (n: unknown) => Math.max(0, Number(n) || 0);
  return {
    length: num(v.length),
    width: num(v.width),
    height: num(v.height),
  };
}

/**
 * Default + redact a settings row for the wire. NEVER returns the API key —
 * exposes `easyship_api_key_set: boolean` instead.
 */
function shape(data: Record<string, any> | null | undefined) {
  const d = data ?? {};
  const hostedShipping = shapeHostedShippingSettings(d);
  const adDiscount = shapeAdDiscountSettings(d);
  const cartOffer = shapeCartOfferSettings(d);
  const klaviyo = shapeKlaviyoSettings(d);
  return {
    id: d.id ?? null,
    checkout_type: d.checkout_type === 'email' ? 'email' : 'crypto',
    admin_emails: Array.isArray(d.admin_emails) ? d.admin_emails : [],
    invoice_cc_emails: Array.isArray(d.invoice_cc_emails) ? d.invoice_cc_emails : [],
    invoice_customer_email_subject: d.invoice_customer_email_subject ?? DEFAULT_CUSTOMER_SUBJECT,
    invoice_customer_email_body: d.invoice_customer_email_body ?? DEFAULT_CUSTOMER_BODY,
    invoice_admin_email_subject: d.invoice_admin_email_subject ?? DEFAULT_ADMIN_SUBJECT,
    invoice_admin_email_body: d.invoice_admin_email_body ?? DEFAULT_ADMIN_BODY,
    pickup_address: d.pickup_address ?? '',
    guest_checkout_enabled: d.guest_checkout_enabled ?? true,
    // Stealth Health hosted checkout is the only checkout, so it is always on
    // (the old on-site e-Transfer flow and its toggle were removed). The
    // credential flag below is derived from server env (the API key itself is
    // never returned).
    puramass_checkout_enabled: true,
    // Hosted-checkout shipping. Normalised through the same shaper the checkout
    // itself uses, so the storefront and the server can never disagree about
    // whether the promo is live — above all, it is forced off without live
    // courier rates. `_active` folds in the checkout toggle, which is the only
    // thing the storefront has to look at.
    puramass_shipping_rates_enabled: hostedShipping.ratesEnabled,
    puramass_flat_shipping: hostedShipping.flatShipping,
    puramass_free_shipping_enabled: hostedShipping.freeShippingEnabled,
    puramass_free_shipping_threshold: hostedShipping.freeShippingThreshold,
    puramass_free_shipping_active:
      hostedShipping.freeShippingEnabled,
    puramass_configured: isPuramassConfigured(),
    // Paid-ads welcome discount. Like the free-shipping promo above, `_active`
    // folds in the hosted-checkout toggle: the discount is applied by lowering
    // the line prices on the Stealth Health hand-off, so there is nowhere to apply it
    // when that is not the live checkout — and an offer the checkout would not
    // honour must not be advertised.
    ad_discount_enabled: adDiscount.enabled,
    ad_discount_percent: adDiscount.percent,
    ad_discount_active: adDiscount.enabled,
    // Limited-time cart offer — "add one more item and get X% off". Same shape
    // as the two promos above, and `_active` folds in the same hosted-checkout
    // toggle for the same reason: the saving travels as lowered line prices,
    // so there is nowhere to apply it when that is not the live checkout.
    cart_offer_enabled: cartOffer.enabled,
    cart_offer_min_items: cartOffer.minItems,
    cart_offer_percent: cartOffer.percent,
    cart_offer_ends_at: cartOffer.endsAt,
    cart_offer_active: cartOffer.enabled,
    // The two merchandising blocks on the cart. Nothing is discounted by
    // either, so they carry no `_active` twin — they are on unless switched
    // off, and default on for a store that has not been asked yet.
    cart_fbt_enabled: d.cart_fbt_enabled ?? true,
    cart_similar_enabled: d.cart_similar_enabled ?? true,
    // The checkout's "Complete your order" box (reconstitution help + add-on
    // products). Merchandising only, so on unless switched off.
    checkout_addons_enabled: d.checkout_addons_enabled ?? true,
    // Cart header trust badges and the checkout's "A few quick questions
    // first" notice. Presentation only, so on unless switched off.
    cart_trust_strip_enabled: d.cart_trust_strip_enabled ?? true,
    checkout_verify_notice_enabled: d.checkout_verify_notice_enabled ?? true,
    product_trust_badges_enabled: d.product_trust_badges_enabled ?? true,
    product_reviews_enabled: d.product_reviews_enabled ?? true,
    easyship_enabled: d.easyship_enabled ?? false,
    easyship_api_key_set: Boolean(d.easyship_api_key),
    shipping_origin: d.shipping_origin ?? {},
    shipping_box: d.shipping_box ?? {},
    shipping_item_weight_kg: d.shipping_item_weight_kg ?? 0.05,
    shipping_flat_rate: d.shipping_flat_rate ?? 20,
    // Processing fee added on top of the live rate (baked into shipping; never
    // shown separately at checkout). 'flat' = CAD amount, 'pct' = % of rate.
    shipping_handling_fee_type: d.shipping_handling_fee_type === 'pct' ? 'pct' : 'flat',
    shipping_handling_fee_value: Number(d.shipping_handling_fee_value) || 0,
    // Klaviyo. The private key is write-only — only whether one is set, and
    // whether it comes from the admin UI or the KLAVIYO_PRIVATE_API_KEY env
    // fallback. The public key is a client-side id and safe to return.
    klaviyo_enabled: klaviyo.enabled,
    klaviyo_private_key_set: klaviyo.keySource !== null,
    klaviyo_private_key_source: klaviyo.keySource,
    klaviyo_public_key: klaviyo.publicKey,
    klaviyo_list_id: klaviyo.listId,
    klaviyo_onsite_enabled: klaviyo.onsiteEnabled,
    klaviyo_server_events_enabled: klaviyo.serverEventsEnabled,
    klaviyo_sync_signups: klaviyo.syncSignups,
    // Registration alerts
    registration_alert_enabled: d.registration_alert_enabled ?? true,
    abandoned_registration_enabled: d.abandoned_registration_enabled ?? true,
    abandoned_registration_hours: Number(d.abandoned_registration_hours) || 12,
    // How long a hosted checkout sits unpaid before /admin/stealth-health (Orders tab)
    // lists it as an abandoned cart worth chasing.
    abandoned_checkout_hours: Number(d.abandoned_checkout_hours) || 1,
    created_at: d.created_at ?? null,
    updated_at: d.updated_at ?? null,
  };
}

// GET /api/admin/settings — unauthenticated read of public checkout config.
export async function GET() {
  const { data } = await db
    .from('site_settings')
    .select(SETTINGS_COLUMNS)
    .limit(1)
    .maybeSingle();

  return NextResponse.json({ settings: shape(data) });
}

async function resolveRole(req: NextRequest): Promise<UserRole | null> {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return null;
  const { data } = await db.from('customers').select('role').eq('id', user.id).single();
  return (data?.role ?? 'customer') as UserRole;
}

// PUT /api/admin/settings — admin only (assistants + analytics excluded).
// Branding/tracking has its own /api/admin/marketing endpoint; this route keeps
// the sensitive config (API keys / emails) out of the analytics role's reach.
export async function PUT(req: NextRequest) {
  const role = await resolveRole(req);
  if (!role || !canAccessAdmin(role) || role === 'assistant' || role === 'analytics') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const updates: Record<string, any> = {};

  if ('checkout_type' in body) {
    if (body.checkout_type !== 'email' && body.checkout_type !== 'crypto') {
      return NextResponse.json({ error: 'checkout_type must be email or crypto' }, { status: 400 });
    }
    updates.checkout_type = body.checkout_type;
  }

  for (const key of ['admin_emails', 'invoice_cc_emails'] as const) {
    if (key in body) {
      const result = normaliseEmailList(body[key]);
      if (!Array.isArray(result)) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      updates[key] = result;
    }
  }

  for (const key of [
    'guest_checkout_enabled',
    'easyship_enabled',
    'registration_alert_enabled',
    'abandoned_registration_enabled',
    'puramass_shipping_rates_enabled',
    'puramass_free_shipping_enabled',
    'ad_discount_enabled',
    'cart_offer_enabled',
    'cart_fbt_enabled',
    'cart_similar_enabled',
    'checkout_addons_enabled',
    'cart_trust_strip_enabled',
    'checkout_verify_notice_enabled',
    'product_trust_badges_enabled',
    'product_reviews_enabled',
    'klaviyo_enabled',
    'klaviyo_onsite_enabled',
    'klaviyo_server_events_enabled',
    'klaviyo_sync_signups',
  ] as const) {
    if (key in body) updates[key] = Boolean(body[key]);
  }

  // Klaviyo public key (Site ID) and list id: short alphanumerics, or empty
  // to clear.
  for (const [key, re, label] of [
    ['klaviyo_public_key', KLAVIYO_PUBLIC_KEY_RE, 'Klaviyo public key / Site ID'],
    ['klaviyo_list_id', KLAVIYO_LIST_ID_RE, 'Klaviyo list ID'],
  ] as const) {
    if (key in body) {
      const v = String(body[key] ?? '').trim();
      if (v && !re.test(v)) {
        return NextResponse.json({ error: `${label} looks invalid: ${v}` }, { status: 400 });
      }
      updates[key] = v;
    }
  }

  // Klaviyo private key: write-only, same rules as the Easyship token — only
  // overwritten when a non-empty value is sent; a single space clears it.
  if (
    'klaviyo_private_api_key' in body &&
    typeof body.klaviyo_private_api_key === 'string' &&
    body.klaviyo_private_api_key.length > 0
  ) {
    const key = body.klaviyo_private_api_key.trim();
    if (key && !/^pk_[A-Za-z0-9_]{10,}$/.test(key)) {
      return NextResponse.json(
        { error: 'Klaviyo private API key should start with "pk_" (Klaviyo → Settings → API keys).' },
        { status: 400 },
      );
    }
    updates.klaviyo_private_api_key = key;
  }

  // How much the paid-ads welcome discount takes off. Bounded on both sides
  // rather than merely non-negative: 0 switches the promo off, and the ceiling
  // is 99 rather than 100 because the discount travels as per-line
  // `unit_price_cents` and Stealth Health reads a zero there as "no price given" —
  // giving the goods away would charge full list instead. See
  // lib/promos/ad-discount.ts.
  if ('ad_discount_percent' in body) {
    const n = Number(body.ad_discount_percent);
    if (!Number.isFinite(n) || n < 0 || n > 99) {
      return NextResponse.json(
        {
          error:
            'ad_discount_percent must be a number between 0 and 99 — the hosted ' +
            'checkout cannot be sent a zero line price.',
        },
        { status: 400 },
      );
    }
    updates.ad_discount_percent = clampDiscountPercent(n);
  }

  // The limited-time cart offer. Same ceiling as the welcome discount, and for
  // the same reason — the two can stack, and `combineDiscountPercents` keeps
  // the pair under it too, so neither one alone nor both together can produce
  // a zero line price.
  if ('cart_offer_percent' in body) {
    const n = Number(body.cart_offer_percent);
    if (!Number.isFinite(n) || n < 0 || n > MAX_DISCOUNT_PERCENT) {
      return NextResponse.json(
        {
          error:
            `cart_offer_percent must be a number between 0 and ${MAX_DISCOUNT_PERCENT} — ` +
            'the hosted checkout cannot be sent a zero line price.',
        },
        { status: 400 },
      );
    }
    updates.cart_offer_percent = clampDiscountPercent(n);
  }

  // How many cart items unlock it. A whole number of items, at least one:
  // a minimum of zero would be a standing discount wearing an offer's clothes.
  if ('cart_offer_min_items' in body) {
    const n = Math.floor(Number(body.cart_offer_min_items));
    if (!Number.isFinite(n) || n < 1) {
      return NextResponse.json(
        { error: 'cart_offer_min_items must be a whole number of items (>= 1)' },
        { status: 400 },
      );
    }
    updates.cart_offer_min_items = clampMinItems(n);
  }

  // When the offer stops. Empty clears it, which is how an offer is made to
  // run until it is switched off — and is also what hides the cart countdown.
  if ('cart_offer_ends_at' in body) {
    const raw = body.cart_offer_ends_at;
    if (raw === null || raw === undefined || String(raw).trim() === '') {
      updates.cart_offer_ends_at = null;
    } else {
      const when = new Date(String(raw));
      if (!Number.isFinite(when.getTime())) {
        return NextResponse.json(
          { error: 'cart_offer_ends_at must be a date/time, or empty for no end date' },
          { status: 400 },
        );
      }
      updates.cart_offer_ends_at = when.toISOString();
    }
  }

  // Abandoned-registration delay must be a whole number of hours >= 1.
  if ('abandoned_registration_hours' in body) {
    const n = Math.floor(Number(body.abandoned_registration_hours));
    if (!Number.isFinite(n) || n < 1) {
      return NextResponse.json(
        { error: 'abandoned_registration_hours must be a whole number of hours (>= 1)' },
        { status: 400 },
      );
    }
    updates.abandoned_registration_hours = n;
  }

  // Abandoned-checkout window, same shape. Capped at 30 days: a longer window
  // just fills the list with carts whose payment links Stealth Health has expired.
  if ('abandoned_checkout_hours' in body) {
    const n = Math.floor(Number(body.abandoned_checkout_hours));
    if (!Number.isFinite(n) || n < 1 || n > 24 * 30) {
      return NextResponse.json(
        { error: 'abandoned_checkout_hours must be a whole number of hours between 1 and 720' },
        { status: 400 },
      );
    }
    updates.abandoned_checkout_hours = n;
  }

  for (const key of [
    'invoice_customer_email_subject',
    'invoice_customer_email_body',
    'invoice_admin_email_subject',
    'invoice_admin_email_body',
    'pickup_address',
  ] as const) {
    if (key in body) updates[key] = String(body[key] ?? '');
  }

  if ('shipping_origin' in body) updates.shipping_origin = coerceOrigin(body.shipping_origin);
  if ('shipping_box' in body) updates.shipping_box = coerceBox(body.shipping_box);

  if ('shipping_handling_fee_type' in body) {
    updates.shipping_handling_fee_type =
      body.shipping_handling_fee_type === 'pct' ? 'pct' : 'flat';
  }

  for (const key of [
    'shipping_item_weight_kg',
    'shipping_flat_rate',
    'shipping_handling_fee_value',
    'puramass_flat_shipping',
    'puramass_free_shipping_threshold',
  ] as const) {
    if (key in body) {
      const n = Number(body[key]);
      if (!Number.isFinite(n) || n < 0) {
        return NextResponse.json({ error: `${key} must be a non-negative number` }, { status: 400 });
      }
      updates[key] = n;
    }
  }

  // API key is write-only: only overwrite when a non-empty value is sent
  // (a single space clears it).
  if ('easyship_api_key' in body && typeof body.easyship_api_key === 'string' && body.easyship_api_key.length > 0) {
    updates.easyship_api_key = body.easyship_api_key.trim();
  }

  // Upsert the singleton: update if present, else insert a fully-defaulted row.
  const { data: existing } = await db.from('site_settings').select('id').limit(1).maybeSingle();

  let saved: Record<string, any> | null = null;
  if (existing?.id) {
    const { data, error } = await db
      .from('site_settings')
      .update(updates)
      .eq('id', existing.id)
      .select(SETTINGS_COLUMNS)
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    saved = data as any;
  } else {
    const { data, error } = await db
      .from('site_settings')
      .insert({ checkout_type: 'crypto', admin_emails: [], ...updates })
      .select(SETTINGS_COLUMNS)
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    saved = data as any;
  }

  // Product pages are cached for 5 minutes; refresh them now so a show/hide
  // switch takes effect on the next visit.
  if ('product_trust_badges_enabled' in body || 'product_reviews_enabled' in body) {
    revalidatePath('/products/[slug]', 'page');
  }

  return NextResponse.json({ success: true, settings: shape(saved) });
}
