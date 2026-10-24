// #1580: POST /me/nutrition-logs and GET /me/nutrition-progress against the real stack.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, TEST_USER_ID, cleanupTestGyms, createTestGym, createTestMembership, request,
} from './helpers';

let gymId: string;
let memberId: number;
let allDaysMealId: number;
let futureOnlyMealId: number;
let foreignMealId: number;

// The gym's zone is Europe/Madrid by default; use UTC-safe dates relative to now.
const today = DateTime.now().setZone('Europe/Madrid').toISODate() as string;
const tomorrow = DateTime.fromISO(today).plus({ days: 1 }).toISODate() as string;
const yesterday = DateTime.fromISO(today).minus({ days: 1 }).toISODate() as string;
// The nutrition plan's day numbering: 0=Monday … 6=Sunday (7 = every day).
const weekdayOf = (d: string) => DateTime.fromISO(d, { zone: 'UTC' }).weekday - 1;

async function createMember(gid: string, name: string, clerk: string | null): Promise<number> {
  const email = `${name.toLowerCase().replace(/\W+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`;
  if (clerk === null) {
    return (await db.query(`INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, NULL)`, [gid, name, email])).insertId;
  }
  await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE gym_id = VALUES(gym_id), name = VALUES(name), email = VALUES(email), deleted_at = NULL`,
    [gid, name, email, clerk],
  );
  const { rows } = await db.query<{ id: number }>('SELECT id FROM members WHERE clerk_user_id = ?', [clerk]);
  return rows[0].id;
}

async function createPlan(gid: string, mid: number, days: { weekday: number }[]): Promise<number[]> {
  const { insertId: planId } = await db.query(
    `INSERT INTO member_nutrition_plans (gym_id, member_id, name, status) VALUES (?, ?, 'Plan', 'active')`, [gid, mid]);
  const ids: number[] = [];
  for (const d of days) {
    const { insertId: dayId } = await db.query(
      `INSERT INTO member_nutrition_plan_days (gym_id, member_nutrition_plan_id, weekday) VALUES (?, ?, ?)`, [gid, planId, d.weekday]);
    const { insertId } = await db.query(
      `INSERT INTO member_nutrition_plan_meals (gym_id, member_nutrition_plan_day_id, display_name) VALUES (?, ?, 'Meal')`, [gid, dayId]);
    ids.push(insertId);
  }
  return ids;
}

const asMember = (req: any) => req.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

beforeAll(async () => {
  gymId = await createTestGym('Nutrition Logs Gym');
  await createTestMembership(gymId, 'member');
  memberId = await createMember(gymId, 'Nutri Member', TEST_USER_ID);
  // A meal only on tomorrow's weekday, and one every day.
  [allDaysMealId, futureOnlyMealId] = await createPlan(gymId, memberId, [{ weekday: 7 }, { weekday: weekdayOf(tomorrow) }]);
  const other = await createMember(gymId, 'Other Nutri', null);
  [foreignMealId] = await createPlan(gymId, other, [{ weekday: 7 }]);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('POST /me/nutrition-logs', () => {
  it('marks a meal done today and persists it', async () => {
    const res = await asMember(request.post('/me/nutrition-logs')).send({ meal_id: allDaysMealId, logged_date: today }).expect(201);
    expect(res.body.meal_id).toBe(allDaysMealId);
    expect(res.body.logged_date).toBe(today);
  });

  it('is idempotent: repeating returns the same record and creates no duplicate', async () => {
    const a = await asMember(request.post('/me/nutrition-logs')).send({ meal_id: allDaysMealId, logged_date: yesterday }).expect(201);
    const b = await asMember(request.post('/me/nutrition-logs')).send({ meal_id: allDaysMealId, logged_date: yesterday }).expect(200);
    expect(b.body.id).toBe(a.body.id);
    const { rows } = await db.query('SELECT COUNT(*) AS n FROM nutrition_logs WHERE meal_id = ? AND logged_date = ?', [allDaysMealId, yesterday]);
    expect(Number(rows[0].n)).toBe(1);
  });

  it('refuses a future date even for a meal that is scheduled then', async () => {
    await asMember(request.post('/me/nutrition-logs')).send({ meal_id: futureOnlyMealId, logged_date: tomorrow }).expect(400);
    await asMember(request.post('/me/nutrition-logs')).send({ meal_id: allDaysMealId, logged_date: tomorrow }).expect(400);
  });

  it('refuses a date the meal is not scheduled on', async () => {
    await asMember(request.post('/me/nutrition-logs')).send({ meal_id: futureOnlyMealId, logged_date: today }).expect(400);
  });

  it("refuses another member's meal and unauthenticated calls", async () => {
    await asMember(request.post('/me/nutrition-logs')).send({ meal_id: foreignMealId, logged_date: today }).expect(403);
    await request.post('/me/nutrition-logs').set('x-gym-id', gymId).send({ meal_id: allDaysMealId, logged_date: today }).expect(401);
  });

  it('rejects a malformed body', async () => {
    await asMember(request.post('/me/nutrition-logs')).send({ meal_id: 'x', logged_date: today }).expect(400);
    await asMember(request.post('/me/nutrition-logs')).send({ meal_id: allDaysMealId, logged_date: 'tomorrow' }).expect(400);
  });
});

describe('GET /me/nutrition-progress', () => {
  it('counts only persisted completions, and reports the week', async () => {
    const res = await asMember(request.get('/me/nutrition-progress')).expect(200);
    expect(res.body.today).toBe(today);
    expect(res.body.day.completed).toBe(1);
    expect(res.body.day.total).toBe(1);
    expect(res.body.day.percent).toBe(100);
    expect(res.body.week_days).toHaveLength(7);
    expect(res.body.week_days.find((d: any) => d.date === today).status).toBe('completed');
  });

  it("does not read another member's logs", async () => {
    const res = await asMember(request.get('/me/nutrition-logs')).expect(200);
    expect(res.body.every((l: any) => l.meal_id === allDaysMealId)).toBe(true);
  });
});

describe('POST /me/nutrition-logs — assignment date range (#1957)', () => {
  it('refuses a meal of an ongoing assignment on a date before its start_date', async () => {
    await db.query('UPDATE member_nutrition_plans SET start_date = ? WHERE member_id = ? AND status = \'active\'', [today, memberId]);
    await asMember(request.post('/me/nutrition-logs')).send({ meal_id: allDaysMealId, logged_date: yesterday }).expect(400);
    await asMember(request.post('/me/nutrition-logs')).send({ meal_id: allDaysMealId, logged_date: today }).expect((r) => { if (![200, 201].includes(r.status)) throw new Error(`status ${r.status}`); });
  });
});
