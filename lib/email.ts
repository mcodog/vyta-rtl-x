import { sendMail, defaultFrom } from "@/lib/smtp";
import { productPath } from '@/lib/products/url';
import { SITE_URL } from '@/lib/config';
import type { ConfirmationEmailData } from '@/lib/order-confirmation-data';
import {
  orderConfirmationSubject,
  renderOrderConfirmationHtml,
  renderOrderConfirmationText,
} from '@/lib/order-confirmation-email';

/**
 * Storefront / transactional email sends route through the shared custom SMTP
 * transport (nodemailer) in lib/smtp.ts — the same server used for invoice
 * email. `getResend()` is kept as a thin, Resend-compatible adapter so the
 * existing call sites below (`.emails.send({...})` → `{ data, error }`) don't
 * need to change.
 */
function getResend() {
  return {
    emails: {
      async send(opts: {
        from: string;
        to: string | string[];
        bcc?: string | string[];
        cc?: string | string[];
        subject: string;
        html?: string;
        text?: string;
        replyTo?: string;
        attachments?: Array<{ filename: string; content: Buffer }>;
      }): Promise<{ data: { id?: string } | null; error: { message: string } | null }> {
        const res = await sendMail(opts);
        return res.success
          ? { data: { id: res.id }, error: null }
          : { data: null, error: { message: res.error ?? "Failed to send email" } };
      },
    },
  };
}

// Prefer the SMTP identity (SMTP_FROM / SMTP_USER) so the From header matches
// the authenticated mailbox — many SMTP servers reject a mismatched From.
const fromEmail = defaultFrom();

/**
 * Send the paid-order confirmation ("Thank you for your order.") to the
 * customer. Sent once automatically when an order is paid
 * (lib/order-confirmation.ts) and on demand from the admin. The template
 * lives in lib/order-confirmation-email.ts. Never throws; `subject` is
 * returned on every branch so the caller can log it.
 */
export async function sendOrderConfirmation(
  data: ConfirmationEmailData,
): Promise<{ success: boolean; id?: string; error?: string; subject: string }> {
  const subject = orderConfirmationSubject(data);
  const html = renderOrderConfirmationHtml(data, SITE_URL);
  const text = renderOrderConfirmationText(data);

  try {
    const { data: result, error } = await getResend().emails.send({
      from: fromEmail,
      to: data.to,
      subject,
      html,
      text,
    });

    if (error) {
      console.error("Error sending order confirmation:", error);
      return { success: false, error: error.message, subject };
    }

    return { success: true, id: result?.id, subject };
  } catch (error) {
    console.error("Error sending order confirmation:", error);
    return { success: false, error: "Failed to send email", subject };
  }
}

/**
 * Send shipping notification with tracking
 */
export async function sendShippingNotification(data: {
  to: string;
  customerName: string;
  orderNumber: string;
  trackingNumber: string;
}) {
  const { to, customerName, orderNumber, trackingNumber } = data;

  const html = `
    <div style="max-width: 600px; margin: 0 auto; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      <div style="padding: 32px 24px; text-align: center; border-bottom: 1px solid #DCE7EB;">
        <h1 style="font-size: 24px; font-weight: 700; color: #07203A; margin: 0;">VYTA</h1>
        <p style="font-size: 11px; letter-spacing: 0.15em; color: #438B9E; margin: 4px 0 0; text-transform: uppercase;">Biosciences</p>
      </div>

      <div style="padding: 32px 24px;">
        <h2 style="font-size: 20px; font-weight: 600; color: #07203A; margin: 0 0 8px;">Your Order Has Shipped!</h2>
        <p style="font-size: 14px; color: #56707F; margin: 0 0 24px;">
          Hi ${customerName}, great news! Your order is on its way.
        </p>

        <div style="background: #F7FAFB; border-radius: 8px; padding: 20px; margin-bottom: 16px;">
          <p style="font-size: 12px; color: #56707F; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 0.05em;">Order Number</p>
          <p style="font-size: 16px; font-weight: 600; color: #07203A; margin: 0; font-family: monospace;">${orderNumber}</p>
        </div>

        <div style="background: #F7FAFB; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
          <p style="font-size: 12px; color: #56707F; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 0.05em;">Tracking Number</p>
          <p style="font-size: 16px; font-weight: 600; color: #07203A; margin: 0; font-family: monospace;">${trackingNumber}</p>
        </div>

        <p style="font-size: 14px; color: #56707F; margin: 0;">
          You can track your package using the tracking number above with your carrier's website.
        </p>
      </div>

      <div style="padding: 24px; text-align: center; background: #F7FAFB; border-top: 1px solid #DCE7EB;">
        <p style="font-size: 12px; color: #6E8898; margin: 0;">
          VYTA Biosciences &bull; Canada<br/>
          Questions? Reply to this email.
        </p>
      </div>
    </div>
  `;

  try {
    const { data: result, error } = await getResend().emails.send({
      from: fromEmail,
      to,
      subject: `Your Order Has Shipped - ${orderNumber}`,
      html,
    });

    if (error) {
      console.error("Error sending shipping notification:", error);
      return { success: false, error: error.message };
    }

    return { success: true, id: result?.id };
  } catch (error) {
    console.error("Error sending shipping notification:", error);
    return { success: false, error: "Failed to send email" };
  }
}

/**
 * Send welcome email to new customer
 */
export async function sendCustomerWelcome(data: {
  to: string;
  customerName: string;
}) {
  const { to, customerName } = data;

  const html = `
    <div style="max-width: 600px; margin: 0 auto; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      <div style="padding: 32px 24px; text-align: center; border-bottom: 1px solid #DCE7EB;">
        <h1 style="font-size: 24px; font-weight: 700; color: #07203A; margin: 0;">VYTA</h1>
        <p style="font-size: 11px; letter-spacing: 0.15em; color: #438B9E; margin: 4px 0 0; text-transform: uppercase;">Biosciences</p>
      </div>

      <div style="padding: 32px 24px; text-align: center;">
        <h2 style="font-size: 20px; font-weight: 600; color: #07203A; margin: 0 0 8px;">Welcome to VYTA!</h2>
        <p style="font-size: 14px; color: #56707F; margin: 0 0 24px;">
          Hi ${customerName}, thanks for creating an account. You're all set to start shopping for premium Canadian peptides.
        </p>
        <a href="${SITE_URL}/products" style="display: inline-block; padding: 12px 24px; background: #07203A; color: #FFFFFF; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: 600;">
          Browse Products
        </a>
      </div>

      <div style="padding: 24px; text-align: center; background: #F7FAFB; border-top: 1px solid #DCE7EB;">
        <p style="font-size: 12px; color: #6E8898; margin: 0;">
          VYTA Biosciences &bull; Canada<br/>
          Questions? Reply to this email.
        </p>
      </div>
    </div>
  `;

  try {
    const { data: result, error } = await getResend().emails.send({
      from: fromEmail,
      to,
      subject: "Welcome to VYTA!",
      html,
    });

    if (error) {
      console.error("Error sending welcome email:", error);
      return { success: false, error: error.message };
    }

    return { success: true, id: result?.id };
  } catch (error) {
    console.error("Error sending welcome email:", error);
    return { success: false, error: "Failed to send email" };
  }
}

/**
 * Send welcome email to new affiliate
 */
export async function sendAffiliateWelcome(data: {
  to: string;
  affiliateName: string;
  referralCode: string;
}) {
  const { to, affiliateName, referralCode } = data;
  const baseUrl = SITE_URL;

  const html = `
    <div style="max-width: 600px; margin: 0 auto; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      <div style="padding: 32px 24px; text-align: center; border-bottom: 1px solid #DCE7EB;">
        <h1 style="font-size: 24px; font-weight: 700; color: #07203A; margin: 0;">VYTA</h1>
        <p style="font-size: 11px; letter-spacing: 0.15em; color: #438B9E; margin: 4px 0 0; text-transform: uppercase;">Affiliate Program</p>
      </div>

      <div style="padding: 32px 24px;">
        <h2 style="font-size: 20px; font-weight: 600; color: #07203A; margin: 0 0 8px;">Welcome to the Affiliate Program!</h2>
        <p style="font-size: 14px; color: #56707F; margin: 0 0 24px;">
          Hi ${affiliateName}, your affiliate account is ready. Start sharing your referral code and earn commission on every sale.
        </p>

        <div style="background: #F7FAFB; border-radius: 8px; padding: 24px; margin-bottom: 24px; text-align: center;">
          <p style="font-size: 12px; color: #56707F; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.05em;">Your Referral Code</p>
          <p style="font-size: 28px; font-weight: 700; color: #07203A; margin: 0; font-family: monospace; letter-spacing: 0.1em;">${referralCode}</p>
        </div>

        <div style="background: #F7FAFB; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
          <p style="font-size: 12px; color: #56707F; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 0.05em;">Your Referral URL</p>
          <p style="font-size: 13px; color: #07203A; margin: 0; font-family: monospace; word-break: break-all;">${baseUrl}?ref=${referralCode}</p>
        </div>

        <div style="text-align: center;">
          <a href="${baseUrl}/affiliate/dashboard" style="display: inline-block; padding: 12px 24px; background: #07203A; color: #FFFFFF; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: 600;">
            Go to Dashboard
          </a>
        </div>
      </div>

      <div style="padding: 24px; text-align: center; background: #F7FAFB; border-top: 1px solid #DCE7EB;">
        <p style="font-size: 12px; color: #6E8898; margin: 0;">
          VYTA Biosciences &bull; Canada<br/>
          Questions? Reply to this email.
        </p>
      </div>
    </div>
  `;

  try {
    const { data: result, error } = await getResend().emails.send({
      from: fromEmail,
      to,
      subject: "Welcome to the VYTA Affiliate Program!",
      html,
    });

    if (error) {
      console.error("Error sending affiliate welcome:", error);
      return { success: false, error: error.message };
    }

    return { success: true, id: result?.id };
  } catch (error) {
    console.error("Error sending affiliate welcome:", error);
    return { success: false, error: "Failed to send email" };
  }
}

/**
 * Tell an affiliate their referral code changed.
 *
 * Sent only after the new code is actually saved. Never throws — the caller
 * reports the outcome alongside a successful save rather than failing it.
 */
export async function sendReferralCodeChanged(data: {
  to: string;
  affiliateName: string;
  newCode: string;
  previousCode?: string | null;
}) {
  const { to, affiliateName, newCode, previousCode } = data;
  const baseUrl = SITE_URL;
  const greeting = affiliateName ? `Hi ${escapeHtml(affiliateName)}, y` : "Y";

  const retiredBlock = previousCode
    ? `
        <div style="background: #FFFBEB; border: 1px solid #FDE68A; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
          <p style="font-size: 13px; color: #92400E; margin: 0; line-height: 1.6;">
            Your old code <strong style="font-family: monospace;">${escapeHtml(previousCode)}</strong> has been retired and no longer works.
            Update any links, cards or posts that still carry it.
            Sales and commissions already recorded stay with you.
          </p>
        </div>`
    : "";

  const html = `
    <div style="max-width: 600px; margin: 0 auto; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      <div style="padding: 32px 24px; text-align: center; border-bottom: 1px solid #DCE7EB;">
        <h1 style="font-size: 24px; font-weight: 700; color: #07203A; margin: 0;">VYTA</h1>
        <p style="font-size: 11px; letter-spacing: 0.15em; color: #438B9E; margin: 4px 0 0; text-transform: uppercase;">Affiliate Program</p>
      </div>

      <div style="padding: 32px 24px;">
        <h2 style="font-size: 20px; font-weight: 600; color: #07203A; margin: 0 0 8px;">Your referral code has changed</h2>
        <p style="font-size: 14px; color: #56707F; margin: 0 0 24px;">
          ${greeting}our customers should use the code below from now on.
        </p>

        <div style="background: #F7FAFB; border-radius: 8px; padding: 24px; margin-bottom: 24px; text-align: center;">
          <p style="font-size: 12px; color: #56707F; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.05em;">Your New Referral Code</p>
          <p style="font-size: 28px; font-weight: 700; color: #07203A; margin: 0; font-family: monospace; letter-spacing: 0.1em;">${escapeHtml(newCode)}</p>
        </div>
${retiredBlock}
        <div style="background: #F7FAFB; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
          <p style="font-size: 12px; color: #56707F; margin: 0 0 4px; text-transform: uppercase; letter-spacing: 0.05em;">Your Referral URL</p>
          <p style="font-size: 13px; color: #07203A; margin: 0; font-family: monospace; word-break: break-all;">${baseUrl}?ref=${escapeHtml(newCode)}</p>
        </div>

        <div style="text-align: center;">
          <a href="${baseUrl}/affiliate/dashboard" style="display: inline-block; padding: 12px 24px; background: #07203A; color: #FFFFFF; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: 600;">
            Go to Dashboard
          </a>
        </div>
      </div>

      <div style="padding: 24px; text-align: center; background: #F7FAFB; border-top: 1px solid #DCE7EB;">
        <p style="font-size: 12px; color: #6E8898; margin: 0;">
          VYTA Biosciences &bull; Canada<br/>
          Questions? Reply to this email.
        </p>
      </div>
    </div>
  `;

  try {
    const { data: result, error } = await getResend().emails.send({
      from: fromEmail,
      to,
      subject: `Your VYTA referral code is now ${newCode}`,
      html,
    });

    if (error) {
      console.error("Error sending referral code change:", error);
      return { success: false as const, error: error.message };
    }

    return { success: true as const, id: result?.id };
  } catch (error) {
    console.error("Error sending referral code change:", error);
    return { success: false as const, error: "Failed to send email" };
  }
}

/**
 * Send payment confirmed notification
 */
export async function sendPaymentConfirmed(data: {
  to: string;
  orderNumber: string;
}) {
  const { to, orderNumber } = data;
  const baseUrl = SITE_URL;

  const html = `
    <div style="max-width: 600px; margin: 0 auto; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      <div style="padding: 32px 24px; text-align: center; border-bottom: 1px solid #DCE7EB;">
        <h1 style="font-size: 24px; font-weight: 700; color: #07203A; margin: 0;">VYTA</h1>
        <p style="font-size: 11px; letter-spacing: 0.15em; color: #438B9E; margin: 4px 0 0; text-transform: uppercase;">Biosciences</p>
      </div>
      <div style="padding: 32px 24px; text-align: center;">
        <div style="width: 48px; height: 48px; background: #ECFDF5; border-radius: 50%; margin: 0 auto 16px; display: flex; align-items: center; justify-content: center;">
          <span style="font-size: 24px;">&#10003;</span>
        </div>
        <h2 style="font-size: 20px; font-weight: 600; color: #07203A; margin: 0 0 8px;">Payment Confirmed!</h2>
        <p style="font-size: 14px; color: #56707F; margin: 0 0 24px;">
          Your payment for order <strong>${orderNumber}</strong> has been received and confirmed on the blockchain.
        </p>
        <div style="background: #F7FAFB; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
          <p style="font-size: 12px; color: #56707F; margin: 0 0 4px;">Your order is now being processed and will ship within 24-48 hours.</p>
        </div>
        <a href="${baseUrl}/order/track?order=${orderNumber}" style="display: inline-block; padding: 12px 24px; background: #07203A; color: #FFFFFF; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: 600;">
          Track Your Order
        </a>
      </div>
      <div style="padding: 24px; text-align: center; background: #F7FAFB; border-top: 1px solid #DCE7EB;">
        <p style="font-size: 12px; color: #6E8898; margin: 0;">VYTA Biosciences &bull; Canada<br/>Questions? Reply to this email.</p>
      </div>
    </div>
  `;

  try {
    const { data: result, error } = await getResend().emails.send({
      from: fromEmail,
      to,
      subject: `Payment Confirmed - ${orderNumber}`,
      html,
    });

    if (error) {
      console.error("Error sending payment confirmed:", error);
      return { success: false, error: error.message };
    }
    return { success: true, id: result?.id };
  } catch (error) {
    console.error("Error sending payment confirmed:", error);
    return { success: false, error: "Failed to send email" };
  }
}

/**
 * Send admin notification when payment is confirmed
 */
export async function sendAdminPaymentNotification(data: {
  orderNumber: string;
  total: number;
  crypto: string;
  paymentAmount: string;
  customerEmail?: string;
  items: Array<{ name: string; quantity: number }>;
}) {
  const { orderNumber, total, crypto, paymentAmount, customerEmail, items } =
    data;
  const baseUrl = SITE_URL;

  const itemList = items
    .map(
      (i) =>
        `<li style="font-size: 14px; color: #07203A; padding: 4px 0;">${i.name} x${i.quantity}</li>`,
    )
    .join("");

  const html = `
    <div style="max-width: 600px; margin: 0 auto; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      <div style="padding: 32px 24px; text-align: center; border-bottom: 1px solid #DCE7EB;">
        <h1 style="font-size: 24px; font-weight: 700; color: #07203A; margin: 0;">VYTA</h1>
        <p style="font-size: 11px; letter-spacing: 0.15em; color: #438B9E; margin: 4px 0 0; text-transform: uppercase;">Admin Notification</p>
      </div>

      <div style="padding: 32px 24px;">
        <div style="background: #ECFDF5; border: 1px solid #A7F3D0; border-radius: 8px; padding: 16px; margin-bottom: 24px; text-align: center;">
          <h2 style="font-size: 18px; font-weight: 600; color: #065F46; margin: 0;">Payment Received!</h2>
        </div>

        <div style="background: #F7FAFB; border-radius: 8px; padding: 16px; margin-bottom: 16px;">
          <table style="width: 100%;">
            <tr>
              <td style="font-size: 12px; color: #56707F; padding: 6px 0; text-transform: uppercase; letter-spacing: 0.05em;">Order</td>
              <td style="font-size: 14px; font-weight: 600; color: #07203A; padding: 6px 0; text-align: right; font-family: monospace;">${orderNumber}</td>
            </tr>
            <tr>
              <td style="font-size: 12px; color: #56707F; padding: 6px 0; text-transform: uppercase; letter-spacing: 0.05em;">Total (CAD)</td>
              <td style="font-size: 14px; font-weight: 600; color: #07203A; padding: 6px 0; text-align: right;">$${total.toFixed(2)}</td>
            </tr>
            <tr>
              <td style="font-size: 12px; color: #56707F; padding: 6px 0; text-transform: uppercase; letter-spacing: 0.05em;">Paid</td>
              <td style="font-size: 14px; font-weight: 600; color: #07203A; padding: 6px 0; text-align: right;">${paymentAmount} ${crypto.toUpperCase()}</td>
            </tr>
            ${
              customerEmail
                ? `<tr>
              <td style="font-size: 12px; color: #56707F; padding: 6px 0; text-transform: uppercase; letter-spacing: 0.05em;">Customer</td>
              <td style="font-size: 14px; color: #07203A; padding: 6px 0; text-align: right;">${customerEmail}</td>
            </tr>`
                : ""
            }
          </table>
        </div>

        <div style="margin-bottom: 24px;">
          <p style="font-size: 12px; color: #56707F; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.05em;">Items</p>
          <ul style="margin: 0; padding: 0 0 0 20px;">${itemList}</ul>
        </div>

        <div style="text-align: center;">
          <a href="${baseUrl}/admin/orders" style="display: inline-block; padding: 12px 24px; background: #07203A; color: #FFFFFF; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: 600;">
            View in Admin
          </a>
        </div>
      </div>
    </div>
  `;

  try {
    const { data: result, error } = await getResend().emails.send({
      from: fromEmail,
      to: "info@aminocan.com",
      subject: `Payment Received - ${orderNumber} - $${total.toFixed(2)} CAD`,
      html,
    });

    if (error) {
      console.error("Error sending admin notification:", error);
      return { success: false, error: error.message };
    }
    return { success: true, id: result?.id };
  } catch (error) {
    console.error("Error sending admin notification:", error);
    return { success: false, error: "Failed to send email" };
  }
}

/**
 * Notify a customer that their affiliate application was approved or denied.
 * On approval, includes their new referral code + referral URL.
 */
export async function sendAffiliateRequestDecision(data: {
  to: string;
  customerName: string;
  approved: boolean;
  referralCode?: string;
}) {
  const { to, customerName, approved, referralCode } = data;
  const baseUrl = SITE_URL;

  const body = approved
    ? `
        <h2 style="font-size: 20px; font-weight: 600; color: #07203A; margin: 0 0 8px;">You're an Affiliate!</h2>
        <p style="font-size: 14px; color: #56707F; margin: 0 0 24px;">
          Hi ${customerName}, your affiliate application has been approved. Start sharing your referral code to earn commission on every sale.
        </p>
        ${
          referralCode
            ? `<div style="background: #F7FAFB; border-radius: 8px; padding: 24px; margin-bottom: 24px; text-align: center;">
          <p style="font-size: 12px; color: #56707F; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.05em;">Your Referral Code</p>
          <p style="font-size: 28px; font-weight: 700; color: #07203A; margin: 0; font-family: monospace; letter-spacing: 0.1em;">${referralCode}</p>
          <p style="font-size: 13px; color: #07203A; margin: 12px 0 0; font-family: monospace; word-break: break-all;">${baseUrl}?ref=${referralCode}</p>
        </div>`
            : ""
        }
        <div style="text-align: center;">
          <a href="${baseUrl}/admin" style="display: inline-block; padding: 12px 24px; background: #07203A; color: #FFFFFF; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: 600;">
            Go to Dashboard
          </a>
        </div>`
    : `
        <h2 style="font-size: 20px; font-weight: 600; color: #07203A; margin: 0 0 8px;">Affiliate Application Update</h2>
        <p style="font-size: 14px; color: #56707F; margin: 0 0 24px;">
          Hi ${customerName}, thank you for your interest in our affiliate program. After review, we're unable to approve your application at this time. Feel free to reach out if you have any questions.
        </p>`;

  const html = `
    <div style="max-width: 600px; margin: 0 auto; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      <div style="padding: 32px 24px; text-align: center; border-bottom: 1px solid #DCE7EB;">
        <h1 style="font-size: 24px; font-weight: 700; color: #07203A; margin: 0;">VYTA</h1>
        <p style="font-size: 11px; letter-spacing: 0.15em; color: #438B9E; margin: 4px 0 0; text-transform: uppercase;">Affiliate Program</p>
      </div>
      <div style="padding: 32px 24px;">
        ${body}
      </div>
      <div style="padding: 24px; text-align: center; background: #F7FAFB; border-top: 1px solid #DCE7EB;">
        <p style="font-size: 12px; color: #6E8898; margin: 0;">
          VYTA Biosciences &bull; Canada<br/>
          Questions? Reply to this email.
        </p>
      </div>
    </div>
  `;

  try {
    const { data: result, error } = await getResend().emails.send({
      from: fromEmail,
      to,
      subject: approved
        ? "Your VYTA Affiliate Application is Approved!"
        : "VYTA Affiliate Application Update",
      html,
    });

    if (error) {
      console.error("Error sending affiliate request decision:", error);
      return { success: false, error: error.message };
    }
    return { success: true, id: result?.id };
  } catch (error) {
    console.error("Error sending affiliate request decision:", error);
    return { success: false, error: "Failed to send email" };
  }
}

/**
 * Notify admins that a customer has applied to become an affiliate.
 * Falls back to info@aminocan.com when no explicit recipients are supplied.
 */
export async function sendAffiliateRequestAdminNotification(data: {
  customerName: string;
  customerEmail: string;
  walletAddress?: string | null;
  message?: string | null;
  to?: string[];
}) {
  const { customerName, customerEmail, walletAddress, message, to } = data;
  const baseUrl = SITE_URL;
  const recipients = to && to.length > 0 ? to : ["info@aminocan.com"];

  const html = `
    <div style="max-width: 600px; margin: 0 auto; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      <div style="padding: 32px 24px; text-align: center; border-bottom: 1px solid #DCE7EB;">
        <h1 style="font-size: 24px; font-weight: 700; color: #07203A; margin: 0;">VYTA</h1>
        <p style="font-size: 11px; letter-spacing: 0.15em; color: #438B9E; margin: 4px 0 0; text-transform: uppercase;">Admin Notification</p>
      </div>
      <div style="padding: 32px 24px;">
        <div style="background: #F1F8F9; border: 1px solid #C4DFE3; border-radius: 8px; padding: 16px; margin-bottom: 24px; text-align: center;">
          <h2 style="font-size: 18px; font-weight: 600; color: #1B5D83; margin: 0;">New Affiliate Application</h2>
        </div>
        <div style="background: #F7FAFB; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
          <table style="width: 100%;">
            <tr>
              <td style="font-size: 12px; color: #56707F; padding: 6px 0; text-transform: uppercase; letter-spacing: 0.05em;">Name</td>
              <td style="font-size: 14px; font-weight: 600; color: #07203A; padding: 6px 0; text-align: right;">${customerName}</td>
            </tr>
            <tr>
              <td style="font-size: 12px; color: #56707F; padding: 6px 0; text-transform: uppercase; letter-spacing: 0.05em;">Email</td>
              <td style="font-size: 14px; color: #07203A; padding: 6px 0; text-align: right;">${customerEmail}</td>
            </tr>
            ${
              walletAddress
                ? `<tr>
              <td style="font-size: 12px; color: #56707F; padding: 6px 0; text-transform: uppercase; letter-spacing: 0.05em;">Wallet</td>
              <td style="font-size: 13px; color: #07203A; padding: 6px 0; text-align: right; font-family: monospace;">${walletAddress}</td>
            </tr>`
                : ""
            }
          </table>
        </div>
        ${
          message
            ? `<div style="margin-bottom: 24px;">
          <p style="font-size: 12px; color: #56707F; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.05em;">Message</p>
          <p style="font-size: 14px; color: #07203A; margin: 0; white-space: pre-wrap;">${message}</p>
        </div>`
            : ""
        }
        <div style="text-align: center;">
          <a href="${baseUrl}/admin/affiliates" style="display: inline-block; padding: 12px 24px; background: #07203A; color: #FFFFFF; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: 600;">
            Review in Admin
          </a>
        </div>
      </div>
    </div>
  `;

  try {
    const { data: result, error } = await getResend().emails.send({
      from: fromEmail,
      to: recipients,
      subject: `New Affiliate Application - ${customerName}`,
      html,
    });

    if (error) {
      console.error("Error sending affiliate request admin notification:", error);
      return { success: false, error: error.message };
    }
    return { success: true, id: result?.id };
  } catch (error) {
    console.error("Error sending affiliate request admin notification:", error);
    return { success: false, error: "Failed to send email" };
  }
}

/**
 * Notify a waitlisted customer that an out-of-stock product is back.
 * Fired on the 0 -> positive restock edge from the admin product PATCH.
 */
export async function sendBackInStockNotification(data: {
  to: string;
  productName: string;
  productSlug?: string | null;
  /** Public URL identifier. Preferred over productSlug, which is the SKU. */
  productUrlSlug?: string | null;
  imageUrl?: string | null;
  strength?: string | null;
  price?: number | null;
}) {
  const { to, productName, productSlug, productUrlSlug, imageUrl, strength, price } = data;
  const baseUrl = SITE_URL;
  // Link the public URL, falling back to the SKU slug for a row that predates
  // url_slug — the product route resolves either.
  const productUrl = `${baseUrl}${productPath({ slug: productSlug, url_slug: productUrlSlug })}`;

  const html = `
    <div style="max-width: 600px; margin: 0 auto; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      <div style="padding: 32px 24px; text-align: center; border-bottom: 1px solid #DCE7EB;">
        <h1 style="font-size: 24px; font-weight: 700; color: #07203A; margin: 0;">VYTA</h1>
        <p style="font-size: 11px; letter-spacing: 0.15em; color: #438B9E; margin: 4px 0 0; text-transform: uppercase;">Biosciences</p>
      </div>
      <div style="padding: 32px 24px;">
        <div style="width: 48px; height: 48px; background: #ECFDF5; border-radius: 50%; margin: 0 auto 16px; display: flex; align-items: center; justify-content: center;">
          <span style="font-size: 24px;">&#10003;</span>
        </div>
        <h2 style="font-size: 20px; font-weight: 600; color: #07203A; margin: 0 0 8px; text-align: center;">Back in stock!</h2>
        <p style="font-size: 14px; color: #56707F; margin: 0 0 24px; text-align: center;">
          Good news &mdash; a product you asked about is available again.
        </p>
        <div style="display: flex; align-items: center; gap: 16px; background: #F7FAFB; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
          ${imageUrl ? `<img src="${imageUrl}" alt="" width="64" height="64" style="border-radius: 8px; object-fit: cover; border: 1px solid #DCE7EB;" />` : ""}
          <div>
            <p style="font-size: 15px; font-weight: 600; color: #07203A; margin: 0 0 2px;">${productName}${strength ? ` &middot; ${strength}` : ""}</p>
            ${price != null ? `<p style="font-size: 14px; color: #438B9E; margin: 0; font-weight: 600;">$${Number(price).toFixed(2)}</p>` : ""}
          </div>
        </div>
        <div style="text-align: center;">
          <a href="${productUrl}" style="display: inline-block; padding: 12px 24px; background: #07203A; color: #FFFFFF; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: 600;">
            Shop now
          </a>
        </div>
      </div>
      <div style="padding: 24px; text-align: center; background: #F7FAFB; border-top: 1px solid #DCE7EB;">
        <p style="font-size: 12px; color: #6E8898; margin: 0;">VYTA Biosciences &bull; Canada<br/>You received this because you signed up for a back-in-stock alert.</p>
      </div>
    </div>
  `;

  try {
    const { data: result, error } = await getResend().emails.send({
      from: fromEmail,
      to,
      subject: `Back in stock: ${productName}`,
      html,
    });

    if (error) {
      console.error("Error sending back-in-stock notification:", error);
      return { success: false, error: error.message };
    }
    return { success: true, id: result?.id };
  } catch (error) {
    console.error("Error sending back-in-stock notification:", error);
    return { success: false, error: "Failed to send email" };
  }
}

/**
 * Alert admins that a product has crossed its low-stock threshold.
 */
export async function sendLowStockAlert(data: {
  to: string | string[];
  productName: string;
  sku?: string | null;
  stockQuantity: number;
  threshold: number;
}) {
  const { to, productName, sku, stockQuantity, threshold } = data;
  const baseUrl = SITE_URL;

  const html = `
    <div style="max-width: 600px; margin: 0 auto; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      <div style="padding: 32px 24px; text-align: center; border-bottom: 1px solid #DCE7EB;">
        <h1 style="font-size: 24px; font-weight: 700; color: #07203A; margin: 0;">VYTA</h1>
        <p style="font-size: 11px; letter-spacing: 0.15em; color: #438B9E; margin: 4px 0 0; text-transform: uppercase;">Admin Alert</p>
      </div>
      <div style="padding: 32px 24px;">
        <div style="width: 48px; height: 48px; background: #FEF3C7; border-radius: 50%; margin: 0 auto 16px; display: flex; align-items: center; justify-content: center;">
          <span style="font-size: 24px;">&#9888;</span>
        </div>
        <h2 style="font-size: 20px; font-weight: 600; color: #07203A; margin: 0 0 8px; text-align: center;">Low stock alert</h2>
        <p style="font-size: 14px; color: #56707F; margin: 0 0 24px; text-align: center;">
          A product has dropped to or below its reorder threshold.
        </p>
        <div style="background: #F7FAFB; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
          <p style="font-size: 15px; font-weight: 600; color: #07203A; margin: 0 0 4px;">${productName}${sku ? ` <span style="color:#6E8898; font-weight:400;">(${sku})</span>` : ""}</p>
          <p style="font-size: 14px; color: #B45309; margin: 0; font-weight: 600;">${stockQuantity} in stock &middot; threshold ${threshold}</p>
        </div>
        <div style="text-align: center;">
          <a href="${baseUrl}/admin/products" style="display: inline-block; padding: 12px 24px; background: #07203A; color: #FFFFFF; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: 600;">
            Manage products
          </a>
        </div>
      </div>
      <div style="padding: 24px; text-align: center; background: #F7FAFB; border-top: 1px solid #DCE7EB;">
        <p style="font-size: 12px; color: #6E8898; margin: 0;">VYTA Biosciences &bull; Operational alert</p>
      </div>
    </div>
  `;

  try {
    const { data: result, error } = await getResend().emails.send({
      from: fromEmail,
      to,
      subject: `Low stock: ${productName} (${stockQuantity} left)`,
      html,
    });

    if (error) {
      console.error("Error sending low-stock alert:", error);
      return { success: false, error: error.message };
    }
    return { success: true, id: result?.id };
  } catch (error) {
    console.error("Error sending low-stock alert:", error);
    return { success: false, error: "Failed to send email" };
  }
}

// =================================================================
//  Shared HTML helpers
// =================================================================

export function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The chrome every VYTA email is served in: a dark masthead over a white
 * card, floated on a warm off-white page, with the footer outside the card.
 *
 * The wordmark is set in Inter (VYTA's display face), falling through to the
 * platform UI sans where the client has no webfont, reversed out of Midnight
 * Navy — so an order confirmation and a recovery email
 * open with the same masthead.
 *
 * Table-built rather than nested divs so Outlook honours the 600px measure
 * instead of laying the message out full-bleed; the radius is split across the
 * two cells to keep the card's corners round where they meet. `inner` brings
 * its own padding (every caller wraps its content in a padded div), so the
 * card adds none.
 *
 * `renderPromoEmail` in lib/customer/promo-email.ts restates this shell — it
 * has to stay free of server-only imports — so the two are meant to look
 * alike: a change here belongs there too.
 */
export function vytaShell(inner: string): string {
  const display = `Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif`;
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-collapse: collapse; background: #EDF3F5;">
      <tr>
        <td align="center" style="padding: 36px 12px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width: 100%; max-width: 600px; border-collapse: separate;">
            <tr>
              <td style="background: #05182B; border-radius: 20px 20px 0 0; padding: 38px 32px 34px; text-align: center;">
                <p style="font-family: ${display}; font-size: 26px; font-weight: 400; letter-spacing: 0.34em; text-indent: 0.34em; color: #C4DFE3; margin: 0;">VYTA</p>
                <p style="font-size: 9px; font-weight: 600; letter-spacing: 0.3em; text-indent: 0.3em; text-transform: uppercase; color: #6EB2B8; margin: 10px 0 0;">Biosciences</p>
              </td>
            </tr>
            <tr>
              <td style="background: #FFFFFF; border: 1px solid #DCE7EB; border-top: 0; border-radius: 0 0 20px 20px;">
                ${inner}
              </td>
            </tr>
            <tr>
              <td style="padding: 22px 12px 4px; text-align: center;">
                <p style="font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: #6E8898; margin: 0;">VYTA · Canadian research peptides</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `;
}

// =================================================================
//  REGISTRATION ALERTS — new signup + abandoned registration
// =================================================================
//
// Both go to the operational recipient list (site_settings.admin_emails) and
// carry a prominent "View customer" button that deep-links to the admin
// customer-insights page (/admin/customers/[id]). That page is gated by the
// admin layout + admin API auth, so the link is safe to email.

/**
 * A large, nicely-styled call-to-action button used in the registration alert
 * emails. Rendered as a bordered, rounded "pill" so it reads as a button in
 * every mail client (including those that strip background colours).
 */
function insightsButton(url: string, label: string): string {
  return `
    <div style="text-align: center; margin: 8px 0 4px;">
      <a href="${url}"
         style="display: inline-block; padding: 14px 32px; background: #07203A; color: #FFFFFF; text-decoration: none; border-radius: 10px; font-size: 15px; font-weight: 700; letter-spacing: 0.01em; box-shadow: 0 2px 6px rgba(7,32,58,0.25); border: 1px solid #07203A;">
        ${escapeHtml(label)} &nbsp;&rarr;
      </a>
    </div>
    <p style="text-align:center; font-size:11px; color:#6E8898; margin: 12px 0 0;">
      You'll be asked to sign in as an admin to view this page.
    </p>
  `;
}

/**
 * Fired the moment a customer registers. Lets the team jump straight to the
 * customer's insights page to see what they're interested in and, optionally,
 * claim them as their point of contact.
 */
export async function sendRegistrationAlert(data: {
  to: string | string[];
  customerName: string;
  customerEmail: string;
  contactConsent: boolean;
  customerId: string;
}) {
  const { to, customerName, customerEmail, contactConsent, customerId } = data;
  if (!to || (Array.isArray(to) && to.length === 0)) {
    return { success: false, error: "no admin recipients" };
  }
  const baseUrl = SITE_URL;
  const insightsUrl = `${baseUrl}/admin/customers/${customerId}`;

  const html = vytaShell(`
    <div style="padding: 32px 24px;">
      <div style="background: #F1F8F9; border: 1px solid #C4DFE3; border-radius: 8px; padding: 16px; margin-bottom: 24px; text-align: center;">
        <h2 style="font-size: 18px; font-weight: 600; color: #07203A; margin: 0;">New customer registered</h2>
      </div>

      <table style="width:100%; border-collapse:collapse; margin-bottom: 24px;">
        <tbody>
          <tr><td style="padding:6px 0; font-size:13px; color:#56707F; width:140px;">Name</td>
              <td style="padding:6px 0; font-size:14px; color:#07203A; font-weight:600;">${escapeHtml(customerName)}</td></tr>
          <tr><td style="padding:6px 0; font-size:13px; color:#56707F;">Email</td>
              <td style="padding:6px 0; font-size:14px; color:#07203A;">${escapeHtml(customerEmail)}</td></tr>
          <tr><td style="padding:6px 0; font-size:13px; color:#56707F;">Contact consent</td>
              <td style="padding:6px 0; font-size:14px; color:${contactConsent ? "#047857" : "#B45309"}; font-weight:600;">
                ${contactConsent ? "Yes — happy to be contacted" : "No consent given"}
              </td></tr>
        </tbody>
      </table>

      <p style="font-size: 14px; color: #56707F; margin: 0 0 20px; text-align:center;">
        Open their insights page to see what they searched for, viewed and added to cart — and claim them as your customer.
      </p>

      ${insightsButton(insightsUrl, "View customer")}
    </div>
  `);

  try {
    const { data: result, error } = await getResend().emails.send({
      from: fromEmail,
      to,
      subject: `New registration: ${customerName || customerEmail}`,
      html,
    });
    if (error) {
      console.error("Error sending registration alert:", error);
      return { success: false, error: error.message };
    }
    return { success: true, id: result?.id };
  } catch (error) {
    console.error("Error sending registration alert:", error);
    return { success: false, error: "Failed to send email" };
  }
}

/**
 * Fired by cron when a registered customer still hasn't checked out after the
 * configured delay (default 12h). Nudges the team to reach out.
 */
export async function sendAbandonedRegistrationAlert(data: {
  to: string | string[];
  customerName: string;
  customerEmail: string;
  hoursElapsed: number;
  contactConsent: boolean;
  customerId: string;
}) {
  const { to, customerName, customerEmail, hoursElapsed, contactConsent, customerId } = data;
  if (!to || (Array.isArray(to) && to.length === 0)) {
    return { success: false, error: "no admin recipients" };
  }
  const baseUrl = SITE_URL;
  const insightsUrl = `${baseUrl}/admin/customers/${customerId}`;

  const html = vytaShell(`
    <div style="padding: 32px 24px;">
      <div style="background: #FEF3C7; border: 1px solid #FDE68A; border-radius: 8px; padding: 16px; margin-bottom: 24px; text-align: center;">
        <h2 style="font-size: 18px; font-weight: 600; color: #92400E; margin: 0;">Registered but hasn't checked out</h2>
      </div>

      <table style="width:100%; border-collapse:collapse; margin-bottom: 24px;">
        <tbody>
          <tr><td style="padding:6px 0; font-size:13px; color:#56707F; width:140px;">Name</td>
              <td style="padding:6px 0; font-size:14px; color:#07203A; font-weight:600;">${escapeHtml(customerName)}</td></tr>
          <tr><td style="padding:6px 0; font-size:13px; color:#56707F;">Email</td>
              <td style="padding:6px 0; font-size:14px; color:#07203A;">${escapeHtml(customerEmail)}</td></tr>
          <tr><td style="padding:6px 0; font-size:13px; color:#56707F;">Waited</td>
              <td style="padding:6px 0; font-size:14px; color:#07203A;">~${Math.round(hoursElapsed)} hours since registering</td></tr>
          <tr><td style="padding:6px 0; font-size:13px; color:#56707F;">Contact consent</td>
              <td style="padding:6px 0; font-size:14px; color:${contactConsent ? "#047857" : "#B45309"}; font-weight:600;">
                ${contactConsent ? "Yes — happy to be contacted" : "No consent given"}
              </td></tr>
        </tbody>
      </table>

      <p style="font-size: 14px; color: #56707F; margin: 0 0 20px; text-align:center;">
        This might be a good moment to reach out. Review what they were interested in and claim them below.
      </p>

      ${insightsButton(insightsUrl, "View customer")}
    </div>
  `);

  try {
    const { data: result, error } = await getResend().emails.send({
      from: fromEmail,
      to,
      subject: `No checkout yet: ${customerName || customerEmail}`,
      html,
    });
    if (error) {
      console.error("Error sending abandoned-registration alert:", error);
      return { success: false, error: error.message };
    }
    return { success: true, id: result?.id };
  } catch (error) {
    console.error("Error sending abandoned-registration alert:", error);
    return { success: false, error: "Failed to send email" };
  }
}

/**
 * Tell the admins an order has been paid, to the operational list from
 * `getAdminAlertEmails`. Sent once per Stealth Health order automatically by
 * lib/admin/stealth-health-paid-alert.ts, and by hand from the invoice page for
 * Stealth Health and manual invoices (`source: 'manual'`). Never throws;
 * `subject` is returned on every branch so the caller can log it.
 */
export async function sendStealthHealthOrderAlert(data: {
  to: string | string[];
  invoiceId: string;
  invoiceNumber: string | null;
  customerName: string | null;
  customerEmail: string | null;
  items: Array<{ description: string; qty: number; lineTotal: number }>;
  subtotal: number;
  shipping: number;
  shippingCourier: string | null;
  total: number;
  /** ISO code shown next to the money; defaults to CAD. */
  currency?: string;
  discountCode?: string | null;
  shipTo?: string | null;
  /** Lines that took no stock (no product linked) — shown as a warning. */
  stockWarnings?: string[];
  /** 'admin' when an admin marked the invoice paid rather than the checkout. */
  paidVia?: 'checkout' | 'admin';
  /** 'manual' for a manual invoice (no Stealth Health checkout behind it). */
  source?: 'stealth_health' | 'manual';
}): Promise<{ success: boolean; id?: string; error?: string; subject: string }> {
  const { to, invoiceId, invoiceNumber, customerName, customerEmail, items } = data;
  if (!to || (Array.isArray(to) && to.length === 0)) {
    return { success: false, error: "no admin recipients", subject: "" };
  }
  const money = (n: number) => `$${(Number(n) || 0).toFixed(2)}`;
  const manual = data.source === "manual";
  const label = invoiceNumber || (manual ? "Invoice" : "Stealth Health order");
  const who = customerName || customerEmail || "Guest";
  const currency = escapeHtml(data.currency || "CAD");
  const subject = `${manual ? "Invoice paid" : "New order"}: ${label} · ${who} · ${money(data.total)} ${data.currency || "CAD"}`;

  const row = (k: string, v: string, strong = false) => `
    <tr><td style="padding:6px 0; font-size:13px; color:#56707F; width:140px; vertical-align:top;">${k}</td>
        <td style="padding:6px 0; font-size:14px; color:#07203A;${strong ? " font-weight:600;" : ""}">${v}</td></tr>`;

  const itemRows = items
    .map(
      (i) => `
    <tr><td style="padding:6px 0; font-size:14px; color:#07203A; border-bottom:1px solid #EDF3F5;">${escapeHtml(i.description)} &times; ${i.qty}</td>
        <td style="padding:6px 0; font-size:14px; color:#07203A; text-align:right; border-bottom:1px solid #EDF3F5;">${money(i.lineTotal)}</td></tr>`,
    )
    .join("");

  const html = vytaShell(`
    <div style="padding: 32px 24px;">
      <div style="background: #ECFDF5; border: 1px solid #A7F3D0; border-radius: 8px; padding: 16px; margin-bottom: 24px; text-align: center;">
        <h2 style="font-size: 18px; font-weight: 600; color: #065F46; margin: 0;">${manual ? "Invoice paid" : "New Stealth Health order paid"}</h2>
        <p style="font-size: 13px; color: #065F46; margin: 6px 0 0;">${escapeHtml(label)} · ${money(data.total)} ${currency}</p>
      </div>

      <table style="width:100%; border-collapse:collapse; margin-bottom: 20px;"><tbody>
        ${row("Customer", escapeHtml(who), true)}
        ${customerEmail && customerName ? row("Email", escapeHtml(customerEmail)) : ""}
        ${data.shipTo ? row("Ship to", escapeHtml(data.shipTo)) : ""}
        ${manual
          ? data.shippingCourier ? row("Courier", escapeHtml(data.shippingCourier)) : ""
          : row("Courier", escapeHtml(data.shippingCourier || "Flat-rate shipping"))}
        ${data.discountCode ? row("Discount code", escapeHtml(data.discountCode)) : ""}
      </tbody></table>

      <table style="width:100%; border-collapse:collapse; margin-bottom: 8px;"><tbody>
        ${itemRows}
        <tr><td style="padding:8px 0 2px; font-size:13px; color:#56707F;">Subtotal</td>
            <td style="padding:8px 0 2px; font-size:13px; color:#07203A; text-align:right;">${money(data.subtotal)}</td></tr>
        <tr><td style="padding:2px 0; font-size:13px; color:#56707F;">Shipping</td>
            <td style="padding:2px 0; font-size:13px; color:#07203A; text-align:right;">${money(data.shipping)}</td></tr>
        <tr><td style="padding:6px 0; font-size:15px; font-weight:700; color:#07203A;">Total (${currency})</td>
            <td style="padding:6px 0; font-size:15px; font-weight:700; color:#07203A; text-align:right;">${money(data.total)}</td></tr>
      </tbody></table>

      <p style="font-size: 13px; color: #56707F; margin: 16px 0 20px; text-align:center;">
        ${manual
          ? "This manual invoice is marked paid."
          : data.paidVia === "admin"
            ? "The invoice was marked paid by an admin. The order is now in the fulfillment queue."
            : "Payment was collected on the Stealth Health checkout. The order is now in the fulfillment queue."}
      </p>

      ${
        data.stockWarnings && data.stockWarnings.length > 0
          ? `<div style="background:#FFFBEB; border:1px solid #FDE68A; border-radius:8px; padding:12px 16px; margin-bottom:20px;">
        <p style="font-size:13px; font-weight:600; color:#92400E; margin:0 0 6px;">Stock was not taken for:</p>
        <p style="font-size:13px; color:#92400E; margin:0;">${data.stockWarnings.map((w) => escapeHtml(w)).join("<br>")}</p>
        <p style="font-size:12px; color:#92400E; margin:8px 0 0;">Link them under Admin → Stock Ledger → Needs attention.</p>
      </div>`
          : ""
      }

      ${insightsButton(`${SITE_URL}/admin/invoices/${invoiceId}`, "View invoice")}
    </div>
  `);

  try {
    const { data: result, error } = await getResend().emails.send({
      from: fromEmail,
      to,
      subject,
      html,
    });
    if (error) {
      console.error("Error sending Stealth Health order alert:", error);
      return { success: false, error: error.message, subject };
    }
    return { success: true, id: result?.id, subject };
  } catch (error) {
    console.error("Error sending Stealth Health order alert:", error);
    return { success: false, error: "Failed to send email", subject };
  }
}
