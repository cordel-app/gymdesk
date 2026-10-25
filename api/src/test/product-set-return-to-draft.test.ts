import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { expirePendingPayments } from '../api/product-sets';

// The real provider verifies the webhook signature; only the call that would
// reach Monei is stubbed.
vi.mock('../payments', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../payments')>();
  return {
    ...mod,
    getPaymentProvider: () => {
      const real = mod.getPaymentProvider();
      return Object.assign(Object.create(real), {
        createPaymentRequest: async (p: { orderId: string }) => ({
          providerOrderId: `monei-${p.orderId}`, checkoutUrl: 'https://pay.test/x',
        }),
      });
    },
  };
});

import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';

const SECRET = 'test-return-to-draft';
let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const day = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const TODAY = day(0);

const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'PS Member', `ps-${uniq()}@test.com`]);
  return insertId;
}
async function plan(price: number, free: number | null = null): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', ?, NULL, 0, 0)`, [gymId, `PS-Plan-${uniq()}`, free]);
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status) VALUES (?, ?, ?, ?, 'active')`,
    [gymId, insertId, price, day(-365)]);
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit) VALUES (?, ?, 1, 'month')`,
    [gymId, insertId]);
  return insertId;
}
beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = SECRET;
  gymId = await createTestGym('PS api gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  delete process.env.MONEI_API_KEY;
  delete process.env.MONEI_WEBHOOK_SECRET;
  await db.query('DELETE FROM payment_requests WHERE gym_id = ?', [gymId]);
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});


async function pending() {
  const memberId = await member();
  const planId = await plan(40);
  const c = await auth(request.post('/product-sets')).send({ member_id: memberId, membership_plan_id: planId, starts_at: TODAY });
  const pay = await auth(request.post(`/product-sets/${c.body.id}/save-and-pay`)).send({});
  expect(pay.body.status).toBe('pending_payment');
  const { insertId: umId } = await db.query(
    `INSERT INTO user_memberships (gym_id, member_id, status, starts_at) VALUES (?, ?, 'pending_payment', ?)`,
    [gymId, memberId, TODAY]);
  await db.query('UPDATE product_sets SET user_membership_id = ? WHERE id = ?', [umId, c.body.id]);
  return { id: Number(c.body.id), memberId, planId, umId, requestId: Number(pay.body.payment_request_id) };
}
const eventCount = async (id: number) =>
  Number((await db.query<any>('SELECT COUNT(*) AS n FROM billing_events WHERE product_set_id = ?', [id])).rows[0].n);

describe('Pending Payment returns to Draft (#1991 stage 4)', () => {
  it('a manual cancel keeps the configuration, deletes the unpaid event and returns the assignment to draft', async () => {
    const p = await pending();
    expect(await eventCount(p.id)).toBe(1);
    // A fresh checkout's attempt has a provider reference and no outcome, which
    // the guard (#1535) reads as unknown; cancelling needs it definitively over.
    await db.query(`UPDATE payment_requests SET status = 'failed' WHERE id = ?`, [p.requestId]);
    const del = await auth(request.delete(`/product-sets/${p.id}`));
    expect(del.status).toBe(204);
    const { rows } = await db.query<any>('SELECT status, membership_plan_id, payment_request_id FROM product_sets WHERE id = ?', [p.id]);
    expect(rows[0].status).toBe('draft');
    expect(Number(rows[0].membership_plan_id)).toBe(p.planId);
    expect(rows[0].payment_request_id).toBeNull();
    expect(await eventCount(p.id)).toBe(0);
    const { rows: pr } = await db.query<any>('SELECT id FROM payment_requests WHERE id = ?', [p.requestId]);
    expect(pr).toHaveLength(0);
    const { rows: um } = await db.query<any>('SELECT status FROM user_memberships WHERE id = ?', [p.umId]);
    expect(um[0].status).toBe('draft');
    // It is a real Draft again: it can be paid once more, or discarded for good.
    const again = await auth(request.post(`/product-sets/${p.id}/save-and-pay`)).send({});
    expect(again.status).toBe(201);
    expect(again.body.status).toBe('pending_payment');
  });

  it('a payment of unknown outcome is not returned to Draft', async () => {
    const p = await pending();
    await db.query(`UPDATE payment_requests SET provider_ref = 'unknown-outcome', status = 'pending', provider_status = NULL WHERE id = ?`, [p.requestId]);
    const del = await auth(request.delete(`/product-sets/${p.id}`));
    expect(del.status).toBe(409);
    expect(del.body.error).toBe('payment_unresolved');
    const { rows } = await db.query<any>('SELECT status FROM product_sets WHERE id = ?', [p.id]);
    expect(rows[0].status).toBe('pending_payment');
    expect(await eventCount(p.id)).toBe(1);
  });

  it('a payment that already settled is never rolled back', async () => {
    const p = await pending();
    await db.query(`UPDATE payment_requests SET status = 'completed', provider_ref = 'paid' WHERE id = ?`, [p.requestId]);
    const del = await auth(request.delete(`/product-sets/${p.id}`));
    expect(del.status).toBe(409);
    expect(await eventCount(p.id)).toBe(1);
  });

  it('the expiry sweep returns a set whose payment link expired, and leaves a merely failed one pending', async () => {
    const expired = await pending();
    const failed = await pending();
    await db.query(`UPDATE payment_requests SET status = 'expired' WHERE id = ?`, [expired.requestId]);
    await db.query(`UPDATE payment_requests SET status = 'failed' WHERE id = ?`, [failed.requestId]);
    expect(await expirePendingPayments()).toBeGreaterThanOrEqual(1);
    const st = async (id: number) => (await db.query<any>('SELECT status FROM product_sets WHERE id = ?', [id])).rows[0].status;
    expect(await st(expired.id)).toBe('draft');
    expect(await eventCount(expired.id)).toBe(0);
    expect(await st(failed.id)).toBe('pending_payment');
  });
});
