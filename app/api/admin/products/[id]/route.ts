import { NextRequest, NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { canEdit, canDelete, canEditProductDescriptors, PRODUCT_DESCRIPTOR_FIELDS } from '@/lib/permissions';
import { logAuditServer } from '@/lib/admin/audit';
import { recordProductChanges } from '@/lib/admin/product-history';
import { setProductStock } from '@/lib/admin/stock-ledger';
import { checkLowStockForProducts } from '@/lib/admin/low-stock';
import { parsePriceOverride, parseVialsPerBox } from '@/lib/admin/product-input';
import { normalizePackOptions, normalizePackSizes, reconcilePackOptions } from '@/lib/pricing';
import { sendBackInStockNotification } from '@/lib/email-smtp';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * Email every pending waitlist subscriber that a product is back in stock,
 * then flip the successfully-emailed rows to 'notified'. Awaited (reliable
 * in serverless) but wrapped so an email failure never fails the product
 * update; failed rows stay 'pending' for a later retry.
 */
async function notifyWaitlist(
  db: SupabaseClient,
  productId: string,
  product: {
    name: string;
    slug: string | null;
    url_slug: string | null;
    image_url: string | null;
    strength: string | null;
    price: number;
  },
) {
  try {
    const { data: rows, error } = await db
      .from('stock_notifications')
      .select('id, email')
      .eq('product_id', productId)
      .eq('status', 'pending');

    if (error || !rows || rows.length === 0) return;

    const notifiedIds: string[] = [];
    for (const row of rows) {
      try {
        const res = await sendBackInStockNotification({
          to: row.email,
          productName: product.name,
          productSlug: product.slug,
          productUrlSlug: product.url_slug,
          imageUrl: product.image_url,
          strength: product.strength,
          price: product.price,
        });
        if (res?.success !== false) notifiedIds.push(row.id);
      } catch (err) {
        console.error('back-in-stock email failed for', row.email, err);
      }
    }

    if (notifiedIds.length > 0) {
      await db
        .from('stock_notifications')
        .update({ status: 'notified', notified_at: new Date().toISOString() })
        .in('id', notifiedIds);
    }
  } catch (err) {
    console.error('notifyWaitlist threw:', err);
  }
}

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

    if (requireMutation && !canEdit(role)) {
      return { authorized: false, role, actor_id, actor_email };
    }

    // Reads are open to admin / assistant / analytics (the analytics partner
    // needs to load the catalog to edit descriptors).
    if (!requireMutation && (role === 'admin' || role === 'assistant' || role === 'analytics')) {
      return { authorized: true, role, actor_id, actor_email };
    }

    return { authorized: role === 'admin', role, actor_id, actor_email };
  } catch (error) {
    console.error('Error verifying admin role:', error);
    return { authorized: false, role: 'customer' as const, actor_id: null, actor_email: null };
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { authorized } = await verifyAdminRole(request);

  if (!authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  try {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json({ error: 'Product not found' }, { status: 404 });
      }
      console.error('Error fetching product:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ product: data });
  } catch (error) {
    console.error('Unexpected error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Descriptor-only editors (analytics) may PATCH; every non-descriptor key is
  // stripped below before the write, so a hand-crafted analytics request still
  // cannot change price / stock / visibility. Admins send the full payload.
  const { role, actor_id, actor_email } = await verifyAdminRole(request);

  if (!canEditProductDescriptors(role)) {
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
      low_stock_threshold,
      category,
      image_url,
      box_image_url,
      strength,
      purity,
      form,
      featured,
      active,
      slug,
      url_slug,
      sku,
      description_short,
      benefits,
      mechanism,
      coa_url,
      is_checkout_addon,
    } = body;

    const { data: existingProduct, error: fetchError } = await supabase
      .from('products')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !existingProduct) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

    if (price !== undefined && price < 0) {
      return NextResponse.json({ error: 'Price must be non-negative' }, { status: 400 });
    }

    if (stock_quantity !== undefined && stock_quantity < 0) {
      return NextResponse.json({ error: 'Stock quantity must be non-negative' }, { status: 400 });
    }

    // Nullable price overrides and the box factor. Parsed up front so an
    // invalid value is a 400 rather than a silently skipped column.
    let parsedPriceUsd: number | null = null;
    if (price_usd !== undefined) {
      const parsed = parsePriceOverride(price_usd, 'USD price');
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
      parsedPriceUsd = parsed.value;
    }

    let parsedVialPrice: number | null = null;
    if (vial_price !== undefined) {
      const parsed = parsePriceOverride(vial_price, 'Vial price');
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
      parsedVialPrice = parsed.value;
    }

    // Pack options. `null` / `[]` both mean "not opted in" and are stored as
    // NULL, which is what makes the storefront fall back to the legacy
    // single-vial + full-case pair (see lib/pricing.ts `packSizesFor`).
    let parsedPackSizes: number[] | null = null;
    if (pack_sizes !== undefined) {
      if (pack_sizes !== null && !Array.isArray(pack_sizes)) {
        return NextResponse.json(
          { error: 'Pack options must be a list of numbers' },
          { status: 400 },
        );
      }
      const cleaned = normalizePackSizes(pack_sizes);
      parsedPackSizes = cleaned.length > 0 ? cleaned : null;
    }

    // Per-pack price / label / compare-at. Same "empty means not opted in"
    // rule: clearing the editor stores NULL and the packs go back to being
    // priced at the vial price × size.
    let parsedPackOptions: ReturnType<typeof normalizePackOptions> | null = null;
    if (pack_options !== undefined) {
      if (pack_options !== null && !Array.isArray(pack_options)) {
        return NextResponse.json(
          { error: 'Pack pricing must be a list of pack rows' },
          { status: 400 },
        );
      }
      const cleaned = normalizePackOptions(pack_options);
      parsedPackOptions = cleaned.length > 0 ? cleaned : null;
    }

    let parsedVialsPerBox = 10;
    if (vials_per_box !== undefined) {
      const parsed = parseVialsPerBox(vials_per_box);
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
      parsedVialsPerBox = parsed.value;
    }

    if (slug && slug !== existingProduct.slug) {
      const { data: conflictingProduct } = await supabase
        .from('products')
        .select('id')
        .eq('slug', slug)
        .neq('id', id)
        .single();

      if (conflictingProduct) {
        return NextResponse.json(
          { error: 'A product with this slug already exists' },
          { status: 409 }
        );
      }
    }

    // The public URL is only changed when explicitly edited — it is NOT
    // re-derived when the SKU slug changes. A live URL that silently moves
    // breaks inbound links, so that has to be a deliberate act.
    if (url_slug !== undefined && url_slug !== existingProduct.url_slug) {
      const candidate = String(url_slug ?? '').trim();
      if (!candidate) {
        return NextResponse.json({ error: 'Product URL cannot be empty' }, { status: 400 });
      }
      // Conflict against BOTH columns: the product route resolves url_slug and
      // falls back to slug, so a value matching either would make the URL
      // ambiguous and could serve the wrong product.
      const { data: urlConflict } = await supabase
        .from('products')
        .select('id')
        .or(`url_slug.eq.${candidate},slug.eq.${candidate}`)
        .neq('id', id)
        .maybeSingle();

      if (urlConflict) {
        return NextResponse.json(
          { error: 'Another product already uses this URL' },
          { status: 409 }
        );
      }
    }

    const updateData: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (name !== undefined) updateData.name = name;
    if (url_slug !== undefined) updateData.url_slug = String(url_slug).trim();
    if (description !== undefined) updateData.description = description;
    if (price !== undefined) updateData.price = price;
    if (price_usd !== undefined) updateData.price_usd = parsedPriceUsd;
    if (vial_price !== undefined) updateData.vial_price = parsedVialPrice;
    if (stock_quantity !== undefined) updateData.stock_quantity = stock_quantity;
    if (vials_per_box !== undefined) updateData.vials_per_box = parsedVialsPerBox;
    if (pack_sizes !== undefined) updateData.pack_sizes = parsedPackSizes;
    if (pack_options !== undefined) {
      updateData.pack_options = parsedPackOptions;
    } else if (pack_sizes !== undefined) {
      // A sizes-only edit (the cell grid) has to keep the richer column in
      // step, or the storefront — which reads pack_options first — would keep
      // selling a size the grid just removed. Surviving sizes keep their
      // prices; see lib/pricing.ts `reconcilePackOptions`.
      updateData.pack_options = reconcilePackOptions(
        existingProduct.pack_options,
        parsedPackSizes ?? [],
      );
    }
    if (low_stock_threshold !== undefined) updateData.low_stock_threshold = low_stock_threshold;
    if (category !== undefined) updateData.category = category;
    if (image_url !== undefined) updateData.image_url = image_url;
    if (box_image_url !== undefined) updateData.box_image_url = box_image_url;
    if (strength !== undefined) updateData.strength = strength;
    if (purity !== undefined) updateData.purity = purity;
    if (form !== undefined) updateData.form = form;
    if (featured !== undefined) updateData.featured = featured;
    if (active !== undefined) updateData.active = active;
    if (is_checkout_addon !== undefined) updateData.is_checkout_addon = is_checkout_addon;
    if (slug !== undefined) updateData.slug = slug;
    if (sku !== undefined) updateData.sku = sku;
    if (description_short !== undefined) updateData.description_short = description_short;
    if (benefits !== undefined) updateData.benefits = benefits;
    if (mechanism !== undefined) updateData.mechanism = mechanism;
    if (coa_url !== undefined) updateData.coa_url = Array.isArray(coa_url) ? coa_url : coa_url ? [coa_url] : [];

    // Authoritative descriptor-only enforcement: a non-admin editor may only
    // change copy/image fields. Strip every key that isn't a descriptor (plus
    // the always-allowed updated_at) before writing.
    if (role !== 'admin') {
      const allowed = new Set<string>([...PRODUCT_DESCRIPTOR_FIELDS, 'updated_at']);
      for (const key of Object.keys(updateData)) {
        if (!allowed.has(key)) delete updateData[key];
      }
    }

    // Stock goes through set_product_stock so the change and the ledger row
    // naming who made it commit together. Before stock-ledger-migration.sql
    // has run it stays in the plain update, logged by the diff below.
    let stockLogged = false;
    if (
      'stock_quantity' in updateData &&
      Number.isInteger(Number(updateData.stock_quantity)) &&
      Number(updateData.stock_quantity) !== Number(existingProduct.stock_quantity ?? 0)
    ) {
      const res = await setProductStock(supabase, {
        productId: id,
        quantity: Number(updateData.stock_quantity),
        actorId: actor_id,
        actorEmail: actor_email,
      });
      if (res.ok) {
        stockLogged = true;
        delete updateData.stock_quantity;
      } else if (!res.unsupported) {
        console.error('Error setting product stock:', res.error);
        return NextResponse.json({ error: res.error }, { status: 500 });
      }
    }

    const { data, error } = await supabase
      .from('products')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating product:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Restock detection: fire the back-in-stock waitlist on the 0 -> positive
    // edge only. Awaited but non-fatal.
    const oldStock = existingProduct.stock_quantity ?? 0;
    const newStock = data?.stock_quantity ?? 0;
    const wasOutOfStock = oldStock <= 0;
    const isNowInStock = newStock > 0;
    if (wasOutOfStock && isNowInStock && data) {
      await notifyWaitlist(supabase, id, {
        name: data.name,
        slug: data.slug,
        url_slug: data.url_slug,
        image_url: data.image_url,
        strength: data.strength,
        price: data.price,
      });
    }

    // Re-evaluate the low-stock alert state for this product.
    await checkLowStockForProducts(supabase, [id]);

    // Field-level history: log price / stock / general changes made here.
    // A stock change set_product_stock already logged is left out here.
    if (data) {
      const after: Record<string, unknown> = { ...data };
      if (stockLogged) delete after.stock_quantity;
      await recordProductChanges(
        supabase,
        { actor_id, actor_email },
        id,
        existingProduct,
        after,
        { source: 'admin_edit' },
      );
    }

    await logAuditServer(supabase, { actor_id, actor_email }, {
      action: 'product.update',
      entity_type: 'product',
      entity_id: id,
    });

    return NextResponse.json({ product: data });
  } catch (error) {
    console.error('Unexpected error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Backwards-compatible alias: existing callers may still issue PUT.
export const PUT = PATCH;

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { authorized, role, actor_id, actor_email } = await verifyAdminRole(request, true);

  if (!authorized || !canDelete(role)) {
    return NextResponse.json({ error: 'Unauthorized - Admin role required' }, { status: 403 });
  }

  try {
    const { data: existingProduct, error: fetchError } = await supabase
      .from('products')
      .select('id, name')
      .eq('id', id)
      .single();

    if (fetchError || !existingProduct) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

    const { error } = await supabase
      .from('products')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Error deleting product:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    await logAuditServer(supabase, { actor_id, actor_email }, {
      action: 'product.delete',
      entity_type: 'product',
      entity_id: id,
    });

    return NextResponse.json({ success: true, message: 'Product deleted successfully' });
  } catch (error) {
    console.error('Unexpected error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
