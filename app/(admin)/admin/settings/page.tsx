'use client';

import React, { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import {
  Settings as SettingsIcon, AlertCircle, AlertTriangle, Check, CreditCard, Send, Mail, Plus,
  Trash2, FileText, ChevronRight, MapPin, Users, ToggleRight, ToggleLeft,
  Truck, KeyRound, Bell, Clock, ShieldCheck, RefreshCw, Megaphone, Droplets,
  ShoppingCart, BadgeCheck, Copy, Webhook,
} from 'lucide-react';
import { supabase, type SiteSettings } from '@/lib/supabase';
import { useToast } from '@/contexts/ToastContext';
import { useUserRole } from '../layout';
import AddressAutocomplete, {
  type AddressSuggestion,
} from '@/components/AddressAutocomplete';
import ChangePasswordForm from '@/components/ChangePasswordForm';
import ToggleSwitch from '@/components/admin/ToggleSwitch';
import { DEFAULT_FLAT_SHIPPING } from '@/lib/payments/puramass-settings';
import { EASYSHIP_WEBHOOK_URL, EASYSHIP_WEBHOOK_EVENTS } from '@/lib/shipping/easyship-webhook';

const INPUT =
  'px-4 py-2.5 bg-surface rounded-lg border border-line text-sm text-ink ' +
  'placeholder-ink-muted focus:outline-none focus:ring-2 focus:ring-teal/40 ' +
  'disabled:opacity-50';

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type PuramassMapping = 'box' | 'vial';
interface PuramassSyncReport {
  source: string;
  catalog_count: number;
  partner_catalog_count: number;
  dry_run: boolean;
  vial_column_available: boolean;
  counts: { updated: number; skipped_already_set: number; ambiguous: number; unmatched: number };
  by_mapping: {
    box: { updated: number; skipped_already_set: number; ambiguous: number; unmatched: number };
    vial: { updated: number; skipped_already_set: number; ambiguous: number; unmatched: number };
  };
  updated: { id: string; name: string; mapping: PuramassMapping; sku: string }[];
  skipped_already_set: { id: string; name: string; mapping: PuramassMapping; sku: string }[];
  ambiguous: { id: string; name: string; mapping: PuramassMapping; candidates: string[] }[];
  unmatched: { id: string; name: string; mapping: PuramassMapping }[];
}

interface KlaviyoTestResult {
  ok: boolean;
  has_private_key?: boolean;
  key_source?: 'typed' | 'db' | 'env' | null;
  account?: {
    id: string;
    organization_name: string | null;
    public_api_key: string | null;
    default_sender_email: string | null;
    timezone: string | null;
    preferred_currency: string | null;
  } | null;
  lists?: { id: string; name: string }[];
  errors?: string[];
  warnings?: string[];
  test_event?: { sent: boolean; email?: string; error?: string } | null;
}

interface PuramassCleanupReport {
  dry_run: boolean;
  vial_column_available: boolean;
  cleared_products: number;
  cleared_box: number;
  cleared_vial: number;
  cleared_values: number;
  products: string[];
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

export default function SettingsPage() {
  const userRole = useUserRole();
  const isReadOnly = userRole === 'assistant';
  const toast = useToast();

  const [settings, setSettings] = useState<SiteSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [newEmail, setNewEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [newInvoiceCc, setNewInvoiceCc] = useState('');
  const [invoiceCcError, setInvoiceCcError] = useState<string | null>(null);

  const [abandonedHoursInput, setAbandonedHoursInput] = useState('12');
  const [abandonedCheckoutHoursInput, setAbandonedCheckoutHoursInput] = useState('1');
  const [pickupAddressInput, setPickupAddressInput] = useState('');
  const [easyshipApiKeyInput, setEasyshipApiKeyInput] = useState('');
  const [puramassFlatShippingInput, setPuramassFlatShippingInput] = useState('');
  const [klaviyoKeyInput, setKlaviyoKeyInput] = useState('');
  const [klForm, setKlForm] = useState({ public_key: '', list_id: '' });
  const [klTestEmail, setKlTestEmail] = useState('');
  const [klTest, setKlTest] = useState<KlaviyoTestResult | null>(null);
  const [klTesting, setKlTesting] = useState(false);
  const [klSyncing, setKlSyncing] = useState(false);
  const [diag, setDiag] = useState<Record<string, any> | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [puramassSyncing, setPuramassSyncing] = useState(false);
  const [puramassReport, setPuramassReport] = useState<PuramassSyncReport | null>(null);
  const [puramassCleaning, setPuramassCleaning] = useState(false);
  const [puramassCleanup, setPuramassCleanup] = useState<PuramassCleanupReport | null>(null);
  const [shipForm, setShipForm] = useState({
    line_1: '', city: '', state: '', postal_code: '', country_alpha2: '',
    company: '', phone: '', email: '',
    length: '', width: '', height: '',
    shipping_item_weight_kg: '', shipping_flat_rate: '',
    handling_fee_type: 'flat' as 'flat' | 'pct', handling_fee_value: '',
  });

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/settings', { cache: 'no-store' });
      const json = await res.json();
      const s: SiteSettings = json.settings;
      setSettings(s);
      setPickupAddressInput(s.pickup_address ?? '');
      setAbandonedHoursInput(String(s.abandoned_registration_hours ?? 12));
      setAbandonedCheckoutHoursInput(String(s.abandoned_checkout_hours ?? 1));
      setPuramassFlatShippingInput(
        String(s.puramass_flat_shipping ?? DEFAULT_FLAT_SHIPPING),
      );
      setKlForm({
        public_key: s.klaviyo_public_key ?? '',
        list_id: s.klaviyo_list_id ?? '',
      });
      setShipForm({
        line_1: s.shipping_origin?.line_1 ?? '',
        city: s.shipping_origin?.city ?? '',
        state: s.shipping_origin?.state ?? '',
        postal_code: s.shipping_origin?.postal_code ?? '',
        country_alpha2: s.shipping_origin?.country_alpha2 ?? '',
        company: s.shipping_origin?.company ?? '',
        phone: s.shipping_origin?.phone ?? '',
        email: s.shipping_origin?.email ?? '',
        length: s.shipping_box?.length != null ? String(s.shipping_box.length) : '',
        width: s.shipping_box?.width != null ? String(s.shipping_box.width) : '',
        height: s.shipping_box?.height != null ? String(s.shipping_box.height) : '',
        shipping_item_weight_kg: String(s.shipping_item_weight_kg ?? ''),
        shipping_flat_rate: String(s.shipping_flat_rate ?? ''),
        handling_fee_type: s.shipping_handling_fee_type === 'pct' ? 'pct' : 'flat',
        handling_fee_value:
          s.shipping_handling_fee_value != null ? String(s.shipping_handling_fee_value) : '',
      });
    } catch {
      toast.error('Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  const saveSettings = useCallback(async (updates: Record<string, any>) => {
    setSaving(true);
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify(updates),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Save failed');
      setSettings(json.settings);
      toast.success('Settings saved');
      return json.settings as SiteSettings;
    } catch (e: any) {
      toast.error(e.message ?? 'Save failed');
      return null;
    } finally {
      setSaving(false);
    }
  }, [toast]);

  // ---- handlers ----
  const handleCheckoutTypeChange = (type: 'email' | 'crypto') => {
    if (isReadOnly || !settings) return;
    setSettings({ ...settings, checkout_type: type });
    saveSettings({ checkout_type: type });
  };

  const handleGuestCheckoutToggle = (enabled: boolean) => {
    if (isReadOnly || !settings) return;
    setSettings({ ...settings, guest_checkout_enabled: enabled });
    saveSettings({ guest_checkout_enabled: enabled });
  };

  // Show/hide switches for the optional sections on the product, cart and
  // checkout pages.
  // cart_similar_enabled is the same switch as Promotions → Cart suggestions.
  const handleSectionToggle = (
    key:
      | 'product_trust_badges_enabled'
      | 'product_reviews_enabled'
      | 'product_specs_enabled'
      | 'product_benefits_enabled'
      | 'product_certifications_enabled'
      | 'product_cta_badges_enabled'
      | 'cart_trust_strip_enabled'
      | 'cart_similar_enabled'
      | 'checkout_addons_enabled'
      | 'checkout_verify_notice_enabled',
    enabled: boolean,
  ) => {
    if (isReadOnly || !settings) return;
    setSettings({ ...settings, [key]: enabled });
    saveSettings({ [key]: enabled });
  };

  const handleEasyshipToggle = (enabled: boolean) => {
    if (isReadOnly || !settings) return;
    setSettings({ ...settings, easyship_enabled: enabled });
    saveSettings({ easyship_enabled: enabled });
  };

  const handleSavePuramassFlatShipping = () => {
    if (isReadOnly) return;
    const amount = Number(puramassFlatShippingInput);
    if (!Number.isFinite(amount) || amount < 0) {
      toast.error('Enter a shipping fee of zero or more.');
      return;
    }
    saveSettings({ puramass_flat_shipping: amount });
  };

  const handlePuramassShippingToggle = (enabled: boolean) => {
    if (isReadOnly || !settings) return;
    setSettings({ ...settings, puramass_shipping_rates_enabled: enabled });
    saveSettings({ puramass_shipping_rates_enabled: enabled });
  };

  const runSyncSkus = useCallback(async () => {
    setPuramassSyncing(true);
    setPuramassReport(null);
    try {
      const res = await fetch('/api/admin/puramass/sync-skus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Sync failed');
      setPuramassReport(json as PuramassSyncReport);
      toast.success(
        `Synced — ${json.counts.updated} mapped, ${json.counts.ambiguous} to review`,
      );
    } catch (e: any) {
      toast.error(e.message ?? 'Sync failed');
    } finally {
      setPuramassSyncing(false);
    }
  }, [toast]);

  const runCleanupSkus = useCallback(async () => {
    if (
      !window.confirm(
        'Clear all Stealth Health SKU mappings whose value is not prefixed "vyta-"? You can re-run Sync afterward.',
      )
    ) {
      return;
    }
    setPuramassCleaning(true);
    setPuramassCleanup(null);
    try {
      const res = await fetch('/api/admin/puramass/cleanup-skus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Cleanup failed');
      setPuramassCleanup(json as PuramassCleanupReport);
      toast.success(
        `Cleared ${json.cleared_values} mapping${json.cleared_values === 1 ? '' : 's'} on ${json.cleared_products} product${json.cleared_products === 1 ? '' : 's'}`,
      );
    } catch (e: any) {
      toast.error(e.message ?? 'Cleanup failed');
    } finally {
      setPuramassCleaning(false);
    }
  }, [toast]);

  const handleRegistrationAlertToggle = (enabled: boolean) => {
    if (isReadOnly || !settings) return;
    setSettings({ ...settings, registration_alert_enabled: enabled });
    saveSettings({ registration_alert_enabled: enabled });
  };

  const handleAbandonedToggle = (enabled: boolean) => {
    if (isReadOnly || !settings) return;
    setSettings({ ...settings, abandoned_registration_enabled: enabled });
    saveSettings({ abandoned_registration_enabled: enabled });
  };

  const handleSaveAbandonedHours = () => {
    if (isReadOnly) return;
    const n = Math.floor(Number(abandonedHoursInput));
    if (!Number.isFinite(n) || n < 1) {
      toast.error('Enter a whole number of hours (at least 1)');
      return;
    }
    saveSettings({ abandoned_registration_hours: n });
  };

  const handleSaveAbandonedCheckoutHours = () => {
    if (isReadOnly) return;
    const n = Math.floor(Number(abandonedCheckoutHoursInput));
    if (!Number.isFinite(n) || n < 1 || n > 24 * 30) {
      toast.error('Enter a whole number of hours between 1 and 720');
      return;
    }
    saveSettings({ abandoned_checkout_hours: n });
  };

  const handleSavePickupAddress = () => {
    if (isReadOnly) return;
    saveSettings({ pickup_address: pickupAddressInput.trim() });
  };

  const handleSaveShipping = () => {
    if (isReadOnly) return;
    const payload: Record<string, any> = {
      shipping_origin: {
        line_1: shipForm.line_1, city: shipForm.city, state: shipForm.state,
        postal_code: shipForm.postal_code, country_alpha2: shipForm.country_alpha2,
        company: shipForm.company.trim(), phone: shipForm.phone.trim(),
        email: shipForm.email.trim(),
      },
      shipping_box: {
        length: Number(shipForm.length) || 0,
        width: Number(shipForm.width) || 0,
        height: Number(shipForm.height) || 0,
      },
      shipping_item_weight_kg: Number(shipForm.shipping_item_weight_kg) || 0,
      shipping_flat_rate: Number(shipForm.shipping_flat_rate) || 0,
      shipping_handling_fee_type: shipForm.handling_fee_type,
      shipping_handling_fee_value: Number(shipForm.handling_fee_value) || 0,
    };
    if (easyshipApiKeyInput.trim().length > 0) payload.easyship_api_key = easyshipApiKeyInput.trim();
    saveSettings(payload).then((s) => { if (s) setEasyshipApiKeyInput(''); });
  };

  const handleKlaviyoToggle = (
    key: 'klaviyo_enabled' | 'klaviyo_onsite_enabled' | 'klaviyo_server_events_enabled' | 'klaviyo_sync_signups',
    enabled: boolean,
  ) => {
    if (isReadOnly || !settings) return;
    setSettings({ ...settings, [key]: enabled });
    saveSettings({ [key]: enabled });
  };

  const handleSaveKlaviyo = () => {
    if (isReadOnly) return;
    const payload: Record<string, any> = {
      klaviyo_public_key: klForm.public_key.trim(),
      klaviyo_list_id: klForm.list_id.trim(),
    };
    if (klaviyoKeyInput.length > 0) payload.klaviyo_private_api_key = klaviyoKeyInput;
    saveSettings(payload).then((s) => { if (s) setKlaviyoKeyInput(''); });
  };

  const runKlaviyoTest = useCallback(async (withEvent: boolean) => {
    setKlTesting(true);
    try {
      const body: Record<string, string> = {};
      if (klaviyoKeyInput.trim()) body.private_api_key = klaviyoKeyInput.trim();
      if (withEvent) body.test_email = klTestEmail.trim();
      const res = await fetch('/api/admin/klaviyo/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Test failed');
      setKlTest(json as KlaviyoTestResult);
      // Fill the Site ID from the account when it hasn't been entered yet.
      const pub = json?.account?.public_api_key;
      if (pub) setKlForm((f) => (f.public_key ? f : { ...f, public_key: pub }));
    } catch (e: any) {
      setKlTest({ ok: false, errors: [e.message ?? 'Test failed'] });
    } finally {
      setKlTesting(false);
    }
  }, [klaviyoKeyInput, klTestEmail]);

  const runKlaviyoSync = useCallback(async () => {
    if (!window.confirm(
      'Subscribe every existing customer who gave marketing consent at signup to the selected Klaviyo list?',
    )) return;
    setKlSyncing(true);
    try {
      const res = await fetch('/api/admin/klaviyo/sync-customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Sync failed');
      toast.success(`Sent ${json.submitted} consenting customer${json.submitted === 1 ? '' : 's'} to Klaviyo`);
    } catch (e: any) {
      toast.error(e.message ?? 'Sync failed');
    } finally {
      setKlSyncing(false);
    }
  }, [toast]);

  const runDiagnose = useCallback(async () => {
    setDiagLoading(true);
    setDiag(null);
    try {
      const res = await fetch('/api/admin/shipping/diagnose', {
        cache: 'no-store',
        headers: await authHeaders(),
      });
      setDiag(await res.json());
    } catch {
      setDiag({ ok: false, errors: ['Diagnostics request failed'] });
    } finally {
      setDiagLoading(false);
    }
  }, []);

  const addEmail = () => {
    if (isReadOnly || !settings) return;
    const email = newEmail.trim();
    if (!emailRegex.test(email)) { setEmailError('Enter a valid email'); return; }
    if (settings.admin_emails.includes(email)) { setEmailError('Already added'); return; }
    const next = [...settings.admin_emails, email];
    setSettings({ ...settings, admin_emails: next });
    setNewEmail(''); setEmailError(null);
    saveSettings({ admin_emails: next });
  };

  const removeEmail = (email: string) => {
    if (isReadOnly || !settings) return;
    const next = settings.admin_emails.filter((e) => e !== email);
    setSettings({ ...settings, admin_emails: next });
    saveSettings({ admin_emails: next });
  };

  const addInvoiceCc = () => {
    if (isReadOnly || !settings) return;
    const email = newInvoiceCc.trim();
    if (!emailRegex.test(email)) { setInvoiceCcError('Enter a valid email'); return; }
    if (settings.invoice_cc_emails.includes(email)) { setInvoiceCcError('Already added'); return; }
    const next = [...settings.invoice_cc_emails, email];
    setSettings({ ...settings, invoice_cc_emails: next });
    setNewInvoiceCc(''); setInvoiceCcError(null);
    saveSettings({ invoice_cc_emails: next });
  };

  const removeInvoiceCc = (email: string) => {
    if (isReadOnly || !settings) return;
    const next = settings.invoice_cc_emails.filter((e) => e !== email);
    setSettings({ ...settings, invoice_cc_emails: next });
    saveSettings({ invoice_cc_emails: next });
  };

  if (loading || !settings) {
    return (
      <div className="text-center py-20 text-sm text-ink-muted">Loading settings…</div>
    );
  }

  return (
    <div className="max-w-4xl space-y-6">
      {/* 1. Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-teal/10 flex items-center justify-center">
          <SettingsIcon className="w-5 h-5 text-teal-dark" />
        </div>
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-ink">Site Settings</h1>
          <p className="text-sm text-ink-muted">Global configuration for checkout, notifications, and shipping.</p>
        </div>
      </div>

      {/* Status feedback is shown via toast notifications. */}

      {/* 2. Account security — personal to the signed-in user, so it is NOT
          gated by isReadOnly: assistants can still change their own password. */}
      <Card icon={<KeyRound className="w-4 h-4 text-teal-dark" />} title="Change Password"
        subtitle="Update the password for your admin account.">
        <div className="max-w-md">
          <ChangePasswordForm variant="admin" />
        </div>
      </Card>

      {/* 3. Checkout Type */}
      <Card icon={<CreditCard className="w-4 h-4 text-teal-dark" />} title="Checkout Type"
        subtitle="How customers pay at checkout.">
        <div className="grid sm:grid-cols-2 gap-3">
          <SelectCard
            selected={settings.checkout_type === 'email'} disabled={isReadOnly}
            onClick={() => handleCheckoutTypeChange('email')}
            icon={<Send className="w-5 h-5" />} title="Email Invoice"
            desc="Send an invoice; customer pays manually." />
          <SelectCard
            selected={settings.checkout_type === 'crypto'} disabled={isReadOnly}
            onClick={() => handleCheckoutTypeChange('crypto')}
            icon={<CreditCard className="w-5 h-5" />} title="Cryptocurrency"
            desc="Accept BTC / ETH / SOL on-chain." />
        </div>
      </Card>

      {/* 4. Admin Email Notifications */}
      <Card icon={<Mail className="w-4 h-4 text-teal-dark" />} title="Admin Email Notifications"
        subtitle="Recipients for operational alerts (orders, low stock).">
        <div className="flex gap-2">
          <input
            type="email" value={newEmail} disabled={isReadOnly}
            onChange={(e) => { setNewEmail(e.target.value); setEmailError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addEmail(); } }}
            placeholder="admin@example.com" className={`flex-1 ${INPUT}`} />
          <button onClick={addEmail} disabled={isReadOnly}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-ink text-white rounded-lg text-sm font-medium hover:bg-ink/90 disabled:opacity-50">
            <Plus className="w-4 h-4" /> Add
          </button>
        </div>
        {emailError && <p className="text-xs text-red-600 mt-2">{emailError}</p>}
        <EmailList items={settings.admin_emails} onRemove={removeEmail} disabled={isReadOnly} />
      </Card>

      {/* 4b. Registration Alerts */}
      <Card icon={<Bell className="w-4 h-4 text-teal-dark" />} title="Registration Alerts"
        subtitle="Email the admin recipients above when a customer registers, and again if they never check out.">
        <div className="space-y-5">
          <div>
            <p className="text-sm font-medium text-ink mb-2">On new registration</p>
            <div className="grid sm:grid-cols-2 gap-3">
              <SelectCard
                selected={settings.registration_alert_enabled} disabled={isReadOnly}
                onClick={() => handleRegistrationAlertToggle(true)}
                icon={<ToggleRight className="w-5 h-5" />} title="Enabled"
                desc="Send an alert the moment a customer signs up." />
              <SelectCard
                selected={!settings.registration_alert_enabled} disabled={isReadOnly}
                onClick={() => handleRegistrationAlertToggle(false)}
                icon={<ToggleLeft className="w-5 h-5" />} title="Disabled"
                desc="Don't send a registration alert." />
            </div>
          </div>

          <div>
            <p className="text-sm font-medium text-ink mb-2">Abandoned registration (no checkout)</p>
            <div className="grid sm:grid-cols-2 gap-3 mb-3">
              <SelectCard
                selected={settings.abandoned_registration_enabled} disabled={isReadOnly}
                onClick={() => handleAbandonedToggle(true)}
                icon={<ToggleRight className="w-5 h-5" />} title="Enabled"
                desc="Follow up if a customer doesn't check out in time." />
              <SelectCard
                selected={!settings.abandoned_registration_enabled} disabled={isReadOnly}
                onClick={() => handleAbandonedToggle(false)}
                icon={<ToggleLeft className="w-5 h-5" />} title="Disabled"
                desc="No follow-up alert." />
            </div>
            <label className="block text-xs font-medium text-ink-muted uppercase tracking-wider mb-1.5">
              Send follow-up after (hours)
            </label>
            <div className="flex gap-2 items-center">
              <div className="relative">
                <Clock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                <input
                  type="number" min={1} step={1} value={abandonedHoursInput}
                  disabled={isReadOnly || !settings.abandoned_registration_enabled}
                  onChange={(e) => setAbandonedHoursInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSaveAbandonedHours(); } }}
                  className={`w-32 pl-9 ${INPUT}`} />
              </div>
              <button onClick={handleSaveAbandonedHours}
                disabled={isReadOnly || saving || !settings.abandoned_registration_enabled}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-ink text-white rounded-lg text-sm font-medium hover:bg-ink/90 disabled:opacity-50">
                <Check className="w-4 h-4" /> Save
              </button>
              <span className="text-xs text-ink-muted">Default 12 hours</span>
            </div>
          </div>

          <div>
            <p className="text-sm font-medium text-ink mb-2">Abandoned checkout (started, never paid)</p>
            <p className="text-xs text-ink-muted mb-3">
              How long a hosted checkout sits unpaid before the Abandoned tab on{' '}
              <span className="font-medium text-ink">Stealth Health Orders</span> lists it as a cart worth
              chasing. Nothing is sent automatically — the tab is where an admin picks a cart and
              emails the payment link back, optionally with a promo code.
            </p>
            <label className="block text-xs font-medium text-ink-muted uppercase tracking-wider mb-1.5">
              Treat as abandoned after (hours)
            </label>
            <div className="flex gap-2 items-center">
              <div className="relative">
                <Clock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                <input
                  type="number" min={1} max={720} step={1} value={abandonedCheckoutHoursInput}
                  disabled={isReadOnly}
                  onChange={(e) => setAbandonedCheckoutHoursInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSaveAbandonedCheckoutHours(); } }}
                  className={`w-32 pl-9 ${INPUT}`} />
              </div>
              <button onClick={handleSaveAbandonedCheckoutHours}
                disabled={isReadOnly || saving}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-ink text-white rounded-lg text-sm font-medium hover:bg-ink/90 disabled:opacity-50">
                <Check className="w-4 h-4" /> Save
              </button>
              <span className="text-xs text-ink-muted">Default 1 hour</span>
            </div>
          </div>
        </div>
      </Card>

      {/* 5. Invoice Emails */}
      <Card icon={<FileText className="w-4 h-4 text-teal-dark" />} title="Invoice Emails"
        subtitle="BCC recipients and the editable invoice email templates.">
        <div className="flex gap-2">
          <input
            type="email" value={newInvoiceCc} disabled={isReadOnly}
            onChange={(e) => { setNewInvoiceCc(e.target.value); setInvoiceCcError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addInvoiceCc(); } }}
            placeholder="bcc@example.com" className={`flex-1 ${INPUT}`} />
          <button onClick={addInvoiceCc} disabled={isReadOnly}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-ink text-white rounded-lg text-sm font-medium hover:bg-ink/90 disabled:opacity-50">
            <Plus className="w-4 h-4" /> Add
          </button>
        </div>
        {invoiceCcError && <p className="text-xs text-red-600 mt-2">{invoiceCcError}</p>}
        <EmailList items={settings.invoice_cc_emails} onRemove={removeInvoiceCc} disabled={isReadOnly} />
        <Link href="/admin/settings/email-templates"
          className="mt-4 w-full flex items-center justify-between px-4 py-3 bg-ink text-white rounded-lg text-sm font-medium hover:bg-ink/90">
          <span className="inline-flex items-center gap-2"><FileText className="w-4 h-4" /> Edit invoice email templates</span>
          <ChevronRight className="w-4 h-4" />
        </Link>
      </Card>

      {/* 5b. Error Tracking */}
      <Card icon={<AlertTriangle className="w-4 h-4 text-teal-dark" />} title="Error Tracking"
        subtitle="Fallback log for background failures. Order emails now send after checkout completes, so this is where a failed send shows up.">
        <Link href="/admin/settings/error-log"
          className="w-full flex items-center justify-between px-4 py-3 bg-ink text-white rounded-lg text-sm font-medium hover:bg-ink/90">
          <span className="inline-flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> View error log (failed emails)</span>
          <ChevronRight className="w-4 h-4" />
        </Link>
      </Card>

      {/* 6. Pickup Address */}
      <Card icon={<MapPin className="w-4 h-4 text-teal-dark" />} title="Pickup Address"
        subtitle="Shown to customers who choose local pickup.">
        <div className="flex gap-2">
          <input
            type="text" value={pickupAddressInput} disabled={isReadOnly}
            onChange={(e) => setPickupAddressInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSavePickupAddress(); } }}
            placeholder="123 Main St, City, Province" className={`flex-1 ${INPUT}`} />
          <button onClick={handleSavePickupAddress} disabled={isReadOnly || saving}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-ink text-white rounded-lg text-sm font-medium hover:bg-ink/90 disabled:opacity-50">
            <Check className="w-4 h-4" /> Save
          </button>
        </div>
        {settings.pickup_address && (
          <p className="text-xs text-ink-muted mt-2">Current: {settings.pickup_address}</p>
        )}
      </Card>

      {/* 7. Guest Checkout */}
      <Card icon={<Users className="w-4 h-4 text-teal-dark" />} title="Guest Checkout"
        subtitle="Allow customers to check out without an account.">
        <div className="grid sm:grid-cols-2 gap-3">
          <SelectCard
            selected={settings.guest_checkout_enabled} disabled={isReadOnly}
            onClick={() => handleGuestCheckoutToggle(true)}
            icon={<ToggleRight className="w-5 h-5" />} title="Enabled"
            desc="Guests can place orders." />
          <SelectCard
            selected={!settings.guest_checkout_enabled} disabled={isReadOnly}
            onClick={() => handleGuestCheckoutToggle(false)}
            icon={<ToggleLeft className="w-5 h-5" />} title="Disabled"
            desc="Account required to check out." />
        </div>
      </Card>

      {/* 7a. Storefront Sections — show/hide the optional blocks */}
      <Card icon={<ShoppingCart className="w-4 h-4 text-teal-dark" />} title="Storefront Sections"
        subtitle="Show or hide the optional sections on the product, cart and checkout pages.">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted mb-2">Product page</p>
        <div className="space-y-3 mb-5">
          <ToggleSwitch
            checked={settings.product_trust_badges_enabled !== false} disabled={isReadOnly}
            onChange={(v) => handleSectionToggle('product_trust_badges_enabled', v)}
            icon={<ShieldCheck className="w-4 h-4" />}
            label="Trust badges"
            description={'"99% Purity", "GMP Certified", "COA Available" and "Ships from Canada" with their icons, under the product image.'} />
          <ToggleSwitch
            checked={settings.product_specs_enabled !== false} disabled={isReadOnly}
            onChange={(v) => handleSectionToggle('product_specs_enabled', v)}
            icon={<FileText className="w-4 h-4" />}
            label="Purity / Strength / Form"
            description="The three spec tiles under the product name." />
          <ToggleSwitch
            checked={settings.product_benefits_enabled !== false} disabled={isReadOnly}
            onChange={(v) => handleSectionToggle('product_benefits_enabled', v)}
            icon={<Check className="w-4 h-4" />}
            label="Key Research Benefits"
            description="The bulleted benefits list under the Add to Cart badges." />
          <ToggleSwitch
            checked={settings.product_cta_badges_enabled !== false} disabled={isReadOnly}
            onChange={(v) => handleSectionToggle('product_cta_badges_enabled', v)}
            icon={<BadgeCheck className="w-4 h-4" />}
            label="Add to Cart badges"
            description={'"99% Purity", "Third-Party Tested", "COA Available" and "Ships from Canada" with their icons, under the Add to Cart button.'} />
          <ToggleSwitch
            checked={settings.product_certifications_enabled !== false} disabled={isReadOnly}
            onChange={(v) => handleSectionToggle('product_certifications_enabled', v)}
            icon={<ShieldCheck className="w-4 h-4" />}
            label="Quality Certifications"
            description={'The dark panel lower on the page — 99%+ Purity, GMP Certified, ISO Compliant, COA Available and the "For Research Purposes Only" line.'} />
          <ToggleSwitch
            checked={settings.product_reviews_enabled !== false} disabled={isReadOnly}
            onChange={(v) => handleSectionToggle('product_reviews_enabled', v)}
            icon={<Users className="w-4 h-4" />}
            label="Customer reviews"
            description="The Customer Reviews section — ratings, the review list and the write-a-review form." />
        </div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted mb-2">Cart page</p>
        <div className="space-y-3 mb-5">
          <ToggleSwitch
            checked={settings.cart_trust_strip_enabled !== false} disabled={isReadOnly}
            onChange={(v) => handleSectionToggle('cart_trust_strip_enabled', v)}
            icon={<ShieldCheck className="w-4 h-4" />}
            label="Trust badges"
            description={'"Free, Fast & Discreet Shipping", "Secure Checkout" and "Carefully Packaged" with their icons, at the top of the cart.'} />
          <ToggleSwitch
            checked={settings.cart_similar_enabled !== false} disabled={isReadOnly}
            onChange={(v) => handleSectionToggle('cart_similar_enabled', v)}
            icon={<Megaphone className="w-4 h-4" />}
            label="You May Also Like"
            description="Suggested products under the cart items. Same switch as Promotions → Cart suggestions." />
        </div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted mb-2">Checkout page</p>
        <div className="space-y-3">
          <ToggleSwitch
            checked={settings.checkout_addons_enabled !== false} disabled={isReadOnly}
            onChange={(v) => handleSectionToggle('checkout_addons_enabled', v)}
            icon={<Droplets className="w-4 h-4" />}
            label="Checkout add-ons"
            description={'The "Complete your order" box — reconstitution help, the WhatsApp link and products flagged as checkout add-ons. Hidden, checkout shows contact and order summary only.'} />
          <ToggleSwitch
            checked={settings.checkout_verify_notice_enabled !== false} disabled={isReadOnly}
            onChange={(v) => handleSectionToggle('checkout_verify_notice_enabled', v)}
            icon={<AlertCircle className="w-4 h-4" />}
            label="Verification notice"
            description={'"A few quick questions first" — the note under the pay button explaining the checkout partner\'s confirmation questions.'} />
        </div>
      </Card>

      {/* 7b. Stealth Health Hosted Checkout */}
      <Card icon={<ShieldCheck className="w-4 h-4 text-teal-dark" />} title="Stealth Health Checkout"
        subtitle="Checkout hands the cart off to the Stealth Health hosted checkout. Pricing, shipping, and fulfilment are handled by Stealth Health.">
        {/* Credential status banner */}
        <div className={`mb-4 rounded-lg border px-4 py-3 text-sm flex items-center gap-2 ${
          settings.puramass_configured
            ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
            : 'bg-amber-50 border-amber-200 text-amber-800'
        }`}>
          {settings.puramass_configured ? <Check className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          <span>
            {settings.puramass_configured
              ? 'API key detected — hosted checkout can run.'
              : 'No API key detected. Set PURAMASS_API_KEY on the server — checkout cannot take orders without it.'}
          </span>
        </div>

        {/* Shipping rates on the hosted checkout */}
        <div className="mt-4 pt-4 border-t border-line">
          <p className="text-sm font-medium text-ink">Shipping</p>
          <p className="text-xs text-ink-muted mb-3">
            With live rates on, the checkout asks for the delivery address and offers the
            fastest UPS and Canada Post services for it — the buyer picks one and
            that amount is sent to Stealth Health as the shipping total. The{' '}
            <span className="font-medium text-ink">Processing fee</span> configured under
            Shipping &amp; Easyship is folded into every quoted price and never itemised
            for the buyer. Off, everyone pays the flat fee below and Stealth Health collects the
            address on its own page.
          </p>
          <div className="grid sm:grid-cols-2 gap-3">
            <SelectCard
              selected={settings.puramass_shipping_rates_enabled} disabled={isReadOnly}
              onClick={() => handlePuramassShippingToggle(true)}
              icon={<Truck className="w-5 h-5" />} title="Live courier rates"
              desc="Buyer enters their address and chooses a courier." />
            <SelectCard
              selected={!settings.puramass_shipping_rates_enabled} disabled={isReadOnly}
              onClick={() => handlePuramassShippingToggle(false)}
              icon={<ToggleLeft className="w-5 h-5" />} title="Flat fee"
              desc="One shipping price for every order." />
          </div>

          <div className="mt-3">
            <label className="block text-xs font-medium text-ink-muted uppercase tracking-wider mb-1.5">
              Flat shipping fee (CAD)
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="number" min="0" step="0.01" disabled={isReadOnly}
                value={puramassFlatShippingInput}
                onChange={(e) => setPuramassFlatShippingInput(e.target.value)}
                placeholder={String(DEFAULT_FLAT_SHIPPING)}
                className={`${INPUT} max-w-[12rem]`} />
              <button onClick={handleSavePuramassFlatShipping} disabled={isReadOnly || saving}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-surface border border-line text-ink rounded-lg text-sm font-medium hover:border-teal/40 disabled:opacity-50">
                <Check className="w-4 h-4" /> Save
              </button>
            </div>
            <p className="mt-1.5 text-xs text-ink-muted">
              Charged when live rates are off, and as the fallback whenever a courier quote
              can&apos;t be had. Also what the fulfillment invoice records for those orders.
            </p>
          </div>
          {settings.puramass_shipping_rates_enabled && !settings.easyship_enabled && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>
                Easyship live rates are switched off below, so buyers will still be quoted
                the flat fee. Turn Easyship on to offer real courier prices.
              </span>
            </div>
          )}
        </div>

        {/* SKU sync */}
        <div className="mt-4 pt-4 border-t border-line">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="text-sm font-medium text-ink">Product SKU mapping</p>
              <p className="text-xs text-ink-muted">Match your products to Stealth Health catalog SKUs by name + strength.</p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={runCleanupSkus} disabled={isReadOnly || puramassCleaning}
                title="Clear mappings whose SKU is not prefixed vyta-"
                className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-surface border border-line text-ink rounded-lg text-sm font-medium hover:border-teal/40 disabled:opacity-50">
                <Trash2 className={`w-4 h-4 ${puramassCleaning ? 'animate-pulse' : ''}`} />
                {puramassCleaning ? 'Cleaning…' : 'Clean up non-vyta SKUs'}
              </button>
              <button onClick={runSyncSkus} disabled={isReadOnly || puramassSyncing}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-ink text-white rounded-lg text-sm font-medium hover:bg-ink/90 disabled:opacity-50">
                <RefreshCw className={`w-4 h-4 ${puramassSyncing ? 'animate-spin' : ''}`} />
                {puramassSyncing ? 'Syncing…' : 'Sync SKUs from catalog'}
              </button>
            </div>
          </div>

          {puramassCleanup && (
            <div className="mt-3 rounded-lg border border-line bg-surface px-4 py-3 text-sm text-ink">
              Cleared <span className="font-semibold">{puramassCleanup.cleared_values}</span> mapping
              {puramassCleanup.cleared_values === 1 ? '' : 's'} (packs {puramassCleanup.cleared_box},
              vials {puramassCleanup.cleared_vial}) on{' '}
              <span className="font-semibold">{puramassCleanup.cleared_products}</span> product
              {puramassCleanup.cleared_products === 1 ? '' : 's'} not prefixed{' '}
              <span className="font-mono text-xs">vyta-</span>.
              {puramassCleanup.products.length > 0 && (
                <span className="block mt-1 text-xs text-ink-muted">
                  {puramassCleanup.products.join(', ')}
                </span>
              )}
            </div>
          )}

          {puramassReport && (
            <div className="mt-4 space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <ReportStat label="Mapped" value={puramassReport.counts.updated} tone="emerald" />
                <ReportStat label="Already set" value={puramassReport.counts.skipped_already_set} tone="muted" />
                <ReportStat label="Needs review" value={puramassReport.counts.ambiguous} tone="amber" />
                <ReportStat label="Unmatched" value={puramassReport.counts.unmatched} tone="muted" />
              </div>
              <p className="text-xs text-ink-muted">
                Catalog source: <span className="font-medium text-ink">{puramassReport.source}</span>{' '}
                ({puramassReport.partner_catalog_count} <span className="font-mono">vyta-</span> SKUs
                of {puramassReport.catalog_count} · packs {puramassReport.by_mapping.box.updated},
                vials {puramassReport.by_mapping.vial.updated} mapped)
              </p>
              {!puramassReport.vial_column_available && (
                <p className="text-xs text-amber-700">
                  Single-vial column not found — run the migration to enable vial SKU mapping.
                </p>
              )}
              {puramassReport.ambiguous.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-ink mb-1">Needs review — pick a SKU by hand:</p>
                  <ul className="space-y-1 text-xs text-ink-muted">
                    {puramassReport.ambiguous.map((a) => (
                      <li key={`${a.id}-${a.mapping}`}>
                        <span className="text-ink">{a.name}</span>{' '}
                        <span className="text-ink-light">({a.mapping === 'vial' ? 'vial' : 'pack'})</span>{' '}
                        → {a.candidates.join(', ')}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {puramassReport.unmatched.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-ink mb-1">Unmatched (no Stealth Health equivalent found):</p>
                  <p className="text-xs text-ink-muted">
                    {puramassReport.unmatched
                      .map((u) => `${u.name} (${u.mapping === 'vial' ? 'vial' : 'pack'})`)
                      .join(', ')}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* 8. Shipping (Easyship) */}
      <Card icon={<Truck className="w-4 h-4 text-teal-dark" />} title="Shipping (Easyship)"
        subtitle="Live-rate or flat-rate shipping via Easyship.">
        <div className="grid sm:grid-cols-2 gap-3 mb-4">
          <SelectCard
            selected={settings.easyship_enabled} disabled={isReadOnly}
            onClick={() => handleEasyshipToggle(true)}
            icon={<Truck className="w-5 h-5" />} title="Live rates"
            desc="Quote real carrier rates at checkout." />
          <SelectCard
            selected={!settings.easyship_enabled} disabled={isReadOnly}
            onClick={() => handleEasyshipToggle(false)}
            icon={<CreditCard className="w-5 h-5" />} title="Flat rate"
            desc="Charge a single flat shipping fee." />
        </div>

        {/* API token */}
        <div className="mb-4">
          <label className="flex items-center gap-2 text-xs font-medium text-ink-muted uppercase tracking-wider mb-1.5">
            <KeyRound className="w-3.5 h-3.5" /> Easyship API token
            <span className={settings.easyship_api_key_set ? 'text-emerald-600' : 'text-ink-muted'}>
              {settings.easyship_api_key_set ? '• configured' : '• not set'}
            </span>
          </label>
          <input
            type="password" value={easyshipApiKeyInput} disabled={isReadOnly}
            onChange={(e) => setEasyshipApiKeyInput(e.target.value)}
            placeholder={settings.easyship_api_key_set ? '•••••••• (leave blank to keep)' : 'Paste your Easyship API token'}
            className={`w-full ${INPUT}`} />
        </div>

        {/* Origin / warehouse */}
        <div className="mb-4">
          <p className="text-xs font-medium text-ink-muted uppercase tracking-wider mb-2">Origin / warehouse</p>
          {/* Same address autocomplete as checkout — picking a suggestion fills
              city, province (2-letter), postal code and country so Easyship
              rate/shipment calls have the fields they require. */}
          <div className="mb-2">
            <AddressAutocomplete
              value={shipForm.line_1}
              onChange={(next) => setShipForm((f) => ({ ...f, line_1: next }))}
              onPick={(s: AddressSuggestion) =>
                setShipForm((f) => ({
                  ...f,
                  line_1: s.address || f.line_1,
                  city: s.city || f.city,
                  state: s.state || f.state,
                  postal_code: s.postalCode || f.postal_code,
                  country_alpha2: s.country || f.country_alpha2 || 'CA',
                }))
              }
              placeholder="Start typing the warehouse street address…"
              name="origin_address"
              disabled={isReadOnly}
            />
          </div>
          <div className="grid grid-cols-2 gap-2 mb-2">
            <input type="text" value={shipForm.city} disabled={isReadOnly}
              onChange={(e) => setShipForm({ ...shipForm, city: e.target.value })}
              placeholder="City" className={`${INPUT}`} />
            <input type="text" value={shipForm.state} disabled={isReadOnly}
              onChange={(e) => setShipForm({ ...shipForm, state: e.target.value })}
              placeholder="State / Province" className={`${INPUT}`} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input type="text" value={shipForm.postal_code} disabled={isReadOnly}
              onChange={(e) => setShipForm({ ...shipForm, postal_code: e.target.value })}
              placeholder="Postal code" className={`${INPUT}`} />
            <input type="text" value={shipForm.country_alpha2} disabled={isReadOnly} maxLength={2}
              onChange={(e) => setShipForm({ ...shipForm, country_alpha2: e.target.value.toUpperCase() })}
              placeholder="Country (e.g. CA)" className={`${INPUT}`} />
          </div>
          {/* Sender contact — Easyship requires a company name, phone and email
              on the origin address for shipment creation. */}
          <input type="text" value={shipForm.company} disabled={isReadOnly}
            onChange={(e) => setShipForm({ ...shipForm, company: e.target.value })}
            placeholder="Sender / company name" className={`w-full ${INPUT} mt-2 mb-2`} />
          <div className="grid grid-cols-2 gap-2">
            <input type="tel" value={shipForm.phone} disabled={isReadOnly}
              onChange={(e) => setShipForm({ ...shipForm, phone: e.target.value })}
              placeholder="Sender phone" className={`${INPUT}`} />
            <input type="email" value={shipForm.email} disabled={isReadOnly}
              onChange={(e) => setShipForm({ ...shipForm, email: e.target.value })}
              placeholder="Sender email" className={`${INPUT}`} />
          </div>
        </div>

        {/* Default parcel & flat rate */}
        <div className="mb-4">
          <p className="text-xs font-medium text-ink-muted uppercase tracking-wider mb-2">Default parcel & flat rate</p>
          <div className="grid grid-cols-3 gap-2 mb-2">
            <input type="number" min="0" value={shipForm.length} disabled={isReadOnly}
              onChange={(e) => setShipForm({ ...shipForm, length: e.target.value })}
              placeholder="L (cm)" className={`${INPUT}`} />
            <input type="number" min="0" value={shipForm.width} disabled={isReadOnly}
              onChange={(e) => setShipForm({ ...shipForm, width: e.target.value })}
              placeholder="W (cm)" className={`${INPUT}`} />
            <input type="number" min="0" value={shipForm.height} disabled={isReadOnly}
              onChange={(e) => setShipForm({ ...shipForm, height: e.target.value })}
              placeholder="H (cm)" className={`${INPUT}`} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input type="number" min="0" step="0.01" value={shipForm.shipping_item_weight_kg} disabled={isReadOnly}
              onChange={(e) => setShipForm({ ...shipForm, shipping_item_weight_kg: e.target.value })}
              placeholder="Per-vial weight (kg)" className={`${INPUT}`} />
            <input type="number" min="0" step="0.01" value={shipForm.shipping_flat_rate} disabled={isReadOnly}
              onChange={(e) => setShipForm({ ...shipForm, shipping_flat_rate: e.target.value })}
              placeholder="Flat rate ($)" className={`${INPUT}`} />
          </div>
        </div>

        {/* Processing fee */}
        <div className="mb-4">
          <p className="text-xs font-medium text-ink-muted uppercase tracking-wider mb-1">Processing fee</p>
          <p className="text-xs text-ink-muted mb-2">
            Added on top of the live carrier rate to form the shipping total. Baked
            into the quoted shipping price — never shown to customers as a separate line.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <select
              value={shipForm.handling_fee_type} disabled={isReadOnly}
              onChange={(e) => setShipForm({ ...shipForm, handling_fee_type: e.target.value as 'flat' | 'pct' })}
              className={`${INPUT}`}>
              <option value="flat">Fixed amount ($)</option>
              <option value="pct">Percentage (%)</option>
            </select>
            <input
              type="number" min="0" step="0.01" value={shipForm.handling_fee_value} disabled={isReadOnly}
              onChange={(e) => setShipForm({ ...shipForm, handling_fee_value: e.target.value })}
              placeholder={shipForm.handling_fee_type === 'pct' ? '% of rate (e.g. 10)' : 'Amount ($)'}
              className={`${INPUT}`} />
          </div>
        </div>

        {/* Webhook — the URL registered in Easyship. Fixed; nothing to save. */}
        <div className="mb-4 rounded-lg border border-line bg-surface p-3">
          <p className="text-xs font-medium text-ink-muted uppercase tracking-wider mb-1 flex items-center gap-1.5">
            <Webhook className="w-3.5 h-3.5" /> Easyship webhook
          </p>
          <p className="text-xs text-ink-muted mb-2">
            Registered in Easyship → Connect → Webhooks. Label and tracking events update
            the order and invoice and send the shipped email. The webhook&apos;s secret key
            goes in the server&apos;s <span className="font-mono">EASYSHIP_WEBHOOK_SECRET</span>.
          </p>
          <div className="flex items-center gap-2">
            <input type="text" readOnly value={EASYSHIP_WEBHOOK_URL}
              onFocus={(e) => e.currentTarget.select()}
              className={`flex-1 font-mono text-xs ${INPUT}`} />
            <button type="button"
              onClick={() => {
                navigator.clipboard?.writeText(EASYSHIP_WEBHOOK_URL).then(
                  () => toast.success('Webhook URL copied'),
                  () => {},
                );
              }}
              className="inline-flex items-center gap-1 px-3 py-2 bg-white border border-line rounded-lg text-xs text-ink hover:border-teal/40">
              <Copy className="w-3.5 h-3.5" /> Copy
            </button>
          </div>
          <details className="mt-2">
            <summary className="text-xs text-ink-muted cursor-pointer">
              Subscribed events ({EASYSHIP_WEBHOOK_EVENTS.length})
            </summary>
            <ul className="mt-1 grid sm:grid-cols-2 gap-x-4 font-mono text-[11px] text-ink-muted">
              {EASYSHIP_WEBHOOK_EVENTS.map((e) => <li key={e}>{e}</li>)}
            </ul>
          </details>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button onClick={handleSaveShipping} disabled={isReadOnly || saving}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-ink text-white rounded-lg text-sm font-medium hover:bg-ink/90 disabled:opacity-50">
            <Check className="w-4 h-4" /> Save shipping settings
          </button>
          <button onClick={runDiagnose} disabled={diagLoading}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-surface border border-line text-ink rounded-lg text-sm font-medium hover:border-teal/40 disabled:opacity-50">
            <Truck className="w-4 h-4" /> {diagLoading ? 'Testing…' : 'Test connection'}
          </button>
        </div>

        {/* Diagnostics result */}
        {diag && (
          <div className={`mt-4 rounded-lg border p-4 text-sm ${
            diag.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    : 'bg-amber-50 border-amber-200 text-amber-800'
          }`}>
            <p className="font-semibold mb-2 flex items-center gap-2">
              {diag.ok ? <Check className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
              {diag.ok ? 'EasyShip is configured and reachable' : 'EasyShip is not fully working'}
            </p>
            <ul className="space-y-1 text-xs">
              <DiagRow label="Base URL" value={diag.base_url} />
              <DiagRow label="DB read" ok={diag.db_read_ok} />
              <DiagRow label="Settings row present" ok={diag.settings_row_present} />
              <DiagRow label="EasyShip columns present" ok={diag.easyship_columns_present} />
              <DiagRow label="Live rates enabled" ok={diag.enabled} />
              <DiagRow label="API token set" ok={diag.has_api_key} />
              <DiagRow label="Origin address complete" ok={diag.origin_complete} />
              <DiagRow label="EasyShip reachable" ok={diag.reachable} />
              <DiagRow label="Webhook secret set" ok={diag.webhook_secret_set} />
            </ul>
            {Array.isArray(diag.errors) && diag.errors.length > 0 && (
              <div className="mt-3 pt-3 border-t border-current/20">
                <p className="font-medium mb-1">Issues found:</p>
                <ul className="list-disc list-inside space-y-0.5 text-xs">
                  {diag.errors.map((e: string, i: number) => <li key={i}>{e}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* 9. Klaviyo */}
      <Card icon={<Megaphone className="w-4 h-4 text-teal-dark" />} title="Klaviyo"
        subtitle="Email & SMS marketing: sync customers, orders and onsite activity to Klaviyo for flows, campaigns and signup forms.">
        <div className="grid sm:grid-cols-2 gap-3 mb-4">
          <SelectCard
            selected={settings.klaviyo_enabled} disabled={isReadOnly}
            onClick={() => handleKlaviyoToggle('klaviyo_enabled', true)}
            icon={<ToggleRight className="w-5 h-5" />} title="Enabled"
            desc="Send events and load Klaviyo on the storefront." />
          <SelectCard
            selected={!settings.klaviyo_enabled} disabled={isReadOnly}
            onClick={() => handleKlaviyoToggle('klaviyo_enabled', false)}
            icon={<ToggleLeft className="w-5 h-5" />} title="Disabled"
            desc="Nothing is sent to Klaviyo." />
        </div>

        {/* Private key */}
        <div className="mb-4">
          <label className="flex items-center gap-2 text-xs font-medium text-ink-muted uppercase tracking-wider mb-1.5">
            <KeyRound className="w-3.5 h-3.5" /> Private API key
            <span className={settings.klaviyo_private_key_set ? 'text-emerald-600' : 'text-ink-muted'}>
              {settings.klaviyo_private_key_set
                ? settings.klaviyo_private_key_source === 'env'
                  ? '• set via KLAVIYO_PRIVATE_API_KEY'
                  : '• configured'
                : '• not set'}
            </span>
          </label>
          <input
            type="password" value={klaviyoKeyInput} disabled={isReadOnly} autoComplete="off"
            onChange={(e) => setKlaviyoKeyInput(e.target.value)}
            placeholder={settings.klaviyo_private_key_set ? '•••••••• (leave blank to keep, a single space clears)' : 'pk_…'}
            className={`w-full ${INPUT}`} />
          <p className="text-xs text-ink-muted mt-1">
            Klaviyo → Settings → API keys → Create Private API Key. Give it Full access to
            Events, Profiles, Lists and Subscriptions, and Read access to Accounts. Stored
            server-side only — never sent to the browser.
          </p>
        </div>

        {/* Public key + list */}
        <div className="grid sm:grid-cols-2 gap-3 mb-4">
          <div>
            <label className="block text-xs font-medium text-ink-muted uppercase tracking-wider mb-1.5">
              Public API key / Site ID
            </label>
            <input
              type="text" value={klForm.public_key} disabled={isReadOnly} maxLength={12}
              onChange={(e) => setKlForm({ ...klForm, public_key: e.target.value.trim() })}
              placeholder="e.g. AbC123" className={`w-full ${INPUT}`} />
            <p className="text-xs text-ink-muted mt-1">
              6 characters, shown next to your API keys. “Test connection” fills it in.
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-muted uppercase tracking-wider mb-1.5">
              Newsletter list
            </label>
            {klTest?.lists && klTest.lists.length > 0 ? (
              <select
                value={klForm.list_id} disabled={isReadOnly}
                onChange={(e) => setKlForm({ ...klForm, list_id: e.target.value })}
                className={`w-full ${INPUT}`}>
                <option value="">— Don't subscribe anyone —</option>
                {klForm.list_id && !klTest.lists.some((l) => l.id === klForm.list_id) && (
                  <option value={klForm.list_id}>{klForm.list_id} (not found)</option>
                )}
                {klTest.lists.map((l) => (
                  <option key={l.id} value={l.id}>{l.name} ({l.id})</option>
                ))}
              </select>
            ) : (
              <input
                type="text" value={klForm.list_id} disabled={isReadOnly} maxLength={16}
                onChange={(e) => setKlForm({ ...klForm, list_id: e.target.value.trim() })}
                placeholder="List ID (run Test connection to pick)" className={`w-full ${INPUT}`} />
            )}
            <p className="text-xs text-ink-muted mt-1">
              Only customers who tick the marketing-consent box are subscribed.
            </p>
          </div>
        </div>

        {/* What to sync */}
        <div className="space-y-3 mb-4">
          <ToggleSwitch
            checked={settings.klaviyo_onsite_enabled} disabled={isReadOnly}
            onChange={(v) => handleKlaviyoToggle('klaviyo_onsite_enabled', v)}
            label="Onsite tracking & signup forms"
            description="Loads klaviyo.js (after cookie consent): Viewed Product, Added to Cart, Viewed Cart, and any pop-up or embedded forms you publish in Klaviyo." />
          <ToggleSwitch
            checked={settings.klaviyo_server_events_enabled} disabled={isReadOnly}
            onChange={(v) => handleKlaviyoToggle('klaviyo_server_events_enabled', v)}
            label="Order & checkout events"
            description="Started Checkout, Placed Order, Ordered Product, Confirmed / Fulfilled / Delivered / Cancelled / Refunded Order." />
          <ToggleSwitch
            checked={settings.klaviyo_sync_signups} disabled={isReadOnly}
            onChange={(v) => handleKlaviyoToggle('klaviyo_sync_signups', v)}
            label="Sync new accounts"
            description="Creates the profile and a Created Account event on signup, and subscribes consenting customers to the list above." />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button onClick={handleSaveKlaviyo} disabled={isReadOnly || saving}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-ink text-white rounded-lg text-sm font-medium hover:bg-ink/90 disabled:opacity-50">
            <Check className="w-4 h-4" /> Save Klaviyo settings
          </button>
          <button onClick={() => runKlaviyoTest(false)} disabled={isReadOnly || klTesting}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-surface border border-line text-ink rounded-lg text-sm font-medium hover:border-teal/40 disabled:opacity-50">
            <RefreshCw className={`w-4 h-4 ${klTesting ? 'animate-spin' : ''}`} /> {klTesting ? 'Testing…' : 'Test connection'}
          </button>
          <button onClick={runKlaviyoSync} disabled={isReadOnly || klSyncing || !settings.klaviyo_list_id}
            title={settings.klaviyo_list_id ? undefined : 'Save a newsletter list first'}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-surface border border-line text-ink rounded-lg text-sm font-medium hover:border-teal/40 disabled:opacity-50">
            <Users className="w-4 h-4" /> {klSyncing ? 'Syncing…' : 'Sync consenting customers'}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 mt-3">
          <input
            type="email" value={klTestEmail} disabled={isReadOnly}
            onChange={(e) => setKlTestEmail(e.target.value)}
            placeholder="you@example.com" className={`flex-1 min-w-[200px] ${INPUT}`} />
          <button onClick={() => runKlaviyoTest(true)}
            disabled={isReadOnly || klTesting || !emailRegex.test(klTestEmail.trim())}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-surface border border-line text-ink rounded-lg text-sm font-medium hover:border-teal/40 disabled:opacity-50">
            <Send className="w-4 h-4" /> Send test event
          </button>
        </div>

        {klTest && (
          <div className={`mt-4 rounded-lg border p-4 text-sm ${
            klTest.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                      : 'bg-amber-50 border-amber-200 text-amber-800'
          }`}>
            <p className="font-semibold mb-2 flex items-center gap-2">
              {klTest.ok ? <Check className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
              {klTest.account
                ? `Connected to ${klTest.account.organization_name ?? 'Klaviyo'}`
                : 'Klaviyo is not connected'}
            </p>
            {klTest.account && (
              <ul className="space-y-1 text-xs">
                <DiagRow label="Account ID" value={klTest.account.id} />
                <DiagRow label="Site ID (public key)" value={klTest.account.public_api_key ?? '—'} />
                {klTest.account.default_sender_email && (
                  <DiagRow label="Default sender" value={klTest.account.default_sender_email} />
                )}
                <DiagRow label="Lists found" value={String(klTest.lists?.length ?? 0)} />
                <DiagRow
                  label="Key tested"
                  value={klTest.key_source === 'typed' ? 'typed (not saved yet)' : klTest.key_source === 'env' ? 'env var' : 'saved'} />
              </ul>
            )}
            {klTest.test_event && (
              <p className="mt-2 text-xs">
                {klTest.test_event.sent
                  ? `Test event sent to ${klTest.test_event.email} — look for “VYTA Test Event” in Klaviyo → Analytics → Metrics.`
                  : `Test event failed: ${klTest.test_event.error}`}
              </p>
            )}
            {[...(klTest.errors ?? []), ...(klTest.warnings ?? [])].length > 0 && (
              <div className="mt-3 pt-3 border-t border-current/20">
                <ul className="list-disc list-inside space-y-0.5 text-xs">
                  {(klTest.errors ?? []).map((e, i) => <li key={`e${i}`}>{e}</li>)}
                  {(klTest.warnings ?? []).map((w, i) => <li key={`w${i}`} className="opacity-80">{w}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* 10. Info box */}
      <div className="flex gap-3 rounded-xl p-4 bg-blue-50 border border-blue-200 text-sm text-blue-800">
        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p>Checkout type changes take effect immediately on the storefront.</p>
          <p>Admin emails receive order and low-stock notifications.</p>
          <p>Email checkout requires SMTP/Resend configuration; crypto checkout requires wallet setup.</p>
        </div>
      </div>
    </div>
  );
}

// ---- presentational helpers ----

function Card({ icon, title, subtitle, children }: {
  icon: React.ReactNode; title: string; subtitle?: string; children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl border border-line p-5">
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <h2 className="font-semibold text-ink">{title}</h2>
      </div>
      {subtitle && <p className="text-xs text-ink-muted mb-4">{subtitle}</p>}
      {children}
    </div>
  );
}

function SelectCard({ selected, disabled, onClick, icon, title, desc }: {
  selected: boolean; disabled?: boolean; onClick: () => void;
  icon: React.ReactNode; title: string; desc: string;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={`relative text-left p-4 rounded-lg border transition-colors disabled:opacity-50 ${
        selected ? 'border-teal bg-teal/5' : 'border-line bg-surface hover:border-teal/40'
      }`}>
      {selected && (
        <div className="absolute top-3 right-3 w-5 h-5 rounded-full bg-teal flex items-center justify-center">
          <Check className="w-3 h-3 text-white" />
        </div>
      )}
      <div className={`mb-2 ${selected ? 'text-teal-dark' : 'text-ink-muted'}`}>{icon}</div>
      <p className="font-medium text-ink text-sm">{title}</p>
      <p className="text-xs text-ink-muted mt-0.5">{desc}</p>
    </button>
  );
}

function ReportStat({ label, value, tone }: {
  label: string; value: number; tone: 'emerald' | 'amber' | 'muted';
}) {
  const toneCls =
    tone === 'emerald' ? 'text-emerald-600'
      : tone === 'amber' ? 'text-amber-600'
        : 'text-ink';
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-center">
      <p className={`text-lg font-bold tabular-nums ${toneCls}`}>{value}</p>
      <p className="text-[11px] text-ink-muted">{label}</p>
    </div>
  );
}

function DiagRow({ label, ok, value }: {
  label: string; ok?: boolean | null; value?: string;
}) {
  let mark = '•';
  if (value === undefined) mark = ok === true ? '✓' : ok === false ? '✗' : '–';
  return (
    <li className="flex items-center justify-between gap-2">
      <span>{label}</span>
      <span className="font-mono">{value !== undefined ? value : mark}</span>
    </li>
  );
}

function EmailList({ items, onRemove, disabled }: {
  items: string[]; onRemove: (email: string) => void; disabled?: boolean;
}) {
  if (items.length === 0) {
    return <p className="text-xs text-ink-muted mt-3">No addresses added yet.</p>;
  }
  return (
    <div className="space-y-2 mt-3">
      {items.map((email) => (
        <div key={email} className="flex items-center justify-between bg-surface rounded-lg px-3 py-2">
          <span className="flex items-center gap-2 text-sm text-ink">
            <span className="w-6 h-6 rounded bg-teal/10 flex items-center justify-center">
              <Mail className="w-3.5 h-3.5 text-teal-dark" />
            </span>
            {email}
          </span>
          {!disabled && (
            <button onClick={() => onRemove(email)}
              className="text-ink-muted hover:text-red-600 transition-colors">
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
