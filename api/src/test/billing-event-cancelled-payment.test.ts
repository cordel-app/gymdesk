// #2533 stage 2: a Billing Event's administrative status is independent of its
// payment result. The normal lifecycle still moves pending → paid / failed, but
// a cancelled event stays `cancelled` whatever the provider answers afterwards,
// while the attempt keeps the provider's raw status and the normalized one, the
// money stays receiptable and refundable, and nothing is activated from it.
// Integration — the payment provider is never called (settlement is driven with
// the provider's own payload).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { settlePaymentRequest } from '../api/payment-settlement';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let ctId: number;

const log = { info: () => {}, warn: () => {}, error: () => {} } as any;

beforeAll(async () => {
  gymId = await createTestGym('BE cancelled payment');
  await createTestMembership(gymId, 'admin');
  const { rows } = await db.query<{ id: number }>("SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1");
  ctId = rows[0].id;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

/** A Pending Payment ProductSet with its initial event and one pending provider attempt. */
async function pendingEvent() {
  const { insertId: memberId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Cancel Member', `bec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`]);
  const { insertId: setId } = await db.query(
    `INSERT INTO product_sets (gym_id, owner_member_id, status, starts_at, pending_at)
     VALUES (?, ?, 'pending_payment', CURDATE(), UTC_TIMESTAMP())`, [gymId, memberId]);
  const { insertId: eventId } = await db.query(
    `INSERT INTO billing_events (gym_id, product_set_id, member_id, event_type, amount, charge_type_id, source, attempt_count)
     VALUES (?, ?, ?, 'payment_recorded', '40.00', ?, 'system', 1)`, [gymId, setId, memberId, ctId]);
  await db.query(
    `INSERT INTO billing_event_lines (gym_id, billing_event_id, kind, item_name, quantity, amount)
     VALUES (?, ?, 'product', 'Membership fee', 1, '40.00')`, [gymId, eventId]);
  const orderId = `bec-${Math.random().toString(36).slice(2)}`;
  await db.query(
    `INSERT INTO payment_requests
       (gym_id, member_id, amount, currency, charge_type_id, billing_event_id, status, provider, provider_order,
        source, attempt, method, created_at)
     VALUES (?, ?, '40.00', 'EUR', ?, ?, 'pending', 'monei', ?, 'customer', 1, 'provider', UTC_TIMESTAMP())`,
    [gymId, memberId, ctId, eventId, orderId]);
  return { memberId: Number(memberId), setId: Number(setId), eventId: Number(eventId), orderId };
}

const cancel = (id: number) => request.post(`/payments/billing-events/${id}/cancel`)
  .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send({});
const detail = async (id: number) => (await request.get(`/payments/billing-events/${id}`)
  .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)).body;
const listRow = async (memberId: number, id: number) => (await request.get(`/payments/billing-events?member_id=${memberId}`)
  .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)).body.items.find((r: any) => r.id === id);
const setStatus = async (id: number) =>
  (await db.query<{ status: string }>('SELECT status FROM product_sets WHERE id = ?', [id])).rows[0].status;

function payload(orderId: string, status: 'completed' | 'failed' | 'expired', providerStatus: string) {
  return {
    orderId, status, providerStatus, providerRef: `pay_${orderId}`,
    paymentToken: null, sequenceId: null, cardLast4: null, cardBrand: null,
  };
}

describe('normal lifecycle', () => {
  it('a pending event becomes paid when the payment succeeds, and its set is activated', async () => {
    const e = await pendingEvent();
    expect((await detail(e.eventId)).status).toBe('pending');
    await settlePaymentRequest(payload(e.orderId, 'completed', 'SUCCEEDED'), { via: 'webhook', log });
    const d = await detail(e.eventId);
    expect(d).toMatchObject({ status: 'paid', payment_status: 'SUCCEEDED', normalized_payment_status: 'completed' });
    expect(await setStatus(e.setId)).toBe('active');
  });

  it('a pending event becomes failed when the payment fails', async () => {
    const e = await pendingEvent();
    await settlePaymentRequest(payload(e.orderId, 'failed', 'FAILED'), { via: 'webhook', log });
    const d = await detail(e.eventId);
    expect(d).toMatchObject({ status: 'failed', payment_status: 'FAILED', normalized_payment_status: 'failed' });
  });
});

describe('after an administrative cancellation', () => {
  it('a successful payment is recorded but the event stays cancelled and nothing is activated', async () => {
    const e = await pendingEvent();
    expect((await cancel(e.eventId)).status).toBe(200);

    const out = await settlePaymentRequest(payload(e.orderId, 'completed', 'SUCCEEDED'), { via: 'webhook', log });
    expect(out).toEqual({ kind: 'settled', status: 'completed' });

    const d = await detail(e.eventId);
    expect(d).toMatchObject({
      status: 'cancelled', payment_status: 'SUCCEEDED', normalized_payment_status: 'completed',
      can_cancel: false, can_retry: false, can_pay_cash: false, can_waive: false,
    });
    // The money is real: it can be receipted and reviewed for a refund.
    expect(d.can_issue_receipt).toBe(true);
    expect(d.can_refund).toBe(true);
    const row = await listRow(e.memberId, e.eventId);
    expect(row).toMatchObject({ status: 'cancelled', normalized_payment_status: 'completed', can_refund: true });
    // The cancellation is not undone by automatic processing.
    expect(await setStatus(e.setId)).toBe('pending_payment');

    // A repeated delivery changes nothing.
    const again = await settlePaymentRequest(payload(e.orderId, 'completed', 'SUCCEEDED'), { via: 'webhook', log });
    expect(again.kind).toBe('already_processed');
    expect((await detail(e.eventId)).status).toBe('cancelled');
  });

  it('a failed payment leaves the event cancelled, out of the failed queue', async () => {
    const e = await pendingEvent();
    // Reopen the attempt the cancellation expired, as an in-flight payment would be.
    expect((await cancel(e.eventId)).status).toBe(200);
    await db.query("UPDATE payment_requests SET status = 'pending' WHERE provider_order = ?", [e.orderId]);
    await settlePaymentRequest(payload(e.orderId, 'failed', 'FAILED'), { via: 'webhook', log });

    const d = await detail(e.eventId);
    expect(d).toMatchObject({ status: 'cancelled', payment_status: 'FAILED', normalized_payment_status: 'failed', can_retry: false });
    const failed = (await request.get(`/payments/billing-events?member_id=${e.memberId}&status=failed`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)).body.items;
    expect(failed.find((r: any) => r.id === e.eventId)).toBeUndefined();
  });

  it('staff payment actions are refused on a cancelled event', async () => {
    const e = await pendingEvent();
    expect((await cancel(e.eventId)).status).toBe(200);
    const res = await request.post(`/payments/billing-events/${e.eventId}/manual-payment`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send({ method: 'cash' });
    expect(res.status).toBe(409);
    expect((await detail(e.eventId)).status).toBe('cancelled');
  });
});
