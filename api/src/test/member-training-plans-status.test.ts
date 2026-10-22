import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

// #1965: the Member card's Training Plan list reports the plan's own status, the one
// Assigned Training Plans shows, not the assignment row's stale copy.

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('GET /members/:memberId/member-training-plans status (#1965)', () => {
  let gymId: string;
  let otherGymId: string;
  let memberId: number;

  async function assign(planStatus: string, mtpStatus: string): Promise<number> {
    const { insertId: planId } = await db.query(
      `INSERT INTO training_plans (gym_id, member_id, name, status, start_date) VALUES (?, ?, ?, ?, CURRENT_DATE)`,
      [gymId, memberId, `Plan ${planStatus}/${mtpStatus}`, planStatus],
    );
    await db.query(
      `INSERT INTO member_training_plans (gym_id, member_id, training_plan_id, status) VALUES (?, ?, ?, ?)`,
      [gymId, memberId, planId, mtpStatus],
    );
    return planId;
  }

  beforeAll(async () => {
    gymId = await createTestGym('MTP Status Gym');
    otherGymId = await createTestGym('MTP Status Other Gym');
    await createTestMembership(gymId, 'admin');
    await createTestMembership(otherGymId, 'admin');
    const { insertId } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Status Member', ?)`,
      [gymId, `mtp-status-${Date.now()}@test.com`],
    );
    memberId = insertId;
  });

  it('reports each plan status, whatever the assignment row still says', async () => {
    const completed = await assign('completed', 'active');
    const expired = await assign('expired', 'active');
    const active = await assign('active', 'active');
    const cancelled = await assign('active', 'cancelled');

    const res = await request
      .get(`/members/${memberId}/member-training-plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(200);
    const byPlan = (id: number) => res.body.find((r: any) => r.training_plan_id === id);
    expect(byPlan(completed).status).toBe('completed');
    expect(byPlan(completed).assignment_status).toBe('active');
    expect(byPlan(expired).status).toBe('expired');
    expect(byPlan(active).status).toBe('active');
    expect(byPlan(cancelled).status).toBe('cancelled');
  });

  it('does not serve another gym\'s member', async () => {
    const res = await request
      .get(`/members/${memberId}/member-training-plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
