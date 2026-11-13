// #2607 stage 2 — One per Member reaches the Products a Membership Plan carries: a plan whose
// included Product the member already holds (a purchase or another live plan) is refused before it
// becomes the member's, a Replace does not count the plan it supersedes, and a member holding the
// Product through a plan is refused a purchase of it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { violatesOnePerMember } from '../api/one-per-member';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, insertTestPurchase, createTestMembership, request } from './helpers';

let gymId: string;
let planId: number;
let lockerId: number;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const today = () => new Date().toISOString().slice(0, 10);

const post = (path: string, body: object = {}) =>
  request.post(path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send(body);

async function member(): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'Opm Plan Member', `opm-plan-${uniq()}@test.com`]);
  return Number(insertId);
}

async function draftFor(memberId: number): Promise<number> {
  const res = await post('/user-memberships', { member_id: memberId, membership_plan_id: planId, starts_at: today() });
  expect(res.status).toBe(201);
  return Number(res.body.id);
}

async function status(umId: number): Promise<string> {
  const { rows } = await db.query<any>('SELECT status FROM user_memberships WHERE id = ?', [umId]);
  return rows[0].status;
}

beforeAll(async () => {
  gymId = await createTestGym('One Per Member Plans Gym');
  await createTestMembership(gymId, 'admin');
  const p = await db.query(
    `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status, enrollment_status, is_system, one_per_member, created_by)
     VALUES (?, 'Locker OPM Plan', 'fee', 10, 'EUR', 'once', 'active', 'public', 0, 1, 'test')`, [gymId]);
  lockerId = Number(p.insertId);
  const plan = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'public')`, [gymId, `Opm-Plan-${uniq()}`]);
  planId = Number(plan.insertId);
  await db.query(
    `INSERT INTO membership_plan_oneoff (gym_id, membership_plan_id, product_id, quantity, mandatory) VALUES (?, ?, ?, 1, 1)`,
    [gymId, planId, lockerId]);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('One per Member on Membership Plans', () => {
  it('refuses activating a plan that carries a Product the member already bought', async () => {
    const m = await member();
    await insertTestPurchase(
      `INSERT INTO member_products_oneoff_snapshot
         (gym_id, member_id, product_id, status, product_name, product_type, billing_frequency, amount, currency, created_by)
       VALUES (?, ?, ?, 'active', 'Locker OPM Plan', 'fee', 'once', 10, 'EUR', 'test')`, [gymId, m, lockerId]);
    const umId = await draftFor(m);
    const res = await post(`/user-memberships/${umId}/activate`, { confirm: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/one assignment of this product: Locker OPM Plan/);
    expect(await status(umId)).toBe('draft');
  });

  it('a plan gives the Product once: a second plan is refused as an add, a replacement is allowed', async () => {
    const m = await member();
    const first = await draftFor(m);
    expect((await post(`/user-memberships/${first}/activate`, { confirm: true })).status).toBeLessThan(300);
    expect(await status(first)).toBe('active');

    // Holding it through the plan blocks buying it.
    expect(await violatesOnePerMember(db, gymId, m, lockerId)).toBe(true);

    const second = await draftFor(m);
    const add = await post(`/user-memberships/${second}/activate`, { on_conflict: 'add' });
    expect(add.status).toBe(409);
    expect(add.body.error).toMatch(/one assignment of this product/);
    expect(await status(second)).toBe('draft');
    expect(await status(first)).toBe('active');

    const replace = await post(`/user-memberships/${second}/activate`, { on_conflict: 'replace' });
    expect(replace.status).toBeLessThan(300);
    expect(await status(second)).toBe('active');
    expect(await status(first)).toBe('superseded');
  });

  it('a member with no holding activates the plan', async () => {
    const m = await member();
    const umId = await draftFor(m);
    expect((await post(`/user-memberships/${umId}/activate`, { confirm: true })).status).toBeLessThan(300);
    expect(await status(umId)).toBe('active');
  });
});
