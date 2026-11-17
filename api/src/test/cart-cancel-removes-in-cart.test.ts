// #2967 — cancelling the cart (DELETE /product-sets/:id) removes the owner's standalone In Cart
// purchases too, leaves other members' carts alone and writes no billing event or payment request.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';
import { TEST_PURCHASES } from './productSnapshotReads';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

const asMember = (clerk: string, method: 'get' | 'post', path: string) => {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any);
  return (request as any)[method](`/me/cart${path}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
};
const staff = (method: 'post' | 'get' | 'delete', path: string) =>
  (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function member() {
  const clerk = `cart-cx-${uniq()}`;
  await createTestMembership(gymId, 'member', clerk);
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, 'Cart Member', `${clerk}@t.com`, clerk]);
  return { clerk, id: insertId };
}

async function product(amount: string, frequency: 'once' | 'month' = 'once'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', ?, 'active', 'public', 'EUR', ?, 'inclusive')`, [gymId, `P-${uniq()}`, frequency, amount]);
  return insertId;
}

const status = async (id: number) =>
  (await db.query<any>(`SELECT status FROM ${TEST_PURCHASES} AS legacy WHERE id = ?`, [id])).rows[0]?.status ?? null;

beforeAll(async () => {
  gymId = await createTestGym('Cart Cancel Gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => { await cleanupTestGyms(); await db.end(); });

describe('Cancel cart removes In Cart products (#2967)', () => {
  it('deletes the owner\'s standalone In Cart purchases with the Draft, and only theirs', async () => {
    const m = await member();
    const other = await member();
    const draft = await staff('post', `/members/${m.id}/product-purchases`).send({ product_id: await product('30.00', 'month') });
    expect(draft.status).toBe(201);
    const setId = Number(draft.body.product_set_id);
    const mine = await asMember(m.clerk, 'post', '/purchases').send({ product_id: await product('12.50') });
    const theirs = await asMember(other.clerk, 'post', '/purchases').send({ product_id: await product('9.00') });
    expect(mine.status).toBe(201);
    expect(theirs.status).toBe(201);
    const myId = Number(mine.body.purchase_id);
    const theirId = Number(theirs.body.purchase_id);

    const res = await staff('delete', `/product-sets/${setId}`);
    expect(res.status).toBe(204);

    expect(await status(myId)).toBeNull();
    expect(await status(theirId)).toBe('in_cart');
    const { rows } = await db.query<any>('SELECT COUNT(*) AS n FROM billing_events WHERE gym_id = ? AND member_id = ?', [gymId, m.id]);
    expect(Number(rows[0].n)).toBe(0);
    const left = await asMember(m.clerk, 'get', '/purchases');
    expect(left.body.purchases).toHaveLength(0);
  });
});
