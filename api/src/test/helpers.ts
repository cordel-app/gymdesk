import supertest from 'supertest';
import { app } from '../app';
import { db } from '../infra/db';

export const request = supertest(app);

// Must match the `sub` returned by the mocked verifyToken in setup.ts
export const TEST_USER_ID = 'test-user-id';

// Any non-empty string is accepted by the mocked verifyToken
export const TEST_AUTH_HEADER = 'Bearer test-token';

/** Creates a gym and returns its UUID. */
export async function createTestGym(name = 'Test Gym'): Promise<string> {
  const slug = `test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await db.query(
    `INSERT INTO gyms (name, slug, plan) VALUES (?, ?, 'free')`,
    [name, slug],
  );
  const { rows } = await db.query<{ id: string }>('SELECT id FROM gyms WHERE slug = ?', [slug]);
  return rows[0].id;
}

/** Inserts a gym_memberships row so tenantContext can resolve the user's role. */
export async function createTestMembership(
  gymId: string,
  role: 'admin' | 'coach' | 'staff' | 'member' = 'admin',
  userId = TEST_USER_ID,
) {
  await db.query(
    `INSERT INTO gym_memberships (user_id, gym_id, role, status) VALUES (?, ?, ?, 'active')`,
    [userId, gymId, role],
  );
}

/** Deletes all gyms created by tests and their dependent rows. */
export async function cleanupTestGyms() {
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM gyms WHERE slug LIKE 'test-%'`);
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  // Delete in FK dependency order to avoid constraint violations.
  await db.query(`DELETE FROM bookings WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM members WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM class_sessions WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM activity_types WHERE gym_id IN (${marks})`, ids);
  await db.query(`DELETE FROM gyms WHERE id IN (${marks})`, ids);
}
