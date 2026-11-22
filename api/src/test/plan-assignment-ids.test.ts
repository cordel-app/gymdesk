// #2125 M6b-51d-1 — an assignment's id comes from the `plan_assignment_ids` registry, never from
// `user_memberships`' own counter, so the id survives the table's retirement.
import { TEST_ASSIGNMENTS } from './assignmentReads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { allocateAssignmentId } from '../api/assignment-lifecycle-writer';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';
import { testAssignmentWrite } from './assignmentFixture';

let gymId: string;
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

beforeAll(async () => {
  gymId = await createTestGym('Assignment Ids Gym');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

async function plan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '1')`, [gymId, `Ids-${uniq()}`]);
  return insertId;
}
async function member(): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'Ids', `ids-${uniq()}@test.com`]);
  return insertId;
}
const assign = async (m: number) => request.post('/user-memberships')
  .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)
  .send({ member_id: m, membership_plan_id: await plan(), starts_at: '2026-06-01' });

async function registered(id: number) {
  const { rows } = await db.query<any>('SELECT gym_id FROM plan_assignment_ids WHERE id = ?', [id]);
  return rows[0] ?? null;
}

describe('assignment ids come from plan_assignment_ids (#2125 M6b-51d-1)', () => {
  it('a created assignment is registered under its own id, for its gym', async () => {
    const res = await assign(await member());
    expect(res.status).toBe(201);
    expect(await registered(res.body.id)).toEqual({ gym_id: gymId });
  });

  it('the legacy table allocates nothing: the next registry id is the assignment\'s id', async () => {
    const first = await assign(await member());
    const second = await assign(await member());
    expect(second.status).toBe(201);
    expect(second.body.id).toBeGreaterThan(first.body.id);
    // An id taken from the registry is never reused by an assignment created after it.
    const taken = await allocateAssignmentId(db, gymId);
    const third = await assign(await member());
    expect(third.body.id).toBeGreaterThan(taken);
    const { rows } = await db.query<any>(`SELECT id FROM ${TEST_ASSIGNMENTS} um WHERE id = ?`, [taken]);
    expect(rows).toHaveLength(0);
  });

  it('a hand-written legacy row cannot collide with a later created assignment', async () => {
    const m = await member();
    const { insertId: legacyId } = await testAssignmentWrite(
      `INSERT INTO user_memberships (member_id, gym_id, membership_plan_id, starts_at, status)
       VALUES (?, ?, ?, '2026-06-01', 'cancelled')`, [m, gymId, await plan()]);
    expect(await registered(legacyId)).toEqual({ gym_id: gymId });
    const res = await assign(await member());
    expect(res.status).toBe(201);
    expect(res.body.id).toBeGreaterThan(legacyId);
  });
});
