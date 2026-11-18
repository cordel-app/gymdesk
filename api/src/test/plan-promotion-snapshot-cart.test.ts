// #3026 stage 2 — checking / unchecking a Plan Promotion on an in_cart plan is persisted as
// a plan_promotion_snapshots row on that in-cart plan snapshot, one per Promotion, and the
// removal deletes only that row.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

let gymId: string;
let planId: number;
const promos: number[] = [];

async function createPromo(name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable,
                             only_applicable_for_new_members, paid_months)
     VALUES (?, ?, '2026-01-01', '2099-12-31', 'active', 1, 0, 12)`,
    [gymId, name]);
  await db.query(
    'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
    [gymId, insertId, planId]);
  await db.query(
    `INSERT INTO promotion_membership_fee_benefits (gym_id, promotion_id, duration_months, enabled, action, value)
     VALUES (?, ?, NULL, 1, 'percentage_discount', 10)`, [gymId, insertId]);
  return Number(insertId);
}

const call = (method: 'post' | 'delete', umId: number, promotionId: number) => {
  const r = method === 'post'
    ? request.post(`/user-memberships/${umId}/promotions`).send({ promotion_id: promotionId })
    : request.delete(`/user-memberships/${umId}/promotions/${promotionId}`);
  return r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
};

async function rowsFor(memberId: number): Promise<number[]> {
  const { rows } = await db.query<any>(
    `SELECT pps.promotion_id, pps.plan_snapshot_id
       FROM plan_promotion_snapshots pps
       JOIN product_set_plan_snapshots psj ON psj.plan_snapshot_id = pps.plan_snapshot_id
       JOIN product_sets ps ON ps.id = psj.product_set_id
      WHERE ps.owner_member_id = ? AND ps.status = 'in_cart' AND pps.status = 'applied'
      ORDER BY pps.promotion_id`, [memberId]);
  return rows.map((r: any) => Number(r.promotion_id));
}

beforeAll(async () => {
  gymId = await createTestGym('Plan Promo Cart Gym');
  await createTestMembership(gymId, 'admin');
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, 'PPC Plan', 'active', 'staff_only')`, [gymId]);
  planId = Number(insertId);
  promos.push(await createPromo('PPC A'), await createPromo('PPC B'));
});

describe('Plan Promotion on an in_cart plan snapshot (#3026 stage 2)', () => {
  it('check writes one snapshot row, uncheck deletes only that one, re-check leaves no duplicate', async () => {
    const { insertId } = await db.query(
      'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
      [gymId, 'PPC Member', `ppc-${Date.now()}@test.com`]);
    const memberId = Number(insertId);
    const umId = await createTestDraftAssignment(gymId, memberId, planId, { config: { base_price: 100 } });

    expect((await call('post', umId, promos[0])).status).toBe(201);
    expect((await call('post', umId, promos[1])).status).toBe(201);
    expect(await rowsFor(memberId)).toEqual(promos);

    expect((await call('delete', umId, promos[0])).status).toBeLessThan(300);
    expect(await rowsFor(memberId)).toEqual([promos[1]]);

    expect((await call('post', umId, promos[0])).status).toBe(201);
    expect((await call('post', umId, promos[0])).status).toBe(409);
    expect(await rowsFor(memberId)).toEqual(promos);
  });
});
