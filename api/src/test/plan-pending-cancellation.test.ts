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

// #3302 — while the Draft is open, the marked plan reads `to_be_canceled` with the end date the commit
// will give it (the one `cancellationEndDate()` rule), on the Member's plan list and in the Summary.
describe('pending cancellation preview (#3302)', () => {
  const configPlan = async (memberId: number, umId: number) => {
    const res = await authed(request.get(`/user-memberships/member/${memberId}/configuration`));
    expect(res.status).toBe(200);
    return res.body.plans.find((p: any) => p.id === umId);
  };

  it('shows To Be Canceled with the committed end date, and restores the plan on discard', async () => {
    const { memberId, umId } = await runningPlan();
    expect((await configPlan(memberId, umId)).lifecycle_status).toBe('active');
    const mark = await authed(request.post(`/user-memberships/${umId}/mark-cancel`));
    const setId = mark.body.product_set_id;

    const plan = await configPlan(memberId, umId);
    expect(plan.lifecycle_status).toBe('to_be_canceled');
    expect(plan.ends_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const review = await authed(request.get(`/product-sets/${setId}/review`));
    const item = review.body.contracted_items.find((i: any) => i.kind === 'plan');
    expect(item.pending_deletion).toEqual({ ends_on: plan.ends_at });

    await authed(request.delete(`/product-sets/${setId}`));
    const restored = await configPlan(memberId, umId);
    expect(restored.lifecycle_status).toBe('active');
    expect(restored.ends_at).toBeNull();
  });

  it('Save commits the end date the Draft previewed', async () => {
    const { memberId, umId } = await runningPlan();
    const mark = await authed(request.post(`/user-memberships/${umId}/mark-cancel`));
    const previewed = (await configPlan(memberId, umId)).ends_at;
    expect((await authed(request.post(`/product-sets/${mark.body.product_set_id}/activate`))).status).toBeLessThan(300);
    const { rows } = await db.query<any>(
      `SELECT DATE_FORMAT(ends_at, '%Y-%m-%d') AS ends_at FROM ${TEST_ASSIGNMENTS} um WHERE id = ?`, [umId]);
    expect(rows[0].ends_at).toBe(previewed);
    expect((await configPlan(memberId, umId)).ends_at).toBe(previewed);
  });
});
