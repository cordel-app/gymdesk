// #2965 — every Product in the cart is in the checkout Summary: its contracted items and, when the
// Product is due at checkout, a line of the Initial Payment whose total is what Save & Pay charges.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../payments', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../payments')>();
  return {
    ...mod,
    getPaymentProvider: () => Object.assign(Object.create(mod.getPaymentProvider()), {
      createPaymentRequest: async (p: { orderId: string }) => ({ providerOrderId: `monei-${p.orderId}`, checkoutUrl: 'https://pay.test/x' }),
    }),
  };
});
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const staff = (method: 'post' | 'get', path: string) =>
  (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Summary Member', `sum-${uniq()}@t.com`]);
  return insertId;
}
async function product(name: string, amount: string, frequency: 'once' | 'month'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', ?, 'active', 'public', 'EUR', ?, 'inclusive')`,
    [gymId, name, frequency, amount]);
  return insertId;
}

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = 'test-2965';
  gymId = await createTestGym('Cart Summary Gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  delete process.env.MONEI_API_KEY;
  delete process.env.MONEI_WEBHOOK_SECRET;
  await cleanupTestGyms();
  await db.end();
});

describe('the checkout Summary lists every cart Product (#2965)', () => {
  it('a one-time Product staff saved to the cart is contracted and charged with the recurring Draft', async () => {
    const m = await member();
    const shirt = `Camiseta-${uniq()}`;
    const one = await staff('post', `/members/${m}/product-purchases`).send({ product_id: await product(shirt, '15.00', 'once'), draft: true });
    expect(one.status).toBe(201);
    const rec = await staff('post', `/members/${m}/product-purchases`).send({ product_id: await product(`Locker-${uniq()}`, '20.00', 'month') });
    expect(rec.status).toBe(201);
    const setId = Number(rec.body.product_set_id);

    const review = await staff('get', `/product-sets/${setId}/review`);
    expect(review.status).toBe(200);
    expect(review.body.contracted_items.filter((i: any) => i.name === shirt)).toHaveLength(1);
    const lines = review.body.initial_payment.lines;
    expect(lines.filter((l: any) => l.name === shirt)).toHaveLength(1);
    expect(lines.find((l: any) => l.name === shirt).amount).toBeCloseTo(15, 2);
    const sum = lines.reduce((n: number, l: any) => n + l.amount, 0);
    expect(review.body.initial_payment.total).toBeCloseTo(sum, 2);
    expect(review.body.amount_due).toBeCloseTo(sum, 2);

    const pay = await staff('post', `/product-sets/${setId}/save-and-pay`).send({});
    expect(pay.status).toBe(201);
    const { rows } = await db.query<any>(
      'SELECT amount FROM billing_events WHERE product_set_id = ? AND event_type = ? ORDER BY id DESC', [setId, 'payment_recorded']);
    expect(Number(rows[0].amount)).toBeCloseTo(review.body.amount_due, 2);
  });

  it('a cart of standalone Products alone has its own Summary, matching what the cart checkout charges', async () => {
    const m = await member();
    const a = `Camiseta-${uniq()}`;
    const b = `Botella-${uniq()}`;
    for (const [name, amount] of [[a, '15.00'], [b, '7.50']]) {
      const r = await staff('post', `/members/${m}/product-purchases`).send({ product_id: await product(name, amount, 'once'), draft: true });
      expect(r.status).toBe(201);
    }
    const events = async () => Number((await db.query<any>(
      'SELECT COUNT(*) AS n FROM billing_events WHERE gym_id = ? AND member_id = ?', [gymId, m])).rows[0].n);

    const summary = await staff('get', `/members/${m}/product-purchases/cart-summary`);
    expect(summary.status).toBe(200);
    expect(summary.body.contracted_items.map((i: any) => i.name)).toEqual([a, b]);
    expect(summary.body.initial_payment.lines.map((l: any) => [l.name, l.amount])).toEqual([[a, 15], [b, 7.5]]);
    expect(summary.body.initial_payment.total).toBeCloseTo(22.5, 2);
    expect(summary.body.amount_due).toBeCloseTo(22.5, 2);
    expect(await events()).toBe(0);

    const checkout = await staff('post', `/members/${m}/product-purchases/checkout`).send({});
    expect(checkout.status).toBe(201);
    const { rows } = await db.query<any>(
      `SELECT amount FROM billing_events WHERE gym_id = ? AND member_id = ? AND event_type = 'product_purchase'`, [gymId, m]);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount)).toBeCloseTo(summary.body.amount_due, 2);

    // Once paying, nothing is left in the cart.
    const after = await staff('get', `/members/${m}/product-purchases/cart-summary`);
    expect(after.body.initial_payment.lines).toEqual([]);
    expect(after.body.amount_due).toBe(0);
  });

  it('is scoped to the gym', async () => {
    const m = await member();
    const other = await createTestGym('Cart Summary Other Gym');
    const res = await request.get(`/members/${m}/product-purchases/cart-summary`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', other);
    expect([403, 404]).toContain(res.status);
  });
});
