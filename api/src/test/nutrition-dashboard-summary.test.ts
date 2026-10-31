// Integration tests for GET /nutrition/dashboard/summary (#2172): the Nutrition
// Plan and Personal Goal usage numbers of the Nutrition & Goals Dashboard.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

const PATH = '/nutrition/dashboard/summary';
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

let gymId: string;

const get = (gym: string) =>
  request.get(PATH).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);

async function member(gym: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gym, 'NDS Member', `nds-${unique()}@test.com`]);
  return insertId;
}

async function template(gym: string): Promise<number> {
  const { insertId } = await db.query(
    "INSERT INTO nutrition_plan_templates (gym_id, name, status) VALUES (?, ?, 'active')", [gym, `NDS T ${unique()}`]);
  return insertId;
}

async function plan(gym: string, memberId: number, templateId: number | null, status = 'active') {
  await db.query(
    'INSERT INTO member_nutrition_plans (gym_id, member_id, template_id, name, status) VALUES (?, ?, ?, ?, ?)',
    [gym, memberId, templateId, `NDS Plan ${unique()}`, status]);
}

async function goal(gym: string, name: string, baseId: number | null = null): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO personal_goals (gym_id, name, base_personal_goal_id) VALUES (?, ?, ?)', [gym, name, baseId]);
  return insertId;
}

async function assignGoal(gym: string, memberId: number, goalId: number, status = 'in_progress', deleted = false) {
  await db.query(
    `INSERT INTO member_personal_goals (gym_id, member_id, personal_goal_id, goal_name, status, deleted_at)
     VALUES (?, ?, ?, 'x', ?, ${deleted ? 'UTC_TIMESTAMP()' : 'NULL'})`,
    [gym, memberId, goalId, status]);
}

beforeAll(async () => {
  gymId = await createTestGym('NDS Gym');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('GET /nutrition/dashboard/summary', () => {
  it('returns 401 without auth', async () => {
    expect((await request.get(PATH).set('x-gym-id', gymId)).status).toBe(401);
  });

  it('reports zeros and no most-popular goal for an empty gym', async () => {
    const gym = await createTestGym('NDS Empty Gym');
    await createTestMembership(gym, 'admin');
    const res = await get(gym);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      nutrition_plans: { members: 0, assignments: 0, plans_in_use: 0 },
      personal_goals: { members: 0, goals_in_use: 0, average_per_member: 0, most_popular: null },
    });
  });

  it('counts members, assignments and templates separately and ignores completed or deleted plans', async () => {
    const gym = await createTestGym('NDS Plans Gym');
    await createTestMembership(gym, 'admin');
    const t1 = await template(gym);
    const t2 = await template(gym);
    const a = await member(gym);
    const b = await member(gym);
    await plan(gym, a, t1);
    await plan(gym, a, t2);
    await plan(gym, b, t1);
    await plan(gym, b, t1, 'completed');
    await plan(gym, b, t1, 'deleted');

    const res = await get(gym);
    expect(res.body.nutrition_plans).toEqual({ members: 2, assignments: 3, plans_in_use: 2 });
  });

  it('computes the Personal Goals metrics from live assignments only, grouping a copy with its System template', async () => {
    const gym = await createTestGym('NDS Goals Gym');
    await createTestMembership(gym, 'admin');
    const { rows: base } = await db.query<{ id: number }>(
      'SELECT id FROM base_personal_goals WHERE deleted_at IS NULL ORDER BY id LIMIT 1');
    const copy = await goal(gym, 'Copy of base', base[0].id);
    const custom = await goal(gym, `Custom ${unique()}`);
    const [m1, m2, m3, m4] = [await member(gym), await member(gym), await member(gym), await member(gym)];

    await assignGoal(gym, m1, copy);
    await assignGoal(gym, m2, copy);
    await assignGoal(gym, m1, custom);
    await assignGoal(gym, m3, custom, 'achieved');
    await assignGoal(gym, m4, custom, 'in_progress', true);

    const res = await get(gym);
    expect(res.status).toBe(200);
    expect(res.body.personal_goals).toMatchObject({ members: 2, goals_in_use: 2, average_per_member: 1.5 });
    expect(res.body.personal_goals.most_popular).toMatchObject({ goal_id: base[0].id, members: 2 });
  });

  it("never counts another gym's data", async () => {
    const other = await createTestGym('NDS Other Gym');
    await createTestMembership(other, 'admin');
    await assignGoal(other, await member(other), await goal(other, `Other ${unique()}`));
    const res = await get(gymId);
    expect(res.body.personal_goals.members).toBe(0);
  });
});
