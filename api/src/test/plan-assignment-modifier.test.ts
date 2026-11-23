// #2125 M6b-30 (migration 427): the assignment's last modification (`modified_at` / `modified_by`) is
// dual-written onto its plan snapshot beside `user_memberships`, on the rule the other
// assignment-level facts follow (an unshared snapshot; a copy carries its source's), and the
// migration's backfill converges on the legacy row.
import { TEST_ASSIGNMENTS } from './assignmentReads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';
import { testAssignmentWrite } from './assignmentFixture';


let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Modifier Member', `pam-${uniq()}@test.com`]);
  return Number(insertId);
}
async function plan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 1)`, [gymId, `PAM Plan ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 10, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}
async function legacy(um: number) {
  const { rows } = await db.query<any>(`SELECT modified_at, modified_by FROM ${TEST_ASSIGNMENTS} um WHERE id = ?`, [um]);
  return rows[0];
}
/** The snapshot of the owner's Active set naming the assignment. */
async function activeSnapshot(um: number) {
  const { rows } = await db.query<any>(
    `SELECT s.id, s.modified_at, s.modified_by FROM plan_snapshots s
       JOIN product_set_plan_snapshots j ON j.plan_snapshot_id = s.id
       JOIN product_sets ps ON ps.id = j.product_set_id AND ps.status = 'active'
      WHERE s.gym_id = ? AND s.anchor_plan_snapshot_id = ? ORDER BY s.id DESC LIMIT 1`, [gymId, um]);
  return rows[0];
}

beforeAll(async () => {
  gymId = await createTestGym('Plan Assignment Modifier Gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('the assignment modifier on plan_snapshots', () => {
  it('a status change through the API reaches the snapshot of the Active set', async () => {
    const um = await createTestDraftAssignment(gymId, await member(), await plan());
    const act = await auth(request.post(`/user-memberships/${um}/activate`)).send({ on_conflict: 'add' });
    expect(act.status).toBeLessThan(300);

    expect((await auth(request.put(`/user-memberships/${um}`)).send({ status: 'paused' })).status).toBe(200);
    const row = await legacy(um);
    expect(row.modified_by).not.toBeNull();
    const snap = await activeSnapshot(um);
    expect(snap.modified_by).toBe(row.modified_by);
    expect(new Date(snap.modified_at).getTime()).toBe(new Date(row.modified_at).getTime());
  });

});
