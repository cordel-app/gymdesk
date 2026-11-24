// #3020 stage 5 — a staff one-time purchase carries a quantity while it is in the cart: the charge
// is the unit price (after Promotions and the direct discount) times it, it can be changed until
// Pay, and a bad quantity is a 400. Integration; only the provider's createPaymentRequest is stubbed.
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

import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';
import { TEST_PURCHASES } from './productSnapshotReads';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const base = (memberId: number) => `/members/${memberId}/product-purchases`;

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Qty Member', `qty-${uniq()}@test.com`]);
  return insertId;
}
async function product(amount: string, type = 'fee', units: number | null = null): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, is_system, currency, amount, tax_behavior, units)
     VALUES (?, ?, ?, 'once', 'active', 'public', 0, 'EUR', ?, 'inclusive', ?)`,
    [gymId, `Q-${uniq()}`, type, amount, units]);
  return insertId;
}
const row = async (id: number) =>
  (await db.query<any>(`SELECT status, amount, unit_amount, quantity FROM ${TEST_PURCHASES} AS legacy WHERE id = ?`, [id])).rows[0];

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = 'test-webhook-secret';
  gymId = await createTestGym('Purchase Quantity Gym');
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

describe('quantity of a one-time purchase', () => {
  it('defaults to 1 and charges the unit price', async () => {
    const m = await member();
    const res = await auth(request.post(base(m))).send({ product_id: await product('40.00'), draft: true });
    expect(res.status).toBe(201);
    expect(await row(res.body.purchaseId)).toMatchObject({ quantity: 1, amount: '40.00', unit_amount: '40.00' });
  });

  it('multiplies the unit price after the direct discount; a Sessions package keeps its package price', async () => {
    const m = await member();
    const res = await auth(request.post(base(m))).send({
      product_id: await product('50.00', 'sessions', 5), draft: true, quantity: 3, direct_discount_percent: 10,
    });
    expect(res.status).toBe(201);
    expect(res.body.amount).toBe(135);
    expect(await row(res.body.purchaseId)).toMatchObject({ quantity: 3, amount: '135.00', unit_amount: '45.00' });
  });

  it('can be changed while in the cart, and the payment carries the draft\'s quantity', async () => {
    const m = await member();
    const saved = await auth(request.post(base(m))).send({ product_id: await product('20.00'), draft: true, quantity: 2 });
    const put = await auth(request.put(`${base(m)}/${saved.body.purchaseId}`)).send({ quantity: 4 });
    expect(put.status).toBe(200);
    expect(put.body.amount).toBe(80);
    const pay = await auth(request.post(`${base(m)}/${put.body.purchaseId}/pay`)).send({});
    expect(pay.status).toBe(201);
    expect(pay.body.amount).toBe(80);
    expect(await row(pay.body.purchaseId)).toMatchObject({ status: 'pending_payment', quantity: 4, amount: '80.00' });
  });

  it('refuses a quantity that is not a whole number from 1 to 99', async () => {
    const m = await member();
    const p = await product('10.00');
    for (const quantity of [0, -2, 1.5, 100, 'x']) {
      const res = await auth(request.post(base(m))).send({ product_id: p, draft: true, quantity });
      expect(res.status).toBe(400);
    }
  });
});

// #3359 — the Members → Products table shows line totals: the base price and the final price of a
// one-time purchase are both the unit times its quantity, with the unit figures beside them.
describe('GET /members/:id/products reports line totals and unit prices (#3359)', () => {
  it('a quantity-2 purchase with a direct discount reads 30.00 / 27.00 with units 15.00 / 13.50', async () => {
    const m = await member();
    const saved = await auth(request.post(base(m))).send({
      product_id: await product('15.00'), draft: true, quantity: 2, direct_discount_percent: 10,
    });
    expect(saved.status).toBe(201);
    const list = await auth(request.get(`/members/${m}/products`));
    expect(list.status).toBe(200);
    const item = list.body.items.find((i: any) => i.id === saved.body.purchaseId);
    expect(item).toMatchObject({
      quantity: 2, regular_amount: 30, regular_unit_amount: 15, amount: 27, unit_amount: 13.5,
    });
  });

  it('a quantity-1 purchase reports the same figure as total and unit', async () => {
    const m = await member();
    const saved = await auth(request.post(base(m))).send({ product_id: await product('40.00'), draft: true });
    const list = await auth(request.get(`/members/${m}/products`));
    const item = list.body.items.find((i: any) => i.id === saved.body.purchaseId);
    expect(item).toMatchObject({ quantity: 1, regular_amount: 40, regular_unit_amount: 40, amount: 40, unit_amount: 40 });
  });
});
