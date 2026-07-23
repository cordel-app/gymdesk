import supertest from 'supertest';
import { app } from '../app';
import { db } from '../infra/db';

export const request = supertest(app);

// Must match the `sub` returned by the mocked verifyToken in setup.ts
export const TEST_USER_ID = 'test-user-id';

// Any non-empty string is accepted by the mocked verifyToken
export const TEST_AUTH_HEADER = 'Bearer test-token';

// Track gym IDs per worker so concurrent test files don't cross-contaminate cleanup.
const _createdGymIds: string[] = [];

/** Creates a gym and returns its UUID. */
export async function createTestGym(name = 'Test Gym'): Promise<string> {
  const slug = `test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await db.query(
    `INSERT INTO gyms (name, slug, plan) VALUES (?, ?, 'free')`,
    [name, slug],
  );
  const { rows } = await db.query<{ id: string }>('SELECT id FROM gyms WHERE slug = ?', [slug]);
  _createdGymIds.push(rows[0].id);
  return rows[0].id;
}

/** Inserts a gym_memberships row so tenantContext can resolve the user's role. */
export async function createTestMembership(
  gymId: string,
  role: 'admin' | 'trainer_performance' | 'trainer_perf_nutrition' | 'front_desk' | 'accountant' | 'nutritionist' | 'member' = 'admin',
  userId = TEST_USER_ID,
) {
  await db.query(
    `INSERT INTO gym_memberships (user_id, gym_id, role, status) VALUES (?, ?, ?, 'active')`,
    [userId, gymId, role],
  );
}

/** Deletes gyms created by this worker and their dependent rows. */
export async function cleanupTestGyms() {
  const ids = _createdGymIds.splice(0);
  if (ids.length === 0) return;
  const marks = ids.map(() => '?').join(',');
  // Delete in FK dependency order to avoid constraint violations.
  await db.query(`DELETE FROM bookings WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM members WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM staff WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM class_sessions WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM space_activity_types WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM spaces WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM activity_types WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM workout_template_exercises WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM workout_template_blocks WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM workout_templates WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM exercises WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM nutrition_plan_template_meal_dishes WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM nutrition_plan_template_meals WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM nutrition_plan_template_days WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM nutrition_plan_templates WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM dishes WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM sides WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM sauces WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM gyms WHERE id IN (${marks})`, ids);
}
