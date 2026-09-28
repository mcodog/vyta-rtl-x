'use client';

import React, { useEffect, useState } from 'react';
import { Loader2, Shuffle, X } from 'lucide-react';
import {
  adminFetch,
  loadAffiliateOptions,
  type AdminDiscountCode,
  type AffiliateOption,
} from './api';
import CodeRestrictionsFields from './CodeRestrictionsFields';

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomCode(prefix = ''): string {
  let out = prefix;
  for (let i = 0; i < 6; i++) out += CHARS.charAt(Math.floor(Math.random() * CHARS.length));
  return out;
}

/** ISO → the value a `datetime-local` input wants, in local time. */
function toLocalInput(iso: string | null): string {
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
 * Create or edit a discount code. When `fixedAffiliate` is given (opened from
 * an affiliate's profile) the code is assigned to them and the picker hidden.
 */
export default function DiscountCodeModal({
  existing,
  fixedAffiliate,
  onClose,
  onSaved,
}: {
  existing?: AdminDiscountCode | null;
  fixedAffiliate?: { id: string; name: string } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [affiliates, setAffiliates] = useState<AffiliateOption[]>([]);
  const [code, setCode] = useState(existing?.code ?? '');
  const [affiliateId, setAffiliateId] = useState(fixedAffiliate?.id ?? existing?.affiliate_id ?? '');
  const [discountType, setDiscountType] = useState<'percent' | 'fixed'>(existing?.discount_type ?? 'percent');
  const [discountValue, setDiscountValue] = useState(existing ? String(existing.discount_value) : '10');
  const [commissionRate, setCommissionRate] = useState(
    existing?.commission_rate != null ? String(existing.commission_rate) : '',
  );
  const [minSubtotal, setMinSubtotal] = useState(existing?.min_subtotal ? String(existing.min_subtotal) : '');
  const [maxUses, setMaxUses] = useState(existing?.max_uses ? String(existing.max_uses) : '');
  const [startsAt, setStartsAt] = useState(toLocalInput(existing?.starts_at ?? null));
  const [expiresAt, setExpiresAt] = useState(toLocalInput(existing?.expires_at ?? null));
  const [active, setActive] = useState(existing?.active ?? true);
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [firstOrderOnly, setFirstOrderOnly] = useState(!!existing?.first_order_only);
  const [excludedIds, setExcludedIds] = useState<string[]>(existing?.excluded_product_ids ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!fixedAffiliate) loadAffiliateOptions().then(setAffiliates);
  }, [fixedAffiliate]);

  const save = async () => {
    setSaving(true);
    setError(null);
    const body = {
      code,
      affiliate_id: affiliateId || null,
      discount_type: discountType,
      discount_value: discountValue,
      commission_rate: commissionRate === '' ? null : commissionRate,
      min_subtotal: minSubtotal === '' ? null : minSubtotal,
      max_uses: maxUses === '' ? null : maxUses,
      starts_at: startsAt ? new Date(startsAt).toISOString() : null,
      expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
      active,
      notes,
      first_order_only: firstOrderOnly,
      excluded_product_ids: excludedIds,
    };
    const res = existing
      ? await adminFetch(`/api/admin/discount-codes/${existing.id}`, { method: 'PATCH', body })
      : await adminFetch('/api/admin/discount-codes', { method: 'POST', body });
    setSaving(false);
    if (!res.ok) {
      setError(res.data.error ?? 'Could not save the code.');
      return;
    }
    onSaved();
  };

  const selectedAffiliate = affiliates.find((a) => a.id === affiliateId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-bold text-ink">{existing ? 'Edit discount code' : 'New discount code'}</h3>
          <button onClick={onClose} aria-label="Close">
            <X className="h-4 w-4 text-ink-muted" />
          </button>
        </div>

        {error && (
          <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
        )}

        <div className="space-y-4">
          <div>
            <label className={labelCls} htmlFor="dc-code">Code</label>
            <div className="flex gap-2">
              <input
                id="dc-code"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                maxLength={32}
                placeholder="SPRING20"
                className={`${inputCls} font-mono uppercase`}
                autoFocus
              />
              <button
                type="button"
                onClick={() => setCode(randomCode())}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 text-xs font-medium text-ink-muted hover:bg-surface"
              >
                <Shuffle className="h-3.5 w-3.5" /> Random
              </button>
            </div>
            <p className={hintCls}>Letters and numbers only. Buyers type it at checkout.</p>
          </div>

          <div>
            <label className={labelCls} htmlFor="dc-affiliate">Assigned affiliate</label>
            {fixedAffiliate ? (
              <p className="rounded-lg bg-surface px-3 py-2 text-sm text-ink">{fixedAffiliate.name}</p>
            ) : (
              <select
                id="dc-affiliate"
                value={affiliateId}
                onChange={(e) => setAffiliateId(e.target.value)}
                className={inputCls}
              >
                <option value="">None — store-wide promo code</option>
                {affiliates.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.email}){a.active ? '' : ' — inactive'}
                  </option>
                ))}
              </select>
            )}
            <p className={hintCls}>
              {affiliateId || fixedAffiliate
                ? `${fixedAffiliate?.name ?? selectedAffiliate?.name ?? 'The affiliate'} earns commission on every paid order that uses this code.`
                : 'No commission is paid; sales are still tracked against the code.'}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} htmlFor="dc-type">Discount type</label>
              <select
                id="dc-type"
                value={discountType}
                onChange={(e) => setDiscountType(e.target.value === 'fixed' ? 'fixed' : 'percent')}
                className={inputCls}
              >
                <option value="percent">Percent off</option>
                <option value="fixed">Fixed amount off</option>
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="dc-value">
                {discountType === 'fixed' ? 'Amount (CAD)' : 'Percent'}
              </label>
              <input
                id="dc-value"
                type="number"
                min="0"
                step="0.01"
                value={discountValue}
                onChange={(e) => setDiscountValue(e.target.value)}
                className={inputCls}
              />
            </div>
          </div>

          {(affiliateId || fixedAffiliate) && (
            <div>
              <label className={labelCls} htmlFor="dc-commission">Commission rate (%)</label>
              <input
                id="dc-commission"
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={commissionRate}
                onChange={(e) => setCommissionRate(e.target.value)}
                placeholder="Affiliate's default rate"
                className={inputCls}
              />
              <p className={hintCls}>
                Of the discounted goods subtotal (shipping and tax excluded). Leave blank to use the
                affiliate&apos;s own rate.
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} htmlFor="dc-min">Minimum order (CAD)</label>
              <input
                id="dc-min"
                type="number"
                min="0"
                step="0.01"
                value={minSubtotal}
                onChange={(e) => setMinSubtotal(e.target.value)}
                placeholder="None"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="dc-max">Usage limit</label>
              <input
                id="dc-max"
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

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} htmlFor="dc-start">Starts</label>
              <input
                id="dc-start"
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="dc-end">Ends</label>
              <input
                id="dc-end"
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className={inputCls}
              />
            </div>
          </div>

          {existing?.landing_page && (
            <p className="rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-xs text-teal-dark">
              This code is the offer for the <span className="font-mono">{existing.landing_page}</span>{' '}
              landing page, which displays its percentage. Changing it here changes what that page shows.
            </p>
          )}

          <CodeRestrictionsFields
            firstOrderOnly={firstOrderOnly}
            onFirstOrderOnly={setFirstOrderOnly}
            excludedIds={excludedIds}
            onExcludedIds={setExcludedIds}
            suggestBacWater
          />

          <div>
            <label className={labelCls} htmlFor="dc-notes">Internal notes</label>
            <textarea
              id="dc-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="e.g. Podcast sponsorship, Oct 2026"
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
            Active
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
            disabled={saving || code.length < 3}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-ink/90 disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {existing ? 'Save changes' : 'Create code'}
          </button>
        </div>
      </div>
    </div>
  );
}
