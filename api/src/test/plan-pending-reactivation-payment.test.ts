// #3114 — a reactivation marked in a cart that also owes money is committed only when the payment is
// confirmed, and is audited only then: while the payment is pending, or after it fails, the plan is
// still the cancelling plan it was marked from (`to_be_reactivated`) and nothing records a reactivation.

import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';

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

import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';

const SECRET = 'test-3114-webhook';
let gymId: string;
let centerId: number;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const authed = (req: any) => req.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

function webhook(payload: unknown) {
  const raw = JSON.stringify(payload);
  const t = String(Math.floor(Date.now() / 1000));
  const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
  return request.post('/webhooks/payment').set({ 'monei-signature': `t=${t},v1=${v1}` })
    .set('Content-Type', 'application/json').send(raw);
}
async function settle(paymentRequestId: number, ok: boolean) {
  const { rows } = await db.query<any>('SELECT provider_order FROM payment_requests WHERE id = ?', [paymentRequestId]);
  const id = crypto.randomBytes(12).toString('hex');
  return webhook({
    id: `evt_${id}`, type: ok ? 'charge.succeeded' : 'charge.failed', objectId: id, objectType: 'charge',
    object: { id, orderId: rows[0].provider_order, status: ok ? 'SUCCEEDED' : 'FAILED' },
  });
}

async function cartWithReactivation() {
  const { insertId: memberId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'RAP Member', `rap-${uniq()}@test.com`]);
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit, center_access_mode,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', 1, 'specific_centers', NULL, NULL, 0, 0)`, [gymId, `RAP Plan ${uniq()}`]);
  await db.query('INSERT INTO membership_plan_centers (gym_id, membership_plan_id, center_id) VALUES (?, ?, ?)', [gymId, planId, centerId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, planId]);
  const umId = await createTestDraftAssignment(gymId, memberId, planId, { config: { membership_fee_price: 10 } });
  await authed(request.post(`/user-memberships/${umId}/activate`)).send({ on_conflict: 'add' });
  expect((await authed(request.delete(`/user-memberships/${umId}`))).status).toBe(204);
  const mark = await authed(request.post(`/user-memberships/${umId}/mark-reactivate`));
  expect(mark.status).toBe(200);
  // A one-time Product in the same cart makes the commit owe money.
  const { insertId: productId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, is_system, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', 'month', 'active', 'public', 0, 'EUR', '20.00', 'inclusive')`, [gymId, `RAP Locker ${uniq()}`]);
  const buy = await authed(request.post(`/members/${memberId}/product-purchases`)).send({ product_id: productId });
  expect(buy.status).toBe(201);
  return { memberId, umId, setId: Number(mark.body.product_set_id) };
}

const planStatus = async (umId: number) => (await db.query<any>(
  'SELECT status FROM plan_snapshots WHERE gym_id = ? AND source_user_membership_id = ? ORDER BY id DESC LIMIT 1', [gymId, umId])).rows[0].status;
const statusAudits = async (umId: number) => Number((await db.query<any>(
  `SELECT COUNT(*) AS n FROM audit_logs WHERE gym_id = ? AND entity_type = 'user_membership' AND entity_id = ? AND action = 'status_change'`,
  [gymId, String(umId)])).rows[0].n);

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = SECRET;
  gymId = await createTestGym('Pending Reactivate Pay Gym');
  await createTestMembership(gymId, 'admin');
  const { insertId } = await db.query('INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)', [gymId, 'RAP Center', 'active']);
  centerId = insertId as number;
});
afterAll(async () => {
  delete process.env.MONEI_API_KEY;
  delete process.env.MONEI_WEBHOOK_SECRET;
  await db.query('DELETE FROM payment_requests WHERE gym_id = ?', [gymId]);
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('reactivation committed by a paid cart (#3114)', () => {
  it('is audited and applied only when the payment is confirmed', async () => {
    const { umId, setId } = await cartWithReactivation();
    const before = await statusAudits(umId);
    const sp = await authed(request.post(`/product-sets/${setId}/save-and-pay`)).send({});
    expect(sp.status).toBe(201);
    // Payment pending: nothing is reactivated, nothing is audited.
    expect(await planStatus(umId)).toBe('to_be_reactivated');
    expect(await statusAudits(umId)).toBe(before);

    expect((await settle(sp.body.payment_request_id, true)).status).toBe(200);
    expect(await planStatus(umId)).toBe('active');
    expect(await statusAudits(umId)).toBe(before + 1);
  });

  it('a failed payment reactivates and audits nothing', async () => {
    const { umId, setId } = await cartWithReactivation();
    const before = await statusAudits(umId);
    const sp = await authed(request.post(`/product-sets/${setId}/save-and-pay`)).send({});
    expect(sp.status).toBe(201);
    expect((await settle(sp.body.payment_request_id, false)).status).toBe(200);
    expect(await planStatus(umId)).toBe('to_be_reactivated');
    expect(await statusAudits(umId)).toBe(before);
  });
});
