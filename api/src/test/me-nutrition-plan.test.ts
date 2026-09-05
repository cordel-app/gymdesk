// Tests for me.ts router — GET /me/nutrition-plan (#361)
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  TEST_USER_ID,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

let gymId: string;
let memberId: number;
let libraryItemId: number;

beforeAll(async () => {
  gymId = await createTestGym('Me Nutrition Plan Gym');
  await createTestMembership(gymId, 'member');

  const email = `me-nutrition-${Date.now()}@test.com`;
  await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id)
     VALUES (?, 'Test Member', ?, ?)
     ON DUPLICATE KEY UPDATE gym_id = VALUES(gym_id), email = VALUES(email)`,
    [gymId, email, TEST_USER_ID],
  );
  const { rows: mRows } = await db.query<{ id: number }>(
    'SELECT id FROM members WHERE clerk_user_id = ?',
    [TEST_USER_ID],
  );
  memberId = mRows[0].id;

  const { insertId } = await db.query(
    `INSERT INTO nutrition_library_items (gym_id, category, name, status)
     VALUES (NULL, 'main_dish', 'Grilled Chicken', 'active')`,
  );
  libraryItemId = insertId;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

/** Insert an active member_nutrition_plan with one day/meal/item and one goal. */
async function insertActivePlan(gid: string, mid: number, weekday: number) {
  const { insertId: planId } = await db.query(
    `INSERT INTO member_nutrition_plans (gym_id, member_id, name, status)
     VALUES (?, ?, 'Test Plan', 'active')`,
    [gid, mid],
  );
  const { insertId: dayId } = await db.query(
    `INSERT INTO member_nutrition_plan_days (gym_id, member_nutrition_plan_id, weekday, position)
     VALUES (?, ?, ?, 1)`,
    [gid, planId, weekday],
  );
  const { insertId: mealId } = await db.query(
    `INSERT INTO member_nutrition_plan_meals (gym_id, member_nutrition_plan_day_id, meal_type, display_name, position)
     VALUES (?, ?, 'lunch', 'Lunch', 1)`,
    [gid, dayId],
  );
  await db.query(
    `INSERT INTO member_nutrition_plan_meal_items (gym_id, meal_id, nutrition_library_item_id, component_type, quantity, unit, position)
     VALUES (?, ?, ?, 'main_dish', 150, 'g', 1)`,
    [gid, mealId, libraryItemId],
  );
  await db.query(
    `INSERT INTO member_nutrition_plan_goals (gym_id, member_nutrition_plan_id, item_name, quantity, unit, frequency)
     VALUES (?, ?, 'Protein', 140, 'g', 'daily')`,
    [gid, planId],
  );
  return planId;
}

describe('GET /me/nutrition-plan', () => {
  it('returns 401 without auth', async () => {
    const res = await request.get('/me/nutrition-plan').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no membership in this gym', async () => {
    const otherId = await createTestGym('Other Nutrition Gym');
    const res = await request
      .get('/me/nutrition-plan')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherId);
    expect(res.status).toBe(403);
  });

  it('returns 403 when user has a non-member gym role', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: 'nutrition-admin-user' } as any);
    const roleGymId = await createTestGym('Nutrition Role Guard Gym');
    await createTestMembership(roleGymId, 'admin', 'nutrition-admin-user');
    const res = await request
      .get('/me/nutrition-plan')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', roleGymId);
    expect(res.status).toBe(403);
  });

  it('returns { plan: null } when the member has no active plan', async () => {
    const emptyGymId = await createTestGym('No Plan Gym');
    await createTestMembership(emptyGymId, 'member');
    const email = `no-plan-${Date.now()}@test.com`;
    await db.query(
      `INSERT INTO members (gym_id, name, email, clerk_user_id)
       VALUES (?, 'No Plan Member', ?, ?)
       ON DUPLICATE KEY UPDATE gym_id = VALUES(gym_id), email = VALUES(email)`,
      [emptyGymId, email, TEST_USER_ID],
    );

    const res = await request
      .get('/me/nutrition-plan')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', emptyGymId);
    expect(res.status).toBe(200);
    expect(res.body.plan).toBeNull();
  });

  it('returns the active plan with full days/meals/items/goals for the caller', async () => {
    await insertActivePlan(gymId, memberId, 2);

    const res = await request
      .get('/me/nutrition-plan')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.plan).not.toBeNull();
    expect(res.body.plan.name).toBe('Test Plan');
    expect(Array.isArray(res.body.plan.days)).toBe(true);
    expect(res.body.plan.days.length).toBeGreaterThan(0);

    const day = res.body.plan.days.find((d: any) => d.weekday === 2);
    expect(day).toBeDefined();
    expect(day.meals.length).toBe(1);
    expect(day.meals[0].display_name).toBe('Lunch');
    expect(day.meals[0].items[0].item_name).toBe('Grilled Chicken');

    expect(Array.isArray(res.body.plan.goals)).toBe(true);
    expect(res.body.plan.goals[0].item_name).toBe('Protein');
  });

  it('does not return a different member\'s plan from the same gym', async () => {
    // A second, unlinked member in the same gym with their own active plan.
    const { insertId: otherMemberId } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Other Member', ?)`,
      [gymId, `other-member-${Date.now()}@test.com`],
    );
    await insertActivePlan(gymId, otherMemberId, 3);

    const res = await request
      .get('/me/nutrition-plan')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    // Still resolves to the caller's own plan (inserted earlier in this file), never the other member's.
    expect(res.body.plan.name).toBe('Test Plan');
    expect(res.body.plan.days.some((d: any) => d.weekday === 3)).toBe(false);
  });
});
