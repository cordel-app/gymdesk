// #3358 stage 3 — the Save & Pay review warns when a Cancel Immediately leaves a member without a
// Center they use today, after the whole Draft is applied: a Center another live plan still grants
// is not listed, and no warning is given when nothing is lost.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { addPlanSnapshotToVersion } from '../api/plan-snapshot-add';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';

let gymId: string;
let c1: number; let c2: number; let c3: number;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const authed = (req: any) => req.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function planFor(centers: number[]): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit, center_access_mode,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', 1, 'specific_centers', NULL, NULL, 0, 0)`, [gymId, `CAW Plan ${uniq()}`]);
  for (const c of centers) {
    await db.query('INSERT INTO membership_plan_centers (gym_id, membership_plan_id, center_id) VALUES (?, ?, ?)', [gymId, insertId, c]);
  }
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 10, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return insertId as number;
}

async function runningPlan(memberId: number, centers: number[]): Promise<number> {
  const umId = await createTestDraftAssignment(gymId, memberId, await planFor(centers), { config: { membership_fee_price: 10 } });
  const act = await authed(request.post(`/user-memberships/${umId}/activate`)).send({ on_conflict: 'add' });
  if (act.status >= 300) throw new Error(`activate ${act.status} ${JSON.stringify(act.body)}`);
  return umId;
}

/** A member holding plan A (cancelled at period end, then marked Cancel Immediately) and optionally plan B. */
async function scenario(aCenters: number[], bCenters: number[] | null) {
  const { insertId: memberId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'CAW Member', `caw-${uniq()}@test.com`]);
  const a = await runningPlan(memberId as number, aCenters);
  const del = await authed(request.delete(`/user-memberships/${a}`));
  if (del.status !== 204) throw new Error(`cancel ${del.status}`);
  if (bCenters) await runningPlan(memberId as number, bCenters);
  const mark = await authed(request.post(`/user-memberships/${a}/mark-cancel-immediately`));
  if (mark.status !== 200) throw new Error(`mark ${mark.status} ${JSON.stringify(mark.body)}`);
  const review = await authed(request.get(`/product-sets/${mark.body.product_set_id}/review`));
  expect(review.status).toBe(200);
  return { memberId: memberId as number, review: review.body, setId: mark.body.product_set_id as number };
}

beforeAll(async () => {
  gymId = await createTestGym('Center Access Warning Gym');
  await createTestMembership(gymId, 'admin');
  const mk = async (name: string) => (await db.query('INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)', [gymId, name, 'active'])).insertId as number;
  c1 = await mk('Alpha'); c2 = await mk('Beta'); c3 = await mk('Gamma');
});
afterAll(async () => { await cleanupTestGyms(); await db.end(); });

describe('center access warning on Save & Pay (#3358 stage 3)', () => {
  it('lists the centers the member loses when the only plan granting them is cancelled today', async () => {
    const { memberId, review } = await scenario([c1, c2], null);
    expect(review.center_access_warnings).toEqual([{
      member_id: memberId, member_name: 'CAW Member',
      centers: [{ id: c1, name: 'Alpha' }, { id: c2, name: 'Beta' }],
    }]);
  });

  it('gives no warning when another live plan keeps every affected center', async () => {
    const { review } = await scenario([c1], [c1, c3]);
    expect(review.center_access_warnings).toEqual([]);
  });

  it('lists only the centers no other plan keeps (mixed outcome)', async () => {
    const { review } = await scenario([c1, c2], [c2]);
    expect(review.center_access_warnings).toHaveLength(1);
    expect(review.center_access_warnings[0].centers).toEqual([{ id: c1, name: 'Alpha' }]);
  });

  it('a plan the Draft itself adds keeps the center it grants', async () => {
    const { memberId, setId } = await scenario([c2], null);
    const added = await planFor([c2]);
    await db.transaction((tx) => addPlanSnapshotToVersion(tx, {
      gymId, productSetId: setId, memberId, membershipPlanId: added, membershipFeePrice: 10,
      startsAt: new Date().toISOString().slice(0, 10),
    }));
    const review = await authed(request.get(`/product-sets/${setId}/review`));
    expect(review.status).toBe(200);
    expect(review.body.center_access_warnings).toEqual([]);
  });

  it('is derived, not stored: discarding the cart leaves no warning and access unchanged', async () => {
    const { memberId, setId } = await scenario([c1], null);
    expect((await authed(request.delete(`/product-sets/${setId}`))).status).toBeLessThan(300);
    const access = await authed(request.get(`/members/${memberId}/centers/effective-access`));
    expect(access.status).toBe(200);
    expect(access.body.specific_centers.map((c: any) => c.id)).toEqual([c1]);
  });

  it('reports nothing when no plan is cancelled immediately', async () => {
    const { insertId: memberId } = await db.query(
      'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'CAW Plain', `cawp-${uniq()}@test.com`]);
    await runningPlan(memberId as number, [c1]);
    const draft = await authed(request.post('/product-sets/draft')).send({ member_id: memberId });
    expect(draft.status).toBeLessThan(300);
    const review = await authed(request.get(`/product-sets/${draft.body.id}/review`));
    expect(review.status).toBe(200);
    expect(review.body.center_access_warnings).toEqual([]);
  });
});
