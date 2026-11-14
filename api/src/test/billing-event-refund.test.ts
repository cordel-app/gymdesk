// #2480: Billing Event header fields (Member, payment method snapshot, attempt
// count), Cancel of a pending event and Refund of a collected one (Cash and
// MONEI). Integration — only the payment provider is mocked.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { invalidateFeatureFlagsCache } from '../infra/featureFlags';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request, ensureTestProductSet,
} from './helpers';

const refundPayment = vi.fn();
vi.mock('../payments', () => ({
  getPaymentProvider: () => ({ refundPayment, executeRecurring: vi.fn(), createPaymentRequest: vi.fn() }),
}));

let gymId: string;
let otherGymId: string;
let frontDeskGymId: string;
let ctId: number;

beforeAll(async () => {
  gymId = await createTestGym('BE Refund Gym');
  otherGymId = await createTestGym('BE Refund Other');
  frontDeskGymId = await createTestGym('BE Refund FrontDesk');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
  await createTestMembership(frontDeskGymId, 'front_desk');
  const { rows } = await db.query<{ id: number }>("SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1");
  ctId = rows[0].id;
});

afterAll(async () => {
  await db.query("UPDATE feature_flags SET enabled = 1 WHERE feature_key = 'payments.billing_events.refund'");
  invalidateFeatureFlagsCache();
  await cleanupTestGyms();
  await db.end();
});

beforeEach(() => { refundPayment.mockReset(); });

type Attempt = { status: string; method: string; amount: string; name?: string | null; providerRef?: string | null };

/** A Billing Event with the given attempts (oldest first) and two lines (30 + 10). */
async function createEvent(gym: string, attempts: Attempt[], opts: { amount?: string; lines?: [string, string][] } = {}) {
  const amount = opts.amount ?? '40.00';
  const { insertId: memberId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gym, 'Refund Member', `refund-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`]);
  const psId = await ensureTestProductSet(gym, memberId);
  const { insertId: billingEventId } = await db.query(
    `INSERT INTO billing_events (gym_id, product_set_id, member_id, event_type, amount, charge_type_id, source, attempt_count)
     VALUES (?, ?, ?, 'payment_recorded', ?, ?, 'system', ?)`,
    [gym, psId, memberId, amount, ctId, attempts.length]);
  const lineIds: number[] = [];
  for (const [name, a] of opts.lines ?? [['Membership fee', '30.00'], ['Locker', '10.00']]) {
    const { insertId } = await db.query(
      `INSERT INTO billing_event_lines (gym_id, billing_event_id, kind, item_name, quantity, amount)
       VALUES (?, ?, 'product', ?, 1, ?)`, [gym, billingEventId, name, a]);
    lineIds.push(insertId);
  }
  let i = 0;
  for (const a of attempts) {
    i += 1;
    await db.query(
      `INSERT INTO payment_requests
         (gym_id, member_id, amount, currency, charge_type_id, billing_event_id, status, provider, provider_order,
          provider_ref, source, attempt, method, payment_method_name, created_at, completed_at)
       VALUES (?, ?, ?, 'EUR', ?, ?, ?, ?, UUID(), ?, 'manual', ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND), ?)`,
      [gym, memberId, a.amount, ctId, billingEventId, a.status, a.method === 'provider' ? 'monei' : 'manual',
        a.providerRef ?? null, i, a.method, a.name ?? null, i - 100, a.status === 'completed' ? new Date() : null]);
  }
  return { memberId, billingEventId, lineIds };
}

const paidCash = () => createEvent(gymId, [{ status: 'completed', method: 'cash', amount: '40.00', name: 'Cash' }]);
const paidMonei = () => createEvent(gymId, [{ status: 'completed', method: 'provider', amount: '40.00', name: 'Monei', providerRef: 'pay_123' }]);

const get = (path: string, gym = gymId) => request.get(path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
const post = (id: number, action: string, body: object = {}, gym = gymId) =>
  request.post(`/payments/billing-events/${id}/${action}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym).send(body);
const listRow = async (memberId: number, id: number, gym = gymId) =>
  (await get(`/payments/billing-events?member_id=${memberId}`, gym)).body.items.find((r: any) => r.id === id);
const refundRows = async (id: number) => (await db.query<any>(
  `SELECT r.* FROM payment_requests r JOIN payment_requests o ON o.id = r.refund_of_payment_request_id
    WHERE o.billing_event_id = ? ORDER BY r.id`, [id])).rows;

describe('Billing Event header fields', () => {
  it('reports no method and zero attempts for an event with no transaction', async () => {
    const e = await createEvent(gymId, []);
    const row = await listRow(e.memberId, e.billingEventId);
    expect(row.member_name).toBe('Refund Member');
    expect(row.payment_method_name).toBeNull();
    expect(row.attempt_count).toBe(0);
  });

  it('reports the latest attempt\'s snapshot and the event-level counter', async () => {
    const e = await createEvent(gymId, [
      { status: 'failed', method: 'provider', amount: '40.00', name: 'Monei' },
      { status: 'completed', method: 'cash', amount: '40.00', name: 'Cash' },
    ]);
    await db.query("UPDATE base_payment_method_translations SET name = 'Cash (renamed)' WHERE locale = 'en' AND base_payment_method_id = (SELECT id FROM base_payment_methods WHERE code = 'cash')");
    try {
      const row = await listRow(e.memberId, e.billingEventId);
      expect(row.payment_method_name).toBe('Cash'); // the snapshot, not the renamed catalogue
      expect(row.attempt_count).toBe(2);
      const det = await get(`/payments/billing-events/${e.billingEventId}`);
      expect(det.body).toMatchObject({ payment_method_name: 'Cash', attempt_count: 2, member_name: 'Refund Member' });
    } finally {
      await db.query("UPDATE base_payment_method_translations SET name = 'Cash' WHERE locale = 'en' AND base_payment_method_id = (SELECT id FROM base_payment_methods WHERE code = 'cash')");
    }
  });
});

describe('Cancel', () => {
  it('cancels a pending event, keeps it and its history, and expires the open attempt', async () => {
    const e = await createEvent(gymId, [{ status: 'pending', method: 'provider', amount: '40.00' }]);
    expect((await listRow(e.memberId, e.billingEventId)).can_cancel).toBe(true);
    const res = await post(e.billingEventId, 'cancel');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ previous_status: 'pending', new_status: 'cancelled', expired_attempts: 1 });
    const row = await listRow(e.memberId, e.billingEventId);
    expect(row.status).toBe('cancelled');
    expect(row.can_cancel).toBe(false);
    expect(row.payment_actions_available).toBe(false);
    const { rows } = await db.query<any>('SELECT status FROM payment_requests WHERE billing_event_id = ?', [e.billingEventId]);
    expect(rows).toEqual([{ status: 'expired' }]);
    // Not in the failed-payments queue.
    const attention = await get('/payments/billing-events?status=failed');
    expect(attention.body.items.some((r: any) => r.id === e.billingEventId)).toBe(false);
  });

  it('is refused for a non-pending event and a second time', async () => {
    const paid = await paidCash();
    expect((await listRow(paid.memberId, paid.billingEventId)).can_cancel).toBe(false);
    expect((await post(paid.billingEventId, 'cancel')).status).toBe(409);
    const e = await createEvent(gymId, [{ status: 'pending', method: 'provider', amount: '40.00' }]);
    const results = await Promise.all([1, 2, 3].map(() => post(e.billingEventId, 'cancel')));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
  });

  it('is refused while a submitted payment has no known outcome', async () => {
    const e = await createEvent(gymId, [{ status: 'pending', method: 'provider', amount: '40.00', providerRef: 'pay_inflight' }]);
    expect((await post(e.billingEventId, 'cancel')).status).toBe(409);
  });

  it('is tenant-isolated', async () => {
    const e = await createEvent(gymId, [{ status: 'pending', method: 'provider', amount: '40.00' }]);
    expect((await post(e.billingEventId, 'cancel', {}, otherGymId)).status).toBe(404);
  });
});

describe('Refund — Cash', () => {
  it('offers Refund only for a collected payment, and lists the options', async () => {
    const pending = await createEvent(gymId, [{ status: 'pending', method: 'provider', amount: '40.00' }]);
    expect((await listRow(pending.memberId, pending.billingEventId)).can_refund).toBe(false);
    const failed = await createEvent(gymId, [{ status: 'failed', method: 'provider', amount: '40.00' }]);
    expect((await listRow(failed.memberId, failed.billingEventId)).can_refund).toBe(false);
    expect((await post(failed.billingEventId, 'refund', { kind: 'full', method: 'cash' })).status).toBe(409);

    const e = await paidCash();
    expect((await listRow(e.memberId, e.billingEventId)).can_refund).toBe(true);
    const opts = await get(`/payments/billing-events/${e.billingEventId}/refund-options`);
    expect(opts.status).toBe(200);
    expect(opts.body).toMatchObject({ collected_amount: '40.00', refundable_amount: '40.00', refund_state: 'none' });
    // #2797: the original payment's method, read-only; there is no list to choose from.
    expect(opts.body.method).toEqual({ code: 'cash', name: 'Cash', manual: true });
    expect(opts.body.methods).toBeUndefined();
    expect(opts.body.lines.map((l: any) => l.refundable_amount)).toEqual(['30.00', '10.00']);
  });

  it('a full cash refund writes a new refund transaction, calls no provider, keeps the original and the counter', async () => {
    const e = await paidCash();
    const res = await post(e.billingEventId, 'refund', { kind: 'full', method: 'cash' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ amount: '40.00', status: 'completed', method: 'cash', balance: { refund_state: 'full', refundable_amount: '0.00' } });
    expect(refundPayment).not.toHaveBeenCalled();
    const refunds = await refundRows(e.billingEventId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ transaction_type: 'refund', status: 'completed', method: 'cash', amount: '40.00', billing_event_id: null, payment_method_name: 'Cash' });
    const { rows: orig } = await db.query<any>('SELECT status, amount FROM payment_requests WHERE billing_event_id = ?', [e.billingEventId]);
    expect(orig).toEqual([{ status: 'completed', amount: '40.00' }]);
    const row = await listRow(e.memberId, e.billingEventId);
    expect(row).toMatchObject({ attempt_count: 1, payment_method_name: 'Cash', status: 'paid', refund_state: 'full', can_refund: false, normalized_payment_status: 'refunded' });
    // Shown in the event's transaction history.
    const txs = await get(`/payments/billing-events/${e.billingEventId}/transactions`);
    expect(txs.body.items.map((t: any) => t.transaction_type).sort()).toEqual(['payment', 'refund']);
    // Nothing left to refund.
    expect((await post(e.billingEventId, 'refund', { kind: 'full', method: 'cash' })).status).toBe(409);
  });

  it('ad-hoc refunds validate the amount and accumulate partial refunds', async () => {
    const e = await paidCash();
    for (const amount of ['0', '-5', 'abc', '1.234', '40.01']) {
      expect((await post(e.billingEventId, 'refund', { kind: 'adhoc', method: 'cash', amount })).status).toBe(400);
    }
    expect((await post(e.billingEventId, 'refund', { kind: 'adhoc', method: 'cash', amount: '30' })).status).toBe(201);
    expect((await post(e.billingEventId, 'refund', { kind: 'adhoc', method: 'cash', amount: '20' })).status).toBe(400);
    // #2797: a cash payment is not refunded through another method...
    expect((await post(e.billingEventId, 'refund', { kind: 'adhoc', method: 'card_terminal', amount: '5.50' })).status).toBe(400);
    // ...and a request that names none goes back in cash.
    const second = await post(e.billingEventId, 'refund', { kind: 'adhoc', amount: '5.50' });
    expect(second.body.method).toBe('cash');
    expect(second.body.balance).toMatchObject({ refunded_amount: '35.50', refundable_amount: '4.50', refund_state: 'partial' });
    const full = await post(e.billingEventId, 'refund', { kind: 'full', method: 'cash' });
    expect(full.body.amount).toBe('4.50');
    expect((await listRow(e.memberId, e.billingEventId)).normalized_payment_status).toBe('refunded');
  });

  it('selected line items refund each line once and never above the balance', async () => {
    const e = await paidCash();
    expect((await post(e.billingEventId, 'refund', { kind: 'lines', method: 'cash', line_ids: [] })).status).toBe(400);
    const one = await post(e.billingEventId, 'refund', { kind: 'lines', method: 'cash', line_ids: [e.lineIds[1]] });
    expect(one.status).toBe(201);
    expect(one.body.amount).toBe('10.00');
    expect((await post(e.billingEventId, 'refund', { kind: 'lines', method: 'cash', line_ids: [e.lineIds[1]] })).status).toBe(400);
    const opts = await get(`/payments/billing-events/${e.billingEventId}/refund-options`);
    expect(opts.body.lines.map((l: any) => l.refundable_amount)).toEqual(['30.00', '0.00']);
    // An ad-hoc refund leaves 5.00; the 30.00 line no longer fits.
    expect((await post(e.billingEventId, 'refund', { kind: 'adhoc', method: 'cash', amount: '25' })).status).toBe(201);
    expect((await post(e.billingEventId, 'refund', { kind: 'lines', method: 'cash', line_ids: [e.lineIds[0]] })).status).toBe(400);
    const other = await createEvent(gymId, [{ status: 'completed', method: 'cash', amount: '40.00' }]);
    expect((await post(e.billingEventId, 'refund', { kind: 'lines', method: 'cash', line_ids: [other.lineIds[0]] })).status).toBe(400);
  });

  it('concurrent refunds never exceed what was collected', async () => {
    const e = await paidCash();
    const results = await Promise.all([1, 2, 3, 4].map(() => post(e.billingEventId, 'refund', { kind: 'adhoc', method: 'cash', amount: '15' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    const total = (await refundRows(e.billingEventId)).reduce((s: number, r: any) => s + Number(r.amount), 0);
    expect(total).toBe(30);
  });

  it('does not touch receipts or contracted items', async () => {
    const e = await paidCash();
    await db.query("UPDATE billing_events SET receipt_number = 'R-2026-0001', receipt_issued_at = UTC_TIMESTAMP() WHERE id = ?", [e.billingEventId]);
    expect((await post(e.billingEventId, 'refund', { kind: 'full', method: 'cash' })).status).toBe(201);
    const { rows } = await db.query<any>('SELECT receipt_number, event_type, amount FROM billing_events WHERE id = ?', [e.billingEventId]);
    expect(rows[0]).toEqual({ receipt_number: 'R-2026-0001', event_type: 'payment_recorded', amount: '40.00' });
  });
});

describe('Refund — MONEI', () => {
  it('refunds through the provider with the original reference and records its answer', async () => {
    refundPayment.mockResolvedValue({ providerStatus: 'PARTIALLY_REFUNDED', providerRefundRef: 'pay_123', errorCode: null, errorMessage: null });
    const e = await paidMonei();
    const opts = await get(`/payments/billing-events/${e.billingEventId}/refund-options`);
    expect(opts.body.method).toEqual({ code: 'provider', name: 'Monei', manual: false });
    const res = await post(e.billingEventId, 'refund', { kind: 'adhoc', method: 'provider', amount: '12.34' });
    expect(res.status).toBe(201);
    expect(refundPayment).toHaveBeenCalledWith({ providerRef: 'pay_123', amount: 1234 });
    expect(res.body).toMatchObject({ status: 'completed', provider_status: 'PARTIALLY_REFUNDED' });
    const [r] = await refundRows(e.billingEventId);
    expect(r).toMatchObject({ status: 'completed', method: 'provider', provider_refund_ref: 'pay_123', provider_status: 'PARTIALLY_REFUNDED', payment_method_name: 'Monei' });
  });

  it('a rejected provider refund is not recorded as completed and releases the amount', async () => {
    refundPayment.mockResolvedValue({ providerStatus: 'SUCCEEDED', providerRefundRef: 'pay_123', errorCode: 'E1', errorMessage: 'not refundable' });
    const e = await paidMonei();
    const res = await post(e.billingEventId, 'refund', { kind: 'full', method: 'provider' });
    expect(res.status).toBe(502);
    expect((await refundRows(e.billingEventId))[0].status).toBe('failed');
    expect((await listRow(e.memberId, e.billingEventId)).refundable_amount).toBe('40.00');
  });

  it('an unreachable provider leaves the refund pending with its amount reserved', async () => {
    refundPayment.mockRejectedValue(new Error('fetch failed: timeout'));
    const e = await paidMonei();
    expect((await post(e.billingEventId, 'refund', { kind: 'full', method: 'provider' })).status).toBe(502);
    expect((await refundRows(e.billingEventId))[0].status).toBe('pending');
    // A retry cannot refund the same money again.
    expect((await post(e.billingEventId, 'refund', { kind: 'full', method: 'provider' })).status).toBe(409);
    expect(refundPayment).toHaveBeenCalledTimes(1);
  });

  it('a cash payment cannot be refunded through the provider', async () => {
    const e = await paidCash();
    expect((await post(e.billingEventId, 'refund', { kind: 'full', method: 'provider' })).status).toBe(400);
    expect(refundPayment).not.toHaveBeenCalled();
  });
});

// #2797: a refund always goes back through the original payment's method.
describe('Refund — original payment method', () => {
  it('a provider payment is refunded through the provider when the request names no method', async () => {
    refundPayment.mockResolvedValue({ providerStatus: 'REFUNDED', providerRefundRef: 'pay_123', errorCode: null, errorMessage: null });
    const e = await paidMonei();
    const res = await post(e.billingEventId, 'refund', { kind: 'full' });
    expect(res.status).toBe(201);
    expect(res.body.method).toBe('provider');
    expect(refundPayment).toHaveBeenCalledWith({ providerRef: 'pay_123', amount: 4000 });
    const [r] = await refundRows(e.billingEventId);
    expect(r).toMatchObject({ method: 'provider', status: 'completed', payment_method_name: 'Monei' });
  });

  it('a provider payment cannot be handed back as a manual refund', async () => {
    const e = await paidMonei();
    for (const method of ['cash', 'card_terminal']) {
      expect((await post(e.billingEventId, 'refund', { kind: 'full', method })).status).toBe(400);
    }
    expect(refundPayment).not.toHaveBeenCalled();
    expect(await refundRows(e.billingEventId)).toHaveLength(0);
    expect((await listRow(e.memberId, e.billingEventId)).refundable_amount).toBe('40.00');
  });

  it('a card-terminal payment is refunded as a manual card refund, with no provider call', async () => {
    const e = await createEvent(gymId, [{ status: 'completed', method: 'card_terminal', amount: '40.00', name: 'Card' }]);
    const opts = await get(`/payments/billing-events/${e.billingEventId}/refund-options`);
    expect(opts.body.method).toEqual({ code: 'card_terminal', name: 'Card', manual: true });
    expect((await post(e.billingEventId, 'refund', { kind: 'full', method: 'cash' })).status).toBe(400);
    const res = await post(e.billingEventId, 'refund', { kind: 'adhoc', amount: '10' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ method: 'card_terminal', status: 'completed' });
    expect(refundPayment).not.toHaveBeenCalled();
    const [r] = await refundRows(e.billingEventId);
    expect(r).toMatchObject({ method: 'card_terminal', payment_method_name: 'Card' });
  });

  it('several partial refunds all stay on the original payment and its method', async () => {
    refundPayment.mockResolvedValue({ providerStatus: 'PARTIALLY_REFUNDED', providerRefundRef: 'pay_123', errorCode: null, errorMessage: null });
    const e = await paidMonei();
    expect((await post(e.billingEventId, 'refund', { kind: 'lines', line_ids: [e.lineIds[1]] })).status).toBe(201);
    expect((await post(e.billingEventId, 'refund', { kind: 'adhoc', amount: '5' })).status).toBe(201);
    expect((await post(e.billingEventId, 'refund', { kind: 'adhoc', amount: '25.01' })).status).toBe(400); // above the 25.00 left
    const rows = await refundRows(e.billingEventId);
    expect(rows.map((r: any) => r.method)).toEqual(['provider', 'provider']);
    const { rows: orig } = await db.query<any>("SELECT id FROM payment_requests WHERE billing_event_id = ? AND transaction_type = 'payment'", [e.billingEventId]);
    expect(rows.every((r: any) => r.refund_of_payment_request_id === orig[0].id)).toBe(true);
    expect(refundPayment).toHaveBeenCalledTimes(2);
  });

  it('a provider payment with no provider reference is not refunded through anything', async () => {
    const e = await createEvent(gymId, [{ status: 'completed', method: 'provider', amount: '40.00', name: 'Monei' }]);
    expect((await get(`/payments/billing-events/${e.billingEventId}/refund-options`)).status).toBe(409);
    expect((await post(e.billingEventId, 'refund', { kind: 'full' })).status).toBe(409);
    expect((await post(e.billingEventId, 'refund', { kind: 'full', method: 'cash' })).status).toBe(409);
    expect(refundPayment).not.toHaveBeenCalled();
    expect(await refundRows(e.billingEventId)).toHaveLength(0);
  });
});

describe('Refund — flag and permissions', () => {
  it('is refused for a non-admin role even with write access', async () => {
    const e = await createEvent(frontDeskGymId, [{ status: 'completed', method: 'cash', amount: '40.00' }]);
    expect((await listRow(e.memberId, e.billingEventId, frontDeskGymId)).can_refund).toBe(false);
    expect((await post(e.billingEventId, 'refund', { kind: 'full', method: 'cash' }, frontDeskGymId)).status).toBe(403);
    expect((await get(`/payments/billing-events/${e.billingEventId}/refund-options`, frontDeskGymId)).status).toBe(403);
    expect(await refundRows(e.billingEventId)).toHaveLength(0);
  });

  it('is unavailable while the Refund feature flag is off', async () => {
    const e = await paidCash();
    await db.query("UPDATE feature_flags SET enabled = 0 WHERE feature_key = 'payments.billing_events.refund'");
    invalidateFeatureFlagsCache();
    try {
      expect((await listRow(e.memberId, e.billingEventId)).can_refund).toBe(false);
      expect((await post(e.billingEventId, 'refund', { kind: 'full', method: 'cash' })).status).toBe(403);
    } finally {
      await db.query("UPDATE feature_flags SET enabled = 1 WHERE feature_key = 'payments.billing_events.refund'");
      invalidateFeatureFlagsCache();
    }
    expect((await post(e.billingEventId, 'refund', { kind: 'full', method: 'cash' })).status).toBe(201);
  });

  it('is tenant-isolated and needs authentication', async () => {
    const e = await paidCash();
    expect((await post(e.billingEventId, 'refund', { kind: 'full', method: 'cash' }, otherGymId)).status).toBe(404);
    const unauth = await request.post(`/payments/billing-events/${e.billingEventId}/refund`).set('x-gym-id', gymId).send({});
    expect(unauth.status).toBe(401);
  });
});
