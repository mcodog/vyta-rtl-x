'use client';

import React, { useState } from 'react';
import { Check, Mail, PackageCheck, RotateCw, Truck } from 'lucide-react';
import FulfillmentEmailModal from '@/components/FulfillmentEmailModal';

/**
 * Admin sidebar card for the customer's "order packed" / "order shipped"
 * emails (lib/fulfillment-email.ts). Manual only — nothing sends these on a
 * status change; each button opens the preview-and-send modal (where the
 * shipped email also takes carrier, tracking and estimated delivery). Shows when
 * each was last sent, from the invoice's packed_emailed_at / shipped_emailed_at.
 */
export default function FulfillmentEmailCard({
  invoiceId,
  invoiceNumber,
  fulfillmentType,
  packedEmailedAt,
  shippedEmailedAt,
  canSend = true,
  onSent,
}: {
  invoiceId: string;
  invoiceNumber?: string | null;
  fulfillmentType: 'shipment' | 'pickup';
  packedEmailedAt?: string | null;
  shippedEmailedAt?: string | null;
  canSend?: boolean;
  onSent?: () => void;
}) {
  const [open, setOpen] = useState<'packed' | 'shipped' | null>(null);
  const pickup = fulfillmentType === 'pickup';

  const rows: Array<{ kind: 'packed' | 'shipped'; label: string; sentAt: string | null | undefined; icon: React.ReactNode }> = [
    {
      kind: 'packed',
      label: pickup ? 'Ready for pickup' : 'Order packed',
      sentAt: packedEmailedAt,
      icon: <PackageCheck className="w-3.5 h-3.5" />,
    },
    {
      kind: 'shipped',
      label: pickup ? 'Picked up' : 'Order shipped',
      sentAt: shippedEmailedAt,
      icon: <Truck className="w-3.5 h-3.5" />,
    },
  ];

  return (
    <div className="bg-white rounded-xl border border-line p-5">
      <div className="flex items-center gap-2 mb-1">
        <Mail className="w-4 h-4 text-ink-muted" />
        <h3 className="font-semibold text-ink text-sm">Packed &amp; shipped emails</h3>
      </div>
      <p className="text-[11px] text-ink-muted mb-3">
        Sent by hand only. Preview first{pickup ? '' : ' — add the carrier, tracking number and estimated delivery there'};
        you can change who it goes to, and the admin team gets a copy.
      </p>

      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.kind} className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm text-ink flex items-center gap-1.5">
                {r.icon} {r.label}
              </p>
              {r.sentAt ? (
                <p className="text-[11px] text-emerald-700 flex items-center gap-1">
                  <Check className="w-3 h-3" /> Sent {new Date(r.sentAt).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </p>
              ) : (
                <p className="text-[11px] text-amber-700">Not sent</p>
              )}
            </div>
            {canSend && (
              <button
                onClick={() => setOpen(r.kind)}
                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 bg-teal/10 border border-teal/20 text-teal-dark rounded-lg text-xs hover:bg-teal/20 transition-colors"
              >
                {r.sentAt ? <RotateCw className="w-3 h-3" /> : <Mail className="w-3 h-3" />}
                {r.sentAt ? 'Preview & resend' : 'Preview & send'}
              </button>
            )}
          </li>
        ))}
      </ul>

      {open && (
        <FulfillmentEmailModal
          invoiceId={invoiceId}
          invoiceNumber={invoiceNumber}
          kind={open}
          fulfillmentType={fulfillmentType}
          onClose={() => setOpen(null)}
          onSent={() => onSent?.()}
        />
      )}
    </div>
  );
}
