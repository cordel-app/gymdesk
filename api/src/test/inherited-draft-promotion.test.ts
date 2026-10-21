// #1863 — a Plan Promotion applies only to a Membership Plan added in the Draft
// ProductSet, never to one a Draft inherited from the previous Active version.
// Integration: the rule is enforced by the API, so a request that bypasses the
// Admin cannot apply one to a running plan, and a refusal leaves nothing behind.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, activateTestAssignment, cleanupTestGyms, createTestDraftAssignment,
  createTestGym, createTestMembership, request,
} from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

let gymId: string;
let planId: number;
let promoId: number;
let secondPromoId: number;

async function createMember(name: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, name, `idp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`],
  );
  return Number(insertId);
}

async function createPromo(name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable,
                             only_applicable_for_new_members, paid_months)
     VALUES (?, ?, '2026-01-01', '2099-12-31', 'active', 1, 0, 12)`,
    [gymId, name],
  );
  await db.query(
    'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
    [gymId, insertId, planId],
  );
  await db.query(
    `INSERT INTO promotion_membership_fee_benefits (gym_id, promotion_id, duration_months, enabled, action, value)
     VALUES (?, ?, NULL, 1, 'percentage_discount', 10)`,
    [gymId, insertId],
  );
  return Number(insertId);
}

const apply = (umId: number, promotionId: number, gym = gymId) =>
  request
    .post(`/user-memberships/${umId}/promotions`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gym)
    .send({ promotion_id: promotionId });

beforeAll(async () => {
  gymId = await createTestGym('Inherited Draft Promo Gym');
  await createTestMembership(gymId, 'admin');
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, 'IDP Plan', 'active', 'staff_only')`,
    [gymId],
  );
  planId = Number(insertId);
  promoId = await createPromo('IDP Promo');
  secondPromoId = await createPromo('IDP Second Promo');
});

describe('Promotions only on a plan added in the Draft (#1863)', () => {
  it('applies a Promotion to a plan newly added in a Draft', async () => {
    const memberId = await createMember('IDP New');
    const umId = await createTestDraftAssignment(gymId, memberId, planId, { config: { base_price: 100 } });

    const res = await apply(umId, promoId);
    expect(res.status).toBe(201);
  });

  it('refuses a Promotion on a running plan, through the API, and changes nothing', async () => {
    const memberId = await createMember('IDP Active');
    const umId = await createTestDraftAssignment(gymId, memberId, planId, { config: { base_price: 100 } });
    expect((await apply(umId, promoId)).status).toBe(201);
    await activateTestAssignment(gymId, umId);

    const versionsBefore = await db.query<any>(
      'SELECT id, status FROM product_sets WHERE owner_member_id = ? ORDER BY id', [memberId]);

    const res = await apply(umId, secondPromoId);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/inherited/i);

    // The edit is one transaction: no Draft version is left behind and the
    // Active version keeps exactly the one application it was committed with.
    const versionsAfter = await db.query<any>(
      'SELECT id, status FROM product_sets WHERE owner_member_id = ? ORDER BY id', [memberId]);
    expect(versionsAfter.rows).toEqual(versionsBefore.rows);
    const { rows: apps } = await db.query<any>(
      `SELECT ump.promotion_id FROM user_membership_promotions ump
         JOIN product_sets ps ON ps.id = ump.product_set_id
        WHERE ps.owner_member_id = ? AND ps.status = 'active'`,
      [memberId],
    );
    expect(apps.map((a: any) => Number(a.promotion_id))).toEqual([promoId]);
  });

  it('keeps the Promotion applied while it was a Draft once the plan is running', async () => {
    const memberId = await createMember('IDP Kept');
    const umId = await createTestDraftAssignment(gymId, memberId, planId, { config: { base_price: 100 } });
    expect((await apply(umId, promoId)).status).toBe(201);
    await activateTestAssignment(gymId, umId);

    const res = await request
      .get(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.map((p: any) => Number(p.promotion_id))).toEqual([promoId]);
  });

  it('does not offer a spent application for re-applying on a running plan', async () => {
    const memberId = await createMember('IDP Reapply');
    const umId = await createTestDraftAssignment(gymId, memberId, planId, { config: { base_price: 100 } });
    expect((await apply(umId, promoId)).status).toBe(201);
    const revoked = await request
      .delete(`/user-memberships/${umId}/promotions/${promoId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(revoked.status).toBeLessThan(300);

    const onDraft = await request
      .get(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(onDraft.body[0].can_reapply).toBe(true);

    await activateTestAssignment(gymId, umId);
    const onActive = await request
      .get(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(onActive.body[0].can_reapply).toBe(false);
    expect((await apply(umId, promoId)).status).toBe(409);
  });
});
