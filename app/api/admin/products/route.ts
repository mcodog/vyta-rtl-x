import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { canCreate } from '@/lib/permissions';
import { logAuditServer } from '@/lib/admin/audit';
import { recordProductChanges } from '@/lib/admin/product-history';
import { toUrlSlug } from '@/lib/products/url';
import { parsePriceOverride, parseVialsPerBox } from '@/lib/admin/product-input';
import { normalizePackOptions, normalizePackSizes } from '@/lib/pricing';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function verifyAdminRole(request: NextRequest, requireMutation: boolean = false) {
  try {
    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      return { authorized: false, role: 'customer' as const, actor_id: null, actor_email: null };
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return { authorized: false, role: 'customer' as const, actor_id: null, actor_email: null };
    }

    const { data: customer } = await supabase
      .from('customers')
      .select('id, email, role')
      .eq('id', user.id)
      .single();

    const role = customer?.role || 'customer';
    const actor_id = customer?.id ?? user.id;
    const actor_email = customer?.email ?? user.email ?? null;

    if (requireMutation && !canCreate(role)) {
      return { authorized: false, role, actor_id, actor_email };
    }

    if (!requireMutation && (role === 'admin' || role === 'assistant' || role === 'analytics')) {
      return { authorized: true, role, actor_id, actor_email };
    }

    return { authorized: role === 'admin', role, actor_id, actor_email };
  } catch (error) {
    console.error('Error verifying admin role:', error);
    return { authorized: false, role: 'customer' as const, actor_id: null, actor_email: null };
  }
}

export async function GET(request: NextRequest) {
  const { authorized } = await verifyAdminRole(request);

  if (!authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  try {
    const searchParams = request.nextUrl.searchParams;
    const active = searchParams.get('active');
    const category = searchParams.get('category');
    const featured = searchParams.get('featured');

    let query = supabase
      .from('products')
      .select('*')
      .order('created_at', { ascending: false });

    if (active !== null) {
      query = query.eq('active', active === 'true');
    }

    if (category) {
      query = query.eq('category', category);
    }

    if (featured !== null) {
      query = query.eq('featured', featured === 'true');
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching products:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ products: data });
  } catch (error) {
    console.error('Unexpected error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const { authorized, actor_id, actor_email } = await verifyAdminRole(request, true);

  if (!authorized) {
    return NextResponse.json({ error: 'Unauthorized - Admin role required' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const {
      name,
      description,
      price,
      price_usd,
      vial_price,
      stock_quantity,
      vials_per_box,
      pack_sizes,
      pack_options,
      category,
      image_url,
      box_image_url,
      strength,
      purity,
      form,
      featured,
      active,
      slug,
      sku,
      description_short,
      benefits,
      mechanism,
      coa_url,
      low_stock_threshold,
      is_checkout_addon,
    } = body;

    if (!name || price === undefined || stock_quantity === undefined) {
      return NextResponse.json(
        { error: 'Missing required fields: name, price, stock_quantity' },
        { status: 400 }
      );
    }

    if (price < 0 || stock_quantity < 0) {
      return NextResponse.json(
        { error: 'Price and stock quantity must be non-negative' },
        { status: 400 }
      );
    }

    // Optional per-currency / per-vial overrides. Left NULL when omitted so
    // the storefront derives them from `price` and `vials_per_box`.
    const priceUsd = parsePriceOverride(price_usd ?? null, 'USD price');
    if (!priceUsd.ok) {
      return NextResponse.json({ error: priceUsd.error }, { status: 400 });
    }

    const vialPrice = parsePriceOverride(vial_price ?? null, 'Vial price');
    if (!vialPrice.ok) {
      return NextResponse.json({ error: vialPrice.error }, { status: 400 });
    }

    const vialsPerBox = parseVialsPerBox(vials_per_box ?? null);
    if (!vialsPerBox.ok) {
      return NextResponse.json({ error: vialsPerBox.error }, { status: 400 });
    }

    // Pack options — see lib/pricing.ts `packSizesFor`. An empty list stores
    // NULL, i.e. "fall back to single vial + one full case".
    const cleanedPackSizes = normalizePackSizes(pack_sizes);
    // Per-pack price / label / compare-at. Normalised here so a malformed
    // document can never reach the column, and stored as NULL when empty so
    // the older `pack_sizes` column keeps deciding on its own.
    const cleanedPackOptions = normalizePackOptions(pack_options);

    const productSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    // The public URL is derived from the SKU slug, never equal to it by
    // definition — see lib/products/url.ts. The DB trigger backstops rows
    // inserted outside this route.
    const productUrlSlug = toUrlSlug(productSlug);

    const { data: existingProduct } = await supabase
      .from('products')
      .select('id')
      .eq('slug', productSlug)
      .single();

    if (existingProduct) {
      return NextResponse.json(
        { error: 'A product with this slug already exists' },
        { status: 409 }
      );
    }

    const { data, error } = await supabase
      .from('products')
      .insert({
        name,
        description,
        price,
        price_usd: priceUsd.value,
        vial_price: vialPrice.value,
        stock_quantity,
        vials_per_box: vialsPerBox.value,
        pack_sizes: cleanedPackSizes.length > 0 ? cleanedPackSizes : null,
        pack_options: cleanedPackOptions.length > 0 ? cleanedPackOptions : null,
        low_stock_threshold: low_stock_threshold ?? 10,
        category,
        image_url,
        box_image_url: box_image_url ?? null,
        strength,
        purity,
        form,
        featured: featured || false,
        active: active !== undefined ? active : true,
        slug: productSlug,
        url_slug: productUrlSlug,
        sku: sku ?? null,
        description_short,
        benefits,
        mechanism,
        coa_url: Array.isArray(coa_url) ? coa_url : coa_url ? [coa_url] : [],
        is_checkout_addon: is_checkout_addon ?? false,
      })
      .select()
      .single();

    if (error) {
      console.error('Error creating product:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Opening stock goes on the ledger as a manual entry by whoever created it.
    if (data?.id && Number(data.stock_quantity) > 0) {
      await recordProductChanges(
        supabase,
        { actor_id, actor_email },
        data.id,
        { stock_quantity: null },
        { stock_quantity: data.stock_quantity },
        { source: 'admin_edit' },
      );
    }

    await logAuditServer(supabase, { actor_id, actor_email }, {
      action: 'product.create',
      entity_type: 'product',
      entity_id: data?.id ?? null,
    });

    return NextResponse.json({ product: data }, { status: 201 });
  } catch (error) {
    console.error('Unexpected error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
