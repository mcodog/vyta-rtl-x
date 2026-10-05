/**
 * Binary PDF renderer for the invoice email attachment.
 *
 * Uses pdfkit's built-in Helvetica fonts (no external font files), so it
 * runs on the Node.js serverless runtime. The on-screen/print view is a
 * separate HTML path (app/api/admin/invoices/[id]/pdf).
 */
import { formatAppDate } from '@/lib/datetime';
import PDFDocument from 'pdfkit';
import { formatAddressLines, type ShippingAddressLike } from '@/lib/payments/puramass-address';

export interface InvoicePdfLine {
  description: string;
  qty: number;
  unit_price: number;
  discount_pct: number;
  line_total: number;
  price_type?: 'box' | 'vial' | null;
}

export interface InvoicePdfPayment {
  amount: number;
  method: string;
  paid_at: string;
}

/**
 * The Stealth Health hand-off behind a `source = 'stealth_health'` invoice.
 *
 * Stealth Health collects the buyer's contact and shipping address on its hosted
 * checkout page, so for those sales none of this is on the invoice row — it
 * comes off the hand-off ledger (see lib/admin/puramass-invoice.ts). The
 * attachment prints it under its own heading, attributed to Stealth Health, so the
 * emailed document is packable and nobody mistakes it for locally-entered data.
 */
export interface InvoicePdfPuramass {
  transaction_id: string | null;
  partner_reference: string;
  status: string;
  paid_at: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  shipping_address: ShippingAddressLike | null;
  /** 'customer' when the buyer typed it in after Stealth Health reported none. */
  shipping_address_source: 'puramass' | 'customer' | null;
  /** Refunded on the Stealth Health side, in the invoice's currency. */
  refunded_total: number;
}

export interface InvoicePdfInput {
  invoice_number: string;
  issue_date?: string | null;
  due_date?: string | null;
  status?: string;
  customer_name?: string | null;
  customer_email?: string | null;
  customer_phone?: string | null;
  subtotal: number;
  tax_total: number;
  shipping_cost: number;
  total: number;
  notes?: string | null;
  amount_paid?: number;
  amount_due?: number;
  line_items: InvoicePdfLine[];
  payments?: InvoicePdfPayment[];
  /** Present only for invoices materialised from a Stealth Health hand-off. */
  puramass?: InvoicePdfPuramass | null;
}

const money = (n: number | string | null | undefined) =>
  `$${(Number(n) || 0).toFixed(2)}`;

const fmtDate = (v: string | null | undefined) => formatAppDate(v, {});

export function renderInvoicePdf(inv: InvoicePdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;
      const width = right - left;

      // Header
      doc.fillColor('#07203A').fontSize(22).font('Helvetica-Bold').text('VYTA', left, 50);
      doc.fillColor('#438B9E').fontSize(9).font('Helvetica').text('BIOSCIENCES', { characterSpacing: 2 });
      doc.fillColor('#07203A').fontSize(20).font('Helvetica-Bold')
        .text('INVOICE', left, 50, { width, align: 'right' });
      doc.fillColor('#56707F').fontSize(11).font('Helvetica')
        .text(inv.invoice_number, { width, align: 'right' });

      doc.moveTo(left, 100).lineTo(right, 100).strokeColor('#DCE7EB').stroke();

      // Parties + dates
      let y = 120;
      doc.fillColor('#56707F').fontSize(9).font('Helvetica-Bold').text('BILL TO', left, y);
      doc.fillColor('#07203A').fontSize(11).font('Helvetica')
        .text(inv.customer_name || 'Guest / Offline customer', left, y + 14);
      if (inv.customer_email) doc.fillColor('#56707F').fontSize(10).text(inv.customer_email);
      if (inv.customer_phone) doc.fillColor('#56707F').fontSize(10).text(inv.customer_phone);

      // Ship To — Stealth Health sales only, where the address lives on the hand-off
      // ledger instead of the invoice.
      const pm = inv.puramass ?? null;
      if (pm) {
        let sy = y + 70;
        doc.fillColor('#56707F').fontSize(9).font('Helvetica-Bold').text('SHIP TO', left, sy);
        sy += 14;
        doc.fillColor('#07203A').fontSize(11).font('Helvetica')
          .text(pm.customer_name || inv.customer_name || 'Guest', left, sy);
        sy += 14;
        const addrLines = formatAddressLines(pm.shipping_address);
        doc.fillColor('#56707F').fontSize(10);
        if (addrLines.length > 0) {
          for (const line of addrLines) {
            doc.text(line, left, sy, { width: width / 2 });
            sy += 12;
          }
        } else {
          doc.text('No shipping address on file yet.', left, sy, { width: width / 2 });
          sy += 12;
        }
        if (pm.customer_phone) {
          doc.text(pm.customer_phone, left, sy, { width: width / 2 });
          sy += 12;
        }
        doc.fillColor('#6E8898').fontSize(8).text(
          pm.shipping_address_source === 'customer'
            ? 'Confirmed by the customer'
            : 'Reported by Stealth Health',
          left,
          sy,
          { width: width / 2 },
        );
      }

      const metaX = left + width / 2;
      const metaRow = (label: string, value: string, ry: number) => {
        doc.fillColor('#56707F').fontSize(9).font('Helvetica-Bold').text(label, metaX, ry, { width: width / 2, align: 'right', continued: false });
        doc.fillColor('#07203A').fontSize(10).font('Helvetica').text(value, metaX, ry + 11, { width: width / 2, align: 'right' });
      };
      metaRow('ISSUE DATE', fmtDate(inv.issue_date), y);
      metaRow('DUE DATE', fmtDate(inv.due_date), y + 30);
      if (inv.status) metaRow('STATUS', inv.status.toUpperCase(), y + 60);
      if (inv.puramass) {
        metaRow(
          'STEALTH HEALTH TXN',
          inv.puramass.transaction_id || inv.puramass.partner_reference || '—',
          y + 90,
        );
      }

      // Items table. The Ship To block (Stealth Health sales) needs the extra room.
      y = inv.puramass ? 300 : 210;
      const cols = { desc: left, qty: left + 250, unit: left + 320, disc: left + 400, total: left + 460 };
      doc.fillColor('#56707F').fontSize(9).font('Helvetica-Bold');
      doc.text('DESCRIPTION', cols.desc, y);
      doc.text('QTY', cols.qty, y, { width: 50, align: 'right' });
      doc.text('UNIT', cols.unit, y, { width: 60, align: 'right' });
      doc.text('DISC', cols.disc, y, { width: 50, align: 'right' });
      doc.text('TOTAL', cols.total, y, { width: right - cols.total, align: 'right' });
      y += 16;
      doc.moveTo(left, y).lineTo(right, y).strokeColor('#DCE7EB').stroke();
      y += 8;

      doc.font('Helvetica').fontSize(10).fillColor('#07203A');
      for (const li of inv.line_items) {
        if (y > doc.page.height - 160) { doc.addPage(); y = 60; }
        const pt = li.price_type === 'vial' ? 'Vial' : 'Box';
        const descWithChip = `${li.description}  [${pt}]`;
        const h = doc.heightOfString(descWithChip, { width: 240 });
        doc.fillColor('#07203A').text(descWithChip, cols.desc, y, { width: 240 });
        doc.fillColor('#56707F').text(String(li.qty), cols.qty, y, { width: 50, align: 'right' });
        doc.text(money(li.unit_price), cols.unit, y, { width: 60, align: 'right' });
        doc.text(li.discount_pct > 0 ? `${li.discount_pct}%` : '—', cols.disc, y, { width: 50, align: 'right' });
        doc.fillColor('#07203A').text(money(li.line_total), cols.total, y, { width: right - cols.total, align: 'right' });
        y += Math.max(h, 12) + 8;
      }

      doc.moveTo(left, y).lineTo(right, y).strokeColor('#DCE7EB').stroke();
      y += 12;

      // Totals
      const totalsX = left + width - 220;
      const totalRow = (label: string, value: string, bold = false) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10)
          .fillColor(bold ? '#07203A' : '#56707F');
        doc.text(label, totalsX, y, { width: 110 });
        doc.fillColor('#07203A').text(value, totalsX + 110, y, { width: 110, align: 'right' });
        y += bold ? 20 : 16;
      };
      totalRow('Subtotal', money(inv.subtotal));
      totalRow('Tax', money(inv.tax_total));
      totalRow('Shipping', money(inv.shipping_cost));
      totalRow('Total', money(inv.total), true);
      if ((inv.amount_paid ?? 0) > 0) {
        totalRow('Paid', `- ${money(inv.amount_paid)}`);
        totalRow('Amount Due', money(inv.amount_due ?? (Number(inv.total) - Number(inv.amount_paid))), true);
      }
      if ((inv.puramass?.refunded_total ?? 0) > 0) {
        totalRow('Refunded (Stealth Health)', `- ${money(inv.puramass!.refunded_total)}`);
        totalRow('Net of refunds', money(Number(inv.total) - inv.puramass!.refunded_total), true);
      }

      // Payments
      if (inv.payments && inv.payments.length) {
        y += 12;
        doc.fillColor('#56707F').fontSize(9).font('Helvetica-Bold').text('PAYMENTS', left, y);
        y += 14;
        doc.font('Helvetica').fontSize(10).fillColor('#07203A');
        for (const p of inv.payments) {
          doc.text(`${fmtDate(p.paid_at)} — ${p.method}`, left, y, { width: 300 });
          doc.text(money(p.amount), totalsX + 110, y, { width: 110, align: 'right' });
          y += 14;
        }
      }

      // Notes
      if (inv.notes) {
        y += 16;
        doc.fillColor('#56707F').fontSize(9).font('Helvetica-Bold').text('NOTES', left, y);
        doc.fillColor('#07203A').fontSize(10).font('Helvetica').text(inv.notes, left, y + 14, { width });
      }

      // Footer
      doc.fillColor('#6E8898').fontSize(9).font('Helvetica')
        .text('VYTA Biosciences • Canada', left, doc.page.height - 70, { width, align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
