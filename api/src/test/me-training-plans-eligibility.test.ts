// Regression test for #1631 — My Training showed workouts of plans that the
// admin panel no longer shows as Active. Staff change `training_plans.status`
// (edit, complete, expire) without touching the `member_training_plans`
// assignment row, so the member endpoint must honour the plan's own status.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, TEST_USER_ID, cleanupTestGyms, createTestGym, createTestMembership, request,
} from './helpers';

let gymId: string;
let memberId: number;

async function createPlan(name: string, planStatus: string, assignmentStatuses: string[]): Promise<number> {
  const { insertId: planId } = await db.query(
    `INSERT INTO training_plans (gym_id, member_id, name, status, start_date) VALUES (?, ?, ?, ?, CURRENT_DATE)`,
    [gymId, memberId, name, planStatus],
  );
  for (const s of assignmentStatuses) {
    await db.query(
      `INSERT INTO member_training_plans (gym_id, member_id, training_plan_id, status) VALUES (?, ?, ?, ?)`,
      [gymId, memberId, planId, s],
    );
  }
  await db.query(
    `INSERT INTO workouts (gym_id, training_plan_id, name, position, scheduled_weekday) VALUES (?, ?, ?, 1, 1)`,
    [gymId, planId, `Workout of ${name}`],
  );
  return planId;
}

const asMember = (req: any) => req.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

beforeAll(async () => {
  gymId = await createTestGym('Me Training Eligibility Gym');
  await createTestMembership(gymId, 'member');
  await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, 'Eligibility Member', ?, ?)
     ON DUPLICATE KEY UPDATE gym_id = VALUES(gym_id), email = VALUES(email)`,
    [gymId, `me-training-elig-${Date.now()}@test.com`, TEST_USER_ID],
  );
  const { rows } = await db.query<{ id: number }>('SELECT id FROM members WHERE clerk_user_id = ?', [TEST_USER_ID]);
  memberId = rows[0].id;

  await createPlan('Current', 'active', ['active']);
  // Completed / expired in the admin, assignment row still 'active'.
  await createPlan('Completed', 'completed', ['active']);
  await createPlan('Expired', 'expired', ['active']);
  // Plan active but its assignment ended.
  await createPlan('Ended assignment', 'active', ['completed']);
  // Two active assignment rows for one plan must not duplicate it.
  await createPlan('Doubled', 'active', ['active', 'active']);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('GET /me/training-plans eligibility (#1631)', () => {
  it('returns only active plans with an active assignment, each once', async () => {
    const res = await asMember(request.get('/me/training-plans')).expect(200);
    const names = res.body.map((p: any) => p.name).sort();
    expect(names).toEqual(['Current', 'Doubled']);
  });
});
