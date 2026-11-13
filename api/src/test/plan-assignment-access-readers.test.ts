// #2125 M6b-3: the access readers (a Member's center access, the class-type booking gate and the
// schedule's access-locked flag) read the assignment from `plan_snapshots`: its current snapshot is
// the one the owner's Active Product Set links, and coverage is that snapshot's own beneficiaries.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';
import { loadMemberCenterAccessInputs } from '../api/plan-center-access';
import { CANCELS_AT_PERIOD_END_STATUS } from '../domain/assignmentStatus';
import { currentAssignmentSnapshotSql } from '../domain/planAssignments';

let gymId: string;
let otherGymId: string;
let centerId: number;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any, gym = gymId) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
const must = (res: any, what: string) => {
  if (res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
};

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Access Reader Member', `par-${uniq()}@test.com`]);
  return Number(insertId);
}
async function plan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit, center_access_mode)
     VALUES (?, ?, 'active', 'public', 2, 'specific_centers')`, [gymId, `PAR Plan ${uniq()}`]);
  await db.query('INSERT INTO membership_plan_centers (gym_id, membership_plan_id, center_id) VALUES (?, ?, ?)',
    [gymId, insertId, centerId]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 10, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}
/** A member holding one running plan that grants the test center. */
async function running(): Promise<{ m: number; um: number; planId: number }> {
  const m = await member();
  const planId = await plan();
  const um = await createTestDraftAssignment(gymId, m, planId);
  must(await auth(request.post(`/user-memberships/${um}/activate`)).send({ on_conflict: 'add' }), 'activate');
  return { m, um, planId };
}
const centers = async (memberId: number, gym = gymId) =>
  auth(request.get(`/members/${memberId}/centers/effective-access`), gym);
const centerCount = async (memberId: number) => ((await centers(memberId)).body.specific_centers as unknown[]).length;
const setStatus = async (um: number, status: 'paused' | 'active') =>
  must(await auth(request.put(`/user-memberships/${um}`)).send({ status }), status);
const draftOf = async (memberId: number): Promise<number> =>
  Number(must(await auth(request.post('/product-sets/draft')).send({ member_id: memberId }), 'draft').body.id);
/** The assignment's current snapshot, as the readers resolve it. */
async function currentSnapshot(um: number) {
  const { rows } = await db.query<any>(
    `SELECT s.id, s.status, DATE_FORMAT(s.ends_at, '%Y-%m-%d') AS ends_at,
            (SELECT p.status FROM product_set_plan_snapshots j JOIN product_sets p ON p.id = j.product_set_id
              WHERE j.plan_snapshot_id = s.id ORDER BY (p.status = 'active') DESC, p.id DESC LIMIT 1) AS set_status
       FROM plan_snapshots a
       JOIN plan_snapshots s ON s.id = ${currentAssignmentSnapshotSql('a.assignment_id', 'a.gym_id')}
      WHERE a.gym_id = ? AND a.source_user_membership_id = ? LIMIT 1`, [gymId, um]);
  return rows[0];
}

beforeAll(async () => {
  gymId = await createTestGym('Assignment Access Readers Gym');
  otherGymId = await createTestGym('Assignment Access Readers Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
  const { insertId } = await db.query('INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)', [gymId, 'PAR Center', 'active']);
  centerId = Number(insertId);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('center access is read from the assignment\'s current plan snapshot', () => {
  it('a running plan grants its centers; another gym cannot read them', async () => {
    const { m, um } = await running();
    expect(await centerCount(m)).toBe(1);
    const current = await currentSnapshot(um);
    expect(current.status).toBe('active');
    expect(current.set_status).toBe('active');
    expect((await centers(m, otherGymId)).status).toBe(404);
    expect((await request.get(`/members/${m}/centers/effective-access`)).status).toBe(401);
  });

  it('a pause takes the access away and a resume gives it back', async () => {
    const { m, um } = await running();
    await setStatus(um, 'paused');
    expect((await currentSnapshot(um)).status).toBe('paused');
    expect(await centerCount(m)).toBe(0);
    await setStatus(um, 'active');
    expect(await centerCount(m)).toBe(1);
  });

  it('a pause reaches a plan whose snapshot a Draft Product Set also links', async () => {
    const { m, um } = await running();
    await draftOf(m);
    expect(await centerCount(m)).toBe(1);
    await setStatus(um, 'paused');
    expect(await centerCount(m)).toBe(0);
    // The snapshot that answers is the Active set's, never the Draft's.
    expect((await currentSnapshot(um)).set_status).toBe('active');
    await setStatus(um, 'active');
    expect(await centerCount(m)).toBe(1);
  });

  it('a cancelled plan keeps its access until its end date, and not after', async () => {
    const { m, um } = await running();
    must(await auth(request.delete(`/user-memberships/${um}`)), 'cancel');
    const current = await currentSnapshot(um);
    expect(current.status).toBe(CANCELS_AT_PERIOD_END_STATUS);
    expect(current.set_status).toBe('active');
    expect(await centerCount(m)).toBe(1);
    // Its last entitled day has passed and the nightly sweep has not run yet.
    await db.query('UPDATE plan_snapshots SET ends_at = UTC_DATE() - INTERVAL 1 DAY WHERE id = ?', [current.id]);
    expect(await centerCount(m)).toBe(0);
  });

  it('a Draft plan nobody committed grants nothing', async () => {
    const m = await member();
    await createTestDraftAssignment(gymId, m, await plan());
    expect(await centerCount(m)).toBe(0);
  });

  it('the snapshot is the record: a user_memberships row that disagrees does not move the answer', async () => {
    const { m, um } = await running();
    await db.query("UPDATE user_memberships SET status = 'cancelled' WHERE id = ?", [um]);
    expect(await centerCount(m)).toBe(1);
  });
});

describe('coverage is the current snapshot\'s beneficiaries', () => {
  it('a covered Member holds the plan\'s access; a Member the plan does not cover holds none', async () => {
    const { um } = await running();
    const covered = await member();
    const stranger = await member();
    must(await auth(request.post(`/user-memberships/${um}/members`)).send({ member_id: covered }), 'cover');
    const of = async (memberId: number) => (await loadMemberCenterAccessInputs(db, gymId, memberId)).plans.length;
    expect(await of(covered)).toBe(1);
    expect(await of(stranger)).toBe(0);
    expect(await centerCount(covered)).toBe(1);
  });

  it('two plans of one Member both count', async () => {
    const { m } = await running();
    const um2 = await createTestDraftAssignment(gymId, m, await plan());
    must(await auth(request.post(`/user-memberships/${um2}/activate`)).send({ on_conflict: 'add' }), 'activate second');
    expect((await loadMemberCenterAccessInputs(db, gymId, m)).plans).toHaveLength(2);
  });
});
