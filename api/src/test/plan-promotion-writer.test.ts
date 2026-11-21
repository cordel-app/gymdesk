// #3026 stage 3a — a Plan Promotion application is written onto the plan snapshot by the writer
// itself (apply / revoke / confirm), not only derived later by syncPlanSnapshot(). The row is the
// same one the derivation would write (keyed by the legacy application id), so the two never duplicate.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { recordPlanPromotionApplied, recordPlanPromotionGrants, recordPlanPromotionRevoked } from '../api/plan-promotion-writer';
import { syncPlanSnapshot } from '../api/plan-snapshot-sync';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

let gymId: string;
let planId: number;
let promoId: number;

beforeAll(async () => {
  gymId = await createTestGym('Plan Promo Writer Gym');
  await createTestMembership(gymId, 'admin');
  const plan = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, 'PPW Plan', 'active', 'staff_only')`, [gymId]);
  planId = Number(plan.insertId);
  const promo = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable,
                             only_applicable_for_new_members, paid_months)
     VALUES (?, 'PPW A', '2026-01-01', '2099-12-31', 'active', 1, 0, 12)`, [gymId]);
  promoId = Number(promo.insertId);
  await db.query('INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)', [gymId, promoId, planId]);
  await db.query(
    `INSERT INTO promotion_membership_fee_benefits (gym_id, promotion_id, duration_months, enabled, action, value)
     VALUES (?, ?, NULL, 1, 'percentage_discount', 10)`, [gymId, promoId]);
});

describe('Plan Promotion snapshot writer (#3026 stage 3a)', () => {
  it('apply and revoke write the plan snapshot row; the later derivation adds no duplicate', async () => {
    const m = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'PPW Member', `ppw-${Date.now()}@test.com`]);
    const umId = await createTestDraftAssignment(gymId, Number(m.insertId), planId, { config: { base_price: 100 } });

    const res = await request.post(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send({ promotion_id: promoId });
    expect(res.status).toBe(201);

    const { rows: set } = await db.query<any>(
      `SELECT ps.id FROM product_sets ps WHERE ps.owner_member_id = ? AND ps.status = 'in_cart'`, [Number(m.insertId)]);
    const setId = Number(set[0].id);
    const rows = async () => (await db.query<any>(
      `SELECT pps.status, pps.source_id FROM plan_promotion_snapshots pps
         JOIN product_set_plan_snapshots psj ON psj.plan_snapshot_id = pps.plan_snapshot_id
        WHERE psj.product_set_id = ? AND pps.promotion_id = ?`, [setId, promoId])).rows;

    expect(await rows()).toHaveLength(1);
    // The writer is idempotent on the application id and the derivation lands on the same row.
    await db.transaction(async (tx) => {
      const { rows: ump } = await tx.query<any>('SELECT id FROM user_membership_promotions WHERE product_set_id = ?', [setId]);
      await recordPlanPromotionApplied(tx, gymId, setId, { id: Number(ump[0].id), promotionId: promoId, actor: 'Test' });
      await syncPlanSnapshot(tx, gymId, setId);
    });
    expect(await rows()).toHaveLength(1);

    await db.transaction(async (tx) => { await recordPlanPromotionRevoked(tx, gymId, setId, promoId, 'Test'); });
    expect((await rows())[0].status).toBe('revoked');
  });

  it('confirming writes the grant rows under the plan promotion snapshot, once, keyed by the legacy grant id (#3026 stage 3c-1)', async () => {
    const m = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'PPW Grants', `ppw-g-${Date.now()}@test.com`]);
    const umId = await createTestDraftAssignment(gymId, Number(m.insertId), planId, { config: { base_price: 100 } });
    const res = await request.post(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send({ promotion_id: promoId });
    expect(res.status).toBe(201);
    const { rows: set } = await db.query<any>(
      `SELECT ps.id FROM product_sets ps WHERE ps.owner_member_id = ? AND ps.status = 'in_cart'`, [Number(m.insertId)]);
    const setId = Number(set[0].id);
    const prod = await db.query(
      `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status) VALUES (?, 'PPW Locker', 'other', 15, 'EUR', 'month', 'active')`, [gymId]);

    const grants = async () => (await db.query<any>(
      `SELECT g.source_id, g.product_id, g.quantity FROM plan_promotion_oneoff_product_snapshots g
         JOIN plan_promotion_snapshots pps ON pps.id = g.plan_promotion_snapshot_id
         JOIN product_set_plan_snapshots psj ON psj.plan_snapshot_id = pps.plan_snapshot_id
        WHERE psj.product_set_id = ?`, [setId])).rows;
    expect(await grants()).toHaveLength(0);

    let legacyId = 0;
    await db.transaction(async (tx) => {
      const { rows: ump } = await tx.query<any>('SELECT id FROM user_membership_promotions WHERE product_set_id = ?', [setId]);
      const ins = await tx.query(
        `INSERT INTO user_membership_promotion_oneoff_snapshot
           (gym_id, user_membership_promotion_id, product_id, product_name, quantity, item_type, unit_price, currency)
         VALUES (?, ?, ?, 'PPW Locker', 2, 'other', 15, 'EUR')`, [gymId, Number(ump[0].id), Number(prod.insertId)]);
      legacyId = Number(ins.insertId);
      await recordPlanPromotionGrants(tx, gymId, Number(ump[0].id));
      await recordPlanPromotionGrants(tx, gymId, Number(ump[0].id)); // idempotent
      await syncPlanSnapshot(tx, gymId, setId); // the derivation lands on the same row
    });
    const rows = await grants();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].source_id)).toBe(legacyId);
    expect(Number(rows[0].quantity)).toBe(2);
  });
});
