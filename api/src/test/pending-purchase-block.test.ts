// #3355 stage 1 — a member with a Purchase awaiting payment starts no other purchase.
//
// Integration: + Add Product (`POST /members/:id/product-purchases`) and + Add Membership Plan
// (`POST /membership-plans/:id/assign`) answer `409 purchase_pending_payment` and write nothing
// while the member owns a `pending_payment` purchase; a completed or cancelled purchase never
// blocks; the restriction lifts the moment the pending one is resolved; and the configuration read
// the Admin decides its buttons from reports the same fact. Only the provider is stubbed.

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

let gymId: string;
let otherGymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any, gym = gymId) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);

async function member(gym = gymId): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gym, 'Pending Block Member', `pb-${uniq()}@test.com`]);
  return insertId;
}

async function purchase(ownerId: number, status: string, gym = gymId): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO purchases (gym_id, owner_member_id, status, created_by) VALUES (?, ?, ?, ?)',
    [gym, ownerId, status, 'Tester']);
  return Number(insertId);
}

async function product(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products
       (gym_id, name, type, billing_frequency, status, enrollment_status, is_system, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', 'once', 'active', 'public', 0, 'EUR', '40.00', 'inclusive')`,
    [gymId, `Pending Block Product ${uniq()}`]);
  return insertId;
}

async function plan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '1')`,
    [gymId, `Pending Block Plan ${uniq()}`]);
  return insertId;
}

const purchaseCount = async (memberId: number) => Number((await db.query<{ n: number }>(
  'SELECT COUNT(*) AS n FROM purchases WHERE gym_id = ? AND owner_member_id = ?', [gymId, memberId])).rows[0].n);

const configuration = (memberId: number) =>
  auth(request.get(`/user-memberships/member/${memberId}/configuration`));

beforeAll(async () => {
  gymId = await createTestGym('Pending Purchase Block Gym');
  await createTestMembership(gymId, 'admin');
  otherGymId = await createTestGym('Pending Purchase Block Other Gym');
  await createTestMembership(otherGymId, 'admin');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('#3355 stage 1 — no new purchase while one awaits payment', () => {
  it('refuses + Add Product with 409 purchase_pending_payment and writes nothing', async () => {
    const m = await member();
    await purchase(m, 'pending_payment');
    const productId = await product();
    const before = await purchaseCount(m);

    const res = await auth(request.post(`/members/${m}/product-purchases`)).send({ product_id: productId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('purchase_pending_payment');
    expect(await purchaseCount(m)).toBe(before);
  });

  it('refuses + Add Membership Plan for an owner with a pending purchase, creating no assignment', async () => {
    const m = await member();
    await purchase(m, 'pending_payment');
    const planId = await plan();
    const before = await purchaseCount(m);
    const setsBefore = Number((await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM product_sets WHERE gym_id = ? AND owner_member_id = ?', [gymId, m])).rows[0].n);

    const res = await auth(request.post(`/membership-plans/${planId}/assign`))
      .send({ member_ids: [m], owner_member_id: m, starts_at: '2026-12-01' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('purchase_pending_payment');
    expect(await purchaseCount(m)).toBe(before);
    const setsAfter = Number((await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM product_sets WHERE gym_id = ? AND owner_member_id = ?', [gymId, m])).rows[0].n);
    expect(setsAfter).toBe(setsBefore);
  });

  it('does not block on completed or cancelled purchases', async () => {
    const m = await member();
    await purchase(m, 'completed');
    await purchase(m, 'cancelled');
    const planId = await plan();

    const res = await auth(request.post(`/membership-plans/${planId}/assign`))
      .send({ member_ids: [m], owner_member_id: m, starts_at: '2026-12-01' });
    expect(res.status).toBe(201);
    expect((await configuration(m)).body.has_pending_payment_purchase).toBe(false);
  });

  it('lifts the restriction once the pending purchase is resolved', async () => {
    const m = await member();
    const pending = await purchase(m, 'pending_payment');
    const planId = await plan();

    expect((await configuration(m)).body.has_pending_payment_purchase).toBe(true);
    const refused = await auth(request.post(`/membership-plans/${planId}/assign`))
      .send({ member_ids: [m], owner_member_id: m, starts_at: '2026-12-01' });
    expect(refused.status).toBe(409);

    await db.query("UPDATE purchases SET status = 'cancelled' WHERE id = ?", [pending]);
    expect((await configuration(m)).body.has_pending_payment_purchase).toBe(false);
    const allowed = await auth(request.post(`/membership-plans/${planId}/assign`))
      .send({ member_ids: [m], owner_member_id: m, starts_at: '2026-12-01' });
    expect(allowed.status).toBe(201);
  });

  it("another member's or another gym's pending purchase does not block", async () => {
    const m = await member();
    const neighbour = await member();
    await purchase(neighbour, 'pending_payment');
    const elsewhere = await member(otherGymId);
    await purchase(elsewhere, 'pending_payment', otherGymId);

    expect((await configuration(m)).body.has_pending_payment_purchase).toBe(false);
    const res = await auth(request.post(`/membership-plans/${await plan()}/assign`))
      .send({ member_ids: [m], owner_member_id: m, starts_at: '2026-12-01' });
    expect(res.status).toBe(201);
  });
});
