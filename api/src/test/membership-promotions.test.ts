// Tests for membership-promotions.ts (apply/revoke promotions on a
// user_membership) — in particular that `computeFinalPrice` correctly applies
// `promotion_charge_benefits` for the 'membership_fee' charge type, including
// the `fixed_price` action added in #487 stage 2 (previously unimplemented).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getChargeTypeId(code: string): Promise<number> {
  const { rows } = await db.query<{ id: number }>('SELECT id FROM charge_types WHERE code = ?', [code]);
  return rows[0].id;
}

async function createGymCharge(gymId: string, chargeTypeId: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO gym_charges (gym_id, charge_type_id, amount, currency, billing_frequency, availability)
     VALUES (?, ?, 0, 'EUR', 'month', 'available')`,
    [gymId, chargeTypeId],
  );
  return insertId;
}

async function createPlan(gymId: string, name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status) VALUES (?, ?, 'active', 'staff_only')`,
    [gymId, name],
  );
  return insertId;
}

async function createMember(gymId: string, name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)`,
    [gymId, name, `mp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`],
  );
  return insertId;
}

async function createUserMembership(gymId: string, memberId: number, planId: number, basePrice: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, base_price, final_price)
     VALUES (?, ?, ?, 'active', CURDATE(), ?, ?)`,
    [gymId, memberId, planId, basePrice, basePrice],
  );
  return insertId;
}

async function createPromo(gymId: string, name: string, stackable = false): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable)
     VALUES (?, ?, '2026-01-01', '2099-12-31', 'active', ?)`,
    [gymId, name, stackable ? 1 : 0],
  );
  return insertId;
}

async function targetPlan(gymId: string, promoId: number, planId: number) {
  await db.query(
    'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
    [gymId, promoId, planId],
  );
}

async function setChargeBenefit(gymId: string, promoId: number, gymChargeId: number, action: string, value: number | null) {
  await db.query(
    'INSERT INTO promotion_charge_benefits (gym_id, promotion_id, gym_charge_id, action, value) VALUES (?, ?, ?, ?, ?)',
    [gymId, promoId, gymChargeId, action, value],
  );
}

// ─── Charge benefit actions applied to real billing ───────────────────────────

describe('POST /user-memberships/:id/promotions — charge benefit calc', () => {
  let gymId: string;
  let membershipFeeGymChargeId: number;

  beforeAll(async () => {
    gymId = await createTestGym('MP Gym');
    await createTestMembership(gymId, 'admin');
    const membershipFeeTypeId = await getChargeTypeId('membership_fee');
    membershipFeeGymChargeId = await createGymCharge(gymId, membershipFeeTypeId);
  });

  async function applyAndGetFinalPrice(action: string, value: number | null, basePrice = 100) {
    const planId = await createPlan(gymId, `Plan-${action}-${Date.now()}`);
    const memberId = await createMember(gymId, `Member-${action}`);
    const umId = await createUserMembership(gymId, memberId, planId, basePrice);
    const promoId = await createPromo(gymId, `Promo-${action}-${Date.now()}`);
    await targetPlan(gymId, promoId, planId);
    await setChargeBenefit(gymId, promoId, membershipFeeGymChargeId, action, value);

    const res = await request
      .post(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ promotion_id: promoId });
    return res;
  }

  it('waive brings the membership fee to 0', async () => {
    const res = await applyAndGetFinalPrice('waive', null);
    expect(res.status).toBe(201);
    expect(Number(res.body.final_price)).toBe(0);
  });

  it('percentage_discount reduces the fee proportionally', async () => {
    const res = await applyAndGetFinalPrice('percentage_discount', 50);
    expect(res.status).toBe(201);
    expect(Number(res.body.final_price)).toBe(50);
  });

  it('fixed_discount subtracts a fixed amount', async () => {
    const res = await applyAndGetFinalPrice('fixed_discount', 20);
    expect(res.status).toBe(201);
    expect(Number(res.body.final_price)).toBe(80);
  });

  it('fixed_price replaces the fee with a specific price (#487 stage 2)', async () => {
    const res = await applyAndGetFinalPrice('fixed_price', 60);
    expect(res.status).toBe(201);
    expect(Number(res.body.final_price)).toBe(60);
  });

  it('fixed_price of 0 waives the fee entirely', async () => {
    const res = await applyAndGetFinalPrice('fixed_price', 0);
    expect(res.status).toBe(201);
    expect(Number(res.body.final_price)).toBe(0);
  });

  it('fixed_discount larger than the base price clamps at 0', async () => {
    const res = await applyAndGetFinalPrice('fixed_discount', 500);
    expect(res.status).toBe(201);
    expect(Number(res.body.final_price)).toBe(0);
  });
});

// ─── Auth / tenant isolation ────────────────────────────────────────────────

describe('POST /user-memberships/:id/promotions — auth', () => {
  let gymId: string;
  let gymNoAccess: string;
  let planId: number;
  let memberId: number;
  let umId: number;
  let promoId: number;

  beforeAll(async () => {
    gymId = await createTestGym('MP Auth Gym');
    await createTestMembership(gymId, 'admin');
    planId = await createPlan(gymId, 'Auth Plan');
    memberId = await createMember(gymId, 'Auth Member');
    umId = await createUserMembership(gymId, memberId, planId, 100);
    promoId = await createPromo(gymId, 'Auth Promo');
    await targetPlan(gymId, promoId, planId);

    // trainer_performance has NONE access to the PAYMENTS module → 403 on any route
    gymNoAccess = await createTestGym('MP No Access Gym');
    await createTestMembership(gymNoAccess, 'trainer_performance');
  });

  it('401 without a token', async () => {
    const res = await request
      .post(`/user-memberships/${umId}/promotions`)
      .set('x-gym-id', gymId)
      .send({ promotion_id: promoId });
    expect(res.status).toBe(401);
  });

  it('404 for a membership in another gym', async () => {
    const otherGymId = await createTestGym('MP Other Gym');
    await createTestMembership(otherGymId, 'admin');
    const res = await request
      .post(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId)
      .send({ promotion_id: promoId });
    expect(res.status).toBe(404);
  });

  it('403 when role has NONE access to the PAYMENTS module', async () => {
    const res = await request
      .post(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymNoAccess)
      .send({ promotion_id: promoId });
    expect(res.status).toBe(403);
  });
});
