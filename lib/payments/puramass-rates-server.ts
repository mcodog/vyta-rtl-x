/**
 * The one place a hosted-checkout shipping quote is produced.
 *
 * Two callers need it and they must never disagree: the rates endpoint the
 * checkout screen polls while the buyer types their address, and the hand-off
 * route that re-quotes at submit time to price the option they picked. If those
 * built their Easyship request differently — a different parcel weight, a
 * different origin, a different fee — the buyer would be shown one price and
 * charged another. So both go through here.
 *
 * SERVER-ONLY: reads the Easyship API key out of site settings. The pure rules
 * it applies (courier whitelist, ranking, the processing fee, the flat
 * fallback) live in lib/payments/puramass-shipping.ts, which the browser may
 * import.
 *
 * Never throws and always returns at least one option. A courier lookup is not
 * allowed to be the thing that stops someone buying, so every failure — the
 * feature switched off, Easyship unconfigured, the API down, no services for
 * the destination — resolves to the flat rate instead of an error.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getShippingConfig, fetchEasyshipRates } from '@/lib/easyship';
import {
  flatHostedRate,
  hostedParcelWeight,
  rankHostedRates,
  type HostedShippingRate,
} from '@/lib/payments/puramass-shipping';
import {
  getHostedShippingSettings,
  type HostedShippingSettings,
} from '@/lib/payments/puramass-settings';

export interface HostedQuoteDestination {
  country: string;
  postal_code: string;
  city: string;
  state?: string;
}

export interface HostedQuote {
  /** True only when these are real courier rates the buyer has to choose from. */
  live: boolean;
  rates: HostedShippingRate[];
  /** Why there is nothing live to pick, when that is worth telling the buyer. */
  note: string | null;
  /** The settings the quote was produced under, so callers don't re-read them. */
  settings: HostedShippingSettings;
  /** TEMP DEBUG: why the quote fell back to the flat rate. Remove once diagnosed. */
  debug?: string;
}

/**
 * Quote couriers for `destination`, with the admin's processing fee already
 * folded into every price. `vials` is the whole cart counted in single vials —
 * what the parcel weight is derived from.
 *
 * Pass `settings` when the caller has already read them (the hand-off route
 * has); otherwise they are read here.
 */
export async function quoteHostedRates(
  db: SupabaseClient,
  destination: HostedQuoteDestination,
  vials: number,
  settings?: HostedShippingSettings,
): Promise<HostedQuote> {
  const cfgSettings = settings ?? (await getHostedShippingSettings(db));
  const flatQuote = (note: string | null, debug?: string): HostedQuote => ({
    live: false,
    rates: [flatHostedRate(cfgSettings.flatShipping)],
    note,
    settings: cfgSettings,
    debug,
  });

  if (!cfgSettings.ratesEnabled) return flatQuote(null, 'hosted rates disabled in settings');

  const cfg = await getShippingConfig(db);
  if (!cfg.enabled || !cfg.apiKey) {
    return flatQuote(
      null,
      `easyship not configured (enabled=${cfg.enabled}, apiKey=${cfg.apiKey ? 'set' : 'missing'})`,
    );
  }

  const box = cfg.box ?? {};
  let rates: HostedShippingRate[];
  try {
    const raw = await fetchEasyshipRates(
      {
        origin_country_alpha2: cfg.origin.country_alpha2 ?? 'CA',
        origin_postal_code: cfg.origin.postal_code ?? '',
        origin_state: cfg.origin.state,
        origin_city: cfg.origin.city,
        destination_country_alpha2: (destination.country ?? '').toUpperCase(),
        destination_postal_code: destination.postal_code ?? '',
        destination_city: destination.city ?? '',
        destination_state: destination.state || undefined,
        total_actual_weight: hostedParcelWeight(vials, cfg.itemWeightKg),
        quantity: Math.max(1, Math.round(Number(vials) || 1)),
        // Blank sides go out as 1 cm (lib/easyship.ts parcelDimensions).
        boxes: [
          {
            length: box.length ?? 0,
            width: box.width ?? 0,
            height: box.height ?? 0,
            weight: box.weight ?? 0.05,
          },
        ],
      },
      cfg.apiKey,
    );
    rates = rankHostedRates(raw, cfg);
  } catch (err: any) {
    console.error('[puramass] hosted rate quote failed:', err?.message ?? err);
    return flatQuote(
      'Live shipping rates are unavailable right now.',
      `easyship error: ${err?.message ?? String(err)}`,
    );
  }

  if (rates.length === 0) {
    return flatQuote(
      'No courier rates were returned for this address.',
      'easyship returned no rates after courier filtering',
    );
  }
  return { live: true, rates, note: null, settings: cfgSettings };
}
