// #2973 stage 5 — `GET /me/cart/summary`: the Summary of a cart holding standalone one-time
// purchases alone, in the shape of the Product Set review, from the lines checkout charges.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

const asMember = (clerk: string, method: 'get' | 'post', path: string, gym = gymId) => {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any);
  return (request as any)[method](`/me/cart${path}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
};

async function member(): Promise<{ clerk: string; id: number }> {
  const clerk = `cart-sum-${uniq()}`;
  await createTestMembership(gymId, 'member', clerk);
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, 'Summary Member', `${clerk}@t.com`, clerk]);
  return { clerk, id: insertId };
}

async function product(amount: string): Promise<{ id: number; name: string }> {
  const name = `P-${uniq()}`;
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', 'once', 'active', 'public', 'EUR', ?, 'inclusive')`, [gymId, name, amount]);
  return { id: insertId, name };
}

beforeAll(async () => { gymId = await createTestGym('Cart Summary Gym'); });
afterAll(async () => { await cleanupTestGyms(); await db.end(); });

describe('GET /me/cart/summary', () => {
  it('lists every standalone purchase with its charge line and the cart total', async () => {
    const m = await member();
    const a = await product('20.00');
    const b = await product('5.50');
    expect((await asMember(m.clerk, 'post', '/purchases').send({ product_id: a.id })).status).toBe(201);
    expect((await asMember(m.clerk, 'post', '/purchases').send({ product_id: b.id })).status).toBe(201);

    const res = await asMember(m.clerk, 'get', '/summary');
    expect(res.status).toBe(200);
    expect(res.body.amount_due).toBe(25.5);
    expect(res.body.payment_required).toBe(true);
    expect(res.body.immediate_lines.map((l: any) => l.item_name).sort()).toEqual([a.name, b.name].sort());
    expect(res.body.immediate_lines.reduce((n: number, l: any) => n + l.amount, 0)).toBeCloseTo(25.5);
    expect(res.body.summary_items.map((i: any) => i.name).sort()).toEqual([a.name, b.name].sort());
  });

  it('is empty for a member with no cart, and never shows another member\'s purchases', async () => {
    const m = await member();
    const other = await member();
    const p = await product('9.00');
    await asMember(other.clerk, 'post', '/purchases').send({ product_id: p.id });
    const res = await asMember(m.clerk, 'get', '/summary');
    expect(res.status).toBe(200);
    expect(res.body.amount_due).toBe(0);
    expect(res.body.immediate_lines).toEqual([]);
  });

  it('refuses an unauthenticated request', async () => {
    expect((await request.get('/me/cart/summary').set('x-gym-id', gymId)).status).toBe(401);
  });
});
