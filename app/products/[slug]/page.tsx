import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { SITE_URL } from '@/lib/config';
import { productPath } from '@/lib/products/url';
import {
  getBacteriostaticWater,
  getProductReviewStats,
  getProductsForSitemap,
  getPublicProduct,
  getRelatedProducts,
} from '@/lib/products/products-server';
import {
  buildProductBreadcrumbJsonLd,
  buildProductJsonLd,
  productMetaDescription,
} from '@/lib/products/structured-data';
import { getServerSiteConfig } from '@/lib/site-config-server';
import ProductDetailClient from './ProductDetailClient';

/**
 * A product page.
 *
 * This route is a server shell around a client component. The split exists for
 * indexing: the page used to be entirely client-rendered, which meant every
 * product URL inherited the root layout's title and description (one generic
 * title across the whole catalog) and served Google an empty shell until the
 * browser finished a Supabase round-trip. The product, its related row and the
 * companion buy are now resolved here, so the name, copy, price and specs are
 * in the first HTML response and `generateMetadata` has something to describe.
 *
 * Everything interactive — the pack picker, add-to-cart, the COA modal, the
 * review list — stays in ProductDetailClient, unchanged.
 */

export const revalidate = 300;

/**
 * Prerender every active product at build time, so a crawler's first request
 * is served a cached page instead of waiting on a Supabase round-trip. Slugs
 * outside this list (a product added since the last deploy, or a legacy SKU
 * slug that redirects) still render on demand — `dynamicParams` defaults to
 * true. An unreachable database yields an empty list, which degrades to the
 * on-demand behaviour rather than failing the build.
 */
export async function generateStaticParams() {
  const products = await getProductsForSitemap();
  return products
    .map((product) => product.url_slug || product.slug)
    .filter((slug): slug is string => Boolean(slug))
    .map((slug) => ({ slug }));
}

export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
): Promise<Metadata> {
  const { slug } = await params;
  const [product, cfg] = await Promise.all([getPublicProduct(slug), getServerSiteConfig()]);
  if (!product) return { title: 'Product not found | VYTA' };

  const description = productMetaDescription(product);
  const canonical = `${SITE_URL}${productPath(product)}`;
  const image = product.image_url || product.box_image_url;

  return {
    title: `${product.name} — ${product.strength || product.category} | ${cfg.store_name}`,
    description,
    // The one tag that collapses the duplicates: the legacy SKU slug, the
    // url_slug and every ?gclid=/?utm_* variant the middleware deliberately
    // preserves all resolve to the same page, and this names the winner.
    alternates: { canonical },
    // A de-listed product still renders for anyone holding the link, but it
    // has no business in the index.
    ...(product.active ? {} : { robots: { index: false, follow: true } }),
    openGraph: {
      title: product.name,
      description,
      type: 'website',
      url: canonical,
      ...(image ? { images: [image] } : {}),
    },
    twitter: {
      card: 'summary_large_image',
      title: product.name,
      description,
      ...(image ? { images: [image] } : {}),
    },
  };
}

export default async function ProductPage(
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const product = await getPublicProduct(slug);
  if (!product) notFound();

  // A legacy SKU slug resolved. The old page did this client-side with
  // router.replace, which fixed the address bar but left both URLs returning
  // 200 with identical content. A 308 hands Google one canonical URL and
  // passes the link equity of the old one to it.
  if (product.url_slug && product.url_slug !== slug) {
    permanentRedirect(`/products/${product.url_slug}`);
  }

  const [related, batWater, reviewStats, cfg] = await Promise.all([
    getRelatedProducts(product.category, product.id),
    getBacteriostaticWater(),
    getProductReviewStats(product.id),
    getServerSiteConfig(),
  ]);

  const jsonLd = buildProductJsonLd({
    product,
    siteUrl: SITE_URL,
    storeName: cfg.store_name,
    reviewStats,
  });
  const breadcrumbJsonLd = buildProductBreadcrumbJsonLd(product, SITE_URL);

  return (
    <>
      <script
        type="application/ld+json"
        // JSON.stringify output, not user-authored markup. `<` is escaped so a
        // product description containing "</script>" cannot break out of the tag.
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c'),
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(breadcrumbJsonLd).replace(/</g, '\\u003c'),
        }}
      />
      <ProductDetailClient
        product={product}
        relatedProducts={related}
        batWater={batWater}
        showTrustBadges={cfg.product_trust_badges_enabled}
        showReviews={cfg.product_reviews_enabled}
        showSpecs={cfg.product_specs_enabled}
        showBenefits={cfg.product_benefits_enabled}
      />
    </>
  );
}
