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

async function createPlan(gymId: string, createdBy: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, created_by)
     VALUES (?, 'Test Plan', 'draft', 'closed', ?)`,
    [gymId, createdBy],
  );
  return insertId;
}

describe('Plan Charge Benefits', () => {
  let gymId: string;
  let otherGymId: string;
  let membershipId: number;
  let planId: number;
  let otherPlanId: number;
  let membershipFeeGymChargeId: number;
  let registrationFeeGymChargeId: number;

  beforeAll(async () => {
    gymId = await createTestGym('CB Gym');
    otherGymId = await createTestGym('Other CB Gym');

    await createTestMembership(gymId);
    await createTestMembership(otherGymId);

    const { rows: mRows } = await db.query<{ id: number }>(
      `SELECT id FROM gym_memberships WHERE gym_id = ? LIMIT 1`,
      [gymId],
    );
    membershipId = mRows[0].id;

    const { rows: otherMRows } = await db.query<{ id: number }>(
      `SELECT id FROM gym_memberships WHERE gym_id = ? LIMIT 1`,
      [otherGymId],
    );

    planId = await createPlan(gymId, membershipId);
    otherPlanId = await createPlan(otherGymId, otherMRows[0].id);

    const membershipFeeTypeId = await getChargeTypeId('membership_fee');
    const registrationFeeTypeId = await getChargeTypeId('registration_fee');

    membershipFeeGymChargeId = await createGymCharge(gymId, membershipFeeTypeId);
    registrationFeeGymChargeId = await createGymCharge(gymId, registrationFeeTypeId);
  });

  // ─── Auth / role ────────────────────────────────────────────────────────────

  describe('Auth', () => {
    it('GET returns 401 when unauthenticated', async () => {
      const res = await request
        .get(`/membership-plans/${planId}/charge-benefits`)
        .set('x-gym-id', gymId);
      expect(res.status).toBe(401);
    });

    it('PUT returns 401 when unauthenticated', async () => {
      const res = await request
        .put(`/membership-plans/${planId}/charge-benefits`)
        .set('x-gym-id', gymId)
        .send([]);
      expect(res.status).toBe(401);
    });

    it('PUT returns 403 for non-admin role', async () => {
      const memberGymId = await createTestGym('Member Role CB Gym');
      await createTestMembership(memberGymId, 'member');
      const { rows: memberRows } = await db.query<{ id: number }>(
        `SELECT id FROM gym_memberships WHERE gym_id = ? LIMIT 1`,
        [memberGymId],
      );
      const mPlanId = await createPlan(memberGymId, memberRows[0].id);
      const res = await request
        .put(`/membership-plans/${mPlanId}/charge-benefits`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', memberGymId)
        .send([]);
      expect(res.status).toBe(403);
    });
  });

  // ─── Tenant isolation ────────────────────────────────────────────────────────

  describe('Tenant isolation', () => {
    it('GET returns 404 for plan belonging to another gym', async () => {
      const res = await request
        .get(`/membership-plans/${otherPlanId}/charge-benefits`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(res.status).toBe(404);
    });

    it('PUT returns 404 for plan belonging to another gym', async () => {
      const res = await request
        .put(`/membership-plans/${otherPlanId}/charge-benefits`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send([]);
      expect(res.status).toBe(404);
    });
  });

  // ─── GET ────────────────────────────────────────────────────────────────────

  describe('GET /membership-plans/:id/charge-benefits', () => {
    it('returns empty array when none configured', async () => {
      const res = await request
        .get(`/membership-plans/${planId}/charge-benefits`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  // ─── PUT ────────────────────────────────────────────────────────────────────

  describe('PUT /membership-plans/:id/charge-benefits', () => {
    it('saves charge benefits and returns them with gym_charge_code', async () => {
      const res = await request
        .put(`/membership-plans/${planId}/charge-benefits`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send([
          { gym_charge_id: membershipFeeGymChargeId, action: 'waive', value: null },
          { gym_charge_id: registrationFeeGymChargeId, action: 'percentage_discount', value: 20 },
        ]);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);

      const waive = res.body.find((cb: any) => cb.gym_charge_code === 'membership_fee');
      expect(waive).toBeDefined();
      expect(waive.action).toBe('waive');
      expect(waive.value).toBeNull();

      const pct = res.body.find((cb: any) => cb.gym_charge_code === 'registration_fee');
      expect(pct).toBeDefined();
      expect(pct.action).toBe('percentage_discount');
      expect(parseFloat(pct.value)).toBe(20);
    });

    it('GET returns the saved benefits', async () => {
      const res = await request
        .get(`/membership-plans/${planId}/charge-benefits`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThanOrEqual(2);
    });

    it('replaces all benefits on subsequent PUT', async () => {
      const res = await request
        .put(`/membership-plans/${planId}/charge-benefits`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send([
          { gym_charge_id: membershipFeeGymChargeId, action: 'fixed_discount', value: 10 },
        ]);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].action).toBe('fixed_discount');
    });

    it('clears all benefits when sending empty array', async () => {
      const res = await request
        .put(`/membership-plans/${planId}/charge-benefits`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send([]);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns 400 for invalid action', async () => {
      const res = await request
        .put(`/membership-plans/${planId}/charge-benefits`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send([{ gym_charge_id: membershipFeeGymChargeId, action: 'unknown_action' }]);
      expect(res.status).toBe(400);
    });

    it('returns 400 when body is not an array', async () => {
      const res = await request
        .put(`/membership-plans/${planId}/charge-benefits`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ action: 'waive' });
      expect(res.status).toBe(400);
    });
  });

  // ─── Enriched plan response ──────────────────────────────────────────────────

  describe('GET /membership-plans/:id includes charge_benefits', () => {
    beforeAll(async () => {
      await request
        .put(`/membership-plans/${planId}/charge-benefits`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send([{ gym_charge_id: membershipFeeGymChargeId, action: 'waive', value: null }]);
    });

    it('returns charge_benefits in enriched plan', async () => {
      const res = await request
        .get(`/membership-plans/${planId}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.charge_benefits)).toBe(true);
      expect(res.body.charge_benefits.length).toBeGreaterThanOrEqual(1);
      expect(res.body.charge_benefits[0]).toHaveProperty('gym_charge_code');
      expect(res.body.charge_benefits[0]).toHaveProperty('action');
    });

    it('charge_benefits included in GET /membership-plans list', async () => {
      const res = await request
        .get('/membership-plans')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(res.status).toBe(200);
      const found = res.body.find((p: any) => p.id === planId);
      expect(found).toBeDefined();
      expect(Array.isArray(found.charge_benefits)).toBe(true);
    });
  });
});
