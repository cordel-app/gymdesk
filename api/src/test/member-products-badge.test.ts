// #3243 — the Member card's Products tab badge counts the member's recurring
// Membership Plans and recurring Products that are Active or Cancel on their End
// Date; one-off Products, In Cart / pending items and paused or ended plans are not.
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';

vi.mock('../payments', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../payments')>();
  return {
    ...mod,
    getPaymentProvider: () => Object.assign(Object.create(mod.getPaymentProvider()), {
      createPaymentRequest: async (p: { orderId: string }) => ({
        providerOrderId: `monei-${p.orderId}`, checkoutUrl: 'https://pay.test/x',
      }),
    }),
  };
});
import {
  TEST_AUTH_HEADER, activateTestAssignment, cleanupTestGyms, createTestDraftAssignment, createTestGym,
  createTestMembership, request,
} from './helpers';

const SECRET = 'test-3243-webhook';
let gymId: string;
let otherGymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any, gym = gymId) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
const must = (res: any, what: string) => {
  if (res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
};

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Badge Member', `mpb-${uniq()}@test.com`]);
  return Number(insertId);
}
async function plan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 1)`, [gymId, `MPB Plan ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 0, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}
async function product(frequency: 'month' | 'once'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, is_system, currency, amount, tax_behavior)
     VALUES (?, ?, 'service', ?, 'active', 'public', 0, 'EUR', '5.00', 'inclusive')`,
    [gymId, `MPB Product ${uniq()}`, frequency]);
  return Number(insertId);
}
async function runningPlan(m: number): Promise<number> {
  const um = await createTestDraftAssignment(gymId, m, await plan());
  await activateTestAssignment(gymId, um);
  return um;
}
async function pay(paymentRequestId: number) {
  const { rows } = await db.query<any>('SELECT provider_order FROM payment_requests WHERE id = ?', [paymentRequestId]);
  const id = crypto.randomBytes(12).toString('hex');
  const raw = JSON.stringify({
    id: `evt_${id}`, type: 'charge.succeeded', objectId: id, objectType: 'charge',
    object: { id, orderId: rows[0].provider_order, status: 'SUCCEEDED' },
  });
  const t = String(Math.floor(Date.now() / 1000));
  const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
  return request.post('/webhooks/payment').set({ 'monei-signature': `t=${t},v1=${v1}` })
    .set('Content-Type', 'application/json').send(raw);
}
const badge = async (m: number, gym = gymId): Promise<number> =>
  Number(must(await auth(request.get(`/members/${m}/tab-counts`), gym), 'tab counts').body.products_services);
const setPlanStatus = (um: number, status: string) =>
  db.query('UPDATE plan_snapshots SET status = ?, assignment_status = IF(assignment_id = id, ?, assignment_status) WHERE assignment_id = ?',
    [status, status, um]);

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = SECRET;
  gymId = await createTestGym('Products Badge Gym');
  otherGymId = await createTestGym('Products Badge Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
});

afterAll(async () => {
  delete process.env.MONEI_API_KEY;
  delete process.env.MONEI_WEBHOOK_SECRET;
  await cleanupTestGyms();
  await db.end();
});

describe('Products tab badge (#3243)', () => {
  it('is closed to an unauthenticated caller and to another gym', async () => {
    const m = await member();
    expect((await request.get(`/members/${m}/tab-counts`).set('x-gym-id', gymId)).status).toBe(401);
    expect((await auth(request.get(`/members/${m}/tab-counts`), otherGymId)).status).toBe(404);
  });

  it('counts a plan that is Active or Cancels on its End Date, and not a paused or cancelled one', async () => {
    const m = await member();
    const um = await runningPlan(m);
    expect(await badge(m)).toBe(1);
    await setPlanStatus(um, 'active_cancel_at_period_end');
    expect(await badge(m)).toBe(1);
    await setPlanStatus(um, 'paused');
    expect(await badge(m)).toBe(0);
    await setPlanStatus(um, 'cancelled');
    expect(await badge(m)).toBe(0);
  });

  it('counts an Active recurring Product, not while it is In Cart, and never a one-off Product', async () => {
    const m = await member();
    await runningPlan(m);
    expect(await badge(m)).toBe(1);

    const added = must(await auth(request.post(`/members/${m}/product-purchases`)).send({ product_id: await product('month') }), 'add recurring');
    const draftId = Number(added.body.product_set_id);
    expect(await badge(m)).toBe(1); // In Cart: not yet counted

    const saved = must(await auth(request.post(`/product-sets/${draftId}/save-and-pay`)).send({}), 'save & pay');
    expect(await badge(m)).toBe(1); // Pending Payment: not yet counted
    expect((await pay(saved.body.payment_request_id)).status).toBe(200);
    expect(await badge(m)).toBe(2);

    // A one-off Product, even once bought, is not a recurring item.
    await auth(request.post(`/members/${m}/product-purchases`)).send({ product_id: await product('once') });
    expect(await badge(m)).toBe(2);
  });

  it('does not count a Draft plan', async () => {
    const m = await member();
    await createTestDraftAssignment(gymId, m, await plan());
    expect(await badge(m)).toBe(0);
  });
});
