// #3358 stage 1 — Cancel Immediately: a plan cancelling at its period end is marked `to_be_canceled_immediately`
// (End Date today) in the owner's open In Cart, restored with its previous End Date when the cart is discarded
// or expires, and cancelled (audited once) only when the cart is committed.

import { TEST_ASSIGNMENTS } from './assignmentReads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';

let gymId: string;
let centerId: number;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const authed = (req: any) => req.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function planId(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit, center_access_mode,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', 1, 'specific_centers', NULL, NULL, 0, 0)`, [gymId, `CI Plan ${uniq()}`]);
  await db.query('INSERT INTO membership_plan_centers (gym_id, membership_plan_id, center_id) VALUES (?, ?, ?)', [gymId, insertId, centerId]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 10, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return insertId as number;
}

/** A running plan (started today, so paid through today), then cancelled: `active_cancel_at_period_end`. */
async function cancellingPlan(): Promise<{ memberId: number; umId: number }> {
  const { insertId: memberId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'CI Member', `ci-${uniq()}@test.com`]);
  const umId = await createTestDraftAssignment(gymId, memberId, await planId(), { config: { membership_fee_price: 10 } });
  const act = await authed(request.post(`/user-memberships/${umId}/activate`)).send({ on_conflict: 'add' });
  if (act.status >= 300) throw new Error(`activate ${act.status} ${JSON.stringify(act.body)}`);
  const del = await authed(request.delete(`/user-memberships/${umId}`));
  if (del.status !== 204) throw new Error(`cancel ${del.status}`);
  return { memberId, umId };
}

const snap = async (umId: number) => (await db.query<any>(
  `SELECT status, DATE_FORMAT(ends_at, '%Y-%m-%d') AS ends_at, DATE_FORMAT(previous_end_date, '%Y-%m-%d') AS previous_end_date,
          closed_at FROM plan_snapshots WHERE gym_id = ? AND anchor_plan_snapshot_id = ? ORDER BY id DESC LIMIT 1`,
  [gymId, umId])).rows[0];
const legacy = async (umId: number) => (await db.query<any>(
  `SELECT status, DATE_FORMAT(ends_at, '%Y-%m-%d') AS ends_at, closed_at FROM ${TEST_ASSIGNMENTS} um WHERE id = ?`, [umId])).rows[0];
const statusAudits = async (umId: number) => Number((await db.query<any>(
  `SELECT COUNT(*) AS n FROM audit_logs WHERE gym_id = ? AND entity_type = 'user_membership' AND entity_id = ? AND action = 'status_change'`,
  [gymId, String(umId)])).rows[0].n);
const futureScheduled = async (memberId: number) => (await db.query<any>(
  `SELECT COUNT(*) AS n FROM billing_events WHERE gym_id = ? AND member_id = ? AND is_scheduled = 1 AND billing_date > UTC_DATE()`,
  [gymId, memberId])).rows[0].n as number;
const allEvents = async (memberId: number) => Number((await db.query<any>(
  'SELECT COUNT(*) AS n FROM billing_events WHERE gym_id = ? AND member_id = ?', [gymId, memberId])).rows[0].n);

beforeAll(async () => {
  gymId = await createTestGym('Pending Immediate Cancel Gym');
  await createTestMembership(gymId, 'admin');
  const { insertId } = await db.query('INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)', [gymId, 'CI Center', 'active']);
  centerId = insertId as number;
});
afterAll(async () => { await cleanupTestGyms(); await db.end(); });

const today = () => new Date().toISOString().slice(0, 10);
const entitled = async (umId: number) => Number((await db.query<any>(
  `SELECT COUNT(*) AS n FROM plan_snapshots WHERE gym_id = ? AND anchor_plan_snapshot_id = ?
      AND (status IN ('active', 'to_be_canceled')
           OR (status IN ('active_cancel_at_period_end', 'to_be_reactivated', 'to_be_canceled_immediately') AND ends_at >= UTC_DATE()))`,
  [gymId, umId])).rows[0].n) > 0;

describe('mark / discard (#3358)', () => {
  it('marks a cancelling plan with End Date today, keeps it entitled, and discarding the cart restores it', async () => {
    const { memberId, umId } = await cancellingPlan();
    const before = await snap(umId);
    const eventsBefore = await allEvents(memberId);
    const auditsBefore = await statusAudits(umId);

    const res = await authed(request.post(`/user-memberships/${umId}/mark-cancel-immediately`));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('to_be_canceled_immediately');
    expect(await snap(umId)).toEqual(expect.objectContaining({
      status: 'to_be_canceled_immediately', ends_at: today(), previous_end_date: before.ends_at,
    }));
    expect(await legacy(umId)).toEqual(expect.objectContaining({ status: 'to_be_canceled_immediately', ends_at: today() }));
    expect(await entitled(umId)).toBe(true);
    expect(await allEvents(memberId)).toBe(eventsBefore);
    expect(await statusAudits(umId)).toBe(auditsBefore);

    // The Member card lists it with its own status.
    const conf = await authed(request.get(`/user-memberships/member/${memberId}/configuration`));
    expect(conf.status).toBe(200);
    expect(conf.body.plans.find((p: any) => p.id === umId)).toEqual(expect.objectContaining({
      status: 'to_be_canceled_immediately', is_current: true,
    }));

    const discard = await authed(request.delete(`/product-sets/${res.body.product_set_id}`));
    expect(discard.status).toBeLessThan(300);
    expect(await snap(umId)).toEqual(expect.objectContaining({
      status: 'active_cancel_at_period_end', ends_at: before.ends_at, previous_end_date: null,
    }));
    expect(await legacy(umId)).toEqual(expect.objectContaining({ status: 'active_cancel_at_period_end', ends_at: before.ends_at }));
    expect(await allEvents(memberId)).toBe(eventsBefore);
    expect(await statusAudits(umId)).toBe(auditsBefore);
  });

  it('un-marks one plan, and refuses a plan that is not cancelling at its period end', async () => {
    const { umId } = await cancellingPlan();
    const before = await snap(umId);
    expect((await authed(request.post(`/user-memberships/${umId}/mark-cancel-immediately`))).status).toBe(200);
    expect((await authed(request.post(`/user-memberships/${umId}/unmark-cancel-immediately`))).status).toBe(200);
    expect(await snap(umId)).toEqual(expect.objectContaining({ status: 'active_cancel_at_period_end', ends_at: before.ends_at }));
    expect((await authed(request.post(`/user-memberships/${umId}/unmark-cancel-immediately`))).status).toBe(409);

    // A running plan has no scheduled cancellation to bring forward.
    const { insertId: memberId } = await db.query(
      'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'CI Running', `cir-${uniq()}@test.com`]);
    const running = await createTestDraftAssignment(gymId, memberId, await planId());
    await authed(request.post(`/user-memberships/${running}/activate`)).send({ on_conflict: 'add' });
    const refused = await authed(request.post(`/user-memberships/${running}/mark-cancel-immediately`));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('not_cancelling');
  });

  it('requires an admin and the right gym', async () => {
    const { umId } = await cancellingPlan();
    expect((await request.post(`/user-memberships/${umId}/mark-cancel-immediately`)).status).toBe(401);
    const otherGym = await createTestGym('Other CI Gym');
    await createTestMembership(otherGym, 'admin');
    const res = await request.post(`/user-memberships/${umId}/mark-cancel-immediately`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', otherGym);
    expect(res.status).toBe(404);
    expect((await snap(umId)).status).toBe('active_cancel_at_period_end');
  });
});

describe('commit (#3358)', () => {
  it('committing the cart cancels the plan today, audits it once, charges nothing and is idempotent', async () => {
    const { memberId, umId } = await cancellingPlan();
    const mark = await authed(request.post(`/user-memberships/${umId}/mark-cancel-immediately`));
    const setId = mark.body.product_set_id;
    const review = await authed(request.get(`/product-sets/${setId}/review`));
    expect(review.status).toBe(200);
    expect(review.body.plans_to_cancel_immediately).toEqual([expect.objectContaining({ user_membership_id: umId })]);
    expect(review.body.amount_due).toBe(0);
    const auditsBefore = await statusAudits(umId);
    const eventsBefore = await allEvents(memberId);

    const commit = await authed(request.post(`/product-sets/${setId}/activate`));
    expect(commit.status).toBeLessThan(300);

    const after = await snap(umId);
    expect(after).toEqual(expect.objectContaining({ status: 'cancelled', ends_at: today(), previous_end_date: null }));
    expect(after.closed_at).not.toBeNull();
    expect(await legacy(umId)).toEqual(expect.objectContaining({ status: 'cancelled', ends_at: today() }));
    expect(await statusAudits(umId)).toBe(auditsBefore + 1);
    expect(await futureScheduled(memberId)).toBe(0);
    expect(await allEvents(memberId)).toBe(eventsBefore);
    // The activated set no longer carries the plan, not even for entitlement.
    const { rows: links } = await db.query<any>(
      `SELECT COUNT(*) AS n FROM product_set_plan_snapshots j JOIN plan_snapshots s ON s.id = j.plan_snapshot_id
        WHERE j.product_set_id = ? AND s.anchor_plan_snapshot_id = ?`, [setId, umId]);
    expect(Number(links[0].n)).toBe(0);

    await authed(request.post(`/product-sets/${setId}/activate`));
    expect(await statusAudits(umId)).toBe(auditsBefore + 1);
    expect((await snap(umId)).status).toBe('cancelled');
  });
});
