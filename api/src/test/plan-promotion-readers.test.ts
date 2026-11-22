// #3026 stage 3c-2 — the remaining readers of a Membership Plan Promotion application (the Assigned
// Plan card, the Membership Fee, Save & Pay's eligibility check) read the assignment's current plan
// snapshot's own `plan_promotion_snapshots` rows. The legacy `user_membership_promotions` row is
// no longer what decides what they report, and the row states its own confirmation.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, activateTestAssignment, cleanupTestGyms, createTestDraftAssignment, createTestGym,
  createTestMembership, request,
} from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

let gymId: string;
let planId: number;
let promoId: number;
let seq = 0;

async function draftWithPromotion(): Promise<{ umId: number; memberId: number }> {
  seq += 1;
  const m = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, `PPR Member ${seq}`, `ppr-${Date.now()}-${seq}@test.com`]);
  const memberId = Number(m.insertId);
  const umId = await createTestDraftAssignment(gymId, memberId, planId, { config: { base_price: 100 } });
  const res = await request.post(`/user-memberships/${umId}/promotions`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send({ promotion_id: promoId });
  expect(res.status).toBe(201);
  return { umId, memberId };
}

const detail = (umId: number) => request.get(`/user-memberships/${umId}`)
  .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

const snapshotRows = async (umId: number) => (await db.query<any>(
  `SELECT pps.id, pps.status, pps.snapshot_confirmed_at, pps.snapshot
     FROM plan_promotion_snapshots pps
     JOIN plan_snapshots s ON s.id = pps.plan_snapshot_id
    WHERE s.source_user_membership_id = ? AND pps.promotion_id = ?`, [umId, promoId])).rows;

beforeAll(async () => {
  gymId = await createTestGym('Plan Promo Readers Gym');
  await createTestMembership(gymId, 'admin');
  const plan = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, 'PPR Plan', 'active', 'staff_only')`, [gymId]);
  planId = Number(plan.insertId);
  const promo = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable,
                             only_applicable_for_new_members, paid_months)
     VALUES (?, 'PPR Promo', '2026-01-01', '2099-12-31', 'active', 1, 0, 12)`, [gymId]);
  promoId = Number(promo.insertId);
  await db.query('INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)', [gymId, promoId, planId]);
  await db.query(
    `INSERT INTO promotion_membership_fee_benefits (gym_id, promotion_id, duration_months, enabled, action, value)
     VALUES (?, ?, NULL, 1, 'percentage_discount', 10)`, [gymId, promoId]);
});

describe('Plan Promotion readers on the plan snapshot (#3026 stage 3c-2)', () => {
  it('the card and the fee report the plan snapshot row', async () => {
    const { umId } = await draftWithPromotion();
    const rows = await snapshotRows(umId);
    expect(rows).toHaveLength(1);

    const res = await detail(umId);
    expect(res.status).toBe(200);
    const applied = res.body.promotions.filter((p: any) => p.promotion_id === promoId);
    expect(applied).toHaveLength(1);
    expect(applied[0].id).toBe(Number(rows[0].id));
    expect(applied[0].status).toBe('applied');
    expect(Number(res.body.membership_fee)).toBe(90);
  });

  it('a Draft application is a reference until confirmed, and the row states its own confirmation', async () => {
    const { umId } = await draftWithPromotion();
    const before = await snapshotRows(umId);
    expect(before[0].snapshot_confirmed_at).toBeNull();
    expect(before[0].snapshot).toBeNull();

    await activateTestAssignment(gymId, umId);

    const after = await snapshotRows(umId);
    const standing = after.filter((r: any) => r.status === 'applied');
    expect(standing.length).toBeGreaterThan(0);
    for (const r of standing) {
      expect(r.snapshot_confirmed_at).not.toBeNull();
      expect(r.snapshot).not.toBeNull();
    }
    // The agreed benefit is the snapshot's: editing the Promotion afterwards moves nothing.
    await db.query('UPDATE promotion_membership_fee_benefits SET value = 50 WHERE gym_id = ? AND promotion_id = ?', [gymId, promoId]);
    const res = await detail(umId);
    expect(Number(res.body.membership_fee)).toBe(90);
    await db.query('UPDATE promotion_membership_fee_benefits SET value = 10 WHERE gym_id = ? AND promotion_id = ?', [gymId, promoId]);
  });

  it('Save & Pay refuses a Draft whose standing snapshot application names a Promotion no longer active', async () => {
    const { umId } = await draftWithPromotion();
    await db.query(`UPDATE promotions SET lifecycle_status = 'inactive' WHERE id = ?`, [promoId]);
    try {
      const res = await request.post(`/user-memberships/${umId}/save-and-pay`)
        .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send({});
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    } finally {
      await db.query(`UPDATE promotions SET lifecycle_status = 'active' WHERE id = ?`, [promoId]);
    }
  });

  it('revoking on a running plan revokes the copy made with the plan snapshot, with no derivation (#3026 stage 3c-3)', async () => {
    const { umId, memberId } = await draftWithPromotion();
    await activateTestAssignment(gymId, umId);
    expect(Number((await detail(umId)).body.membership_fee)).toBe(90);

    const res = await request.delete(`/user-memberships/${umId}/promotions/${promoId}`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(res.status).toBeLessThan(300);

    // The owner's running assignment (the same one, or its successor) no longer carries it.
    const { rows: live } = await db.query<any>(
      `SELECT id FROM user_memberships WHERE gym_id = ? AND member_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`,
      [gymId, memberId]);
    const after = await detail(Number(live[0].id));
    expect(Number(after.body.membership_fee)).toBe(100);
    const standing = after.body.promotions.filter((p: any) => p.promotion_id === promoId && p.status === 'applied');
    expect(standing).toHaveLength(0);
    expect(after.body.promotions.some((p: any) => p.promotion_id === promoId && p.status === 'revoked')).toBe(true);
  });
});
