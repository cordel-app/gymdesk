// #3270 — a purchase (cart) carries a persisted name basis — its creation instant, written once —
// that the Admin's In-Cart Summary is headed by, and the Summary's Initial Payment states each
// line's persisted Billing Event Line `source` (#3254). Integration against the real stack; only
// the provider's `createPaymentRequest` is stubbed.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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

import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { productSetOfLegacyAssignmentSql } from '../domain/planAssignments';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const firstOfNextMonth = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
};

const staff = (method: 'get' | 'post', path: string) =>
  (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const asMember = (clerk: string, method: 'get' | 'post', path: string) => {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any);
  return (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
};

async function member(): Promise<{ clerk: string; id: number }> {
  const clerk = `pname-${uniq()}`;
  await createTestMembership(gymId, 'member', clerk);
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, 'Named Cart', `${clerk}@t.com`, clerk]);
  return { clerk, id: insertId };
}
async function product(amount: string, frequency: 'once' | 'month'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', ?, 'active', 'public', 'EUR', ?, 'inclusive')`,
    [gymId, `P-${uniq()}`, frequency, amount]);
  return insertId;
}
async function plan(price: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', 0, 12, 0, 0)`, [gymId, `Named Plan ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, ?, '2025-01-01', 'active')`, [gymId, insertId, price]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return insertId;
}
const purchaseRow = async (id: number) =>
  (await db.query<any>(`SELECT id, name, status, DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%sZ') AS created FROM purchases WHERE id = ?`, [id])).rows[0];
const cartOfSet = async (setId: number) =>
  Number((await db.query<any>('SELECT purchase_id FROM product_sets WHERE id = ?', [setId])).rows[0].purchase_id);

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = 'test-3270';
  gymId = await createTestGym('Purchase Name Gym');
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

describe('a purchase name, persisted once (#3270)', () => {
  it('a new cart has its creation instant as its name, unchanged by edits and status moves, and the Member read reports it', async () => {
    const m = await member();
    const add = await staff('post', `/members/${m.id}/product-purchases`).send({ product_id: await product('30.00', 'month') });
    expect(add.status).toBe(201);
    const setId = Number(add.body.product_set_id);
    const cartId = await cartOfSet(setId);
    const born = await purchaseRow(cartId);
    expect(born.name).toMatch(ISO_INSTANT);
    expect(born.name).toBe(born.created);

    const config = await staff('get', `/user-memberships/member/${m.id}/configuration`);
    expect(config.status).toBe(200);
    const inFlight = config.body.product_sets.find((p: any) => p.id === setId);
    expect(inFlight.purchase).toEqual({ id: cartId, name: born.name, status: 'in_cart' });

    // Editing the cart and moving it to Pending Payment leave the name as it was.
    expect((await asMember(m.clerk, 'post', '/me/cart/purchases').send({ product_id: await product('9.00', 'once') })).status).toBe(201);
    expect((await staff('post', `/product-sets/${setId}/save-and-pay`).send({})).status).toBe(201);
    const after = await purchaseRow(cartId);
    expect(after.status).toBe('pending_payment');
    expect(after.name).toBe(born.name);
  });

  it("the standalone cart's Summary reports its purchase and each line's source", async () => {
    const m = await member();
    const line = await asMember(m.clerk, 'post', '/me/cart/purchases').send({ product_id: await product('12.00', 'once') });
    expect(line.status).toBe(201);
    const res = await staff('get', `/members/${m.id}/product-purchases/cart-summary`);
    expect(res.status).toBe(200);
    expect(res.body.purchase).toMatchObject({ status: 'in_cart' });
    expect(res.body.purchase.name).toMatch(ISO_INSTANT);
    expect(res.body.initial_payment.lines.map((l: any) => l.source)).toEqual(['product']);
    expect(res.body.initial_payment.total).toBe(12);
  });
});

describe("the Summary's Initial Payment states each line's source (#3270)", () => {
  it('a mixed cart reads Plan on the plan lines and Product on the standalone ones, totals unchanged', async () => {
    const { insertId: memberId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
      [gymId, 'Mixed Cart', `mixed-${uniq()}@t.com`]);
    const assign = await staff('post', `/membership-plans/${await plan(40)}/assign`)
      .send({ starts_at: firstOfNextMonth(), owner_member_id: memberId, beneficiary_member_ids: [memberId] });
    expect(assign.status).toBe(201);
    const { rows } = await db.query<any>(
      `SELECT id FROM product_sets WHERE ${productSetOfLegacyAssignmentSql('?', 'product_sets')} ORDER BY id DESC LIMIT 1`, [assign.body.id]);
    const setId = Number(rows[0].id);
    // A recurring Product staff add goes into the member's open Draft (#2891).
    const add = await staff('post', `/members/${memberId}/product-purchases`).send({ product_id: await product('15.00', 'month') });
    expect(add.status).toBe(201);
    expect(Number(add.body.product_set_id)).toBe(setId);

    const review = await staff('get', `/product-sets/${setId}/review`);
    expect(review.status).toBe(200);
    const lines = review.body.initial_payment.lines;
    const sources = new Set(lines.map((l: any) => l.source));
    expect(sources).toEqual(new Set(['plan', 'product']));
    const fee = lines.find((l: any) => l.source === 'plan');
    expect(fee.amount).toBe(40);
    // The breakdown still sums to the charge.
    const sum = Math.round(lines.reduce((n: number, l: any) => n + l.amount, 0) * 100) / 100;
    expect(sum).toBe(review.body.initial_payment.total);
  });
});
