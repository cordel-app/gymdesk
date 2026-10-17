// #1664 — Save & Pay with a payment method chosen in the confirmation modal.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';

let providerBehaviour: 'succeed' | 'fail' | 'throw' = 'succeed';
let providerCalls = 0;
vi.mock('../payments', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../payments')>();
  return {
    ...mod,
    getPaymentProvider: () => {
      const real = mod.getPaymentProvider();
      return Object.assign(Object.create(real), {
        createPaymentRequest: async (p: { orderId: string }) => ({ providerOrderId: `monei-${p.orderId}`, checkoutUrl: 'https://pay.test/x' }),
        executeRecurring: async () => {
          providerCalls += 1;
          if (providerBehaviour === 'throw') throw new Error('timeout');
          return providerBehaviour === 'succeed'
            ? { success: true, providerRef: 'ref-1', providerStatus: 'SUCCEEDED' }
            : { success: false, providerStatus: 'FAILED', errorCode: 'E1', errorMessage: 'declined' };
        },
      });
    },
  };
});

import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function member(withToken = false): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'Pay Member', `pm-${uniq()}@test.com`]);
  if (withToken) {
    await db.query(
      `INSERT INTO payment_methods (gym_id, member_id, provider, payment_token, sequence_id, card_brand, card_last4)
       VALUES (?, ?, 'monei', 'tok', 'seq', 'visa', '4242')`, [gymId, insertId]);
  }
  return insertId;
}
async function plan(price: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit) VALUES (?, ?, 'active', 'public', '1')`,
    [gymId, `PM-Plan-${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status) VALUES (?, ?, ?, '2020-01-01', 'active')`, [gymId, insertId, price]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit) VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return insertId;
}
async function draft(memberId: number): Promise<number> {
  const res = await auth(request.post('/product-sets')).send({ member_id: memberId, membership_plan_id: await plan(30), starts_at: TODAY });
  expect(res.status).toBe(201);
  return res.body.id;
}
const statusOf = async (id: number) => (await db.query<any>('SELECT status FROM product_sets WHERE id = ?', [id])).rows[0].status;

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = 'test-webhook-secret';
  gymId = await createTestGym('Pay Method Gym');
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

describe('POST /product-sets/:id/pay (#1664)', () => {
  it('review lists the active catalogue methods, the tax split, and keeps the Draft a Draft', async () => {
    const id = await draft(await member());
    const res = await auth(request.get(`/product-sets/${id}/review`));
    expect(res.status).toBe(200);
    const codes = res.body.payment_methods.map((m: any) => m.code);
    expect(codes).toEqual(expect.arrayContaining(['cash', 'card', 'monei', 'members_app']));
    expect(codes).not.toContain('google_pay'); // inactive in the catalogue
    expect(res.body.payment_methods.find((m: any) => m.code === 'monei')).toMatchObject({ available: false, reason: 'monei_token_missing' });
    expect(res.body.amount_due).toBe(30);
    expect(typeof res.body.net_total).toBe('number');
    expect(await statusOf(id)).toBe('draft');
  });

  it.each([['cash', 'cash'], ['card', 'card_terminal']])('%s is confirmed by staff: active, method kept, no provider call', async (code, method) => {
    providerCalls = 0;
    const id = await draft(await member());
    const res = await auth(request.post(`/product-sets/${id}/pay`)).send({ method: code });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'active', outcome: 'paid', amount: 30 });
    const { rows } = await db.query<any>('SELECT method, status FROM payment_requests WHERE billing_event_id = ?', [res.body.billing_event_id]);
    expect(rows).toEqual([{ method, status: 'completed' }]);
    expect(providerCalls).toBe(0);
    expect(await statusOf(id)).toBe('active');
    // A second submission cannot pay twice.
    const again = await auth(request.post(`/product-sets/${id}/pay`)).send({ method: code });
    expect(again.status).toBe(409);
    const { rows: n } = await db.query<any>('SELECT COUNT(*) AS n FROM payment_requests WHERE billing_event_id = ?', [res.body.billing_event_id]);
    expect(Number(n[0].n)).toBe(1);
  });

  it('refuses a method with no flow and writes nothing', async () => {
    const id = await draft(await member());
    const res = await auth(request.post(`/product-sets/${id}/pay`)).send({ method: 'google_pay' });
    expect(res.status).toBe(400);
    expect(await statusOf(id)).toBe('draft');
  });

  it('monei without a token is refused before any write or provider call', async () => {
    providerCalls = 0;
    const id = await draft(await member());
    const res = await auth(request.post(`/product-sets/${id}/pay`)).send({ method: 'monei' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('monei_token_missing');
    expect(providerCalls).toBe(0);
    expect(await statusOf(id)).toBe('draft');
  });

  it('monei with a token activates only when the provider settles', async () => {
    providerBehaviour = 'succeed';
    const id = await draft(await member(true));
    const res = await auth(request.post(`/product-sets/${id}/pay`)).send({ method: 'monei' });
    expect(res.status).toBe(201);
    expect(res.body.outcome).toBe('paid');
    expect(await statusOf(id)).toBe('active');
  });

  it('a declined or unanswered monei charge never activates', async () => {
    providerBehaviour = 'fail';
    const a = await draft(await member(true));
    const failed = await auth(request.post(`/product-sets/${a}/pay`)).send({ method: 'monei' });
    expect(failed.status).toBe(202);
    expect(failed.body.outcome).toBe('failed');
    expect(await statusOf(a)).toBe('pending_payment');

    providerBehaviour = 'throw';
    const b = await draft(await member(true));
    const unknown = await auth(request.post(`/product-sets/${b}/pay`)).send({ method: 'monei' });
    expect(unknown.status).toBe(202);
    expect(unknown.body.outcome).toBe('unknown');
    expect(await statusOf(b)).toBe('pending_payment');
    const { rows } = await db.query<any>('SELECT status, provider_status FROM payment_requests WHERE billing_event_id = ?', [unknown.body.billing_event_id]);
    expect(rows[0]).toMatchObject({ status: 'pending', provider_status: null });
    providerBehaviour = 'succeed';
  });

  it('members_app is the existing Save & Pay (pending checkout)', async () => {
    const id = await draft(await member());
    const res = await auth(request.post(`/product-sets/${id}/pay`)).send({ method: 'members_app' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending_payment');
    expect(res.body.checkout_url).toContain('/checkout?token=');
  });

  it('requires auth and is tenant scoped', async () => {
    const id = await draft(await member());
    expect((await request.post(`/product-sets/${id}/pay`).send({ method: 'cash' })).status).toBe(401);
    const other = await createTestGym('Pay Method Other');
    await createTestMembership(other, 'admin');
    const res = await request.post(`/product-sets/${id}/pay`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', other).send({ method: 'cash' });
    expect(res.status).toBe(404);
  });
});
