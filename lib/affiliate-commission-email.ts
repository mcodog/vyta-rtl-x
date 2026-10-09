/**
 * The affiliate's "You earned a new commission" email — sent automatically,
 * once, when a paid order credits them (lib/affiliate/commission-email.ts
 * `notifyAffiliateOfCommission`, called where the commission is booked).
 *
 * Built in the shipped email's frame (`renderVytaEmailShell`: cover photo,
 * white panel) with its card, row and button helpers, under the same rules:
 * table layout, inline styles, no SVG, no web fonts, absolute image URLs.
 *
 * Images of its own, in public/images/email/:
 *   • affiliate-hero.jpg — the shipped cover with its delivery truck removed;
 *   • affiliate-network.png — 320×272, shown at 120×102, and coins-teal.png
 *     (96×96, like the other icons): drawn from Lucide shapes (lucide-static
 *     0.546.0: user, circle-user, gift; the coins as a stack) and
 *     pre-rendered to transparent PNGs.
 *
 * Pure (no server imports), so it renders under `node --test`.
 */
import { SUPPORT_EMAIL, esc, icon, iconCircle, money } from './order-confirmation-email';
import { button, cardTable, detailRow, renderVytaEmailShell } from './fulfillment-email';

export interface AffiliateCommissionEmailData {
  /** "Al Wasserberger"; empty when the affiliate has no name on file. */
  affiliateName: string;
  orderNumber: string;
  /** The order total the commission was worked out on (goods subtotal). */
  orderTotal: number;
  /** The commission booked on it. */
  commission: number;
  /** The code the sale came in on; null when it was a bound customer with no live code. */
  referralCode: string | null;
  /** "View Affiliate Dashboard" target. */
  dashboardUrl: string;
}

const NAVY = '#07203A';
const BLUE = '#0E68AE';
const MUTED = '#56707F';
const TEAL = '#12A6CC';
const LINE = '#DCE7EB';

const INTRO = 'A customer just placed an order using your affiliate link or code.';

export function affiliateCommissionSubject(data: AffiliateCommissionEmailData): string {
  return `You earned a ${money(data.commission)} commission on order ${data.orderNumber}`;
}

function detailsCard(site: string, data: AffiliateCommissionEmailData): string {
  const W = '46%';
  const rows: string[] = [
    // Email can't run a clipboard script: the number selects whole on one
    // tap and the copy icon marks it, as on the shipped email's tracking row.
    detailRow(
      'Order Number',
      `<span style="-webkit-user-select: all; user-select: all;">${esc(data.orderNumber)}</span>`,
      true,
      icon(site, 'copy-blue', 20, 'Copy'),
      W,
    ),
    detailRow('Order Total', esc(money(data.orderTotal)), false, '', W),
    detailRow(
      'Commission Earned',
      `<span style="font-size: 20px; font-weight: 800; color: ${TEAL};">${esc(money(data.commission))}</span>`,
      false,
      '',
      W,
    ),
  ];
  if (data.affiliateName) rows.push(detailRow('Affiliate', esc(data.affiliateName), false, '', W));
  if (data.referralCode) {
    rows.push(
      detailRow(
        'Referral Code',
        `<span style="letter-spacing: 0.02em; word-break: break-all;">${esc(data.referralCode)}</span>`,
        false,
        '',
        W,
      ),
    );
  }
  return cardTable(
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse;">${rows.join('')}</table>`,
    { marginTop: 26 },
  );
}

function recordedNote(site: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: separate; margin-top: 16px; background: #EEF6FB; border-radius: 16px;">
              <tr><td class="card-pad" style="padding: 22px 24px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse;"><tr>
                  <td width="72" valign="middle" style="width: 72px; padding-right: 18px;">${iconCircle(icon(site, 'coins-teal', 44), { size: 72, bg: '#E0F0F8' })}</td>
                  <td valign="middle" style="padding-left: 20px; border-left: 1px solid #CFE2EC;">
                    <p style="margin: 0; font-size: 18px; line-height: 24px; font-weight: 800; color: ${NAVY};">Your commission has been recorded</p>
                    <p style="margin: 4px 0 0; font-size: 15px; line-height: 22px; color: ${MUTED};">and will be included in your next payout.</p>
                  </td>
                </tr></table>
              </td></tr>
            </table>`;
}

function footer(site: string): string {
  const host = site.replace(/^https?:\/\//, '').replace(/^www\./, '');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; margin-top: 28px; border-top: 1px solid ${LINE};">
              <tr><td align="center" style="padding: 24px 12px 4px; text-align: center;">
                <a href="${site}" style="text-decoration: none;">
                  <img src="${site}/images/vyta-mark.png" width="34" alt="" style="display: inline-block; width: 34px; height: auto; vertical-align: middle;">
                  <img src="${site}/images/vyta-wordmark.png" width="104" alt="VYTA Biosciences" style="display: inline-block; width: 104px; height: auto; vertical-align: middle; margin-left: 4px;">
                </a>
                <p style="margin: 10px 0 0; font-size: 14px;"><a href="${site}" style="color: ${BLUE}; text-decoration: none;">${esc(host)}</a></p>
              </td></tr>
            </table>`;
}

export function renderAffiliateCommissionHtml(data: AffiliateCommissionEmailData, siteUrl: string): string {
  const site = siteUrl.replace(/\/$/, '');
  return renderVytaEmailShell(site, {
    hero: 'affiliate-hero.jpg',
    title: affiliateCommissionSubject(data),
    preheader: `${INTRO} You earned ${money(data.commission)}.`,
    body: `            <div style="text-align: center; line-height: 0;">
              <img src="${site}/images/email/affiliate-network.png" width="120" height="102" alt="" style="display: inline-block; width: 120px; height: 102px; border: 0;">
            </div>
            <p style="margin: 18px 0 0; text-align: center; font-size: 13px; line-height: 18px; font-weight: 600; letter-spacing: 0.28em; text-transform: uppercase; color: ${MUTED};">Affiliate Notification</p>
            <h1 class="title" style="margin: 10px 0 0; text-align: center; font-size: 34px; line-height: 40px; font-weight: 800; letter-spacing: -0.01em; color: ${NAVY};">You earned a new commission</h1>
            <p style="margin: 12px auto 0; max-width: 520px; text-align: center; font-size: 16px; line-height: 25px; color: #34495A;">${esc(INTRO)}</p>

            ${detailsCard(site, data)}
            ${recordedNote(site)}

            <div style="padding: 28px 0 0; text-align: center;">
              ${button(site, data.dashboardUrl, 'View Affiliate Dashboard')}
            </div>
            ${footer(site)}`,
  });
}

export function renderAffiliateCommissionText(data: AffiliateCommissionEmailData): string {
  const out: Array<string | null> = [
    'YOU EARNED A NEW COMMISSION',
    '',
    data.affiliateName ? `Hi ${data.affiliateName},` : 'Hi,',
    INTRO,
    '',
    `Order number: ${data.orderNumber}`,
    `Order total: ${money(data.orderTotal)}`,
    `Commission earned: ${money(data.commission)}`,
    data.affiliateName ? `Affiliate: ${data.affiliateName}` : null,
    data.referralCode ? `Referral code: ${data.referralCode}` : null,
    '',
    'Your commission has been recorded and will be included in your next payout.',
    '',
    `View your affiliate dashboard: ${data.dashboardUrl}`,
    '',
    `Questions? Contact us at ${SUPPORT_EMAIL}.`,
  ];
  return out.filter((l) => l !== null).join('\n');
}
