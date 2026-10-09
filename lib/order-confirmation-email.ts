/**
 * The paid-order emails:
 *   • the customer's confirmation ("Thank you for your order.") from a
 *     `ConfirmationEmailData` — `renderOrderConfirmationHtml/Text`;
 *   • the team's "New order paid" notification from an
 *     `AdminOrderPaidEmailData` — `renderAdminOrderPaidHtml/Text`, which is
 *     the customer's email, identical; only its subject differs.
 *
 * Email-client safe: table layout, inline styles, no SVG, no web fonts, no
 * CSS the big clients strip (Gmail, Outlook, Apple Mail). Images are absolute
 * URLs. The hero photo (public/images/email/order-hero.jpg) is a background,
 * with the light-blue colour as the fallback where backgrounds are dropped
 * (Outlook desktop); its left side is lightened so the headline stays legible.
 *
 * Icons are Lucide (lucide-static 0.546.0, the version lucide-react is on)
 * plus Font Awesome's canadian-maple-leaf (react-icons' FaCanadianMapleLeaf;
 * Lucide has no maple leaf), pre-rendered to 96px transparent PNGs in
 * public/images/email/<icon>-<colour>.png — Gmail and Outlook don't render
 * SVG. Lucide strokes are drawn at 1.75. Each has alt text for image-off
 * clients.
 *
 * Pure (type-only imports), so it renders under `node --test` and in a
 * preview script. The mailers are `sendOrderConfirmation` and
 * `sendAdminOrderPaidAlert` in lib/email.ts.
 */
import type { ConfirmationEmailData, ConfirmationLine } from './order-confirmation-data';

export const SUPPORT_EMAIL = 'support@vytabio.com';

const NAVY = '#07203A';
const DEEP = '#05182B';
const BLUE = '#0E68AE';
const TEAL = '#2A8C95';
const MUTED = '#56707F';
const LINE = '#DCE7EB';
const SOFT = '#F3F8FB';
const GREEN = '#047857';

const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function money(n: number): string {
  const v = Number(n) || 0;
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

/** "October 4, 2026" in the store's time zone (date-only values as-is). */
export function formatOrderDate(value: string | undefined | null): string | null {
  if (!value) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const d = new Date(dateOnly ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: dateOnly ? 'UTC' : 'America/New_York',
  });
}

export function packLabel(item: ConfirmationLine): string {
  if (item.unit === 'case') {
    const n = Number(item.vialsPerBox) > 0 ? Number(item.vialsPerBox) : 10;
    return `Pack of ${n}`;
  }
  if (item.unit === 'vial') return 'Single vial';
  return '';
}

export type IconName =
  | 'file-text-blue'
  | 'calendar-blue'
  | 'check-teal'
  | 'map-pin-blue'
  | 'package-blue'
  | 'truck-blue'
  | 'package-open-blue'
  | 'mail-blue'
  | 'flask-conical-blue'
  | 'flask-conical-white'
  | 'shield-check-white'
  | 'canadian-maple-leaf-white'
  | 'arrow-right-white'
  | 'arrow-right-muted'
  | 'copy-blue';

/** One pre-rendered icon (see the header comment), shown at `px`. */
export function icon(site: string, name: IconName, px: number, alt = ''): string {
  return `<img src="${site}/images/email/${name}.png" width="${px}" height="${px}" alt="${esc(alt)}" style="display: inline-block; width: ${px}px; height: ${px}px; border: 0; vertical-align: middle;">`;
}

/** An icon centred in a filled (or outlined) circle. */
export function iconCircle(
  content: string,
  opts: { bg?: string; size?: number; border?: string } = {},
): string {
  const size = opts.size ?? 44;
  // `separate`: a collapsed table ignores border-radius on a bordered cell.
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: separate;"><tr>
    <td width="${size}" height="${size}" align="center" valign="middle" style="width: ${size}px; height: ${size}px; border-radius: ${size / 2}px; background: ${opts.bg ?? '#E3EFF6'};${opts.border ? ` border: ${opts.border};` : ''} line-height: 0; text-align: center;">${content}</td>
  </tr></table>`;
}

type StripCell = { icon: string; label: string; value: string };

function headerStrip(site: string, data: ConfirmationEmailData): string {
  const date = formatOrderDate(data.orderDate);
  return infoStrip(
    [
      { icon: iconCircle(icon(site, 'file-text-blue', 22)), label: 'Order Number', value: esc(data.orderNumber) },
      date ? { icon: iconCircle(icon(site, 'calendar-blue', 22)), label: 'Order Date', value: esc(date) } : null,
      {
        icon: iconCircle(icon(site, 'check-teal', 22), { bg: '#DDF3EC' }),
        label: 'Payment Status',
        value: esc(data.paymentStatus || 'Paid'),
      },
    ].filter(Boolean) as StripCell[],
  );
}

/** The white card of label/value cells under the hero. */
function infoStrip(cells: StripCell[]): string {
  const width = Math.floor(100 / cells.length);
  const tds = cells
    .map(
      (c, i) => `
      <td class="stack${i > 0 ? ' stack-rule' : ''}" width="${width}%" valign="middle" style="padding: 18px 12px; ${i > 0 ? `border-left: 1px solid ${LINE};` : ''}">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse;"><tr>
          <td valign="middle" style="padding-right: 12px;">${c.icon}</td>
          <td valign="middle">
            <p style="margin: 0; font-size: 10px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: ${MUTED};">${c.label}</p>
            <p style="margin: 4px 0 0; font-size: 16px; font-weight: 600; color: ${NAVY}; white-space: nowrap;">${c.value}</p>
          </td>
        </tr></table>
      </td>`,
    )
    .join('');

  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: separate; background: #FFFFFF; border: 1px solid ${LINE}; border-radius: 16px; box-shadow: 0 6px 18px rgba(7,32,58,0.06);">
    <tr>${tds}</tr>
  </table>`;
}

function itemRows(site: string, items: ConfirmationLine[]): string {
  return items
    .map((item) => {
      const qty = Number(item.quantity) || 0;
      const unit = Number(item.price) || 0;
      const pack = packLabel(item);
      const image = item.imageUrl
        ? `<img src="${esc(item.imageUrl)}" width="64" height="64" alt="${esc(item.name)}" style="display: block; width: 64px; height: 64px; object-fit: cover; border-radius: 10px; border: 1px solid ${LINE}; background: ${SOFT};">`
        : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse;"><tr><td width="64" height="64" align="center" valign="middle" style="width: 64px; height: 64px; border-radius: 10px; border: 1px solid ${LINE}; background: ${SOFT}; line-height: 0;">${icon(site, 'flask-conical-blue', 26)}</td></tr></table>`;
      const sub = [pack, item.strength].filter(Boolean).map(esc).join(' · ');
      return `
      <tr>
        <td class="thumb" width="76" valign="middle" style="padding: 14px 12px 14px 0; border-bottom: 1px solid ${LINE};">${image}</td>
        <td valign="middle" style="padding: 14px 8px 14px 0; border-bottom: 1px solid ${LINE};">
          <p style="margin: 0; font-size: 15px; font-weight: 700; color: ${NAVY};">${esc(item.name)}</p>
          ${sub ? `<p style="margin: 4px 0 0; font-size: 13px; color: ${MUTED};">${sub}</p>` : ''}
        </td>
        <td width="44" align="center" valign="middle" style="padding: 14px 4px; border-bottom: 1px solid ${LINE}; font-size: 14px; color: ${NAVY};">${qty}</td>
        <td class="hide-sm" width="84" align="right" valign="middle" style="padding: 14px 4px; border-bottom: 1px solid ${LINE}; font-size: 14px; color: ${NAVY};">${money(unit)}</td>
        <td width="84" align="right" valign="middle" style="padding: 14px 0 14px 4px; border-bottom: 1px solid ${LINE}; font-size: 14px; font-weight: 600; color: ${NAVY};">${money(unit * qty)}</td>
      </tr>`;
    })
    .join('');
}

function summaryRow(label: string, value: string, opts: { color?: string } = {}): string {
  const color = opts.color ?? NAVY;
  return `<tr>
    <td style="padding: 5px 0; font-size: 14px; color: ${MUTED};">${label}</td>
    <td align="right" valign="top" style="padding: 5px 0 5px 12px; font-size: 14px; color: ${color}; white-space: nowrap;">${value}</td>
  </tr>`;
}

function orderSummary(site: string, data: ConfirmationEmailData): string {
  const discount = Number(data.discount) || 0;
  const shipping = Number(data.shipping) || 0;
  const rows = [
    summaryRow('Subtotal', money(data.subtotal)),
    discount > 0
      ? summaryRow(
          `Discount${data.discountLabel ? ` <span style="color: ${MUTED};">(${esc(data.discountLabel)})</span>` : ''}`,
          `-${money(discount)}`,
          { color: GREEN },
        )
      : '',
    summaryRow('Shipping', shipping > 0 ? money(shipping) : 'Free'),
    data.tax != null ? summaryRow('Tax', money(data.tax)) : '',
  ].join('');

  const totals = `
    <p style="margin: 0 0 10px; font-size: 20px; font-weight: 700; color: ${NAVY};">Order Summary</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse;">
      ${rows}
      <tr>
        <td style="padding: 14px 0 0; border-top: 1px solid ${LINE}; font-size: 18px; font-weight: 700; color: ${NAVY};">Total</td>
        <td align="right" style="padding: 14px 0 0; border-top: 1px solid ${LINE}; font-size: 20px; font-weight: 800; color: ${NAVY}; white-space: nowrap;">${money(data.total)} ${esc(data.currency)}</td>
      </tr>
    </table>`;

  const ship = data.shipTo;
  if (!ship) {
    return `<td style="padding: 24px;">${totals}</td>`;
  }
  const address = `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse;"><tr>
      <td valign="top" style="padding-right: 10px;">${iconCircle(icon(site, 'map-pin-blue', 18), { size: 34 })}</td>
      <td valign="top">
        <p style="margin: 6px 0 10px; font-size: 14px; font-weight: 700; color: ${NAVY};">Shipping Address</p>
        ${ship.name ? `<p style="margin: 0 0 4px; font-size: 14px; font-weight: 700; color: ${NAVY};">${esc(ship.name)}</p>` : ''}
        ${ship.lines.map((l) => `<p style="margin: 0; font-size: 13px; line-height: 20px; color: ${MUTED};">${esc(l)}</p>`).join('')}
        ${ship.phone ? `<p style="margin: 8px 0 0; font-size: 13px; color: ${MUTED};">${esc(ship.phone)}</p>` : ''}
      </td>
    </tr></table>`;
  return `
    <td class="stack" width="58%" valign="top" style="padding: 24px 20px 24px 24px;">${totals}</td>
    <td class="stack stack-rule" width="42%" valign="top" style="padding: 24px 24px 24px 20px; border-left: 1px solid ${LINE};">${address}</td>`;
}

function nextSteps(site: string): string {
  const steps: Array<{ icon: IconName; title: string; body: string }> = [
    { icon: 'package-blue', title: '1. Order Processing', body: 'We’re preparing your order.' },
    { icon: 'truck-blue', title: '2. Order Ships', body: 'You’ll receive a tracking email once it ships.' },
    { icon: 'package-open-blue', title: '3. Delivery', body: 'Your order will be on its way to you soon.' },
  ];
  const arrow = `<td class="hide-sm" width="18" align="center" valign="middle" style="line-height: 0;">${icon(site, 'arrow-right-muted', 16)}</td>`;
  const cells = steps
    .map(
      (s) => `
      <td class="stack stack-gap" width="31%" valign="top" style="padding: 0 4px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse;"><tr>
          <td valign="top" style="padding-right: 10px;">${iconCircle(icon(site, s.icon, 20), { size: 40 })}</td>
          <td valign="top">
            <p style="margin: 2px 0 4px; font-size: 13px; font-weight: 700; color: ${NAVY};">${s.title}</p>
            <p style="margin: 0; font-size: 12px; line-height: 17px; color: ${MUTED};">${s.body}</p>
          </td>
        </tr></table>
      </td>`,
    )
    .join(arrow);
  return `
    <p style="margin: 0 0 16px; font-size: 20px; font-weight: 700; color: ${NAVY};">What Happens Next?</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse;"><tr>${cells}</tr></table>`;
}

function help(site: string, data: ConfirmationEmailData): string {
  const button = data.viewOrderUrl
    ? `<td class="stack stack-gap" width="210" align="right" valign="middle" style="padding-left: 12px;">
        <a href="${esc(data.viewOrderUrl)}" style="display: inline-block; padding: 14px 26px; border-radius: 999px; background: ${BLUE}; color: #FFFFFF; font-size: 15px; font-weight: 700; text-decoration: none; white-space: nowrap;">View Order Details&nbsp;&nbsp;${icon(site, 'arrow-right-white', 16)}</a>
        <p style="margin: 8px 0 0; font-size: 11px; color: ${MUTED}; text-align: center;">Sign in or create an account to view it.</p>
      </td>`
    : '';
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse;"><tr>
      <td class="hide-sm" width="56" valign="middle" style="padding-right: 14px;">${iconCircle(icon(site, 'mail-blue', 24), { size: 52 })}</td>
      <td class="stack" valign="middle">
        <p style="margin: 0 0 6px; font-size: 18px; font-weight: 700; color: ${NAVY};">Need Help?</p>
        <p style="margin: 0; font-size: 13px; line-height: 19px; color: ${MUTED};">
          If you have any questions about your order, reply to this email or contact us at
          <a href="mailto:${SUPPORT_EMAIL}" style="color: ${BLUE}; text-decoration: none; font-weight: 600;">${SUPPORT_EMAIL}</a>. We’re happy to help.
        </p>
      </td>
      ${button}
    </tr></table>`;
}

function footer(siteUrl: string): string {
  const badge = (name: IconName, text: string) => `
    <td class="stack stack-gap" valign="middle" style="padding: 0 6px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse;"><tr>
        <td valign="middle" style="padding-right: 8px;">${iconCircle(icon(siteUrl, name, 18), { size: 36, bg: 'transparent', border: '1px solid rgba(255,255,255,0.55)' })}</td>
        <td valign="middle" style="font-size: 10px; font-weight: 600; letter-spacing: 0.08em; line-height: 14px; text-transform: uppercase; color: #E6EEF3;">${text}</td>
      </tr></table>
    </td>`;
  return `
    <tr>
      <td style="background: ${DEEP}; border-radius: 0 0 20px 20px; padding: 28px 24px 22px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse;"><tr>
          <td class="stack" valign="middle" style="padding-right: 12px; border-right: 1px solid rgba(255,255,255,0.18);">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse;"><tr>
              <td valign="middle" style="padding-right: 8px;"><img src="${siteUrl}/images/vyta-mark.png" width="38" alt="" style="display: block; width: 38px; height: auto;"></td>
              <td valign="middle">
                <p style="margin: 0; font-size: 20px; letter-spacing: 0.3em; color: #FFFFFF;">VYTA</p>
                <p style="margin: 3px 0 0; font-size: 7px; letter-spacing: 0.32em; text-transform: uppercase; color: #9DB3BF;">Biosciences</p>
              </td>
            </tr></table>
          </td>
          ${badge('flask-conical-white', 'Third-party<br>lab tested')}
          ${badge('shield-check-white', 'High purity<br>&amp; quality')}
          ${badge('canadian-maple-leaf-white', 'Canadian<br>owned &amp; operated')}
        </tr></table>
        <p style="margin: 22px 0 0; padding-top: 16px; border-top: 1px solid rgba(255,255,255,0.18); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; text-align: center; color: #9DB3BF;">For research purposes only. Not for human or veterinary use.</p>
      </td>
    </tr>`;
}

/** One rounded light-blue card around a row of cells. */
function card(cellsHtml: string, opts: { last?: boolean } = {}): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: separate; margin: 16px 0 ${opts.last ? 20 : 0}px; background: ${SOFT}; border-radius: 16px;">
              <tr>${cellsHtml}</tr>
            </table>`;
}

/** The line-items table with its column headings. */
function itemsSection(site: string, heading: string, items: ConfirmationLine[]): string {
  const th = (label: string, align: string, extra = '') =>
    `<td${extra} align="${align}" style="padding: 0 ${align === 'right' && label === 'Total' ? 0 : 4}px 8px; border-bottom: 2px solid ${LINE}; font-size: 10px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: ${MUTED}; white-space: nowrap;">${label}</td>`;
  return `<div style="padding: 26px 12px 8px;">
              <p style="margin: 0 0 12px; font-size: 22px; font-weight: 700; color: ${NAVY};">${esc(heading)}</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td colspan="2" style="padding: 0 0 8px; border-bottom: 2px solid ${LINE}; font-size: 10px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: ${MUTED};">Product</td>
                  ${th('Qty', 'center')}
                  ${th('Unit price', 'right', ' class="hide-sm"')}
                  ${th('Total', 'right')}
                </tr>
                ${itemRows(site, items)}
              </table>
            </div>`;
}

interface ShellOptions {
  site: string;
  title: string;
  preheader: string;
  eyebrow: string;
  /** Trusted HTML — callers escape any data in it. */
  titleHtml: string;
  /** Trusted HTML — callers escape any data in it. */
  introHtml: string;
  /** The white body between the hero and the footer. */
  bodyHtml: string;
}

/** The whole document: head, hero, body, footer. */
function renderShell(o: ShellOptions): string {
  const site = o.site;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${esc(o.title)}</title>
<style>
  /* Phones: stack the columns. Clients that drop <style> get the desktop layout. */
  @media only screen and (max-width: 600px) {
    .stack { display: block !important; width: 100% !important; box-sizing: border-box !important; border-left: 0 !important; border-right: 0 !important; }
    .stack-rule { border-top: 1px solid ${LINE} !important; }
    .stack-gap { padding-top: 12px !important; text-align: left !important; }
    .hide-sm { display: none !important; }
    .hero-title { font-size: 32px !important; line-height: 36px !important; }
    /* Narrow screens: show the photo's light left side behind the text. */
    .hero { background-position: left center !important; }
    .thumb { width: 52px !important; padding-right: 8px !important; }
    .thumb img, .thumb td { width: 44px !important; height: 44px !important; }
  }
</style>
</head>
<body style="margin: 0; padding: 0; background: #EEF4F7;">
<div style="display: none; max-height: 0; overflow: hidden; opacity: 0; color: transparent;">${esc(o.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; background: #EEF4F7;">
  <tr>
    <td align="center" style="padding: 28px 10px; font-family: ${FONT};">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width: 100%; max-width: 640px; border-collapse: separate;">

        <!-- Hero -->
        <tr>
          <td class="hero" background="${site}/images/email/order-hero.jpg" style="background-color: #E6F0F6; background-image: url('${site}/images/email/order-hero.jpg'); background-position: right bottom; background-size: cover; background-repeat: no-repeat; border-radius: 20px 20px 0 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 26px 32px 0;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse;"><tr>
                    <td valign="middle">
                      <a href="${site}" style="text-decoration: none;">
                        <img src="${site}/images/vyta-mark.png" width="44" alt="" style="display: inline-block; width: 44px; height: auto; vertical-align: middle;">
                        <img src="${site}/images/vyta-wordmark.png" width="132" alt="VYTA Biosciences" style="display: inline-block; width: 132px; height: auto; vertical-align: middle; margin-left: 6px;">
                      </a>
                    </td>
                    <td class="hide-sm" align="right" valign="middle">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse;"><tr>
                        <td style="padding-left: 14px; border-left: 1px solid #B8CDD9; font-size: 10px; font-weight: 600; letter-spacing: 0.2em; line-height: 16px; text-transform: uppercase; color: ${NAVY};">
                          Research today.<br><span style="color: ${TEAL};">Brighter</span> tomorrow.
                        </td>
                      </tr></table>
                    </td>
                  </tr></table>
                </td>
              </tr>
              <tr>
                <td>
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse;"><tr>
                    <td class="stack" width="54%" valign="top" style="padding: 26px 8px 32px 32px;">
                      <p style="margin: 0 0 12px; font-size: 12px; font-weight: 600; letter-spacing: 0.3em; text-transform: uppercase; color: ${NAVY};">${esc(o.eyebrow)}</p>
                      <h1 class="hero-title" style="margin: 0 0 14px; font-size: 38px; line-height: 42px; font-weight: 800; letter-spacing: -0.02em; color: ${NAVY};">${o.titleHtml}</h1>
                      <p style="margin: 0; font-size: 14px; line-height: 22px; color: #34495A;">
                        ${o.introHtml}
                      </p>
                    </td>
                    <!-- The vials in the photo sit here. -->
                    <td class="hide-sm" width="46%">&nbsp;</td>
                  </tr></table>
                </td>
              </tr>
            </table>
          </td>
        </tr>

${o.bodyHtml}
        ${footer(site)}
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** Subject line — kept identical to the previous template. */
export function orderConfirmationSubject(data: Pick<ConfirmationEmailData, 'orderNumber'>): string {
  return `Order Confirmed - ${data.orderNumber}`;
}

export function renderOrderConfirmationHtml(data: ConfirmationEmailData, siteUrl: string): string {
  const site = siteUrl.replace(/\/$/, '');
  return renderShell({
    site,
    title: orderConfirmationSubject(data),
    preheader: `Your payment has been received — order ${data.orderNumber}.`,
    eyebrow: 'Order confirmed',
    titleHtml: `Thank you<br>for <span style="color: ${BLUE};">your order.</span>`,
    introHtml: `Hi ${esc(data.customerName)}, your payment has been received and your order is being processed. We’ll send you another email with tracking information once your order ships.`,
    bodyHtml: `        <!-- Body -->
        <tr>
          <td style="background: #FFFFFF; padding: 0 20px 4px;">
            <div style="height: 20px; line-height: 20px;">&nbsp;</div>
            ${headerStrip(site, data)}

            ${itemsSection(site, 'Your Order', data.items)}

            ${card(orderSummary(site, data))}

            ${card(`<td style="padding: 22px 20px 24px 24px;">${nextSteps(site)}</td>`)}

            ${card(`<td style="padding: 22px 24px;">${help(site, data)}</td>`, { last: true })}
          </td>
        </tr>
`,
  });
}

export function renderOrderConfirmationText(data: ConfirmationEmailData): string {
  const date = formatOrderDate(data.orderDate);
  const lines = data.items.map((i) => {
    const pack = packLabel(i);
    const qty = Number(i.quantity) || 0;
    return `  ${i.name}${pack ? ` (${pack})` : ''} × ${qty} — ${money((Number(i.price) || 0) * qty)}`;
  });
  const out = [
    'ORDER CONFIRMED — Thank you for your order.',
    '',
    `Hi ${data.customerName}, your payment has been received and your order is being processed.`,
    'We’ll email you tracking information once it ships.',
    '',
    `Order number: ${data.orderNumber}`,
    date ? `Order date: ${date}` : null,
    `Payment status: ${data.paymentStatus || 'Paid'}`,
    '',
    'Your order:',
    ...lines,
    '',
    `Subtotal: ${money(data.subtotal)}`,
    Number(data.discount) > 0
      ? `Discount${data.discountLabel ? ` (${data.discountLabel})` : ''}: -${money(data.discount)}`
      : null,
    `Shipping: ${Number(data.shipping) > 0 ? money(data.shipping) : 'Free'}`,
    data.tax != null ? `Tax: ${money(data.tax)}` : null,
    `Total: ${money(data.total)} ${data.currency}`,
    data.shipTo
      ? ['', 'Shipping address:', data.shipTo.name, ...data.shipTo.lines, data.shipTo.phone].filter(Boolean).join('\n')
      : null,
    '',
    data.viewOrderUrl ? `View your order (sign in or create an account first): ${data.viewOrderUrl}` : null,
    `Questions? Reply to this email or write to ${SUPPORT_EMAIL}.`,
    '',
    'For research purposes only. Not for human or veterinary use.',
  ];
  return out.filter((l) => l !== null).join('\n');
}

// ---------------------------------------------------------------------------
//  Admin "New order paid" notification
// ---------------------------------------------------------------------------

export interface AdminOrderPaidEmailData {
  /** The order as the customer email sees it (`to` is unused here). */
  order: ConfirmationEmailData;
  source: 'stealth_health' | 'manual';
  /** 'admin' when an admin marked the invoice paid or sent this by hand. */
  paidVia: 'checkout' | 'admin';
  customer: { name: string | null; email: string | null; phone: string | null };
  courier: string | null;
  discountCode: string | null;
  /** Lines that took no stock (no product linked). */
  stockWarnings: string[];
  /** Admin invoice page. */
  invoiceUrl: string;
}

function adminWho(data: AdminOrderPaidEmailData): string {
  return data.customer.name || data.customer.email || 'Guest';
}

/** Admin-only: says who paid how much, so the inbox can be scanned. */
export function adminOrderPaidSubject(data: AdminOrderPaidEmailData): string {
  const o = data.order;
  const label = o.orderNumber || (data.source === 'manual' ? 'Invoice' : 'Stealth Health order');
  return `${data.source === 'manual' ? 'Invoice paid' : 'New order'}: ${label} · ${adminWho(data)} · ${money(o.total)} ${o.currency}`;
}

/** The body is the customer's confirmation, unchanged — the team sees what the buyer saw. */
export function renderAdminOrderPaidHtml(data: AdminOrderPaidEmailData, siteUrl: string): string {
  return renderOrderConfirmationHtml(data.order, siteUrl);
}

export function renderAdminOrderPaidText(data: AdminOrderPaidEmailData): string {
  return renderOrderConfirmationText(data.order);
}
