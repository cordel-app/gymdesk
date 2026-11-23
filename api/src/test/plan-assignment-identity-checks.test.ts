// #2125 N3d: `plan-assignments:validate` checks that every confirmed assignment has an anchor with a
// lifecycle, and that a cancelled Draft leaves no identity behind. The real flows (create a Draft,
// activate it, discard one) stay clean; each check finds the state it exists to catch.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request, setTestSetAssignmentLink } from './helpers';
import { findPlanAssignmentDrift } from '../api/plan-assignment-drift';

let gymId: string;
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const CHECKS = ['anchor_without_lifecycle', 'active_plan_without_anchor', 'orphan_assignment_identity'];

beforeAll(async () => {
  gymId = await createTestGym('Assignment Identity Checks Gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

async function plan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 1)`, [gymId, `Identity-${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 0, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}
async function member(): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'Identity', `identity-${uniq()}@test.com`]);
  return Number(insertId);
}
async function draft(): Promise<number> {
  const res = await auth(request.post('/user-memberships'))
    .send({ member_id: await member(), membership_plan_id: await plan(), starts_at: new Date().toISOString().slice(0, 10) });
  expect(res.status).toBe(201);
  return Number(res.body.id);
}
async function activated(): Promise<number> {
  const id = await draft();
  expect((await auth(request.post(`/user-memberships/${id}/activate`)).send({})).status).toBeLessThan(300);
  return id;
}
async function check(name: string) {
  return (await findPlanAssignmentDrift(db, gymId)).checks.find((c) => c.name === name)!;
}

describe('plan-assignments:validate — assignment identity (#2125 N3d)', () => {
  it('a Draft, an activated assignment and a discarded Draft leave every identity check clean', async () => {
    await draft();
    await activated();
    const discarded = await draft();
    expect((await auth(request.delete(`/user-memberships/${discarded}/draft`))).status).toBeLessThan(300);
    const report = await findPlanAssignmentDrift(db, gymId);
    for (const name of CHECKS) {
      expect(report.checks.find((c) => c.name === name)?.count, name).toBe(0);
    }
  });

  it('an anchor with no lifecycle is reported', async () => {
    const id = await activated();
    await db.query('UPDATE plan_snapshots SET assignment_status = NULL WHERE id = ? AND gym_id = ?', [id, gymId]);
    const c = await check('anchor_without_lifecycle');
    expect(c.sample.map((r) => Number(r.anchor_id))).toContain(id);
  });

  it('an Active plan whose primary snapshot names no anchor is reported', async () => {
    const id = await activated();
    const { rows } = await db.query<{ product_set_id: number }>(
      `SELECT j.product_set_id FROM product_set_plan_snapshots j JOIN product_sets ps ON ps.id = j.product_set_id
        WHERE j.plan_snapshot_id = ? AND ps.status = 'active'`, [id]);
    expect(rows).toHaveLength(1);
    await setTestSetAssignmentLink(Number(rows[0].product_set_id), null);
    await db.query('UPDATE plan_snapshots SET anchor_plan_snapshot_id = NULL WHERE id = ? AND gym_id = ?', [id, gymId]);
    const c = await check('active_plan_without_anchor');
    expect(c.sample.map((r) => Number(r.product_set_id))).toContain(Number(rows[0].product_set_id));
  });

  it('an assignment no Product Set links any more is reported as a leftover identity', async () => {
    const id = await draft();
    await db.query(
      `DELETE j FROM product_set_plan_snapshots j JOIN plan_snapshots s ON s.id = j.plan_snapshot_id
        WHERE s.anchor_plan_snapshot_id = ? AND s.gym_id = ?`, [id, gymId]);
    const c = await check('orphan_assignment_identity');
    expect(c.sample.map((r) => Number(r.anchor_id))).toContain(id);
  });
});
