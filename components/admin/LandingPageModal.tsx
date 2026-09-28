'use client';

import React, { useState } from 'react';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import { adminFetch } from '@/components/admin/affiliates/api';
import CodeRestrictionsFields from '@/components/admin/affiliates/CodeRestrictionsFields';
import { normalizeLandingSlug, suggestLandingCode } from '@/lib/promos/landing';

export interface AdminLandingPage {
  id: string;
  slug: string;
  name: string;
  domain: string | null;
  destination_path: string;
  active: boolean;
  notes: string | null;
  created_at: string;
  code: {
    id: string;
    code: string;
    discount_type: 'percent' | 'fixed';
    percent: number;
    first_order_only: boolean;
    excluded_product_ids: string[];
    starts_at: string | null;
    expires_at: string | null;
    max_uses: number | null;
    active: boolean;
  } | null;
  live_percent: number;
  cta_url: string;
  api_url: string;
  stats: {
    visitors: number | null;
    signups: number | null;
    checkouts: number | null;
    purchasers: number | null;
    orders: number;
    revenue: Record<string, number>;
    discount_given: number;
  } | null;
}

/** ISO → the value a `datetime-local` input wants, in local time. */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const inputCls =
  'w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink focus:border-teal focus:outline-none disabled:bg-surface';
const labelCls = 'mb-1 block text-xs font-medium text-ink';
const hintCls = 'mt-1 text-[11px] text-ink-muted';

/**
 * Create or edit a landing page and the offer it makes.
 *
 * The offer is saved as a real discount code (it also appears under Discount
 * Codes), because that is what the checkout puts into its discount field. The
 * landing page reads its percentage back from /api/landing/<slug>, so what is
 * set here is what the page prints and what checkout takes off.
 */
export default function LandingPageModal({
  existing,
  onClose,
  onSaved,
}: {
  existing: AdminLandingPage | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? '');
  const [slug, setSlug] = useState(existing?.slug ?? '');
  const [domain, setDomain] = useState(existing?.domain ?? '');
  const [destination, setDestination] = useState(existing?.destination_path ?? '/products');
  const [active, setActive] = useState(existing?.active ?? true);
  const [notes, setNotes] = useState(existing?.notes ?? '');

  const [hasOffer, setHasOffer] = useState(existing ? !!existing.code : true);
  const [percent, setPercent] = useState(existing?.code ? String(existing.code.percent) : '35');
  const [code, setCode] = useState(existing?.code?.code ?? '');
  const [codeTouched, setCodeTouched] = useState(!!existing?.code);
  const [firstOrderOnly, setFirstOrderOnly] = useState(existing?.code?.first_order_only ?? true);
  const [excludedIds, setExcludedIds] = useState<string[]>(existing?.code?.excluded_product_ids ?? []);
  const [startsAt, setStartsAt] = useState(toLocalInput(existing?.code?.starts_at));
  const [expiresAt, setExpiresAt] = useState(toLocalInput(existing?.code?.expires_at));
  const [maxUses, setMaxUses] = useState(existing?.code?.max_uses ? String(existing.code.max_uses) : '');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Until the admin types a code of their own, it follows the slug and the
  // percentage: "standards" at 35% → STANDARDS35.
  const shownCode = codeTouched ? code : suggestLandingCode(slug || 'welcome', Number(percent));
  const slugChanged = !!existing && normalizeLandingSlug(slug) !== existing.slug;

  const save = async () => {
    setSaving(true);
    setError(null);
    const body = {
      name,
      slug,
      domain,
      destination_path: destination,
      active,
      notes,
      offer: hasOffer
        ? {
            code: shownCode,
            percent,
            first_order_only: firstOrderOnly,
            excluded_product_ids: excludedIds,
            starts_at: startsAt ? new Date(startsAt).toISOString() : null,
            expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
            max_uses: maxUses === '' ? null : maxUses,
          }
        : null,
    };
    const res = existing
      ? await adminFetch(`/api/admin/landing-pages/${existing.id}`, { method: 'PATCH', body })
      : await adminFetch('/api/admin/landing-pages', { method: 'POST', body });
    setSaving(false);
    if (!res.ok) {
      setError(res.data.error ?? 'Could not save the landing page.');
      return;
    }
    onSaved();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-bold text-ink">{existing ? 'Edit landing page' : 'New landing page'}</h3>
          <button onClick={onClose} aria-label="Close">
            <X className="h-4 w-4 text-ink-muted" />
          </button>
        </div>

        {error && (
          <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
        )}

        <div className="space-y-4">
          <div>
            <label className={labelCls} htmlFor="lp-name">Name</label>
            <input
              id="lp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Meta — first order 35%"
              className={inputCls}
              autoFocus
            />
            <p className={hintCls}>Internal only.</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} htmlFor="lp-slug">Slug</label>
              <input
                id="lp-slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                maxLength={40}
                placeholder="standards"
                className={`${inputCls} font-mono`}
              />
              <p className={hintCls}>
                Rides on the button link as <span className="font-mono">?lp={slug || 'slug'}</span>.
              </p>
            </div>
            <div>
              <label className={labelCls} htmlFor="lp-domain">Landing domain</label>
              <input
                id="lp-domain"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="getvyta.ca"
                className={inputCls}
              />
              <p className={hintCls}>Where the page is hosted. For reference.</p>
            </div>
          </div>
          {slugChanged && (
            <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Changing the slug breaks the live landing page until its config is updated to the new one,
              and visitors already holding the old one lose the offer.
            </p>
          )}

          <div>
            <label className={labelCls} htmlFor="lp-dest">Button goes to</label>
            <input
              id="lp-dest"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              placeholder="/products"
              className={`${inputCls} font-mono`}
            />
            <p className={hintCls}>A path on vytabio.com — usually the catalogue.</p>
          </div>

          <div className="rounded-xl border border-line p-4">
            <label className="flex items-center gap-2 text-sm font-medium text-ink">
              <input
                type="checkbox"
                checked={hasOffer}
                onChange={(e) => setHasOffer(e.target.checked)}
                className="accent-teal"
              />
              This landing page offers a discount
            </label>

            {hasOffer ? (
              <div className="mt-4 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelCls} htmlFor="lp-percent">Percent off</label>
                    <input
                      id="lp-percent"
                      type="number"
                      min="1"
                      max="99"
                      step="0.5"
                      value={percent}
                      onChange={(e) => setPercent(e.target.value)}
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className={labelCls} htmlFor="lp-code">Discount code</label>
                    <input
                      id="lp-code"
                      value={shownCode}
                      onChange={(e) => {
                        setCodeTouched(true);
                        setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''));
                      }}
                      maxLength={32}
                      className={`${inputCls} font-mono uppercase`}
                    />
                  </div>
                </div>
                <p className={hintCls}>
                  The landing page prints this percentage, and checkout puts this code into the discount field
                  for everyone who arrives from it. Change it here and the page follows on its next load.
                </p>

                <CodeRestrictionsFields
                  firstOrderOnly={firstOrderOnly}
                  onFirstOrderOnly={setFirstOrderOnly}
                  excludedIds={excludedIds}
                  onExcludedIds={setExcludedIds}
                  suggestBacWater
                />

                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className={labelCls} htmlFor="lp-start">Starts</label>
                    <input
                      id="lp-start"
                      type="datetime-local"
                      value={startsAt}
                      onChange={(e) => setStartsAt(e.target.value)}
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className={labelCls} htmlFor="lp-end">Ends</label>
                    <input
                      id="lp-end"
                      type="datetime-local"
                      value={expiresAt}
                      onChange={(e) => setExpiresAt(e.target.value)}
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className={labelCls} htmlFor="lp-max">Usage limit</label>
                    <input
                      id="lp-max"
                      type="number"
                      min="1"
                      step="1"
                      value={maxUses}
                      onChange={(e) => setMaxUses(e.target.value)}
                      placeholder="Unlimited"
                      className={inputCls}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <p className="mt-2 text-xs text-ink-muted">
                Visitors are still recorded as coming from this page. The landing page is told there is no
                offer and should hide its percentage.
              </p>
            )}
          </div>

          <div>
            <label className={labelCls} htmlFor="lp-notes">Internal notes</label>
            <textarea
              id="lp-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="e.g. Meta prospecting, Oct 2026"
              className={inputCls}
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="accent-teal"
            />
            Active — switch off to stop the offer everywhere at once
          </label>
        </div>

        <div className="mt-5 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 rounded-lg bg-surface px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-line"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !name.trim() || slug.length < 2}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-ink/90 disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {existing ? 'Save changes' : 'Create landing page'}
          </button>
        </div>
      </div>
    </div>
  );
}
