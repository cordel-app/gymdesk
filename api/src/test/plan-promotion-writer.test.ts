// #3026 — a Membership Plan Promotion application is the plan snapshot's own row
// (`plan_promotion_snapshots`), written by `plan-promotion-writer.ts` and nothing else. Since stage
// 3d-1 no `user_membership_promotions` row is written for it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { confirmDraftPromotionSnapshots } from '../api/membership-promotions';
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

describe('Plan Promotion snapshot writer (#3026)', () => {
  const draft = async (label: string) => {
    const m = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, label, `ppw-${Date.now()}-${Math.random()}@test.com`]);
    const umId = await createTestDraftAssignment(gymId, Number(m.insertId), planId, { config: { base_price: 100 } });
    const res = await request.post(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send({ promotion_id: promoId });
    expect(res.status).toBe(201);
    const { rows: set } = await db.query<any>(
      `SELECT ps.id FROM product_sets ps WHERE ps.owner_member_id = ? AND ps.status = 'in_cart'`, [Number(m.insertId)]);
    return { umId, setId: Number(set[0].id) };
  };
  const rows = async (setId: number) => (await db.query<any>(
    `SELECT pps.id, pps.status, pps.source_id, pps.snapshot, pps.snapshot_confirmed_at FROM plan_promotion_snapshots pps
       JOIN product_set_plan_snapshots psj ON psj.plan_snapshot_id = pps.plan_snapshot_id
      WHERE psj.product_set_id = ? AND pps.promotion_id = ?`, [setId, promoId])).rows;

  it('applying writes one reference on the plan snapshot and no legacy row; removing it deletes it', async () => {
    const { umId, setId } = await draft('PPW Member');
    const applied = await rows(setId);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ status: 'applied', source_id: null, snapshot: null, snapshot_confirmed_at: null });
    const { rows: legacy } = await db.query<any>('SELECT id FROM user_membership_promotions WHERE product_set_id = ?', [setId]);
    expect(legacy).toHaveLength(0);

    // A second application of the same Promotion on the same plan is refused.
    const again = await request.post(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).send({ promotion_id: promoId });
    expect(again.status).toBe(409);
    expect(await rows(setId)).toHaveLength(1);

    const removed = await request.delete(`/user-memberships/${umId}/promotions/${promoId}`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(removed.status).toBeLessThan(300);
    expect(await rows(setId)).toHaveLength(0);
  });

  it('confirming freezes the snapshot and the grant rows from the Promotion as it stands, once', async () => {
    const prod = await db.query(
      `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status) VALUES (?, 'PPW Locker', 'other', 15, 'EUR', 'once', 'active')`, [gymId]);
    await db.query(
      `INSERT INTO promotion_oneoff (gym_id, promotion_id, product_id, quantity) VALUES (?, ?, ?, 2)`,
      [gymId, promoId, Number(prod.insertId)]);
    const { setId } = await draft('PPW Grants');
    const grants = async () => (await db.query<any>(
      `SELECT g.product_id, g.product_name, g.quantity, g.unit_price FROM plan_promotion_oneoff_product_snapshots g
         JOIN plan_promotion_snapshots pps ON pps.id = g.plan_promotion_snapshot_id
         JOIN product_set_plan_snapshots psj ON psj.plan_snapshot_id = pps.plan_snapshot_id
        WHERE psj.product_set_id = ?`, [setId])).rows;
    expect(await grants()).toHaveLength(0);

    await db.transaction((tx) => confirmDraftPromotionSnapshots(tx, gymId, setId));
    await db.transaction((tx) => confirmDraftPromotionSnapshots(tx, gymId, setId)); // a retry writes nothing more

    const confirmed = await rows(setId);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].snapshot_confirmed_at).not.toBeNull();
    expect(confirmed[0].snapshot).not.toBeNull();
    const frozen = await grants();
    expect(frozen).toHaveLength(1);
    expect(frozen[0]).toMatchObject({ product_id: Number(prod.insertId), product_name: 'PPW Locker', quantity: 2 });
    expect(Number(frozen[0].unit_price)).toBe(15);
  });

  it('migration 451 moves a legacy Plan row onto the plan snapshot and deletes it, leaving Product-target rows (#3026 stage 3d-2)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { retireLegacyPlanPromotionRows } = require('../infra/migrations/451_retire_legacy_plan_promotion_rows.js');
    const m = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'PPW Legacy', `ppw-l-${Date.now()}@test.com`]);
    await createTestDraftAssignment(gymId, Number(m.insertId), planId, { config: { base_price: 100 } });
    const { rows: set } = await db.query<any>(
      `SELECT ps.id FROM product_sets ps WHERE ps.owner_member_id = ? AND ps.status = 'in_cart'`, [Number(m.insertId)]);
    const setId = Number(set[0].id);
    const productPromo = await db.query(
      `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable, only_applicable_for_new_members, applies_to)
       VALUES (?, 'PPW Product', '2026-01-01', '2099-12-31', 'active', 1, 0, 'product')`, [gymId]);
    const legacyPlan = await db.query(
      `INSERT INTO user_membership_promotions (gym_id, product_set_id, promotion_id, status, snapshot, snapshot_confirmed_at)
       VALUES (?, ?, ?, 'applied', JSON_OBJECT('name', 'Legacy'), UTC_TIMESTAMP())`, [gymId, setId, promoId]);
    const legacyProduct = await db.query(
      `INSERT INTO user_membership_promotions (gym_id, product_set_id, promotion_id, status) VALUES (?, ?, ?, 'applied')`,
      [gymId, setId, Number(productPromo.insertId)]);

    await retireLegacyPlanPromotionRows({ raw: async (sql: string) => { const r = await db.query(sql); return [(r as any).rows?.length !== undefined && /^\s*SELECT/i.test(sql) ? r.rows : { affectedRows: r.rowCount }]; } });

    const moved = await rows(setId);
    expect(moved).toHaveLength(1);
    expect(Number(moved[0].source_id)).toBe(Number(legacyPlan.insertId));
    expect(moved[0].snapshot_confirmed_at).not.toBeNull();
    const { rows: left } = await db.query<any>('SELECT id FROM user_membership_promotions WHERE product_set_id = ? ORDER BY id', [setId]);
    expect(left.map((r: any) => Number(r.id))).toEqual([Number(legacyProduct.insertId)]);
  });
});
