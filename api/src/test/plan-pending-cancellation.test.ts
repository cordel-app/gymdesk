// #3007 stage 2(b) — a running plan is marked `to_be_canceled` in the owner's open Draft; discarding
// the Draft restores it exactly, committing the Draft cancels it with no charge.

import { TEST_ASSIGNMENTS } from './assignmentReads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, activateTestAssignment, cleanupTestGyms, createTestDraftAssignment, createTestGym,
  createTestMembership, request,
} from './helpers';
import { testAssignmentWrite } from './assignmentFixture';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const authed = (req: any) => req.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function runningPlan(): Promise<{ memberId: number; umId: number }> {
  const { insertId: memberId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'PC Member', `pc-${uniq()}@test.com`]);
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'staff_only')`, [gymId, `PC Plan ${uniq()}`]);
  const umId = await createTestDraftAssignment(gymId, memberId, planId, { startsAt: '2026-01-01' });
  await activateTestAssignment(gymId, umId);
  return { memberId, umId };
}

const status = async (umId: number) => (await db.query<any>(
  'SELECT status FROM plan_snapshots WHERE gym_id = ? AND anchor_plan_snapshot_id = ? ORDER BY id DESC LIMIT 1',
  [gymId, umId])).rows[0]?.status;
const legacy = async (umId: number) => (await db.query<any>(
  `SELECT status FROM ${TEST_ASSIGNMENTS} um WHERE id = ?`, [umId])).rows[0]?.status;

beforeAll(async () => {
  gymId = await createTestGym('Pending Cancel Gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => { await cleanupTestGyms(); await db.end(); });

describe('mark / discard (#3007 stage 2b)', () => {
  it('marks a running plan in an open Draft, and discarding the Draft restores it', async () => {
    const { umId } = await runningPlan();
    const res = await authed(request.post(`/user-memberships/${umId}/mark-cancel`));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('to_be_canceled');
    expect(await legacy(umId)).toBe('to_be_canceled');
    expect(await status(umId)).toBe('to_be_canceled');

    const discard = await authed(request.delete(`/product-sets/${res.body.product_set_id}`));
    expect(discard.status).toBeLessThan(300);
    expect(await legacy(umId)).toBe('active');
    expect(await status(umId)).toBe('active');
  });

  it('un-marks one plan, and refuses a plan that is not running', async () => {
    const { umId } = await runningPlan();
    await authed(request.post(`/user-memberships/${umId}/mark-cancel`));
    expect((await authed(request.post(`/user-memberships/${umId}/unmark-cancel`))).status).toBe(200);
    expect(await status(umId)).toBe('active');
    expect((await authed(request.post(`/user-memberships/${umId}/unmark-cancel`))).status).toBe(409);
    await db.query(`UPDATE plan_snapshots SET status = 'paused' WHERE gym_id = ? AND anchor_plan_snapshot_id = ?`, [gymId, umId]);
    await testAssignmentWrite(`UPDATE user_memberships SET status = 'paused' WHERE id = ?`, [umId]);
    expect((await authed(request.post(`/user-memberships/${umId}/mark-cancel`))).status).toBe(409);
  });

  it('requires an admin and the right gym', async () => {
    const { umId } = await runningPlan();
    expect((await request.post(`/user-memberships/${umId}/mark-cancel`)).status).toBe(401);
    const otherGym = await createTestGym('Other PC Gym');
    await createTestMembership(otherGym, 'admin');
    const res = await request.post(`/user-memberships/${umId}/mark-cancel`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', otherGym);
    expect(res.status).toBe(404);
  });
});

describe('commit (#3007 stage 2b)', () => {
  it('committing the Draft cancels the marked plan and charges nothing', async () => {
    const { memberId, umId } = await runningPlan();
    const mark = await authed(request.post(`/user-memberships/${umId}/mark-cancel`));
    const review = await authed(request.get(`/product-sets/${mark.body.product_set_id}/review`));
    expect(review.status).toBe(200);
    expect(review.body.plans_to_cancel).toEqual([expect.objectContaining({ user_membership_id: umId })]);

    const commit = await authed(request.post(`/product-sets/${mark.body.product_set_id}/activate`));
    expect(commit.status).toBeLessThan(300);
    expect(['cancelled', 'active_cancel_at_period_end']).toContain(await legacy(umId));
    expect(['cancelled', 'active_cancel_at_period_end']).toContain(await status(umId));
    const { rows: ev } = await db.query<any>(
      `SELECT COUNT(*) AS n FROM billing_events WHERE gym_id = ? AND member_id = ? AND is_scheduled = 1 AND billing_date > UTC_DATE()`,
      [gymId, memberId]);
    expect(Number(ev[0].n)).toBe(0);
  });
});
