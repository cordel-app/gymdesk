// #2811 — the editing lock agrees with the Payments tab, and a Draft the member
// already holds is always editable. Integration against real MySQL.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const day = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const TODAY = day(0);
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Lock Member', `lock-${uniq()}@test.com`]);
  return insertId;
}

async function freePlan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', NULL, NULL, 0, 0)`, [gymId, `Lock-Plan-${uniq()}`]);
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status) VALUES (?, ?, 0, ?, 'active')`,
    [gymId, insertId, day(-365)]);
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit) VALUES (?, ?, 1, 'month')`,
    [gymId, insertId]);
  return insertId;
}

/** A member holding an Active set. */
async function activeMember(): Promise<{ memberId: number; setId: number }> {
  const memberId = await member();
  const c = await auth(request.post('/product-sets')).send({ member_id: memberId, membership_plan_id: await freePlan(), starts_at: TODAY });
  expect(c.status).toBe(201);
  expect((await auth(request.post(`/product-sets/${c.body.id}/activate`)).send({})).status).toBe(200);
  return { memberId, setId: c.body.id };
}

/** A past event of the set whose latest attempt failed at the provider. */
async function failedEvent(memberId: number, setId: number, opts: { eventType?: string; cancelled?: boolean } = {}) {
  const ev = await db.query(
    `INSERT INTO billing_events (gym_id, member_id, event_type, source, amount, product_set_id, billing_date, is_scheduled, cancelled_at)
     VALUES (?, ?, ?, 'system', 10, ?, ?, 0, ?)`,
    [gymId, memberId, opts.eventType ?? 'failed_billing', setId, day(-3), opts.cancelled ? new Date() : null]);
  await db.query(
    `INSERT INTO payment_requests (gym_id, member_id, amount, status, source, billing_event_id, attempt, provider_status)
     VALUES (?, ?, 10, 'failed', 'billing_run', ?, 1, 'FAILED')`, [gymId, memberId, ev.insertId]);
  return ev.insertId;
}

const unresolvedOnPaymentsTab = async (memberId: number) => {
  const res = await auth(request.get(`/payments/billing-events?member_id=${memberId}&limit=200`));
  expect(res.status).toBe(200);
  return res.body.items.filter((e: any) => ['scheduled', 'failed', 'pending'].includes(e.status));
};

beforeAll(async () => {
  gymId = await createTestGym('Draft Edit Lock Gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  await db.query('DELETE FROM payment_requests WHERE gym_id = ?', [gymId]);
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('editing lock agrees with the Payments tab (#2811)', () => {
  it('a cancelled event does not lock the member out of a Draft', async () => {
    const { memberId, setId } = await activeMember();
    await failedEvent(memberId, setId, { cancelled: true });
    expect(await unresolvedOnPaymentsTab(memberId)).toHaveLength(0);

    expect((await auth(request.get(`/product-sets/edit-check?member_id=${memberId}`))).body.editable).toBe(true);
    const draft = await auth(request.post('/product-sets/draft')).send({ member_id: memberId });
    expect(draft.status).toBe(201);
  });

  it('a failed card verification does not lock it either', async () => {
    const { memberId, setId } = await activeMember();
    await failedEvent(memberId, setId, { eventType: 'card_verification' });
    expect((await auth(request.get(`/product-sets/edit-check?member_id=${memberId}`))).body.editable).toBe(true);
    expect((await auth(request.post('/product-sets/draft')).send({ member_id: memberId })).status).toBe(201);
  });

  it('a genuine unresolved obligation still refuses a new Draft and shows on the Payments tab', async () => {
    const { memberId, setId } = await activeMember();
    const evId = await failedEvent(memberId, setId);
    expect((await unresolvedOnPaymentsTab(memberId)).map((e: any) => e.id)).toContain(evId);
    const res = await auth(request.post('/product-sets/draft')).send({ member_id: memberId });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('edit_locked');
  });
});

describe('a Draft the member holds stays editable (#2811)', () => {
  it('reopens the existing Draft and adds a Product to it after an obligation failed, but Save & Pay is still refused', async () => {
    const { memberId, setId } = await activeMember();
    const draft = await auth(request.post('/product-sets/draft')).send({ member_id: memberId });
    expect(draft.status).toBe(201);

    await failedEvent(memberId, setId);

    const again = await auth(request.post('/product-sets/draft')).send({ member_id: memberId });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(draft.body.id);

    const { insertId: productId } = await db.query(
      `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, is_system, currency, amount, tax_behavior)
       VALUES (?, ?, 'service', 'month', 'active', 'public', 0, 'EUR', '5.00', 'inclusive')`, [gymId, `Towel-${uniq()}`]);
    const add = await auth(request.post(`/members/${memberId}/product-purchases`)).send({ product_id: productId });
    expect(add.status).toBe(201);
    expect(add.body.product_set_id).toBe(draft.body.id);

    // Committing still waits for the debt to be resolved.
    const commit = await auth(request.post(`/product-sets/${draft.body.id}/save-and-pay`)).send({});
    expect(commit.status).toBe(409);
    expect(commit.body.error).toBe('edit_locked');
  });
});
