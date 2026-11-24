// #3303 — adding a Membership Plan the member already holds is a second, separately identified instance:
// the cart review reports it as a change (so Save & Pay opens), and committing it with Add keeps the
// running instance and adds the new one.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_ASSIGNMENTS } from './assignmentReads';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';

let gymId: string;
let centerId: number;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const authed = (req: any) => req.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function planId(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit, center_access_mode,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', 1, 'specific_centers', NULL, NULL, 0, 0)`, [gymId, `Standard ${uniq()}`]);
  await db.query('INSERT INTO membership_plan_centers (gym_id, membership_plan_id, center_id) VALUES (?, ?, ?)', [gymId, insertId, centerId]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 10, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return insertId as number;
}

const today = () => new Date().toISOString().slice(0, 10);

/** A member running `plan`, started today, with the plan added again as a cart (an Add Membership Plan Draft). */
async function heldTwice(): Promise<{ memberId: number; plan: number; firstId: number; secondId: number; setId: number }> {
  const plan = await planId();
  const { insertId: memberId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'Twice Member', `twice-${uniq()}@test.com`]);
  const firstId = await createTestDraftAssignment(gymId, memberId, plan, { config: { membership_fee_price: 10 } });
  const act = await authed(request.post(`/user-memberships/${firstId}/activate`)).send({ on_conflict: 'add' });
  if (act.status >= 300) throw new Error(`activate ${act.status} ${JSON.stringify(act.body)}`);

  // The same plan, same start date, fee and beneficiary: only its identity differs.
  const added = await authed(request.post(`/membership-plans/${plan}/assign`)).send({
    owner_member_id: memberId, beneficiary_member_ids: [memberId], starts_at: today(), promotion_ids: [],
  });
  if (added.status >= 300) throw new Error(`assign ${added.status} ${JSON.stringify(added.body)}`);
  const secondId = Number(added.body.id);
  const { rows } = await db.query<any>(
    `SELECT DISTINCT j.product_set_id AS id FROM product_set_plan_snapshots j
       JOIN product_sets ps ON ps.id = j.product_set_id
      WHERE j.plan_snapshot_id = ? AND ps.status = 'in_cart'`, [secondId]);
  return { memberId, plan, firstId, secondId, setId: Number(rows[0].id) };
}

const statusOf = async (id: number) => (await db.query<any>(
  `SELECT status FROM ${TEST_ASSIGNMENTS} um WHERE id = ?`, [id])).rows[0]?.status;

beforeAll(async () => {
  gymId = await createTestGym('Same Plan Twice Gym');
  await createTestMembership(gymId, 'admin');
  const { insertId } = await db.query('INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)', [gymId, 'Twice Center', 'active']);
  centerId = insertId as number;
});
afterAll(async () => { await cleanupTestGyms(); await db.end(); });

describe('the same Membership Plan added again (#3303)', () => {
  it('is a distinct instance the review reports as a change, and both are in the Summary', async () => {
    const { firstId, secondId, setId } = await heldTwice();
    expect(secondId).not.toBe(firstId);

    const review = await authed(request.get(`/product-sets/${setId}/review`));
    expect(review.status).toBe(200);
    expect(review.body.changes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'plan_changed' })]));
    const plans = review.body.summary_items.filter((i: any) => i.type === 'plan');
    expect(plans).toHaveLength(2);
    expect(plans.map((p: any) => p.state).sort()).toEqual(['cancelling', 'draft']);
  });

  it('committed with Add, keeps the running instance and adds the new one', async () => {
    const { firstId, secondId } = await heldTwice();
    const res = await authed(request.post(`/user-memberships/${secondId}/activate`)).send({ on_conflict: 'add' });
    expect(res.status).toBeLessThan(300);
    expect(await statusOf(firstId)).toBe('active');
    expect(await statusOf(secondId)).toBe('active');
  });

  it('committed with Replace, replaces only the running instance', async () => {
    const { firstId, secondId } = await heldTwice();
    const res = await authed(request.post(`/user-memberships/${secondId}/activate`)).send({ on_conflict: 'replace' });
    expect(res.status).toBeLessThan(300);
    expect(await statusOf(secondId)).toBe('active');
    expect(await statusOf(firstId)).toBe('superseded');
  });

  it('is tenant-isolated', async () => {
    const { setId } = await heldTwice();
    const otherGym = await createTestGym('Other Twice Gym');
    await createTestMembership(otherGym, 'admin');
    const res = await request.get(`/product-sets/${setId}/review`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', otherGym);
    expect(res.status).toBe(404);
  });
});
