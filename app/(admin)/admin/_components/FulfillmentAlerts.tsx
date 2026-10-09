'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Bell, X, Send, PackageCheck, Truck, Store, ChevronDown, ChevronUp } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import FulfillmentEmailModal from '@/components/FulfillmentEmailModal';

type FulfillmentStatus = 'pending' | 'packed' | 'shipped' | 'picked_up' | 'dropped_off';

interface AlertEvent {
  key: string;                // id:status — for dedupe
  id: string;
  invoice_number: string | null;
  order_number: string | null;
  customer_name: string | null;
  fulfillment_type: 'shipment' | 'pickup';
  fulfillment_status: FulfillmentStatus;
  at: number;
}

const MAX_EVENTS = 8;
const NOTIFIABLE: FulfillmentStatus[] = ['packed', 'shipped', 'picked_up', 'dropped_off'];

/**
 * Admin-only live fulfillment banner. Subscribes to `postgres_changes`
 * UPDATEs on `invoices`; when `fulfillment_status` reaches a "notifiable"
 * state (packed / shipped / picked_up / dropped_off) it prepends a row
 * (deduped by `id:status`, capped at MAX_EVENTS). Shipments get a one-click
 * "Send shipped email" button that opens the shared FulfillmentEmailModal.
 *
 * Mount once on the admin dashboard. Silently no-ops when the invoices
 * table isn't in the supabase_realtime publication (development).
 */
export default function FulfillmentAlerts() {
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [notify, setNotify] = useState<null | { invoiceId: string; invoiceNumber: string | null }>(null);

  // The Realtime callback only carries the row that changed — enrich it
  // with the joined customer/order names via a follow-up SELECT so the
  // banner shows something useful. `pendingEnrichIds` tracks pending
  // lookups; a Map lets us dedupe repeated events for the same id.
  const pendingEnrich = useRef<Set<string>>(new Set());

  useEffect(() => {
    const channel = supabase
      .channel('fulfillment-alerts')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'invoices' },
        async (payload) => {
          const row: any = payload.new;
          const prev: any = payload.old;
          if (!row || !row.fulfillment_status) return;
          if (!NOTIFIABLE.includes(row.fulfillment_status as FulfillmentStatus)) return;
          // Only fire when the status actually changed on this update —
          // an unrelated field change would repeat the same event.
          if (prev?.fulfillment_status === row.fulfillment_status) return;

          const key = `${row.id}:${row.fulfillment_status}`;
          if (pendingEnrich.current.has(key)) return;
          pendingEnrich.current.add(key);

          // Enrich with customer + order metadata for display.
          const { data } = await supabase
            .from('invoices')
            .select(`
              id, invoice_number, fulfillment_type, fulfillment_status,
              customer:customers!invoices_customer_id_fkey (first_name, last_name),
              order:orders!invoices_order_id_fkey (order_number)
            `)
            .eq('id', row.id)
            .maybeSingle();

          const enriched: AlertEvent = {
            key,
            id: row.id,
            invoice_number: data?.invoice_number ?? row.invoice_number ?? null,
            order_number: (data?.order as any)?.order_number ?? null,
            customer_name: data?.customer
              ? `${(data.customer as any).first_name ?? ''} ${(data.customer as any).last_name ?? ''}`.trim() || null
              : null,
            fulfillment_type: (row.fulfillment_type === 'pickup' ? 'pickup' : 'shipment'),
            fulfillment_status: row.fulfillment_status,
            at: Date.now(),
          };

          setEvents((prev) => {
            if (prev.some((e) => e.key === enriched.key)) return prev;
            const next = [enriched, ...prev].slice(0, MAX_EVENTS);
            return next;
          });
          // Auto-open the banner if the admin had collapsed it.
          setCollapsed(false);
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const visible = useMemo(() => events, [events]);

  if (visible.length === 0) return null;

  return (
    <>
      <div className="mb-6 rounded-xl border border-line bg-white overflow-hidden">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-surface transition-colors"
        >
          <div className="inline-flex items-center gap-2 text-sm font-semibold text-ink">
            <Bell className="w-4 h-4 text-teal-dark" />
            Live fulfillment activity
            <span className="ml-1 inline-flex items-center justify-center min-w-[20px] h-[20px] rounded-full bg-ink text-white text-[11px] font-semibold px-1.5 tabular-nums">
              {visible.length}
            </span>
          </div>
          {collapsed ? <ChevronDown className="w-4 h-4 text-ink-muted" /> : <ChevronUp className="w-4 h-4 text-ink-muted" />}
        </button>

        {!collapsed && (
          <ul className="divide-y divide-line/60 border-t border-line">
            {visible.map((ev) => (
              <li key={ev.key} className="flex items-center gap-3 px-4 py-2.5">
                <div className="rounded-lg bg-surface p-1.5">
                  {ev.fulfillment_type === 'pickup' ? (
                    <Store className="w-4 h-4 text-teal-dark" />
                  ) : ev.fulfillment_status === 'packed' ? (
                    <PackageCheck className="w-4 h-4 text-teal-dark" />
                  ) : (
                    <Truck className="w-4 h-4 text-teal-dark" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-sm text-ink truncate">
                    <span className="font-mono">
                      {ev.invoice_number ?? '(no invoice #)'}
                    </span>
                    {ev.order_number && (
                      <span className="text-ink-muted text-xs">· {ev.order_number}</span>
                    )}
                    <StatusChip status={ev.fulfillment_status} />
                  </div>
                  <div className="text-xs text-ink-muted truncate">
                    {ev.customer_name ?? 'Unknown customer'} · {timeAgo(ev.at)}
                  </div>
                </div>
                {/* One customer email — "Your Order Has Shipped!" — for shipments. */}
                {ev.fulfillment_type === 'shipment' && (
                  <button
                    type="button"
                    onClick={() => setNotify({ invoiceId: ev.id, invoiceNumber: ev.invoice_number })}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-ink text-white text-xs font-medium hover:bg-ink/90"
                  >
                    <Send className="w-3 h-3" /> Send shipped email
                  </button>
                )}
                <Link
                  href={`/admin/invoices/${ev.id}`}
                  className="text-xs text-teal-dark hover:underline hidden sm:inline"
                >
                  View
                </Link>
                <button
                  type="button"
                  onClick={() => setEvents((prev) => prev.filter((e) => e.key !== ev.key))}
                  className="text-ink-muted hover:text-ink"
                  aria-label="Dismiss"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {notify && (
        <FulfillmentEmailModal
          invoiceId={notify.invoiceId}
          invoiceNumber={notify.invoiceNumber ?? undefined}
          onClose={() => setNotify(null)}
        />
      )}
    </>
  );
}

function StatusChip({ status }: { status: FulfillmentStatus }) {
  // Colour lives on a small dot only; the label stays in muted ink so the chip
  // reads as a subtle accent rather than a filled colour box.
  const cfg: Record<FulfillmentStatus, { label: string; dot: string }> = {
    pending:     { label: 'Pending',      dot: 'bg-amber-500' },
    packed:      { label: 'Packed',       dot: 'bg-teal' },
    shipped:     { label: 'Shipped',      dot: 'bg-emerald-500' },
    picked_up:   { label: 'Picked up',    dot: 'bg-emerald-500' },
    dropped_off: { label: 'Dropped off',  dot: 'bg-emerald-500' },
  };
  const c = cfg[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
      <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
      {c.label}
    </span>
  );
}

function timeAgo(ts: number): string {
  const delta = Math.max(0, Date.now() - ts);
  const s = Math.floor(delta / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}
