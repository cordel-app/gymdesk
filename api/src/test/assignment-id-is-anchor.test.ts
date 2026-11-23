// #2125 N1 (migration 461): a Membership Plan assignment's id is its anchor plan snapshot's own id.
// It is opened on that snapshot when the assignment is created, stays the same through activation,
// and a Draft discarded before it is confirmed takes its snapshot, and so its id, with it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';
import { findPlanAssignmentDrift } from '../api/plan-assignment-drift';

let gymId: string;
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

beforeAll(async () => {
  gymId = await createTestGym('Assignment Id Is Anchor Gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

async function plan(price = 0): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 1)`, [gymId, `Anchor-${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, ?, '2020-01-01', 'active')`, [gymId, insertId, price]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}
async function member(): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'Anchor', `anchor-${uniq()}@test.com`]);
  return Number(insertId);
}
const assign = async (m: number) => auth(request.post('/user-memberships'))
  .send({ member_id: m, membership_plan_id: await plan(), starts_at: new Date().toISOString().slice(0, 10) });
async function snapshotsOf(id: number) {
  const { rows } = await db.query<any>(
    `SELECT id, assignment_id, assignment_id AS um FROM plan_snapshots
      WHERE gym_id = ? AND (assignment_id = ? OR assignment_id = ?) ORDER BY id`, [gymId, id, id]);
  return rows.map((r: any) => ({ id: Number(r.id), anchor: Number(r.assignment_id), um: Number(r.um) }));
}

describe('an assignment id is its anchor snapshot id (#2125 N1)', () => {
  it('a created assignment is opened on its own plan snapshot, which anchors itself', async () => {
    const res = await assign(await member());
    expect(res.status).toBe(201);
    const id = Number(res.body.id);
    expect(await snapshotsOf(id)).toEqual([{ id, anchor: id, um: id }]);
    const { rows: audit } = await db.query<any>(
      `SELECT action FROM audit_logs WHERE gym_id = ? AND entity_type = 'user_membership' AND entity_id = ?`, [gymId, String(id)]);
    expect(audit.map((r: any) => r.action)).toContain('status_change');
  });

  it('the id stays the same once the Draft is activated', async () => {
    const res = await assign(await member());
    const id = Number(res.body.id);
    const act = await auth(request.post(`/user-memberships/${id}/activate`)).send({});
    expect(act.status).toBeLessThan(300);
    const after = await auth(request.get(`/user-memberships/${id}`));
    expect(after.status).toBe(200);
    expect(after.body.status).toBe('active');
    for (const s of await snapshotsOf(id)) {
      expect(s.anchor).toBe(id);
      expect(s.um).toBe(id);
    }
  });

  it('a discarded Draft leaves no plan snapshot carrying its id', async () => {
    const res = await assign(await member());
    const id = Number(res.body.id);
    const del = await auth(request.delete(`/user-memberships/${id}/draft`));
    expect(del.status).toBeLessThan(300);
    expect(await snapshotsOf(id)).toEqual([]);
    expect((await auth(request.get(`/user-memberships/${id}`))).status).toBe(404);
  });

  it('the drift report finds no snapshot naming a snapshot that is not an anchor', async () => {
    await assign(await member());
    const check = (await findPlanAssignmentDrift(db, gymId)).checks.find((c) => c.name === 'assignment_identity_split')!;
    expect(check.count).toBe(0);
  });
});
