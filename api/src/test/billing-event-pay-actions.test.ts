// #1459: Pay Cash / Pay Card (external terminal) / Waive on a Billing Event.
// Integration — the online provider is mocked only to prove it is never called.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request,
  ensureTestProductSet, legacyAssignmentQuery, legacyChildQuery,
} from './helpers';

const executeRecurring = vi.fn();
const createPaymentRequest = vi.fn();
vi.mock('../payments', () => ({
  getPaymentProvider: () => ({ executeRecurring, createPaymentRequest }),
}));

let gymId: string;
let otherGymId: string;

beforeAll(async () => {
  gymId = await createTestGym('BE PayActions Gym');
  otherGymId = await createTestGym('BE PayActions Other');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

const today = () => new Date().toISOString().slice(0, 10);

async function createFailedEvent(gym: string, eventType = 'failed_billing') {
  const { rows: ct } = await db.query<{ id: number }>("SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1");
  const { insertId: memberId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Pay Actions', ?)`,
    [gym, `pay-actions-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`],
  );
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'staff_only')`,
    [gym, `PA-Plan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`],
  );
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`, [gym, planId]);
  const { insertId: membershipId } = await legacyAssignmentQuery(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, base_price)
     VALUES (?, ?, ?, 'active', '2000-01-01', '40.00')`, [gym, memberId, planId]);
  await legacyChildQuery(
    `INSERT INTO user_membership_members (gym_id, user_membership_id, member_id, is_owner) VALUES (?, ?, ?, 1)`,
    [gym, membershipId, memberId]);
  const { insertId: billingEventId } = await db.query(
    `INSERT INTO billing_events
       (gym_id, product_set_id, member_id, event_type, amount, charge_type_id, source, actor_user_id, notes, billing_date)
     VALUES (?, ?, ?, ?, '40.00', ?, 'system', NULL, 'E999: card declined', ?)`,
    [gym, await ensureTestProductSet(gym, memberId, membershipId), memberId, eventType, ct[0].id, today()]);
  await db.query(
    `INSERT INTO payment_requests
       (gym_id, user_membership_id, member_id, amount, currency, charge_type_id, billing_event_id,
        status, provider, provider_order, source, created_at, failure_code, failure_message)
     VALUES (?, ?, ?, '40.00', 'EUR', ?, ?, 'failed', 'monei', UUID(), 'billing_run', UTC_TIMESTAMP(), 'E999', 'declined')`,
    [gym, membershipId, memberId, ct[0].id, billingEventId]);
  return { memberId, membershipId, billingEventId };
}

const post = (id: number, action: string, body: object = {}, gym = gymId) =>
  request.post(`/payments/billing-events/${id}/${action}`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym).send(body);

const attempts = async (id: number) =>
  (await db.query<any>('SELECT status, method, amount FROM payment_requests WHERE billing_event_id = ? ORDER BY id', [id])).rows;

describe('Pay Card (external terminal)', () => {
  it('records a card_terminal settlement with no provider call and no second event', async () => {
    const f = await createFailedEvent(gymId);
    const res = await post(f.billingEventId, 'manual-payment', { method: 'card_terminal' });
    expect(res.status).toBe(201);
    expect(res.body.method).toBe('card_terminal');
    expect(res.body.new_status).toBe('paid');
    const rows = await attempts(f.billingEventId);
    expect(rows.at(-1)).toMatchObject({ status: 'completed', method: 'card_terminal', amount: '40.00' });
    expect(executeRecurring).not.toHaveBeenCalled();
    expect(createPaymentRequest).not.toHaveBeenCalled();
    const { rows: ev } = await db.query<any>('SELECT COUNT(*) AS n FROM billing_events WHERE member_id = ?', [f.memberId]);
    expect(Number(ev[0].n)).toBe(1);
  });

  it('defaults to cash and rejects an unknown method', async () => {
    const f = await createFailedEvent(gymId);
    expect((await post(f.billingEventId, 'manual-payment', { method: 'provider' })).status).toBe(400);
    const ok = await post(f.billingEventId, 'manual-payment');
    expect(ok.body.method).toBe('cash');
  });

  it('settles once under concurrent submissions', async () => {
    const f = await createFailedEvent(gymId);
    const results = await Promise.all([1, 2, 3].map(() => post(f.billingEventId, 'manual-payment', { method: 'card_terminal' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect((await attempts(f.billingEventId)).filter((a: any) => a.status === 'completed')).toHaveLength(1);
  });
});

describe('Waive', () => {
  it('requires a reason', async () => {
    const f = await createFailedEvent(gymId);
    expect((await post(f.billingEventId, 'waive', {})).status).toBe(400);
    expect((await post(f.billingEventId, 'waive', { reason: '  ' })).status).toBe(400);
    expect((await attempts(f.billingEventId)).some((a: any) => a.method === 'waive')).toBe(false);
  });

  it('waives on the same event: zero-amount waive attempt, waived_billing, no receipt, no provider', async () => {
    const f = await createFailedEvent(gymId);
    const res = await post(f.billingEventId, 'waive', { reason: 'Goodwill' });
    expect(res.status).toBe(201);
    expect(res.body.waived_amount).toBe('40.00');
    expect((await attempts(f.billingEventId)).at(-1)).toMatchObject({ status: 'completed', method: 'waive', amount: '0.00' });
    const { rows } = await db.query<any>('SELECT event_type, amount, is_scheduled FROM billing_events WHERE id = ?', [f.billingEventId]);
    expect(rows[0].event_type).toBe('waived_billing');
    expect(executeRecurring).not.toHaveBeenCalled();

    const receipt = await request.post(`/payments/${f.billingEventId}/receipt`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send({});
    expect(receipt.status).toBe(400);
  });

  it('is refused for a settled or already waived event, and cannot then be paid or retried', async () => {
    const f = await createFailedEvent(gymId);
    expect((await post(f.billingEventId, 'waive', { reason: 'x' })).status).toBe(201);
    expect((await post(f.billingEventId, 'waive', { reason: 'x' })).status).toBe(409);
    expect((await post(f.billingEventId, 'manual-payment')).status).toBe(409);
    expect((await post(f.billingEventId, 'retry')).status).toBe(409);
  });

  it('is tenant-isolated and needs write access', async () => {
    const f = await createFailedEvent(gymId);
    expect((await post(f.billingEventId, 'waive', { reason: 'x' }, otherGymId)).status).toBe(404);
    const unauth = await request.post(`/payments/billing-events/${f.billingEventId}/waive`).set('x-gym-id', gymId).send({ reason: 'x' });
    expect(unauth.status).toBe(401);
    const roGym = await createTestGym('BE Waive RO');
    await createTestMembership(roGym, 'accountant');
    const g = await createFailedEvent(roGym);
    expect((await post(g.billingEventId, 'waive', { reason: 'x' }, roGym)).status).toBe(403);
  });

  it('exposes the actions on the list and details, and none once waived', async () => {
    const f = await createFailedEvent(gymId);
    const before = await request.get(`/payments/billing-events/${f.billingEventId}`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(before.body).toMatchObject({ can_pay_cash: true, can_pay_card: true, can_waive: true, can_retry: true });
    await post(f.billingEventId, 'waive', { reason: 'x' });
    const after = await request.get(`/payments/billing-events/${f.billingEventId}`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(after.body).toMatchObject({ can_pay_cash: false, can_pay_card: false, can_waive: false, can_retry: false });
    expect(after.body.event_type).toBe('waived_billing');
  });
});
