/**
 * The paid-order confirmation email ("Thank you for your order.") — HTML and
 * plain-text bodies built from a `ConfirmationEmailData`.
 *
 * Email-client safe: table layout, inline styles, no SVG, no web fonts, no
 * CSS the big clients strip (Gmail, Outlook, Apple Mail). Images are absolute
 * URLs; icons are emoji / text glyphs so nothing breaks when images are off.
 *
 * Pure (type-only imports), so it renders under `node --test` and in a
 * preview script. The mailer is `sendOrderConfirmation` in lib/email.ts.
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

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(n: number): string {
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

function packLabel(item: ConfirmationLine): string {
  if (item.unit === 'case') {
    const n = Number(item.vialsPerBox) > 0 ? Number(item.vialsPerBox) : 10;
    return `Pack of ${n}`;
  }
  if (item.unit === 'vial') return 'Single vial';
  return '';
}

function iconCircle(
  glyph: string,
  opts: { bg?: string; color?: string; size?: number; border?: string } = {},
): string {
  const size = opts.size ?? 44;
  // `separate`: a collapsed table ignores border-radius on a bordered cell.
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: separate;"><tr>
    <td width="${size}" height="${size}" align="center" valign="middle" style="width: ${size}px; height: ${size}px; border-radius: ${size / 2}px; background: ${opts.bg ?? '#E3EFF6'};${opts.border ? ` border: ${opts.border};` : ''} color: ${opts.color ?? BLUE}; font-size: ${Math.round(size * 0.45)}px; line-height: ${size}px; font-weight: 700; text-align: center; mso-line-height-rule: exactly;">${glyph}</td>
  </tr></table>`;
}

function headerStrip(data: ConfirmationEmailData): string {
  const date = formatOrderDate(data.orderDate);
  const cells = [
    { icon: iconCircle('&#129534;'), label: 'Order Number', value: esc(data.orderNumber) },
    date ? { icon: iconCircle('&#128197;'), label: 'Order Date', value: esc(date) } : null,
    {
      icon: iconCircle('&#10003;', { bg: '#DDF3EC', color: TEAL }),
      label: 'Payment Status',
      value: esc(data.paymentStatus || 'Paid'),
    },
  ].filter(Boolean) as Array<{ icon: string; label: string; value: string }>;

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

function itemRows(items: ConfirmationLine[]): string {
  return items
    .map((item) => {
      const qty = Number(item.quantity) || 0;
      const unit = Number(item.price) || 0;
      const pack = packLabel(item);
      const image = item.imageUrl
        ? `<img src="${esc(item.imageUrl)}" width="64" height="64" alt="${esc(item.name)}" style="display: block; width: 64px; height: 64px; object-fit: cover; border-radius: 10px; border: 1px solid ${LINE}; background: ${SOFT};">`
        : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse;"><tr><td width="64" height="64" align="center" valign="middle" style="width: 64px; height: 64px; border-radius: 10px; border: 1px solid ${LINE}; background: ${SOFT}; font-size: 24px;">&#129514;</td></tr></table>`;
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
    <td style="padding: 5px 0; font-size: 14px; color: ${opts.color ?? MUTED};">${label}</td>
    <td align="right" style="padding: 5px 0; font-size: 14px; color: ${color};">${value}</td>
  </tr>`;
}

function orderSummary(data: ConfirmationEmailData): string {
  const discount = Number(data.discount) || 0;
  const shipping = Number(data.shipping) || 0;
  const rows = [
    summaryRow('Subtotal', money(data.subtotal)),
    discount > 0 ? summaryRow('Discount', `-${money(discount)}`, { color: GREEN }) : '',
    summaryRow('Shipping', shipping > 0 ? money(shipping) : 'Free'),
    data.tax != null ? summaryRow('Tax', money(data.tax)) : '',
  ].join('');

  const savings =
    data.savings && data.savings.amount > 0
      ? `<p style="margin: 12px 0 0; padding: 10px 12px; border-radius: 10px; background: #E7F6EF; font-size: 13px; color: ${GREEN};">
          You saved <strong>${money(data.savings.amount)}</strong>${data.savings.label ? ` with ${esc(data.savings.label)}` : ''} — already reflected in the prices above.
        </p>`
      : '';

  const totals = `
    <p style="margin: 0 0 10px; font-size: 20px; font-weight: 700; color: ${NAVY};">Order Summary</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse;">
      ${rows}
      <tr>
        <td style="padding: 14px 0 0; border-top: 1px solid ${LINE}; font-size: 18px; font-weight: 700; color: ${NAVY};">Total</td>
        <td align="right" style="padding: 14px 0 0; border-top: 1px solid ${LINE}; font-size: 20px; font-weight: 800; color: ${NAVY};">${money(data.total)} ${esc(data.currency)}</td>
      </tr>
    </table>
    ${savings}`;

  const ship = data.shipTo;
  if (!ship) {
    return `<td style="padding: 24px;">${totals}</td>`;
  }
  const address = `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse;"><tr>
      <td valign="top" style="padding-right: 10px;">${iconCircle('&#128205;', { size: 34 })}</td>
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

function nextSteps(): string {
  const steps = [
    { icon: '&#128230;', title: '1. Order Processing', body: 'We’re preparing your order.' },
    { icon: '&#128666;', title: '2. Order Ships', body: 'You’ll receive a tracking email once it ships.' },
    { icon: '&#127968;', title: '3. Delivery', body: 'Your order will be on its way to you soon.' },
  ];
  const arrow = `<td class="hide-sm" width="16" align="center" valign="middle" style="font-size: 16px; color: #9DB3BF;">&rarr;</td>`;
  const cells = steps
    .map(
      (s) => `
      <td class="stack stack-gap" width="31%" valign="top" style="padding: 0 4px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse;"><tr>
          <td valign="top" style="padding-right: 10px;">${iconCircle(s.icon, { size: 40 })}</td>
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

function help(data: ConfirmationEmailData): string {
  const button = data.viewOrderUrl
    ? `<td class="stack stack-gap" width="210" align="right" valign="middle" style="padding-left: 12px;">
        <a href="${esc(data.viewOrderUrl)}" style="display: inline-block; padding: 14px 26px; border-radius: 999px; background: ${BLUE}; color: #FFFFFF; font-size: 15px; font-weight: 700; text-decoration: none; white-space: nowrap;">View Order Details &rarr;</a>
        <p style="margin: 8px 0 0; font-size: 11px; color: ${MUTED}; text-align: center;">Sign in or create an account to view it.</p>
      </td>`
    : '';
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse;"><tr>
      <td class="hide-sm" width="56" valign="middle" style="padding-right: 14px;">${iconCircle('&#9993;', { size: 52 })}</td>
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
  const badge = (glyph: string, text: string) => `
    <td class="stack stack-gap" valign="middle" style="padding: 0 6px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse;"><tr>
        <td valign="middle" style="padding-right: 8px;">${iconCircle(glyph, { size: 36, bg: 'transparent', color: '#FFFFFF', border: '1px solid rgba(255,255,255,0.55)' })}</td>
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
          ${badge('&#9879;', 'Third-party<br>lab tested')}
          ${badge('&#10004;', 'High purity<br>&amp; quality')}
          ${badge('&#127809;', 'Canadian<br>owned &amp; operated')}
        </tr></table>
        <p style="margin: 22px 0 0; padding-top: 16px; border-top: 1px solid rgba(255,255,255,0.18); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; text-align: center; color: #9DB3BF;">For research purposes only. Not for human or veterinary use.</p>
      </td>
    </tr>`;
}

/** Subject line — kept identical to the previous template. */
export function orderConfirmationSubject(data: Pick<ConfirmationEmailData, 'orderNumber'>): string {
  return `Order Confirmed - ${data.orderNumber}`;
}

export function renderOrderConfirmationHtml(data: ConfirmationEmailData, siteUrl: string): string {
  const site = siteUrl.replace(/\/$/, '');
  const heroImage = data.items.find((i) => i.imageUrl)?.imageUrl ?? null;
  const preheader = `Your payment has been received — order ${data.orderNumber}.`;

  const heroRight = heroImage
    ? `<td class="hide-sm" width="190" align="center" valign="bottom" style="padding: 0 24px 26px 0;">
        <img src="${esc(heroImage)}" width="170" alt="" style="display: block; width: 170px; height: 170px; object-fit: cover; border-radius: 18px; box-shadow: 0 12px 28px rgba(7,32,58,0.18);">
      </td>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${esc(orderConfirmationSubject(data))}</title>
<style>
  /* Phones: stack the columns. Clients that drop <style> get the desktop layout. */
  @media only screen and (max-width: 600px) {
    .stack { display: block !important; width: 100% !important; box-sizing: border-box !important; border-left: 0 !important; border-right: 0 !important; }
    .stack-rule { border-top: 1px solid ${LINE} !important; }
    .stack-gap { padding-top: 12px !important; text-align: left !important; }
    .hide-sm { display: none !important; }
    .hero-title { font-size: 32px !important; line-height: 36px !important; }
    .thumb { width: 52px !important; padding-right: 8px !important; }
    .thumb img, .thumb td { width: 44px !important; height: 44px !important; }
  }
</style>
</head>
<body style="margin: 0; padding: 0; background: #EEF4F7;">
<div style="display: none; max-height: 0; overflow: hidden; opacity: 0; color: transparent;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; background: #EEF4F7;">
  <tr>
    <td align="center" style="padding: 28px 10px; font-family: ${FONT};">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width: 100%; max-width: 640px; border-collapse: separate;">

        <!-- Hero -->
        <tr>
          <td style="background-color: #E6F0F6; background-image: linear-gradient(160deg, #F7FBFD 0%, #E6F0F6 55%, #D3E5EF 100%); border-radius: 20px 20px 0 0;">
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
                    <td valign="top" style="padding: 34px 24px 34px 32px;">
                      <p style="margin: 0 0 12px; font-size: 12px; font-weight: 600; letter-spacing: 0.3em; text-transform: uppercase; color: ${NAVY};">Order confirmed</p>
                      <h1 class="hero-title" style="margin: 0 0 16px; font-size: 40px; line-height: 44px; font-weight: 800; letter-spacing: -0.02em; color: ${NAVY};">Thank you<br>for <span style="color: ${BLUE};">your order.</span></h1>
                      <p style="margin: 0; font-size: 14px; line-height: 22px; color: #34495A;">
                        Hi ${esc(data.customerName)}, your payment has been received and your order is being processed. We’ll send you another email with tracking information once your order ships.
                      </p>
                    </td>
                    ${heroRight}
                  </tr></table>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="background: #FFFFFF; padding: 0 20px 4px;">
            <div style="height: 20px; line-height: 20px;">&nbsp;</div>
            ${headerStrip(data)}

            <div style="padding: 26px 12px 8px;">
              <p style="margin: 0 0 12px; font-size: 22px; font-weight: 700; color: ${NAVY};">Your Order</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td colspan="2" style="padding: 0 0 8px; border-bottom: 2px solid ${LINE}; font-size: 10px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: ${MUTED};">Product</td>
                  <td align="center" style="padding: 0 4px 8px; border-bottom: 2px solid ${LINE}; font-size: 10px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: ${MUTED};">Qty</td>
                  <td class="hide-sm" align="right" style="padding: 0 4px 8px; border-bottom: 2px solid ${LINE}; font-size: 10px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: ${MUTED}; white-space: nowrap;">Unit price</td>
                  <td align="right" style="padding: 0 0 8px; border-bottom: 2px solid ${LINE}; font-size: 10px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: ${MUTED};">Total</td>
                </tr>
                ${itemRows(data.items)}
              </table>
            </div>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: separate; margin-top: 16px; background: ${SOFT}; border-radius: 16px;">
              <tr>${orderSummary(data)}</tr>
            </table>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: separate; margin-top: 16px; background: ${SOFT}; border-radius: 16px;">
              <tr><td style="padding: 22px 20px 24px 24px;">${nextSteps()}</td></tr>
            </table>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: separate; margin: 16px 0 20px; background: ${SOFT}; border-radius: 16px;">
              <tr><td style="padding: 22px 24px;">${help(data)}</td></tr>
            </table>
          </td>
        </tr>

        ${footer(site)}
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
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
    Number(data.discount) > 0 ? `Discount: -${money(data.discount)}` : null,
    `Shipping: ${Number(data.shipping) > 0 ? money(data.shipping) : 'Free'}`,
    data.tax != null ? `Tax: ${money(data.tax)}` : null,
    `Total: ${money(data.total)} ${data.currency}`,
    data.savings && data.savings.amount > 0
      ? `You saved ${money(data.savings.amount)}${data.savings.label ? ` with ${data.savings.label}` : ''} (already reflected in the prices above).`
      : null,
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
