// #3554 — Admin → Members → Products: a cart of standalone one-time Products (no Draft Product Set
// carries them) has a cart-level Cancel, `DELETE /members/:id/product-purchases/cart`. It deletes the
// member's In Cart standalone purchases and writes no payment request or Billing Event; completed
// purchases are untouched; a cart holding a Draft is cancelled through the Draft's own route.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';
import { TEST_PURCHASES } from './productSnapshotReads';

let gymId: string;
let otherGymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

const staff = (method: 'post' | 'get' | 'delete', path: string, gym = gymId) =>
  (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Cart Cancel Member', `cc-${uniq()}@t.com`]);
  return insertId;
}

async function product(amount: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', 'once', 'active', 'public', 'EUR', ?, 'inclusive')`,
    [gymId, `P-${uniq()}`, amount]);
  return insertId;
}

async function addToCart(memberId: number, amount: string): Promise<number> {
  const res = await staff('post', `/members/${memberId}/product-purchases`).send({ product_id: await product(amount), draft: true });
  expect(res.status).toBeLessThan(300);
  return Number(res.body.purchaseId);
}

const purchaseStatus = async (id: number) =>
  (await db.query<any>(`SELECT status FROM ${TEST_PURCHASES} AS legacy WHERE id = ?`, [id])).rows[0]?.status ?? null;

const countFor = async (table: string, memberId: number) =>
  Number((await db.query<any>(`SELECT COUNT(*) AS n FROM ${table} WHERE gym_id = ? AND member_id = ?`, [gymId, memberId])).rows[0].n);

beforeAll(async () => {
  gymId = await createTestGym('Standalone Cart Cancel Gym');
  otherGymId = await createTestGym('Standalone Cart Cancel Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
});
afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('DELETE /members/:id/product-purchases/cart (#3554)', () => {
  it('discards every standalone purchase in the cart and charges nothing', async () => {
    const m = await member();
    const a = await addToCart(m, '12.00');
    const b = await addToCart(m, '8.00');
    expect(await purchaseStatus(a)).toBe('in_cart');

    const res = await staff('delete', `/members/${m}/product-purchases/cart`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);
    expect(await purchaseStatus(a)).toBeNull();
    expect(await purchaseStatus(b)).toBeNull();
    expect(await countFor('payment_requests', m)).toBe(0);
    expect(await countFor('billing_events', m)).toBe(0);

    const summary = await staff('get', `/members/${m}/product-purchases/cart-summary`);
    expect(summary.status).toBe(200);
    expect(summary.body.purchase_ids).toEqual([]);
    const { rows } = await db.query<any>(
      `SELECT COUNT(*) AS n FROM purchases WHERE gym_id = ? AND owner_member_id = ? AND status = 'in_cart'`, [gymId, m]);
    expect(Number(rows[0].n)).toBe(0);
  });

  it('answers 404 when the cart is empty, and for another gym\'s member', async () => {
    const m = await member();
    expect((await staff('delete', `/members/${m}/product-purchases/cart`)).status).toBe(404);
    const p = await addToCart(m, '5.00');
    expect((await staff('delete', `/members/${m}/product-purchases/cart`, otherGymId)).status).toBe(404);
    expect(await purchaseStatus(p)).toBe('in_cart');
  });

  it('refuses a cart that holds a Draft Product Set and leaves it alone', async () => {
    const m = await member();
    const p = await addToCart(m, '9.00');
    const draft = await staff('post', '/product-sets/draft').send({ member_id: m });
    expect(draft.status).toBeLessThan(300);
    const res = await staff('delete', `/members/${m}/product-purchases/cart`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cart_has_draft');
    expect(await purchaseStatus(p)).toBe('in_cart');
  });

  it('requires authentication', async () => {
    const m = await member();
    expect((await request.delete(`/members/${m}/product-purchases/cart`).set('x-gym-id', gymId)).status).toBe(401);
  });
});
