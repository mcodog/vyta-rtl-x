/**
 * Unit tests for reading Easyship webhook bodies.
 *
 * Run with a TS-aware loader, e.g.
 * `node --test --import tsx lib/shipping/easyship-webhook.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EASYSHIP_WEBHOOK_URL,
  EASYSHIP_WEBHOOK_EVENTS,
  parseEasyshipWebhook,
} from '@/lib/shipping/easyship-webhook';

test('the endpoint and its subscriptions', () => {
  assert.equal(EASYSHIP_WEBHOOK_URL, 'https://www.vytabio.com/api/webhooks/easyship');
  assert.equal(EASYSHIP_WEBHOOK_EVENTS.length, 14);
});

test('label created: shipment, tracking and label read from the `label` key', () => {
  const e = parseEasyshipWebhook({
    event_type: 'shipment.label.created',
    resource_id: 'ESCA10001',
    resource_type: 'shipment',
    label: {
      easyship_shipment_id: 'ESCA10001',
      platform_order_number: 'VYTA-1001',
      status: 'generated',
      label_url: 'https://labels.example/ESCA10001.pdf',
      tracking_number: '1Z999',
      tracking_page_url: 'https://track.example/1Z999',
    },
  });
  assert.equal(e.handled, true);
  assert.equal(e.shipmentId, 'ESCA10001');
  assert.equal(e.orderNumber, 'VYTA-1001');
  assert.equal(e.labelState, 'generated');
  assert.equal(e.labelUrl, 'https://labels.example/ESCA10001.pdf');
  assert.equal(e.trackingNumber, '1Z999');
  assert.equal(e.trackingUrl, 'https://track.example/1Z999');
  // The label's "generated" is not a delivery status.
  assert.equal(e.trackingStatus, null);
});

test('label created with no URL in the body still counts as generated', () => {
  const e = parseEasyshipWebhook({
    event_type: 'shipment.label.created',
    resource_id: 'ESCA10002',
    label: { easyship_shipment_id: 'ESCA10002' },
  });
  assert.equal(e.labelState, 'generated');
  assert.equal(e.labelUrl, null);
});

test('tracking status changed: status from the `tracking_status` key', () => {
  const e = parseEasyshipWebhook({
    event_type: 'shipment.tracking.status.changed',
    resource_id: 'ESCA10001',
    tracking_status: {
      easyship_shipment_id: 'ESCA10001',
      status: 'In Transit to Customer',
      tracking_number: '1Z999',
    },
  });
  assert.equal(e.shipmentId, 'ESCA10001');
  assert.equal(e.trackingStatus, 'In Transit to Customer');
  assert.equal(e.labelState, null);
});

test('checkpoints created: journey normalized, status from the newest', () => {
  const e = parseEasyshipWebhook({
    event_type: 'shipment.tracking.checkpoints.created',
    tracking_checkpoints: {
      easyship_shipment_id: 'ESCA10001',
      checkpoints: [
        { message: 'Picked up', checkpoint_time: '2026-10-09T10:00:00Z', city: 'Toronto', state: 'ON', country_alpha2: 'CA', primary_status: 'In Transit to Customer' },
        { message: 'Delivered', checkpoint_time: '2026-10-10T15:00:00Z', location: 'Ottawa, ON', primary_status: 'Delivered' },
      ],
    },
  });
  assert.equal(e.shipmentId, 'ESCA10001');
  assert.equal(e.checkpoints?.length, 2);
  assert.equal(e.checkpoints?.[0].location, 'Toronto, ON, CA');
  assert.equal(e.trackingStatus, 'Delivered');
});

test('label failed and cancelled', () => {
  assert.equal(
    parseEasyshipWebhook({ event_type: 'shipment.label.failed', label: { easyship_shipment_id: 'X' } }).labelState,
    'failed',
  );
  const c = parseEasyshipWebhook({ event_type: 'shipment.cancelled', shipment: { easyship_shipment_id: 'X' } });
  assert.equal(c.labelState, 'cancelled');
  assert.equal(c.trackingStatus, 'cancelled');
  assert.equal(c.shipmentId, 'X');
});

test('account-level events are acknowledged, not handled', () => {
  for (const event_type of ['credit.balance.low', 'batch.finished', 'transaction.record.create']) {
    const e = parseEasyshipWebhook({ event_type, resource_id: 'abc' });
    assert.equal(e.handled, false, event_type);
    assert.equal(e.shipmentId, null, event_type);
  }
});

test('a payload with no event_type is read the old flat way', () => {
  const e = parseEasyshipWebhook({
    shipment: { easyship_shipment_id: 'ESCA9', tracking_status: 'Delivered', label_url: 'https://l/9.pdf' },
  });
  assert.equal(e.handled, true);
  assert.equal(e.shipmentId, 'ESCA9');
  assert.equal(e.trackingStatus, 'Delivered');
  assert.equal(e.labelState, 'generated');
});
