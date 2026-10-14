// #1603: POST/GET /me/nutrition-requirement-logs and the weighted /me/nutrition-progress.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, TEST_USER_ID, cleanupTestGyms, createTestGym, createTestMembership, request,
} from './helpers';

let gymId: string;
let goalId: number;
let restrictionId: number;
let foreignGoalId: number;

const today = DateTime.now().setZone('Europe/Madrid').toISODate() as string;
const tomorrow = DateTime.fromISO(today).plus({ days: 1 }).toISODate() as string;

async function memberWithPlan(name: string, clerk: string | null) {
  const email = `${name.toLowerCase().replace(/\W+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`;
  let memberId: number;
  if (clerk === null) {
    memberId = (await db.query(`INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, NULL)`, [gymId, name, email])).insertId;
  } else {
    await db.query(
      `INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE gym_id = VALUES(gym_id), name = VALUES(name), email = VALUES(email), deleted_at = NULL`,
      [gymId, name, email, clerk]);
    memberId = (await db.query<{ id: number }>('SELECT id FROM members WHERE clerk_user_id = ?', [clerk])).rows[0].id;
  }
  const { insertId: planId } = await db.query(
    `INSERT INTO member_nutrition_plans (gym_id, member_id, name, status) VALUES (?, ?, 'Plan', 'active')`, [gymId, memberId]);
  const g = await db.query(
    `INSERT INTO member_nutrition_plan_goals (gym_id, member_nutrition_plan_id, item_name, quantity, unit, frequency, applies_all_days, position)
     VALUES (?, ?, 'water', 2, 'l', 'daily', 1, 0)`, [gymId, planId]);
  const food = await db.query(`INSERT INTO nutrition_library_items (gym_id, name, status) VALUES (?, ?, 'active')`, [gymId, `Bread ${memberId}`]);
  const r = await db.query(
    `INSERT INTO member_nutrition_plan_restrictions (gym_id, member_nutrition_plan_id, nutrition_library_item_id, applies_all_days, position)
     VALUES (?, ?, ?, 1, 0)`, [gymId, planId, food.insertId]);
  return { goal: g.insertId as number, restriction: r.insertId as number };
}

const asMember = (req: any) => req.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

beforeAll(async () => {
  gymId = await createTestGym('Nutrition Requirement Logs Gym');
  await createTestMembership(gymId, 'member');
  ({ goal: goalId, restriction: restrictionId } = await memberWithPlan('Req Member', TEST_USER_ID));
  ({ goal: foreignGoalId } = await memberWithPlan('Other Req', null));
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('POST /me/nutrition-requirement-logs', () => {
  it('records a restriction as partial, then raises it to done, never back', async () => {
    const a = await asMember(request.post('/me/nutrition-requirement-logs')).send({ restriction_id: restrictionId, logged_date: today, level: 'partial' }).expect(201);
    expect(a.body.level).toBe('partial');
    const b = await asMember(request.post('/me/nutrition-requirement-logs')).send({ restriction_id: restrictionId, logged_date: today }).expect(200);
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.level).toBe('done');
    const c = await asMember(request.post('/me/nutrition-requirement-logs')).send({ restriction_id: restrictionId, logged_date: today, level: 'partial' }).expect(200);
    expect(c.body.level).toBe('done');
    const { rows } = await db.query('SELECT COUNT(*) AS n FROM nutrition_requirement_logs WHERE restriction_id = ?', [restrictionId]);
    expect(Number(rows[0].n)).toBe(1);
  });

  it('feeds the weighted score and keeps a no-meal day out of grey', async () => {
    await asMember(request.post('/me/nutrition-requirement-logs')).send({ goal_id: goalId, logged_date: today }).expect(201);
    const res = await asMember(request.get('/me/nutrition-progress')).expect(200);
    const day = res.body.week_days.find((d: any) => d.date === today);
    expect(day.status).toBe('completed');
    expect(res.body.day.percent).toBe(100);
    const list = await asMember(request.get('/me/nutrition-requirement-logs')).expect(200);
    expect(list.body.length).toBe(2);
  });

  it('refuses a partial goal, a future date, both ids, and malformed bodies', async () => {
    await asMember(request.post('/me/nutrition-requirement-logs')).send({ goal_id: goalId, logged_date: today, level: 'partial' }).expect(400);
    await asMember(request.post('/me/nutrition-requirement-logs')).send({ goal_id: goalId, logged_date: tomorrow }).expect(400);
    await asMember(request.post('/me/nutrition-requirement-logs')).send({ goal_id: goalId, restriction_id: restrictionId, logged_date: today }).expect(400);
    await asMember(request.post('/me/nutrition-requirement-logs')).send({ logged_date: today }).expect(400);
  });

  it("refuses another member's goal and unauthenticated calls", async () => {
    await asMember(request.post('/me/nutrition-requirement-logs')).send({ goal_id: foreignGoalId, logged_date: today }).expect(403);
    await request.post('/me/nutrition-requirement-logs').set('x-gym-id', gymId).send({ goal_id: goalId, logged_date: today }).expect(401);
  });
});
