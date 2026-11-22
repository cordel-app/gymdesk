// #3114 — a plan cancelling at its period end is marked `to_be_reactivated` in the owner's open In Cart,
// restored when the cart is discarded, and reactivated (billed, audited) only when the cart is committed.
// A plan marked `to_be_canceled` just has its cancellation undone.

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
     VALUES (?, ?, 'active', 'public', 1, 'specific_centers', NULL, NULL, 0, 0)`, [gymId, `RA Plan ${uniq()}`]);
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
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'RA Member', `ra-${uniq()}@test.com`]);
  const umId = await createTestDraftAssignment(gymId, memberId, await planId(), { config: { membership_fee_price: 10 } });
  const act = await authed(request.post(`/user-memberships/${umId}/activate`)).send({ on_conflict: 'add' });
  if (act.status >= 300) throw new Error(`activate ${act.status} ${JSON.stringify(act.body)}`);
  const del = await authed(request.delete(`/user-memberships/${umId}`));
  if (del.status !== 204) throw new Error(`cancel ${del.status}`);
  return { memberId, umId };
}

const snap = async (umId: number) => (await db.query<any>(
  `SELECT status, DATE_FORMAT(ends_at, '%Y-%m-%d') AS ends_at, DATE_FORMAT(previous_end_date, '%Y-%m-%d') AS previous_end_date,
          closed_at FROM plan_snapshots WHERE gym_id = ? AND source_user_membership_id = ? ORDER BY id DESC LIMIT 1`,
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
  gymId = await createTestGym('Pending Reactivate Gym');
  await createTestMembership(gymId, 'admin');
  const { insertId } = await db.query('INSERT INTO centers (gym_id, name, status) VALUES (?, ?, ?)', [gymId, 'RA Center', 'active']);
  centerId = insertId as number;
});
afterAll(async () => { await cleanupTestGyms(); await db.end(); });

describe('mark / discard (#3114)', () => {
  it('marks a cancelling plan without changing it, and discarding the cart restores it', async () => {
    const { memberId, umId } = await cancellingPlan();
    const before = await snap(umId);
    const eventsBefore = await allEvents(memberId);
    const auditsBefore = await statusAudits(umId);

    const res = await authed(request.post(`/user-memberships/${umId}/mark-reactivate`));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('to_be_reactivated');
    expect((await snap(umId)).status).toBe('to_be_reactivated');
    expect((await legacy(umId)).status).toBe('to_be_reactivated');
    expect((await snap(umId)).ends_at).toBe(before.ends_at);
    expect((await snap(umId)).previous_end_date).toBe(before.ends_at);
    expect(await allEvents(memberId)).toBe(eventsBefore);
    expect(await statusAudits(umId)).toBe(auditsBefore);

    const discard = await authed(request.delete(`/product-sets/${res.body.product_set_id}`));
    expect(discard.status).toBeLessThan(300);
    expect((await snap(umId)).status).toBe('active_cancel_at_period_end');
    expect((await legacy(umId)).status).toBe('active_cancel_at_period_end');
    expect((await snap(umId)).ends_at).toBe(before.ends_at);
    expect((await legacy(umId)).ends_at).toBe(before.ends_at);
    expect((await snap(umId)).previous_end_date).toBeNull();
    expect(await allEvents(memberId)).toBe(eventsBefore);
    expect(await statusAudits(umId)).toBe(auditsBefore);
  });

  it('un-marks one plan, and refuses a plan that is not cancelling at its period end', async () => {
    const { umId } = await cancellingPlan();
    await authed(request.post(`/user-memberships/${umId}/mark-reactivate`));
    expect((await authed(request.post(`/user-memberships/${umId}/unmark-reactivate`))).status).toBe(200);
    expect((await snap(umId)).status).toBe('active_cancel_at_period_end');
    expect((await authed(request.post(`/user-memberships/${umId}/unmark-reactivate`))).status).toBe(409);
    await db.query(`UPDATE plan_snapshots SET status = 'cancelled' WHERE gym_id = ? AND source_user_membership_id = ?`, [gymId, umId]);
    await db.query(`UPDATE user_memberships SET status = 'cancelled' WHERE id = ?`, [umId]);
    expect((await authed(request.post(`/user-memberships/${umId}/mark-reactivate`))).status).toBe(409);
  });

  it('requires an admin and the right gym', async () => {
    const { umId } = await cancellingPlan();
    expect((await request.post(`/user-memberships/${umId}/mark-reactivate`)).status).toBe(401);
    const otherGym = await createTestGym('Other RA Gym');
    await createTestMembership(otherGym, 'admin');
    const res = await request.post(`/user-memberships/${umId}/mark-reactivate`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', otherGym);
    expect(res.status).toBe(404);
  });
});

describe('commit (#3114)', () => {
  it('committing the cart reactivates the same plan, bills it from its schedule and audits it once', async () => {
    const { memberId, umId } = await cancellingPlan();
    expect(await futureScheduled(memberId)).toBe(0);
    const mark = await authed(request.post(`/user-memberships/${umId}/mark-reactivate`));
    const review = await authed(request.get(`/product-sets/${mark.body.product_set_id}/review`));
    expect(review.status).toBe(200);
    expect(review.body.plans_to_reactivate).toEqual([expect.objectContaining({ user_membership_id: umId })]);
    expect(review.body.plans_to_cancel).toEqual([]);
    const auditsBefore = await statusAudits(umId);
    const initialBefore = Number((await db.query<any>(
      'SELECT COUNT(*) AS n FROM billing_events WHERE gym_id = ? AND member_id = ? AND is_scheduled = 0', [gymId, memberId])).rows[0].n);

    const commit = await authed(request.post(`/product-sets/${mark.body.product_set_id}/activate`));
    expect(commit.status).toBeLessThan(300);

    expect(await legacy(umId)).toEqual(expect.objectContaining({ status: 'active', ends_at: null, closed_at: null }));
    expect(await snap(umId)).toEqual(expect.objectContaining({ status: 'active', ends_at: null, closed_at: null, previous_end_date: null }));
    // The same assignment: no second one was created.
    const { rows: ums } = await db.query<any>(`SELECT COUNT(*) AS n FROM ${TEST_ASSIGNMENTS} um WHERE gym_id = ? AND member_id = ?`, [gymId, memberId]);
    expect(Number(ums[0].n)).toBe(1);
    expect(await statusAudits(umId)).toBe(auditsBefore + 1);
    // Its scheduled obligations are back: the two cycles the engine keeps scheduled.
    expect(await futureScheduled(memberId)).toBe(2);
    // No extra initial charge for the period already paid.
    const { rows: initial } = await db.query<any>(
      `SELECT COUNT(*) AS n FROM billing_events WHERE gym_id = ? AND member_id = ? AND is_scheduled = 0`, [gymId, memberId]);
    expect(Number(initial[0].n)).toBe(initialBefore);
  });

  it('a retried activation does not duplicate the Billing Events or the audit row', async () => {
    const { memberId, umId } = await cancellingPlan();
    const mark = await authed(request.post(`/user-memberships/${umId}/mark-reactivate`));
    await authed(request.post(`/product-sets/${mark.body.product_set_id}/activate`));
    const events = await allEvents(memberId);
    const audits = await statusAudits(umId);
    await authed(request.post(`/product-sets/${mark.body.product_set_id}/activate`));
    expect(await allEvents(memberId)).toBe(events);
    expect(await statusAudits(umId)).toBe(audits);
  });
});

describe('a plan with a cancellation pending (#3114)', () => {
  it('has the cancellation undone: active again, original end date, no billing and no reactivation audit', async () => {
    const { rows: m } = await db.query<any>('SELECT 1');
    void m;
    const { insertId: memberId } = await db.query(
      'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'RA Pending Member', `rp-${uniq()}@test.com`]);
    const umId = await createTestDraftAssignment(gymId, memberId, await planId());
    await authed(request.post(`/user-memberships/${umId}/activate`)).send({ on_conflict: 'add' });
    const cancel = await authed(request.post(`/user-memberships/${umId}/mark-cancel`));
    expect(cancel.body.status).toBe('to_be_canceled');
    const events = await allEvents(memberId);
    const audits = await statusAudits(umId);

    const res = await authed(request.post(`/user-memberships/${umId}/mark-reactivate`));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect((await snap(umId)).status).toBe('active');
    expect((await legacy(umId)).status).toBe('active');
    expect((await snap(umId)).previous_end_date).toBeNull();
    expect(await allEvents(memberId)).toBe(events);
    expect(await statusAudits(umId)).toBe(audits);
    const { rows: reactivation } = await db.query<any>(
      `SELECT COUNT(*) AS n FROM audit_logs WHERE gym_id = ? AND entity_id = ? AND action IN ('reactivate','mark_reactivate')`, [gymId, String(umId)]);
    expect(Number(reactivation[0].n)).toBe(0);
  });
});
