/**
 * Unit tests for the shipment record mirrored onto invoices.
 *
 * Run with a TS-aware loader, e.g.
 * `node --test --import tsx lib/shipping/shipment-record.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addBusinessDays,
  coreShipmentPatch,
  estimatedDeliveryWindow,
  extendedShipmentPatch,
  type ShipmentRecordSource,
} from '@/lib/shipping/shipment-record';

const record = (over: Partial<ShipmentRecordSource> = {}): ShipmentRecordSource => ({
  easyship_shipment_id: 'ESCA123',
  label_state: 'generated',
  label_url: 'https://labels.example/1.pdf',
  tracking_number: '1Z999',
  tracking_url: 'https://track.example/1Z999',
  tracking_status: null,
  carrier: 'UPS',
  service_name: 'UPS Express Saver',
  courier_service_id: 'svc-1',
  total_charge: 18.4,
  currency: 'CAD',
  min_delivery_days: 1,
  max_delivery_days: 2,
  label_generated_at: null,
  ...over,
});

test('core patch carries the shipment, tracking and label', () => {
  assert.deepEqual(coreShipmentPatch(record()), {
    easyship_shipment_id: 'ESCA123',
    easyship_courier_id: 'svc-1',
    tracking_number: '1Z999',
    tracking_url: 'https://track.example/1Z999',
    carrier: 'UPS',
    label_url: 'https://labels.example/1.pdf',
    label_state: 'generated',
  });
});

test('core patch never blanks a stored value with a missing one', () => {
  const patch = coreShipmentPatch(
    record({ tracking_number: null, label_url: null, label_state: 'not_created', carrier: null }),
  );
  assert.equal('tracking_number' in patch, false);
  assert.equal('label_url' in patch, false);
  assert.equal('label_state' in patch, false);
  assert.equal('carrier' in patch, false);
});

test('extended patch carries service, cost and estimate', () => {
  const now = new Date('2026-10-09T15:00:00Z');
  assert.deepEqual(extendedShipmentPatch(record(), now), {
    easyship_synced_at: now.toISOString(),
    shipping_service: 'UPS Express Saver',
    shipping_label_cost: 18.4,
    shipping_label_currency: 'CAD',
    est_delivery_min_days: 1,
    est_delivery_max_days: 2,
  });
});

test('label time comes only from Easyship, never from the sync clock', () => {
  const now = new Date('2026-10-09T15:00:00Z');
  assert.equal('label_generated_at' in extendedShipmentPatch(record(), now), false);
  assert.equal(
    extendedShipmentPatch(record({ label_generated_at: '2026-10-08T12:00:00Z' }), now)
      .label_generated_at,
    '2026-10-08T12:00:00Z',
  );
});

test('business days skip the weekend', () => {
  // 2026-10-09 is a Friday.
  assert.equal(addBusinessDays('2026-10-09', 1), '2026-10-12');
  assert.equal(addBusinessDays('2026-10-09', 2), '2026-10-13');
  assert.equal(addBusinessDays('2026-10-07', 2), '2026-10-09');
  assert.equal(addBusinessDays('2026-10-07', 0), '2026-10-07');
});

test('delivery window from the transit estimate', () => {
  assert.deepEqual(estimatedDeliveryWindow('2026-10-09', 1, 2), {
    deliveryFrom: '2026-10-12',
    deliveryTo: '2026-10-13',
  });
  assert.deepEqual(estimatedDeliveryWindow('2026-10-07', null, 2), {
    deliveryFrom: '2026-10-09',
    deliveryTo: '2026-10-09',
  });
  assert.equal(estimatedDeliveryWindow('2026-10-07', 0, null), null);
});
