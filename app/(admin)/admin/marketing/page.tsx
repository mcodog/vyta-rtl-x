'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  Megaphone, Image as ImageIcon, BarChart3, ShieldCheck, Upload, Save,
  AlertCircle, Check, X, Loader2, Info, Monitor,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { apiFetch } from '@/lib/api-fetch';
import { usePermissions } from '@/lib/hooks/usePermissions';
import { DEFAULT_SITE_CONFIG, type SiteConfig } from '@/lib/site-config';

export default function MarketingManagementPage() {
  const { canManageMarketing } = usePermissions();
  const canManage = canManageMarketing;

  const [form, setForm] = useState<SiteConfig>(DEFAULT_SITE_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getToken = async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? '';
  };

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const token = await getToken();
      const { config } = await apiFetch<{ config: SiteConfig }>('/api/admin/marketing', {
        headers: { Authorization: `Bearer ${token}` },
      });
      setForm(config);
    } catch {
      setError('Failed to load marketing settings');
    }
    setLoading(false);
  };

  const set = <K extends keyof SiteConfig>(key: K, value: SiteConfig[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const save = async () => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const token = await getToken();
      const { config } = await apiFetch<{ config: SiteConfig }>('/api/admin/marketing', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          store_name: form.store_name,
          store_tagline: form.store_tagline,
          logo_url: form.logo_url,
          favicon_url: form.favicon_url,
          hero_image_url: form.hero_image_url,
          gtm_container_id: form.gtm_container_id,
          ga4_measurement_id: form.ga4_measurement_id,
          meta_pixel_id: form.meta_pixel_id,
          tracking_consent_required: form.tracking_consent_required,
        }),
      });
      setForm(config);
      setSuccess('Marketing settings saved');
    } catch (err: any) {
      setError(err?.message || 'Failed to save marketing settings');
    }
    setSaving(false);
  };

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-ink flex items-center gap-2">
            <Megaphone className="w-6 h-6 text-teal-dark" />
            Branding &amp; Tracking
          </h1>
          <p className="text-ink-muted text-sm mt-1">
            Store branding plus analytics tags behind a GDPR consent banner.
          </p>
        </div>
        {canManage && (
          <button
            onClick={save}
            disabled={saving || loading}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-ink text-white rounded-lg text-sm font-semibold hover:bg-ink/90 transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save Changes
          </button>
        )}
      </div>

      {!canManage && (
        <div className="mb-6 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex items-center gap-2">
          <Info className="w-4 h-4 text-amber-600 flex-shrink-0" />
          <p className="text-xs text-amber-700">Read-only access. Contact an administrator to make changes.</p>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
          <p className="flex-1 text-sm text-red-800">{error}</p>
          <button onClick={() => setError('')} className="text-red-500 hover:text-red-700"><X className="w-4 h-4" /></button>
        </div>
      )}
      {success && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 mb-6 flex items-start gap-3">
          <Check className="w-5 h-5 text-emerald-500 flex-shrink-0 mt-0.5" />
          <p className="flex-1 text-sm text-emerald-800">{success}</p>
          <button onClick={() => setSuccess('')} className="text-emerald-500 hover:text-emerald-700"><X className="w-4 h-4" /></button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-ink-muted text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="max-w-3xl space-y-6">
          {/* Store branding */}
          <section className="bg-white rounded-xl border border-line p-5 sm:p-6">
            <div className="flex items-center gap-2 mb-4">
              <ImageIcon className="w-5 h-5 text-teal-dark" />
              <h2 className="text-base font-bold text-ink">Store branding</h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-sm font-medium text-ink mb-1.5">Store name</label>
                <input
                  type="text"
                  value={form.store_name}
                  disabled={!canManage}
                  onChange={(e) => set('store_name', e.target.value)}
                  className="w-full px-3 py-2 bg-surface border border-line rounded-lg text-sm text-ink focus:outline-none focus:ring-2 focus:ring-teal/40 disabled:opacity-60"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-ink mb-1.5">Tagline</label>
                <input
                  type="text"
                  value={form.store_tagline}
                  disabled={!canManage}
                  onChange={(e) => set('store_tagline', e.target.value)}
                  className="w-full px-3 py-2 bg-surface border border-line rounded-lg text-sm text-ink focus:outline-none focus:ring-2 focus:ring-teal/40 disabled:opacity-60"
                />
              </div>
            </div>
            <div className="space-y-4">
              <ImageField
                label="Logo"
                value={form.logo_url}
                disabled={!canManage}
                onChange={(url) => set('logo_url', url)}
                getToken={getToken}
                onError={setError}
              />
              <ImageField
                label="Favicon"
                value={form.favicon_url}
                disabled={!canManage}
                onChange={(url) => set('favicon_url', url)}
                getToken={getToken}
                onError={setError}
              />
            </div>
          </section>

          {/* Home-page hero */}
          <section className="bg-white rounded-xl border border-line p-5 sm:p-6">
            <div className="flex items-center gap-2 mb-1">
              <Monitor className="w-5 h-5 text-teal-dark" />
              <h2 className="text-base font-bold text-ink">Home-page hero</h2>
            </div>
            <p className="text-xs text-ink-muted mb-4">
              The background of the first screen visitors see, behind the frosted band the
              headline sits on, on laptops and desktops — a wide, landscape render works best.
              Phones and tablets use a portrait still shipped with the site. Leave this empty to
              use the shipped desktop image.
            </p>

            <div className="space-y-4">
              <ImageField
                label="Hero image"
                value={form.hero_image_url}
                disabled={!canManage}
                onChange={(url) => set('hero_image_url', url)}
                getToken={getToken}
                onError={setError}
              />
            </div>
          </section>

          {/* Tracking & consent */}
          <section className="bg-white rounded-xl border border-line p-5 sm:p-6">
            <div className="flex items-center gap-2 mb-4">
              <BarChart3 className="w-5 h-5 text-teal-dark" />
              <h2 className="text-base font-bold text-ink">Tracking &amp; consent</h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
              <div>
                <label className="block text-sm font-medium text-ink mb-1.5">GTM Container ID</label>
                <input
                  type="text"
                  value={form.gtm_container_id ?? ''}
                  disabled={!canManage}
                  placeholder="GTM-XXXXXXX"
                  onChange={(e) => set('gtm_container_id', e.target.value || null)}
                  className="w-full px-3 py-2 bg-surface border border-line rounded-lg text-sm text-ink font-mono focus:outline-none focus:ring-2 focus:ring-teal/40 disabled:opacity-60"
                />
                <p className="text-xs text-ink-muted mt-1.5">
                  Loads the container for Ads / remarketing tags. GA4 below runs
                  separately and directly — do not also add a GA4 tag inside the
                  container, or every hit is counted twice.
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-ink mb-1.5">GA4 Measurement ID</label>
                <input
                  type="text"
                  value={form.ga4_measurement_id ?? ''}
                  disabled={!canManage}
                  placeholder="G-XXXXXXXXXX"
                  onChange={(e) => set('ga4_measurement_id', e.target.value || null)}
                  className="w-full px-3 py-2 bg-surface border border-line rounded-lg text-sm text-ink font-mono focus:outline-none focus:ring-2 focus:ring-teal/40 disabled:opacity-60"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-ink mb-1.5">Meta Pixel ID</label>
                <input
                  type="text"
                  value={form.meta_pixel_id ?? ''}
                  disabled={!canManage}
                  placeholder="000000000000000"
                  onChange={(e) => set('meta_pixel_id', e.target.value || null)}
                  className="w-full px-3 py-2 bg-surface border border-line rounded-lg text-sm text-ink font-mono focus:outline-none focus:ring-2 focus:ring-teal/40 disabled:opacity-60"
                />
              </div>
            </div>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={form.tracking_consent_required}
                disabled={!canManage}
                onChange={(e) => set('tracking_consent_required', e.target.checked)}
                className="mt-0.5 w-4 h-4 text-teal-dark border-line rounded focus:ring-teal/40"
              />
              <span>
                <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                  <ShieldCheck className="w-4 h-4 text-emerald-500" />
                  Require cookie consent (GDPR)
                </span>
                <span className="block text-xs text-ink-muted mt-0.5">
                  When on, GA4 and the Meta Pixel do not load until the visitor accepts the
                  consent banner. Turn off to load tracking immediately.
                </span>
              </span>
            </label>
          </section>
        </div>
      )}
    </>
  );
}

function ImageField({
  label, value, disabled, onChange, getToken, onError,
}: {
  label: string;
  value: string | null;
  disabled: boolean;
  onChange: (url: string | null) => void;
  getToken: () => Promise<string>;
  onError: (msg: string) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { onError('Please upload an image file'); return; }
    if (file.size > 20 * 1024 * 1024) { onError('Image must be less than 20MB'); return; }
    setUploading(true);
    try {
      const token = await getToken();
      const fd = new FormData();
      fd.append('file', file);
      const { url } = await apiFetch<{ url: string }>('/api/admin/products/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
        // Uploads run to 20MB; the 10s apiFetch default aborts them mid-flight.
        timeoutMs: 120_000,
      });
      onChange(url);
    } catch (err: any) {
      onError(err?.message || 'Failed to upload image');
    }
    if (inputRef.current) inputRef.current.value = '';
    setUploading(false);
  };

  return (
    <div>
      <label className="block text-sm font-medium text-ink mb-1.5">{label}</label>
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-lg bg-surface border border-line flex items-center justify-center overflow-hidden flex-shrink-0">
          {value ? (
            <img src={value} alt={label} className="w-full h-full object-contain" />
          ) : (
            <ImageIcon className="w-5 h-5 text-ink-muted" />
          )}
        </div>
        <input
          type="text"
          value={value ?? ''}
          disabled={disabled}
          placeholder="https://…"
          onChange={(e) => onChange(e.target.value || null)}
          className="flex-1 px-3 py-2 bg-surface border border-line rounded-lg text-sm text-ink focus:outline-none focus:ring-2 focus:ring-teal/40 disabled:opacity-60"
        />
        {!disabled && (
          <>
            <input ref={inputRef} type="file" accept="image/*" onChange={upload} className="hidden" />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-surface border border-line text-ink rounded-lg text-sm font-medium hover:bg-line/40 transition-colors disabled:opacity-50 flex-shrink-0"
            >
              {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              Upload
            </button>
          </>
        )}
      </div>
    </div>
  );
}
