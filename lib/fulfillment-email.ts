/**
 * The customer's "Your order has been packed" / "Your order has shipped"
 * emails — the branded templates behind the warehouse queue's and the admin
 * screens' Notify packed / Notify shipped buttons. Manual only: nothing sends
 * these on a status change; staff press the button (lib/warehouse/server.ts
 * `sendFulfillmentEmail`).
 *
 * Same rules as the order confirmation (lib/order-confirmation-email.ts),
 * whose icon helpers this reuses: table layout, inline styles, no SVG, no web
 * fonts, absolute image URLs. The cover photo is a plain full-width <img>
 * (public/images/email/shipped-hero.jpg — with the truck — or packed-hero.jpg,
 * the same photo cropped above it), so it shows in Outlook too.
 *
 * Pure (no server imports), so it renders under `node --test`.
 */
import { deliverableEmail, type ConfirmationLine, type ConfirmationShipTo } from './order-confirmation-data';
import {
  SUPPORT_EMAIL,
  esc,
  formatOrderDate,
  icon,
  iconCircle,
  money,
  packLabel,
  type IconName,
} from './order-confirmation-email';

export type FulfillmentEmailKind = 'packed' | 'shipped';
export type FulfillmentEmailType = 'shipment' | 'pickup';

export interface FulfillmentTracking {
  number: string | null;
  carrier: string | null;
  /** The carrier's tracking page; falls back to `trackingUrlFor` when absent. */
  url: string | null;
}

export interface FulfillmentEmailData {
  kind: FulfillmentEmailKind;
  fulfillmentType: FulfillmentEmailType;
  customerName: string;
  orderNumber: string;
  /** When the order was placed / paid (timestamp or YYYY-MM-DD). */
  orderDate?: string;
  items: ConfirmationLine[];
  shipTo?: ConfirmationShipTo;
  tracking?: FulfillmentTracking;
  /** Delivery window (YYYY-MM-DD each; either may be missing) — shipped emails only. */
  estimatedDelivery?: { from: string | null; to: string | null } | null;
  /** "View Order Details" target (customer account), when the order has one. */
  viewOrderUrl?: string;
}

const NAVY = '#07203A';
const BLUE = '#0E68AE';
const MUTED = '#56707F';
const LINE = '#DCE7EB';
const SOFT = '#F3F8FB';
const PAGE = '#EEF4F7';

const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;
const MONO = `'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace`;

// ---------------------------------------------------------------------------
//  Tracking links
// ---------------------------------------------------------------------------

const CARRIER_TRACKING: Array<{ match: RegExp; url: (n: string) => string }> = [
  { match: /\bups\b/i, url: (n) => `https://www.ups.com/track?tracknum=${n}` },
  { match: /fedex/i, url: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}` },
  {
    match: /canada\s*post|postes?\s*canada/i,
    url: (n) => `https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=${n}`,
  },
  { match: /purolator/i, url: (n) => `https://www.purolator.com/en/shipping/tracker?pin=${n}` },
  { match: /\bdhl\b/i, url: (n) => `https://www.dhl.com/ca-en/home/tracking.html?tracking-id=${n}` },
  { match: /usps/i, url: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}` },
];

/**
 * The tracking page for a parcel: the stored URL when there is one, else the
 * carrier's own tracking page for the number, else null.
 */
export function trackingUrlFor(tracking: FulfillmentTracking | null | undefined): string | null {
  const stored = tracking?.url?.trim();
  if (stored && /^https?:\/\//i.test(stored)) return stored;
  const number = tracking?.number?.trim();
  const carrier = tracking?.carrier?.trim();
  if (!number || !carrier) return null;
  const hit = CARRIER_TRACKING.find((c) => c.match.test(carrier));
  return hit ? hit.url(encodeURIComponent(number)) : null;
}

function shortDate(value: string | null | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** "Mar 27, 2026 – Mar 31, 2026", one date when only one is set, or null. */
export function formatDeliveryWindow(
  window: FulfillmentEmailData['estimatedDelivery'],
): string | null {
  const from = shortDate(window?.from);
  const to = shortDate(window?.to);
  if (from && to) return from === to ? from : `${from} – ${to}`;
  return from ?? to;
}

/**
 * The recipient box: one address or several, comma / semicolon / space
 * separated. `invalid` lists anything that isn't a deliverable address.
 */
export function parseRecipients(raw: unknown): { emails: string[]; invalid: string[] } {
  const parts = typeof raw === 'string' ? raw.split(/[\s,;]+/).filter(Boolean) : [];
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const part of parts) {
    const email = deliverableEmail(part);
    if (!email) invalid.push(part);
    else if (!emails.some((e) => e.toLowerCase() === email.toLowerCase())) emails.push(email);
  }
  return { emails, invalid };
}

// ---------------------------------------------------------------------------
//  Copy per kind
// ---------------------------------------------------------------------------

interface Copy {
  subject: string;
  preheader: string;
  title: string;
  intro: string;
  badge: { icon: IconName; label: string };
  itemsHeading: string;
  steps: Array<{ icon: IconName; title: string; body: string }>;
}

function copyFor(data: FulfillmentEmailData): Copy {
  const n = data.orderNumber;
  const pickup = data.fulfillmentType === 'pickup';

  if (data.kind === 'packed' && pickup) {
    return {
      subject: `Your VYTA pickup order ${n} is ready`,
      preheader: `Order ${n} is packed and ready for pickup.`,
      title: 'Your Order Is Ready for Pickup!',
      intro:
        'Great news! Your order has been packed and is ready for you. Come by during business hours and we’ll have it waiting.',
      badge: { icon: 'package-blue', label: 'Ready' },
      itemsHeading: 'Items Packed',
      steps: [
        { icon: 'package-blue', title: 'Order Packed', body: 'Your order is packed and waiting.' },
        { icon: 'map-pin-blue', title: 'Pick It Up', body: 'Come by during business hours.' },
        { icon: 'package-open-blue', title: 'Enjoy Your Order', body: 'Thank you for choosing VYTA.' },
      ],
    };
  }
  if (data.kind === 'shipped' && pickup) {
    return {
      subject: `Your VYTA pickup order ${n}`,
      preheader: `Thanks for picking up order ${n}.`,
      title: 'Thanks for Picking Up Your Order!',
      intro: 'Your order has been picked up. Thank you for choosing VYTA — we hope to see you again soon.',
      badge: { icon: 'check-teal', label: 'Picked up' },
      itemsHeading: 'Items Picked Up',
      steps: [
        { icon: 'package-blue', title: 'Order Packed', body: 'We prepared your order.' },
        { icon: 'map-pin-blue', title: 'Picked Up', body: 'Your order is in your hands.' },
        { icon: 'package-open-blue', title: 'Enjoy Your Order', body: 'Questions? We’re here to help.' },
      ],
    };
  }
  if (data.kind === 'packed') {
    return {
      subject: `Your VYTA order ${n} has been packed`,
      preheader: `Order ${n} is packed and ready for the carrier.`,
      title: 'Your Order Has Been Packed!',
      intro:
        'Great news! Your order has been packed and is ready for the carrier. We’ll send you the tracking details as soon as it ships.',
      badge: { icon: 'package-blue', label: 'Packed' },
      itemsHeading: 'Items Packed',
      steps: [
        { icon: 'package-blue', title: 'Order Packed', body: 'Your order is packed and ready to go.' },
        { icon: 'truck-blue', title: 'Order Ships', body: 'You’ll get a tracking email once it ships.' },
        { icon: 'package-open-blue', title: 'Enjoy Your Order', body: 'It will be on its way to you soon.' },
      ],
    };
  }
  return {
    subject: `Your VYTA order ${n} is on its way`,
    preheader: `Order ${n} has shipped${data.tracking?.number ? ` — tracking ${data.tracking.number}` : ''}.`,
    title: 'Your Order Has Shipped!',
    intro: data.tracking?.number
      ? 'Great news! Your order has been processed and is on its way to you. You can track your shipment using the tracking number below.'
      : 'Great news! Your order has been processed and is on its way to you.',
    badge: { icon: 'truck-blue', label: 'Shipped' },
    itemsHeading: 'Items Shipped',
    steps: [
      { icon: 'truck-blue', title: 'Order Shipped', body: 'Your order is on its way to you.' },
      {
        icon: 'map-pin-blue',
        title: 'Track in Real Time',
        body: trackingUrlFor(data.tracking) ? 'Click the button above to view tracking details.' : 'Use the tracking number above with the carrier.',
      },
      {
        icon: 'package-open-blue',
        title: 'Enjoy Your Order',
        body: formatDeliveryWindow(data.estimatedDelivery)
          ? `Estimated delivery ${formatDeliveryWindow(data.estimatedDelivery)}.`
          : 'Thank you for choosing VYTA.',
      },
    ],
  };
}

export function fulfillmentEmailSubject(data: FulfillmentEmailData): string {
  return copyFor(data).subject;
}

// ---------------------------------------------------------------------------
//  HTML
// ---------------------------------------------------------------------------

function cardTable(inner: string, opts: { bg?: string; marginTop?: number } = {}): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: separate; margin-top: ${opts.marginTop ?? 16}px; background: ${opts.bg ?? '#FFFFFF'}; border: 1px solid ${LINE}; border-radius: 16px;">
              <tr><td class="card-pad" style="padding: 22px 24px;">${inner}</td></tr>
            </table>`;
}

function button(site: string, href: string, label: string): string {
  return `<a href="${esc(href)}" style="display: inline-block; padding: 15px 34px; border-radius: 999px; background: #12A9D6; background-image: linear-gradient(90deg, #22C1E0, ${BLUE}); color: #FFFFFF; font-size: 17px; font-weight: 700; text-decoration: none; white-space: nowrap;">${esc(label)}&nbsp;&nbsp;&nbsp;${icon(site, 'arrow-right-white', 18)}</a>`;
}

function cta(site: string, data: FulfillmentEmailData): string {
  const trackUrl = data.kind === 'shipped' && data.fulfillmentType === 'shipment' ? trackingUrlFor(data.tracking) : null;
  if (trackUrl) {
    return `<div style="padding: 26px 0 0; text-align: center;">
              ${button(site, trackUrl, 'Track Your Order')}
              <p style="margin: 12px 0 0; font-size: 12px; color: ${MUTED};">Tracking information may take a few hours to update.</p>
            </div>`;
  }
  if (data.viewOrderUrl) {
    return `<div style="padding: 26px 0 0; text-align: center;">
              ${button(site, data.viewOrderUrl, 'View Order Details')}
              <p style="margin: 12px 0 0; font-size: 12px; color: ${MUTED};">Sign in or create an account to view it.</p>
            </div>`;
  }
  return '';
}

/**
 * Carrier logos shown at the right of the Carrier row, as 96px PNGs in
 * public/images/email/. UPS is the Simple Icons mark (CC0), recoloured to
 * UPS brown and gold. To add another (e.g. Canada Post), drop its official
 * logo in as carrier-<name>.png and list it here; carriers without one just
 * show their name.
 */
const CARRIER_LOGOS: Array<{ match: RegExp; file: string; alt: string }> = [
  { match: /\bups\b/i, file: 'carrier-ups.png', alt: 'UPS' },
];

function carrierLogo(site: string, carrier: string): string {
  const hit = CARRIER_LOGOS.find((c) => c.match.test(carrier));
  return hit
    ? `<img src="${site}/images/email/${hit.file}" width="34" height="34" alt="${esc(hit.alt)}" style="display: inline-block; width: 34px; height: 34px; border: 0; vertical-align: middle;">`
    : '';
}

function detailRow(label: string, valueHtml: string, first = false, asideHtml = ''): string {
  const rule = first ? '' : `border-top: 1px solid ${LINE};`;
  return `<tr>
      <td class="dl-label" width="38%" valign="middle" style="padding: 13px 12px 13px 0; ${rule} font-size: 14px; font-weight: 700; color: ${NAVY};">${label}</td>
      <td valign="middle" style="padding: 13px 0; ${rule} font-size: 14px; color: ${NAVY};">${valueHtml}</td>
      <td class="dl-aside" width="44" align="right" valign="middle" style="width: 44px; padding: 6px 0; ${rule} line-height: 0;">${asideHtml || '&nbsp;'}</td>
    </tr>`;
}

function orderCard(site: string, data: FulfillmentEmailData, copy: Copy): string {
  const date = formatOrderDate(data.orderDate);
  const badge = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: separate;"><tr>
      <td style="padding: 8px 16px; border-radius: 999px; background: #E3F2FA; border: 1px solid #C5E3F3; font-size: 14px; font-weight: 700; color: ${NAVY}; white-space: nowrap;">${icon(site, copy.badge.icon, 16)}&nbsp;&nbsp;${esc(copy.badge.label)}</td>
    </tr></table>`;

  const rows: string[] = [];
  if (data.kind === 'shipped' && data.fulfillmentType === 'shipment') {
    const t = data.tracking;
    if (t?.number) {
      // Email can't run a copy-to-clipboard script, so the number selects
      // whole on one tap / click (where the client honours user-select) and the
      // copy icon marks it as the thing to copy.
      rows.push(
        detailRow(
          'Tracking Number',
          `<span class="mono" style="font-family: ${MONO}; font-weight: 600; word-break: break-all; -webkit-user-select: all; user-select: all;">${esc(t.number)}</span>`,
          rows.length === 0,
          icon(site, 'copy-blue', 20, 'Copy'),
        ),
      );
    }
    if (t?.carrier) {
      rows.push(detailRow('Carrier', esc(t.carrier), rows.length === 0, carrierLogo(site, t.carrier)));
    }
    const eta = formatDeliveryWindow(data.estimatedDelivery);
    if (eta) rows.push(detailRow('Estimated Delivery', esc(eta), rows.length === 0));
  }

  return cardTable(`
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse;"><tr>
                <td class="stack" valign="top">
                  <p style="margin: 0; font-size: 22px; font-weight: 800; color: ${NAVY};">Order #${esc(data.orderNumber)}</p>
                  ${date ? `<p style="margin: 6px 0 0; font-size: 14px; color: ${MUTED};">Placed on ${esc(date)}</p>` : ''}
                </td>
                <td class="stack badge-cell" align="right" valign="top" style="padding-left: 12px;">${badge}</td>
              </tr></table>
              ${
                rows.length
                  ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin-top: 16px; border-top: 1px solid ${LINE};">${rows.join('')}</table>`
                  : ''
              }`);
}

function itemsCard(site: string, data: FulfillmentEmailData, copy: Copy): string {
  if (data.items.length === 0) return '';
  const rows = data.items
    .map((item, i) => {
      const qty = Number(item.quantity) || 0;
      const total = (Number(item.price) || 0) * qty;
      const image = item.imageUrl
        ? `<img src="${esc(item.imageUrl)}" width="72" height="72" alt="${esc(item.name)}" style="display: block; width: 72px; height: 72px; object-fit: cover; border-radius: 10px; border: 1px solid ${LINE}; background: ${SOFT};">`
        : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: separate;"><tr><td width="72" height="72" align="center" valign="middle" style="width: 72px; height: 72px; border-radius: 10px; border: 1px solid ${LINE}; background: ${SOFT}; line-height: 0;">${icon(site, 'flask-conical-blue', 28)}</td></tr></table>`;
      const sub = [item.strength, packLabel(item)].filter(Boolean).map(esc).join(' · ');
      const rule = i > 0 ? `border-top: 1px solid ${LINE};` : '';
      return `<tr>
        <td class="thumb" width="88" valign="top" style="padding: 14px 16px 14px 0; ${rule}">${image}</td>
        <td valign="top" style="padding: 14px 8px 14px 0; ${rule}">
          <p style="margin: 0; font-size: 17px; font-weight: 800; color: ${NAVY};">${esc(item.name)}</p>
          ${sub ? `<p style="margin: 4px 0 0; font-size: 14px; color: ${MUTED};">${sub}</p>` : ''}
          <p style="margin: 4px 0 0; font-size: 13px; color: ${MUTED};">Research Use Only</p>
          <p class="show-sm" style="display: none; margin: 4px 0 0; font-size: 13px; color: ${MUTED};">Qty: ${qty}</p>
        </td>
        <td class="hide-sm" width="64" valign="top" style="padding: 16px 8px 14px 0; ${rule} font-size: 14px; color: ${MUTED}; white-space: nowrap;">Qty: ${qty}</td>
        <td width="80" align="right" valign="top" style="padding: 16px 0 14px; ${rule} font-size: 15px; font-weight: 700; color: ${NAVY}; white-space: nowrap;">${money(total)}</td>
      </tr>`;
    })
    .join('');
  return cardTable(`
              <p style="margin: 0 0 4px; font-size: 19px; font-weight: 800; color: ${NAVY};">${esc(copy.itemsHeading)}</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; border-top: 1px solid ${LINE}; margin-top: 10px;">${rows}</table>`);
}

function addressCard(site: string, data: FulfillmentEmailData): string {
  const ship = data.shipTo;
  if (!ship || data.fulfillmentType !== 'shipment') return '';
  return cardTable(`
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse;"><tr>
                <td valign="top" style="padding-right: 14px;">${icon(site, 'map-pin-blue', 26, 'Address')}</td>
                <td valign="top">
                  <p style="margin: 2px 0 8px; font-size: 18px; font-weight: 800; color: ${NAVY};">Shipping Address</p>
                  ${ship.name ? `<p style="margin: 0; font-size: 15px; line-height: 22px; color: ${MUTED};">${esc(ship.name)}</p>` : ''}
                  ${ship.lines.map((l) => `<p style="margin: 0; font-size: 15px; line-height: 22px; color: ${MUTED};">${esc(l)}</p>`).join('')}
                </td>
              </tr></table>`);
}

function nextSteps(site: string, copy: Copy): string {
  const arrow = `<td class="hide-sm" width="20" align="center" valign="top" style="padding-top: 16px; line-height: 0;">${icon(site, 'arrow-right-muted', 16)}</td>`;
  const cells = copy.steps
    .map(
      (s) => `
      <td class="stack stack-gap" width="31%" align="center" valign="top" style="padding: 0 4px; text-align: center;">
        <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="border-collapse: separate; margin: 0 auto;"><tr><td>${iconCircle(icon(site, s.icon, 22), { size: 48, bg: '#FFFFFF' })}</td></tr></table>
        <p style="margin: 10px 0 4px; font-size: 14px; font-weight: 700; color: ${NAVY};">${esc(s.title)}</p>
        <p style="margin: 0; font-size: 13px; line-height: 18px; color: ${MUTED};">${esc(s.body)}</p>
      </td>`,
    )
    .join(arrow);
  return cardTable(
    `<p style="margin: 0 0 18px; font-size: 19px; font-weight: 800; color: ${NAVY};">What Happens Next?</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse;"><tr>${cells}</tr></table>`,
    { bg: SOFT },
  );
}

function footer(site: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin-top: 24px; border-top: 1px solid ${LINE};">
              <tr><td align="center" style="padding: 24px 12px 6px; text-align: center;">
                <a href="${site}" style="text-decoration: none;">
                  <img src="${site}/images/vyta-mark.png" width="34" alt="" style="display: inline-block; width: 34px; height: auto; vertical-align: middle;">
                  <img src="${site}/images/vyta-wordmark.png" width="104" alt="VYTA Biosciences" style="display: inline-block; width: 104px; height: auto; vertical-align: middle; margin-left: 4px;">
                </a>
                <p style="margin: 14px 0 0; font-size: 13px; line-height: 20px; color: ${MUTED};">
                  If you have any questions, please contact our support team at<br>
                  <a href="mailto:${SUPPORT_EMAIL}" style="color: ${BLUE}; text-decoration: underline;">${SUPPORT_EMAIL}</a>
                </p>
                <p style="margin: 16px 0 0; font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: #8AA0AD;">For research purposes only. Not for human or veterinary use.</p>
              </td></tr>
            </table>`;
}

/** "Hi Sam, great news! …" — or the intro alone when there's no name. */
function greet(name: string, intro: string): string {
  if (!name || name === 'there') return intro;
  return `Hi ${name}, ${intro.charAt(0).toLowerCase()}${intro.slice(1)}`;
}

export interface FulfillmentEmailRenderOptions {
  /**
   * A bar above the cover — set on the admin team's copy ("sent to … by …")
   * so it can't be mistaken for the customer's own email. Plain text.
   */
  notice?: string;
}

export function renderFulfillmentEmailHtml(
  data: FulfillmentEmailData,
  siteUrl: string,
  options: FulfillmentEmailRenderOptions = {},
): string {
  const site = siteUrl.replace(/\/$/, '');
  const copy = copyFor(data);
  // The shipped photo ends in the delivery truck; the packed one is cropped above it.
  const shippedArt = data.kind === 'shipped' && data.fulfillmentType === 'shipment';
  const hero = shippedArt
    ? { src: `${site}/images/email/shipped-hero.jpg`, height: 360 }
    : { src: `${site}/images/email/packed-hero.jpg`, height: 284 };
  // Without the truck in the photo, mark the moment with an icon instead.
  const badgeIcon = shippedArt
    ? ''
    : `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="border-collapse: separate; margin: 0 auto 4px;"><tr><td>${iconCircle(icon(site, copy.badge.icon, 30), { size: 64 })}</td></tr></table>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${esc(copy.subject)}</title>
<style>
  @media only screen and (max-width: 600px) {
    .stack { display: block !important; width: 100% !important; box-sizing: border-box !important; }
    .stack-gap { padding-top: 16px !important; }
    .hide-sm { display: none !important; }
    .title { font-size: 28px !important; line-height: 34px !important; }
    .body-pad { padding-left: 14px !important; padding-right: 14px !important; }
    .card-pad { padding: 18px 16px !important; }
    .badge-cell { display: block !important; text-align: left !important; padding: 12px 0 0 !important; }
    .show-sm { display: block !important; }
    .dl-label { width: 30% !important; padding-right: 8px !important; }
    .dl-aside { width: 36px !important; }
    .mono { font-size: 13px !important; }
    .thumb { width: 60px !important; padding-right: 10px !important; }
    .thumb img, .thumb td { width: 52px !important; height: 52px !important; }
  }
</style>
</head>
<body style="margin: 0; padding: 0; background: ${PAGE};">
<div style="display: none; max-height: 0; overflow: hidden; opacity: 0; color: transparent;">${esc(copy.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; background: ${PAGE};">
  <tr>
    <td align="center" style="padding: 28px 10px; font-family: ${FONT};">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width: 100%; max-width: 640px; border-collapse: separate;">

${
  options.notice
    ? `        <!-- Admin notice -->
        <tr>
          <td style="padding: 0 0 12px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: separate; background: #FFF7E6; border: 1px solid #F3D49B; border-radius: 12px;">
              <tr><td style="padding: 12px 16px; font-size: 13px; line-height: 19px; color: #7A4B00;"><strong>Admin copy</strong> — ${esc(options.notice)}</td></tr>
            </table>
          </td>
        </tr>
`
    : ''
}        <!-- Cover -->
        <tr>
          <td style="background: #DCEBF4; border-radius: 20px 20px 0 0; line-height: 0; font-size: 0;">
            <a href="${site}" style="text-decoration: none;"><img src="${hero.src}" width="640" alt="VYTA Biosciences" style="display: block; width: 100%; max-width: 640px; height: auto; border: 0; border-radius: 20px 20px 0 0;"></a>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td class="body-pad" style="background: #FFFFFF; border-radius: 0 0 20px 20px; padding: 28px 28px 24px;">
            ${badgeIcon}
            <h1 class="title" style="margin: 0; text-align: center; font-size: 34px; line-height: 40px; font-weight: 800; letter-spacing: -0.01em; color: ${NAVY};">${esc(copy.title)}</h1>
            <p style="margin: 14px auto 0; max-width: 520px; text-align: center; font-size: 16px; line-height: 25px; color: #34495A;">
              ${esc(greet(data.customerName, copy.intro))}
            </p>
            ${cta(site, data)}

            ${orderCard(site, data, copy)}
            ${itemsCard(site, data, copy)}
            ${addressCard(site, data)}
            ${nextSteps(site, copy)}
            ${footer(site)}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
//  Plain text
// ---------------------------------------------------------------------------

export function renderFulfillmentEmailText(data: FulfillmentEmailData): string {
  const copy = copyFor(data);
  const date = formatOrderDate(data.orderDate);
  const trackUrl = data.kind === 'shipped' && data.fulfillmentType === 'shipment' ? trackingUrlFor(data.tracking) : null;
  const greeting = data.customerName && data.customerName !== 'there' ? `Hi ${data.customerName},` : 'Hi,';
  const lines = data.items.map((i) => {
    const qty = Number(i.quantity) || 0;
    const pack = packLabel(i);
    return `  ${i.name}${i.strength ? ` ${i.strength}` : ''}${pack ? ` (${pack})` : ''} × ${qty} — ${money((Number(i.price) || 0) * qty)}`;
  });
  const out: Array<string | null> = [
    copy.title.toUpperCase(),
    '',
    greeting,
    copy.intro,
    '',
    `Order #${data.orderNumber}`,
    date ? `Placed on ${date}` : null,
    data.kind === 'shipped' && data.tracking?.number ? `Tracking number: ${data.tracking.number}` : null,
    data.kind === 'shipped' && data.tracking?.carrier ? `Carrier: ${data.tracking.carrier}` : null,
    data.kind === 'shipped' && formatDeliveryWindow(data.estimatedDelivery)
      ? `Estimated delivery: ${formatDeliveryWindow(data.estimatedDelivery)}`
      : null,
    trackUrl ? `Track your order: ${trackUrl}` : null,
    lines.length ? '' : null,
    lines.length ? `${copy.itemsHeading}:` : null,
    ...lines,
    data.shipTo && data.fulfillmentType === 'shipment'
      ? ['', 'Shipping address:', data.shipTo.name, ...data.shipTo.lines].filter(Boolean).join('\n')
      : null,
    '',
    !trackUrl && data.viewOrderUrl ? `View your order (sign in or create an account first): ${data.viewOrderUrl}` : null,
    `Questions? Contact our support team at ${SUPPORT_EMAIL}.`,
    '',
    'For research purposes only. Not for human or veterinary use.',
  ];
  return out.filter((l) => l !== null).join('\n');
}
