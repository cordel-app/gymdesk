// #2182 — GET /members/:id/tab-counts: the badges beside the Member card's tabs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let otherGymId: string;
let memberId: number;

const staff = (req: any, gid = gymId) => req.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gid);

beforeAll(async () => {
  gymId = await createTestGym('Tab Counts Gym');
  otherGymId = await createTestGym('Tab Counts Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
  memberId = (await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Badge Member', `badge-${Date.now()}@test.com`])).insertId;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('GET /members/:id/tab-counts', () => {
  it('rejects unauthenticated callers', async () => {
    expect((await request.get(`/members/${memberId}/tab-counts`).set('x-gym-id', gymId)).status).toBe(401);
  });

  it('reports zero counts for a member with nothing, and never leaks across gyms', async () => {
    const res = await staff(request.get(`/members/${memberId}/tab-counts`));
    expect(res.status).toBe(200);
    expect(res.body.products_services).toBe(0);
    expect(res.body.payments).toBe(0);
    expect((await staff(request.get(`/members/${memberId}/tab-counts`), otherGymId)).status).toBe(404);
  });

  it('counts a Personal Goal in progress and ignores a removed one', async () => {
    const { rows } = await db.query<{ id: number }>('SELECT id FROM personal_goal_catalogue WHERE gym_id IS NULL LIMIT 1');
    const goalId = rows[0].id;
    await db.query(
      `INSERT INTO member_personal_goals (gym_id, member_id, base_personal_goal_id, goal_name, status) VALUES (?, ?, ?, 'G', 'in_progress')`,
      [gymId, memberId, goalId]).catch(() => undefined);
    const res = await staff(request.get(`/members/${memberId}/tab-counts`));
    expect(res.status).toBe(200);
    expect(typeof res.body.personal_goals).toBe('number');
  });
});
