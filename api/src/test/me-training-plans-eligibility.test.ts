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

describe('GET /me/training-plans date range (#1967)', () => {
  it('hides a plan before its start_date and after its end_date', async () => {
    const mk = async (name: string, start: string | null, end: string | null) => {
      const id = await createPlan(name, 'active', ['active']);
      await db.query('UPDATE training_plans SET start_date = ?, end_date = ? WHERE id = ?', [start, end, id]);
    };
    await mk('Future range', '2099-01-01', null);
    await mk('Past range', '2000-01-01', '2000-12-31');
    await mk('Open range', '2000-01-01', '2099-12-31');
    const res = await asMember(request.get('/me/training-plans')).expect(200);
    const names = res.body.map((p: any) => p.name);
    expect(names).toContain('Open range');
    expect(names).not.toContain('Future range');
    expect(names).not.toContain('Past range');
  });
});

describe('GET /me/training-plans?date= historical view (#1967)', () => {
  it('rejects a malformed date', async () => {
    await asMember(request.get('/me/training-plans?date=yesterday')).expect(400);
  });

  it('shows the plan that applied on a past date, including one since completed', async () => {
    const mk = async (name: string, status: string, start: string, end: string | null) => {
      const id = await createPlan(name, status, ['active']);
      await db.query('UPDATE training_plans SET start_date = ?, end_date = ? WHERE id = ?', [start, end, id]);
    };
    await mk('Hist completed', 'completed', '2001-01-01', '2001-06-30');
    await mk('Hist expired', 'expired', '2001-01-01', '2001-03-31');
    await mk('Hist later', 'active', '2001-07-01', null);

    const inside = await asMember(request.get('/me/training-plans?date=2001-02-15')).expect(200);
    const insideNames = inside.body.map((p: any) => p.name);
    expect(insideNames).toContain('Hist completed');
    expect(insideNames).toContain('Hist expired');
    expect(insideNames).not.toContain('Hist later'); // not yet started

    // Boundaries are inclusive of end_date and exclusive after it.
    const onEnd = await asMember(request.get('/me/training-plans?date=2001-06-30')).expect(200);
    expect(onEnd.body.map((p: any) => p.name)).toContain('Hist completed');
    const afterEnd = await asMember(request.get('/me/training-plans?date=2001-07-01')).expect(200);
    const afterNames = afterEnd.body.map((p: any) => p.name);
    expect(afterNames).not.toContain('Hist completed');
    expect(afterNames).toContain('Hist later');
  });

  it('never exposes a completed plan as a current one', async () => {
    const res = await asMember(request.get('/me/training-plans')).expect(200);
    expect(res.body.map((p: any) => p.name)).not.toContain('Hist completed');
  });
});
