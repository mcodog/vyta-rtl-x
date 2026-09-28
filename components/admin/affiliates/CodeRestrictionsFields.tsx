'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, Search, X } from 'lucide-react';

/** Matches bacteriostatic / BAC water products — the usual exclusion. */
const isBacWater = (name: string) => /bacteriostatic|bac[\s-]?water/i.test(name || '');

interface ProductOption {
  id: string;
  name: string;
}

let productCache: Promise<ProductOption[]> | null = null;

/** The catalogue, fetched once per admin session. */
function loadProducts(): Promise<ProductOption[]> {
  if (!productCache) {
    productCache = fetch('/api/products', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : { products: [] }))
      .then((json) =>
        ((json?.products ?? []) as any[])
          .map((p) => ({ id: String(p.id), name: String(p.name ?? '') }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      )
      .catch(() => {
        productCache = null;
        return [];
      });
  }
  return productCache;
}

const labelCls = 'mb-1 block text-xs font-medium text-ink';
const hintCls = 'mt-1 text-[11px] text-ink-muted';

/**
 * "First order only" and "excluded products" — the two restrictions a code can
 * carry since landing-pages-migration.sql. Shared by the discount-code modal
 * and the landing-page modal, so a landing page's code reads the same in both.
 *
 * The exclusion list is what makes an asterisk like "*excluding Bac water"
 * true at checkout: excluded lines keep their list price and the percentage is
 * taken off everything else.
 */
export default function CodeRestrictionsFields({
  firstOrderOnly,
  onFirstOrderOnly,
  excludedIds,
  onExcludedIds,
  suggestBacWater = false,
}: {
  firstOrderOnly: boolean;
  onFirstOrderOnly: (value: boolean) => void;
  excludedIds: string[];
  onExcludedIds: (ids: string[]) => void;
  /** Offer a one-click "exclude bacteriostatic water" shortcut. */
  suggestBacWater?: boolean;
}) {
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    loadProducts().then((list) => {
      if (cancelled) return;
      setProducts(list);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const selected = new Set(excludedIds);
  const bacWater = products.filter((p) => isBacWater(p.name));
  const bacMissing = bacWater.filter((p) => !selected.has(p.id));

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return products.filter((p) => !selected.has(p.id) && p.name.toLowerCase().includes(q)).slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, products, excludedIds]);

  const add = (ids: string[]) => onExcludedIds([...new Set([...excludedIds, ...ids])]);
  const remove = (id: string) => onExcludedIds(excludedIds.filter((x) => x !== id));

  return (
    <div className="space-y-4">
      <label className="flex items-start gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={firstOrderOnly}
          onChange={(e) => onFirstOrderOnly(e.target.checked)}
          className="mt-0.5 accent-teal"
        />
        <span>
          First order only
          <span className="block text-[11px] text-ink-muted">
            Refused to anyone who already has a paid order, or a checkout awaiting payment —
            checked by account and by email, so guest checkouts count too.
          </span>
        </span>
      </label>

      <div>
        <p className={labelCls}>Excluded products</p>
        {excludedIds.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {excludedIds.map((id) => (
              <span
                key={id}
                className="inline-flex items-center gap-1 rounded-full bg-surface px-2.5 py-1 text-xs text-ink"
              >
                {byId.get(id)?.name ?? (loading ? '…' : 'Unknown product')}
                <button
                  type="button"
                  onClick={() => remove(id)}
                  aria-label={`Stop excluding ${byId.get(id)?.name ?? 'product'}`}
                  className="rounded-full p-0.5 text-ink-muted hover:bg-line hover:text-ink"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="mb-2 text-[11px] text-ink-muted">None — the code applies to the whole cart.</p>
        )}

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={loading ? 'Loading products…' : 'Search products to exclude'}
            disabled={loading}
            className="w-full rounded-lg border border-line bg-white py-2 pl-8 pr-3 text-sm text-ink focus:border-teal focus:outline-none disabled:bg-surface"
          />
          {loading && (
            <Loader2 className="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-ink-muted" />
          )}
        </div>
        {matches.length > 0 && (
          <ul className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-line bg-white text-sm shadow-card">
            {matches.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => {
                    add([p.id]);
                    setQuery('');
                  }}
                  className="block w-full px-3 py-2 text-left text-ink hover:bg-surface"
                >
                  {p.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        {suggestBacWater && bacMissing.length > 0 && (
          <button
            type="button"
            onClick={() => add(bacMissing.map((p) => p.id))}
            className="mt-2 text-xs font-medium text-teal-dark hover:underline"
          >
            + Exclude all bacteriostatic water ({bacMissing.length})
          </button>
        )}
        <p className={hintCls}>
          Excluded lines keep their list price; the percentage comes off everything else.
        </p>
      </div>
    </div>
  );
}
