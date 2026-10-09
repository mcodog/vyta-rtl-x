'use client';

import React, { useState } from 'react';
import { Check, Mail, RotateCw, Truck } from 'lucide-react';
import FulfillmentEmailModal from '@/components/FulfillmentEmailModal';

/**
 * Admin sidebar card for the customer's one "Your Order Has Shipped!" email
 * (lib/fulfillment-email.ts), sent once the order is packed and shipped.
 * Manual only — nothing sends it on a status change; the button opens the
 * preview-and-send modal, where the carrier, tracking and estimated delivery
 * are typed and the recipient can be changed. Shows when it was last sent,
 * from the invoice's shipped_emailed_at.
 */
export default function FulfillmentEmailCard({
  invoiceId,
  invoiceNumber,
  shippedEmailedAt,
  canSend = true,
  onSent,
}: {
  invoiceId: string;
  invoiceNumber?: string | null;
  shippedEmailedAt?: string | null;
  canSend?: boolean;
  onSent?: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="bg-white rounded-xl border border-line p-5">
      <div className="flex items-center gap-2 mb-1">
        <Truck className="w-4 h-4 text-ink-muted" />
        <h3 className="font-semibold text-ink text-sm">Order shipped email</h3>
      </div>
      <p className="text-[11px] text-ink-muted mb-3">
        Sent by hand once the order is packed and shipped. Add the carrier, tracking number and
        estimated delivery in the preview; you can change who it goes to, and the admin team gets a copy.
      </p>

      {shippedEmailedAt ? (
        <p className="text-xs text-emerald-700 flex items-center gap-1">
          <Check className="w-3.5 h-3.5" /> Sent{' '}
          {new Date(shippedEmailedAt).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })}
        </p>
      ) : (
        <p className="text-xs text-amber-700">Not sent</p>
      )}

      {canSend && (
        <button
          onClick={() => setOpen(true)}
          className="mt-3 w-full px-3 py-2 bg-teal/10 border border-teal/20 text-teal-dark rounded-lg text-sm hover:bg-teal/20 transition-colors flex items-center justify-center gap-2"
        >
          {shippedEmailedAt ? <RotateCw className="w-3.5 h-3.5" /> : <Mail className="w-3.5 h-3.5" />}
          {shippedEmailedAt ? 'Preview & resend' : 'Preview & send'}
        </button>
      )}

      {open && (
        <FulfillmentEmailModal
          invoiceId={invoiceId}
          invoiceNumber={invoiceNumber}
          onClose={() => setOpen(false)}
          onSent={() => onSent?.()}
        />
      )}
    </div>
  );
}
