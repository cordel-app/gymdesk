// Integration tests for the Training Dashboard (#2173): adoption, counts and the
// Top 5 exercises over Assigned Training Plans, against the real stack.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership,
  request, legacyAssignmentQuery, legacyChildQuery,
} from './helpers';

const PATH = '/training/dashboard/summary';
const u = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const get = (gym: string) => request.get(PATH).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);

async function member(gym: string, enrolled: boolean): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gym, 'TD Member', `td-${u()}@test.com`]);
  if (enrolled) {
    const mp = await db.query(
      `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit) VALUES (?, ?, 'active', 'staff_only', '1')`,
      [gym, `TD Plan ${u()}`]);
    const um = await legacyAssignmentQuery(
      `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, base_price) VALUES (?, ?, ?, 'active', CURDATE(), 29.99)`,
      [gym, insertId, mp.insertId]);
    await legacyChildQuery('INSERT INTO user_membership_members (gym_id, user_membership_id, member_id, is_owner) VALUES (?, ?, ?, 1)', [gym, um.insertId, insertId]);
  }
  return insertId;
}

async function exercise(gym: string, name: string): Promise<number> {
  const { insertId } = await db.query("INSERT INTO exercises (gym_id, name, status) VALUES (?, ?, 'active')", [gym, name]);
  return insertId;
}

/** A plan for the member with one block holding `exerciseIds` (repeats allowed). */
async function plan(gym: string, memberId: number, exerciseIds: number[], opts: { status?: string; mtp?: string; template?: number | null } = {}): Promise<number> {
  const { insertId: tp } = await db.query(
    `INSERT INTO training_plans (gym_id, member_id, template_id, name, status, start_date) VALUES (?, ?, ?, ?, ?, CURDATE())`,
    [gym, memberId, opts.template ?? null, `TD ${u()}`, opts.status ?? 'active']);
  await db.query(
    `INSERT INTO member_training_plans (gym_id, member_id, training_plan_id, status) VALUES (?, ?, ?, ?)`,
    [gym, memberId, tp, opts.mtp ?? 'active']);
  const w = await db.query('INSERT INTO workouts (gym_id, training_plan_id, name, position) VALUES (?, ?, ?, 0)', [gym, tp, 'W']);
  const b = await db.query("INSERT INTO workout_blocks (gym_id, workout_id, position, type) VALUES (?, ?, 1, 'Circuit')", [gym, w.insertId]);
  let pos = 0;
  for (const ex of exerciseIds) {
    await db.query(
      'INSERT INTO workout_exercises (gym_id, workout_block_id, exercise_id, position) VALUES (?, ?, ?, ?)',
      [gym, b.insertId, ex, pos++]);
  }
  return tp;
}

let gymA: string;
let gymB: string;

beforeAll(async () => {
  gymA = await createTestGym('TD Gym A');
  gymB = await createTestGym('TD Gym B');
  await createTestMembership(gymA, 'admin');
  await createTestMembership(gymB, 'admin');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('GET /training/dashboard/summary', () => {
  it('is zeroed for a gym with no plans', async () => {
    await member(gymB, true);
    const res = await get(gymB);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      adoption: { active_members: 1, members_with_plan: 0, percent: 0 },
      active_assignments: 0, plans_in_use: 0, avg_exercises_per_plan: 0, top_exercises: [],
    });
  });

  it('counts members once, assignments separately, and only active plans', async () => {
    const squat = await exercise(gymA, 'TD Squat');
    const bench = await exercise(gymA, 'TD Bench');
    const row = await exercise(gymA, 'TD Row');
    const m1 = await member(gymA, true);
    const m2 = await member(gymA, true);
    await member(gymA, true); // no plan
    const noEnrol = await member(gymA, false); // plan but not an active member
    await plan(gymA, m1, [squat, squat, bench]); // squat twice in one plan: counts once
    await plan(gymA, m1, [squat, row]);
    await plan(gymA, m2, [squat]);
    await plan(gymA, m2, [bench], { status: 'completed' });
    await plan(gymA, m2, [bench], { mtp: 'completed' });
    await plan(gymA, noEnrol, [row]);

    const res = await get(gymA);
    expect(res.status).toBe(200);
    expect(res.body.adoption).toEqual({ active_members: 3, members_with_plan: 2, percent: 66.7 });
    expect(res.body.members_with_active_plans).toBe(3); // m1, m2 and the non-enrolled member
    expect(res.body.active_assignments).toBe(4);
    expect(res.body.plans_in_use).toBe(4);
    // distinct (plan, exercise) pairs: 2 + 2 + 1 + 1 = 6 over 4 plans
    expect(res.body.avg_exercises_per_plan).toBe(1.5);
    const top = res.body.top_exercises;
    expect(top[0]).toMatchObject({ rank: 1, name: 'TD Squat', uses: 3, percent: 75 });
    expect(top.map((t: any) => [t.name, t.uses])).toEqual([['TD Squat', 3], ['TD Row', 2], ['TD Bench', 1]]);
  });

  it('is isolated per gym', async () => {
    const res = await get(gymB);
    expect(res.body.active_assignments).toBe(0);
  });

  it('rejects unauthenticated and wrong-role callers', async () => {
    expect((await request.get(PATH)).status).toBe(401);
    const g = await createTestGym('TD Member Role');
    await createTestMembership(g, 'member');
    expect((await get(g)).status).toBe(403);
  });
});
