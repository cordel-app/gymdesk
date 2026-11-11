// #2490 stage 3 — a Direct Discount (%) on each Product line of a Membership
// Plan, beside its Benefit treatment: stored per line, kept by a save that does
// not mention it, copied by Duplicate and onto an assignment's plan snapshot,
// and billed by the engine. Integration: the real router against MySQL.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request,
} from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const today = () => new Date().toISOString().slice(0, 10);

let gymId: string;
let gymB: string;
let planId: number;
let lockerId: number;
let towelId: number;

const put = (gym: string, items: unknown[]) => request
  .put(`/membership-plans/${planId}/periodical-benefits`)
  .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym)
  .send({ items });

async function product(name: string, amount: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status, is_system)
     VALUES (?, ?, 'service', ?, 'EUR', 'month', 'active', 0)`, [gymId, name, amount]);
  return insertId;
}

beforeAll(async () => {
  gymId = await createTestGym('Direct Discount Gym');
  gymB = await createTestGym('Direct Discount Gym B');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(gymB, 'admin');
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '1')`, [gymId, `DD-${uniq()}`]);
  planId = insertId;
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, 50, '2020-01-01', 'active')`, [gymId, planId]);
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`, [gymId, planId]);
  lockerId = await product(`Locker ${uniq()}`, 20);
  towelId = await product(`Towel ${uniq()}`, 10);
});

describe('Membership Plan line Direct Discount (%)', () => {
  it('stores an independent discount per line and prices the Final Price with it', async () => {
    const res = await put(gymId, [
      { product_id: lockerId, quantity: 1, action: 'percentage_discount', value: 50, direct_discount_percent: 10 },
      { product_id: towelId, quantity: 1 },
    ]);
    expect(res.status).toBe(200);
    const locker = res.body.find((r: any) => r.product_id === lockerId);
    const towel = res.body.find((r: any) => r.product_id === towelId);
    expect(locker.direct_discount_percent).toBe(10);
    expect(locker.action).toBe('percentage_discount');
    expect(towel.direct_discount_percent).toBeNull();
    // The products carry no tax rate, so the gross is the stored amount.
    expect(locker.final_price_incl_tax).toBe(9);
    expect(towel.final_price_incl_tax).toBe(10);
  });

  it('keeps the stored discount when a save does not mention it', async () => {
    const res = await put(gymId, [{ product_id: lockerId, quantity: 2 }, { product_id: towelId, quantity: 1 }]);
    expect(res.status).toBe(200);
    expect(res.body.find((r: any) => r.product_id === lockerId).direct_discount_percent).toBe(10);
  });

  it('refuses a value outside 0..100 and changes nothing', async () => {
    const res = await put(gymId, [{ product_id: lockerId, quantity: 1, direct_discount_percent: 150 }]);
    expect(res.status).toBe(400);
    const { rows } = await db.query<any>(
      'SELECT direct_discount_percent FROM membership_plan_periodical WHERE membership_plan_id = ? AND product_id = ?',
      [planId, lockerId]);
    expect(Number(rows[0].direct_discount_percent)).toBe(10);
  });

  it('is tenant-isolated', async () => {
    const res = await put(gymB, [{ product_id: lockerId, quantity: 1, direct_discount_percent: 99 }]);
    expect([400, 404]).toContain(res.status);
  });

  it('Duplicate copies it with the line', async () => {
    const res = await request.post(`/membership-plans/${planId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(res.status).toBe(201);
    const { rows } = await db.query<any>(
      'SELECT direct_discount_percent FROM membership_plan_periodical WHERE membership_plan_id = ? AND product_id = ?',
      [res.body.id, lockerId]);
    expect(Number(rows[0].direct_discount_percent)).toBe(10);
  });

  it('an assignment freezes it on its plan snapshot and the engine bills it', async () => {
    const { insertId: memberId } = await db.query(
      'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'DD Member', `dd-${uniq()}@test.com`]);
    const res = await request.post('/user-memberships')
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)
      .send({ member_id: memberId, membership_plan_id: planId, starts_at: today() });
    expect(res.status).toBe(201);
    const { rows } = await db.query<any>(
      `SELECT l.direct_discount_percent FROM plan_periodical_snapshots l
         JOIN plan_snapshots s ON s.id = l.plan_snapshot_id
        WHERE s.gym_id = ? AND s.member_id = ? AND l.product_id = ?`, [gymId, memberId, lockerId]);
    expect(Number(rows[0].direct_discount_percent)).toBe(10);

    // A later change of the Plan does not move the agreed line.
    await put(gymId, [{ product_id: lockerId, quantity: 2, direct_discount_percent: null }, { product_id: towelId, quantity: 1 }]);

    const sim = await request.get(`/user-memberships/${res.body.id}/billing-event-simulation`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(sim.status).toBe(200);
    const lockerLines = sim.body.dates.flatMap((g: any) => g.lines).filter((l: any) => l.product_id === lockerId);
    expect(lockerLines.length).toBeGreaterThan(0);
    // quantity 2 × €20 → 50% treatment → €20 → 10% direct → €18
    for (const l of lockerLines) expect(l.actual_charge).toBe(18);
  });

  it('null clears it', async () => {
    const res = await put(gymId, [{ product_id: lockerId, quantity: 1, direct_discount_percent: null }]);
    expect(res.status).toBe(200);
    expect(res.body.find((r: any) => r.product_id === lockerId).direct_discount_percent).toBeNull();
  });
});
