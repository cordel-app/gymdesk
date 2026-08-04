// Tests for promotions.ts and promotion-details.ts routers

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  TEST_USER_ID,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ─── Shared helpers ───────────────────────────────────────────────────────────

async function createPromotion(
  gymId: string,
  overrides: Record<string, unknown> = {},
): Promise<number> {
  const name = (overrides.name as string | undefined) ?? `Promo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const { insertId } = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status)
     VALUES (?, ?, '2025-01-01', '2025-12-31', ?)`,
    [gymId, name, (overrides.lifecycle_status as string | undefined) ?? 'active'],
  );
  return insertId;
}

async function createMembershipPlan(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, 'Test Plan', 'draft', 'closed')`,
    [gymId],
  );
  return insertId;
}

async function createGymCharge(gymId: string, chargeTypeId: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO gym_charges (gym_id, charge_type_id, amount, currency, billing_frequency, availability)
     VALUES (?, ?, 50, 'EUR', 'month', 'available')`,
    [gymId, chargeTypeId],
  );
  return insertId;
}

async function getMembershipFeeChargeTypeId(): Promise<number> {
  const { rows } = await db.query<{ id: number }>('SELECT id FROM charge_types WHERE code = ?', ['membership_fee']);
  return rows[0].id;
}

async function getPersonalTrainingChargeTypeId(): Promise<number> {
  const { rows } = await db.query<{ id: number }>('SELECT id FROM charge_types WHERE code = ?', ['personal_training']);
  return rows[0].id;
}

// ─── GET /promotions ──────────────────────────────────────────────────────────

describe('GET /promotions', () => {
  let gymId: string;
  let gymNoAccess: string;
  let gymNoMembership: string;

  beforeAll(async () => {
    gymId = await createTestGym('Promotions GET Gym');
    await createTestMembership(gymId, 'admin');
    await createPromotion(gymId, { name: 'Active Promo', lifecycle_status: 'active' });

    // trainer_performance has NONE on FINANCIALS → 403
    gymNoAccess = await createTestGym('Promotions No Access Gym');
    await createTestMembership(gymNoAccess, 'trainer_performance');

    // No membership row → 403
    gymNoMembership = await createTestGym('Promotions No Membership Gym');
  });

  it('returns 401 without auth', async () => {
    const res = await request.get('/promotions').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no membership in gym (tenant isolation)', async () => {
    const res = await request
      .get('/promotions')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymNoMembership);
    expect(res.status).toBe(403);
  });

  it('returns 403 for a role without FINANCIALS access', async () => {
    const res = await request
      .get('/promotions')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymNoAccess);
    expect(res.status).toBe(403);
  });

  it('returns 200 with an array for admin', async () => {
    const res = await request
      .get('/promotions')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('excludes deleted promotions from the default list', async () => {
    const deletedPromoId = await createPromotion(gymId, { name: 'Deleted Promo', lifecycle_status: 'deleted' });
    const res = await request
      .get('/promotions')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((p: any) => p.id);
    expect(ids).not.toContain(deletedPromoId);
  });

  it('filters by lifecycle_status=inactive', async () => {
    await createPromotion(gymId, { name: 'Inactive Promo', lifecycle_status: 'inactive' });
    const res = await request
      .get('/promotions?lifecycle_status=inactive')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const p of res.body) {
      expect(p.lifecycle_status).toBe('inactive');
    }
  });

  it('returns 400 for invalid lifecycle_status filter', async () => {
    const res = await request
      .get('/promotions?lifecycle_status=deleted')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });

  it('filters by q (name search)', async () => {
    const uniqueName = `UniquePromo-${Date.now()}`;
    await createPromotion(gymId, { name: uniqueName });
    const res = await request
      .get(`/promotions?q=${encodeURIComponent(uniqueName)}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.some((p: any) => p.name === uniqueName)).toBe(true);
  });

  it('returns 200 with an array for accountant (FINANCIALS read-only)', async () => {
    const gymAccountant = await createTestGym('Promotions Accountant Gym');
    await createTestMembership(gymAccountant, 'accountant');
    const res = await request
      .get('/promotions')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymAccountant);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ─── GET /promotions/:id ──────────────────────────────────────────────────────

describe('GET /promotions/:id', () => {
  let gymA: string;
  let gymB: string;
  let promoId: number;

  beforeAll(async () => {
    gymA = await createTestGym('Promotions GET Single GymA');
    await createTestMembership(gymA, 'admin');
    promoId = await createPromotion(gymA, { name: 'Single Promo' });

    gymB = await createTestGym('Promotions GET Single GymB');
    await createTestMembership(gymB, 'admin');
  });

  it('returns 200 for a valid promotion', async () => {
    const res = await request
      .get(`/promotions/${promoId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(promoId);
    expect(res.body).toHaveProperty('deleted_by_name');
    expect(res.body).toHaveProperty('modified_at');
    expect(res.body).toHaveProperty('modified_by_name');
  });

  it('returns 404 for promotion belonging to a different gym (cross-gym isolation)', async () => {
    const res = await request
      .get(`/promotions/${promoId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(404);
  });

  it('still returns 200 for a soft-deleted promotion (GET /:id includes deleted)', async () => {
    const deletedPromoId = await createPromotion(gymA, { name: 'Soft Deleted Single', lifecycle_status: 'deleted' });
    const res = await request
      .get(`/promotions/${deletedPromoId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA);
    expect(res.status).toBe(200);
    expect(res.body.lifecycle_status).toBe('deleted');
  });
});

// ─── POST /promotions ─────────────────────────────────────────────────────────

describe('POST /promotions', () => {
  let gymId: string;
  let gymReadOnly: string;

  beforeAll(async () => {
    gymId = await createTestGym('Promotions POST Gym');
    await createTestMembership(gymId, 'admin');

    // front_desk has R on FINANCIALS → requireRole('admin') blocks writes
    gymReadOnly = await createTestGym('Promotions POST ReadOnly Gym');
    await createTestMembership(gymReadOnly, 'front_desk');
  });

  it('returns 401 without auth', async () => {
    const res = await request
      .post('/promotions')
      .set('x-gym-id', gymId)
      .send({ name: 'Test', starts_at: '2025-01-01', ends_at: '2025-12-31' });
    expect(res.status).toBe(401);
  });

  it('returns 403 for front_desk role (requireRole admin)', async () => {
    const res = await request
      .post('/promotions')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymReadOnly)
      .send({ name: 'Test', starts_at: '2025-01-01', ends_at: '2025-12-31' });
    expect(res.status).toBe(403);
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request
      .post('/promotions')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'No dates' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when ends_at is before starts_at', async () => {
    const res = await request
      .post('/promotions')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Bad dates', starts_at: '2025-12-31', ends_at: '2025-01-01' });
    expect(res.status).toBe(400);
  });

  it('returns 201 and creates promotion with required fields', async () => {
    const res = await request
      .post('/promotions')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'New Promo', starts_at: '2025-01-01', ends_at: '2025-12-31' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('New Promo');
    expect(res.body.lifecycle_status).toBe('active');
    expect(res.body.gym_id).toBe(gymId);
  });

  it('creates promotion with optional free_period fields', async () => {
    const res = await request
      .post('/promotions')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        name: 'Free Period Promo',
        starts_at: '2025-01-01',
        ends_at: '2025-12-31',
        free_period_paid_months: 3,
        free_period_bonus_months: 1,
        lifecycle_status: 'inactive',
      });
    expect(res.status).toBe(201);
    expect(res.body.free_period_paid_months).toBe(3);
    expect(res.body.free_period_bonus_months).toBe(1);
    expect(res.body.lifecycle_status).toBe('inactive');
  });
});

// ─── PUT /promotions/:id ──────────────────────────────────────────────────────

describe('PUT /promotions/:id', () => {
  let gymId: string;
  let promoId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Promotions PUT Gym');
    await createTestMembership(gymId, 'admin');
    promoId = await createPromotion(gymId, { name: 'Update Me' });
  });

  it('returns 401 without auth', async () => {
    const res = await request
      .put(`/promotions/${promoId}`)
      .set('x-gym-id', gymId)
      .send({ name: 'Updated' });
    expect(res.status).toBe(401);
  });

  it('returns 200 and updates the promotion', async () => {
    const res = await request
      .put(`/promotions/${promoId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Updated Name', free_period_paid_months: 2, free_period_bonus_months: 1 });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Name');
    expect(res.body.free_period_paid_months).toBe(2);
    expect(res.body.free_period_bonus_months).toBe(1);
  });

  it('returns 404 for promotion in another gym (cross-gym isolation)', async () => {
    const gymB = await createTestGym('Promotions PUT GymB');
    await createTestMembership(gymB, 'admin');
    const res = await request
      .put(`/promotions/${promoId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB)
      .send({ name: 'Cross gym' });
    expect(res.status).toBe(404);
  });

  it('returns 404 when updating a deleted promotion', async () => {
    const deletedId = await createPromotion(gymId, { name: 'Deleted PUT Target', lifecycle_status: 'deleted' });
    const res = await request
      .put(`/promotions/${deletedId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Try update deleted' });
    expect(res.status).toBe(404);
  });
});

// ─── DELETE /promotions/:id (soft delete) ────────────────────────────────────

describe('DELETE /promotions/:id', () => {
  let gymId: string;
  let promoId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Promotions DELETE Gym');
    await createTestMembership(gymId, 'admin');
    promoId = await createPromotion(gymId, { name: 'Delete Me' });
  });

  it('returns 401 without auth', async () => {
    const res = await request
      .delete(`/promotions/${promoId}`)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 204 on successful soft delete', async () => {
    const res = await request
      .delete(`/promotions/${promoId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);
  });

  it('soft-deleted promotion no longer appears in GET /promotions', async () => {
    const res = await request
      .get('/promotions')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((p: any) => p.id);
    expect(ids).not.toContain(promoId);
  });

  it('soft-deleted promotion still in DB and GET /:id returns it', async () => {
    const res = await request
      .get(`/promotions/${promoId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.lifecycle_status).toBe('deleted');
    expect(res.body.deleted_at).not.toBeNull();
  });

  it('returns 404 when deleting already-deleted promotion', async () => {
    const res = await request
      .delete(`/promotions/${promoId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

// ─── POST /promotions/:id/duplicate ──────────────────────────────────────────

describe('POST /promotions/:id/duplicate', () => {
  let gymId: string;
  let promoId: number;
  let chargeTypeId: number;
  let gymChargeId: number;
  let personalTrainingChargeTypeId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Promotions Duplicate Gym');
    await createTestMembership(gymId, 'admin');

    chargeTypeId = await getMembershipFeeChargeTypeId();
    personalTrainingChargeTypeId = await getPersonalTrainingChargeTypeId();
    gymChargeId = await createGymCharge(gymId, chargeTypeId);

    promoId = await createPromotion(gymId, { name: 'Original Promo' });

    // Seed charge benefit on the source promo
    await db.query(
      `INSERT INTO promotion_charge_benefits (gym_id, promotion_id, gym_charge_id, action, value)
       VALUES (?, ?, ?, 'waive', NULL)`,
      [gymId, promoId, gymChargeId],
    );

    // Seed period benefit on the source promo
    await db.query(
      `INSERT INTO promotion_period_benefits (gym_id, promotion_id, charge_type_id, quantity, frequency_interval, frequency_unit, enabled)
       VALUES (?, ?, ?, 4, 1, 'month', 1)`,
      [gymId, promoId, personalTrainingChargeTypeId],
    );

    // Seed a plan link
    const planId = await createMembershipPlan(gymId);
    await db.query(
      `INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id)
       VALUES (?, ?, ?)`,
      [gymId, promoId, planId],
    );
  });

  it('returns 401 without auth', async () => {
    const res = await request
      .post(`/promotions/${promoId}/duplicate`)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 201 with a copy of the promotion', async () => {
    const res = await request
      .post(`/promotions/${promoId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe(promoId);
    expect(res.body.name).toContain('Copy');
    expect(res.body.gym_id).toBe(gymId);
  });

  it('duplicated promo includes charge benefits', async () => {
    // Duplicate again to get a fresh copy
    const dupRes = await request
      .post(`/promotions/${promoId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(dupRes.status).toBe(201);
    const newId = dupRes.body.id;

    const { rows } = await db.query(
      'SELECT * FROM promotion_charge_benefits WHERE promotion_id = ? AND gym_id = ?',
      [newId, gymId],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].gym_charge_id).toBe(gymChargeId);
  });

  it('duplicated promo includes period benefits', async () => {
    const dupRes = await request
      .post(`/promotions/${promoId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(dupRes.status).toBe(201);
    const newId = dupRes.body.id;

    const { rows } = await db.query(
      'SELECT * FROM promotion_period_benefits WHERE promotion_id = ? AND gym_id = ?',
      [newId, gymId],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].charge_type_id).toBe(personalTrainingChargeTypeId);
  });

  it('returns 404 when duplicating deleted promotion', async () => {
    const deletedId = await createPromotion(gymId, { name: 'Deleted Source', lifecycle_status: 'deleted' });
    const res = await request
      .post(`/promotions/${deletedId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

// ─── GET /promotions/:id/plans ───────────────────────────────────────────────

describe('GET /promotions/:id/plans', () => {
  let gymId: string;
  let gymB: string;
  let promoId: number;
  let planId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Promotions Plans GET Gym');
    await createTestMembership(gymId, 'admin');
    promoId = await createPromotion(gymId, { name: 'Plans Promo' });
    planId = await createMembershipPlan(gymId);
    await db.query(
      `INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id)
       VALUES (?, ?, ?)`,
      [gymId, promoId, planId],
    );

    gymB = await createTestGym('Promotions Plans GET GymB');
    await createTestMembership(gymB, 'admin');
  });

  it('returns 401 without auth', async () => {
    const res = await request.get(`/promotions/${promoId}/plans`).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 200 with an array of plans', async () => {
    const res = await request
      .get(`/promotions/${promoId}/plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((p: any) => p.id === planId)).toBe(true);
  });

  it('returns empty array for promo in different gym (cross-gym isolation)', async () => {
    const res = await request
      .get(`/promotions/${promoId}/plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    // promotionDetailsRouter uses gym scoping — returns empty array for foreign promo
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ─── PUT /promotions/:id/plans ───────────────────────────────────────────────

describe('PUT /promotions/:id/plans', () => {
  let gymId: string;
  let promoId: number;
  let planId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Promotions Plans PUT Gym');
    await createTestMembership(gymId, 'admin');
    promoId = await createPromotion(gymId, { name: 'Plans PUT Promo' });
    planId = await createMembershipPlan(gymId);
  });

  it('returns 401 without auth', async () => {
    const res = await request
      .put(`/promotions/${promoId}/plans`)
      .set('x-gym-id', gymId)
      .send({ membership_plan_ids: [] });
    expect(res.status).toBe(401);
  });

  it('returns 400 when membership_plan_ids is not an array', async () => {
    const res = await request
      .put(`/promotions/${promoId}/plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ membership_plan_ids: planId });
    expect(res.status).toBe(400);
  });

  it('returns 404 for promotion in a different gym', async () => {
    const gymB = await createTestGym('Plans PUT GymB');
    await createTestMembership(gymB, 'admin');
    const res = await request
      .put(`/promotions/${promoId}/plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB)
      .send({ membership_plan_ids: [] });
    expect(res.status).toBe(404);
  });

  it('returns 200 and bulk-replaces plan links', async () => {
    const res = await request
      .put(`/promotions/${promoId}/plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ membership_plan_ids: [planId] });
    expect(res.status).toBe(200);
    expect(res.body.membership_plan_ids).toContain(planId);
  });

  it('returns 200 and clears plans with empty array', async () => {
    const res = await request
      .put(`/promotions/${promoId}/plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ membership_plan_ids: [] });
    expect(res.status).toBe(200);
    expect(res.body.membership_plan_ids).toEqual([]);
  });

  it('returns 403 for front_desk role on write', async () => {
    const gymFD = await createTestGym('Plans PUT FrontDesk Gym');
    await createTestMembership(gymFD, 'front_desk');
    const fdPromoId = await createPromotion(gymFD, { name: 'FD Promo' });
    const res = await request
      .put(`/promotions/${fdPromoId}/plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymFD)
      .send({ membership_plan_ids: [] });
    expect(res.status).toBe(403);
  });
});

// ─── GET /promotions/:id/charge-benefits ─────────────────────────────────────

describe('GET /promotions/:id/charge-benefits', () => {
  let gymId: string;
  let promoId: number;
  let gymChargeId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Promotions CB GET Gym');
    await createTestMembership(gymId, 'admin');
    promoId = await createPromotion(gymId, { name: 'CB Promo' });

    const chargeTypeId = await getMembershipFeeChargeTypeId();
    gymChargeId = await createGymCharge(gymId, chargeTypeId);

    await db.query(
      `INSERT INTO promotion_charge_benefits (gym_id, promotion_id, gym_charge_id, action, value)
       VALUES (?, ?, ?, 'percentage_discount', 10)`,
      [gymId, promoId, gymChargeId],
    );
  });

  it('returns 401 without auth', async () => {
    const res = await request.get(`/promotions/${promoId}/charge-benefits`).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 200 with charge benefits including charge_type codes', async () => {
    const res = await request
      .get(`/promotions/${promoId}/charge-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0]).toHaveProperty('gym_charge_name');
    expect(res.body[0]).toHaveProperty('gym_charge_code');
    expect(res.body[0].action).toBe('percentage_discount');
  });
});

// ─── PUT /promotions/:id/charge-benefits ─────────────────────────────────────

describe('PUT /promotions/:id/charge-benefits', () => {
  let gymId: string;
  let promoId: number;
  let gymChargeId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Promotions CB PUT Gym');
    await createTestMembership(gymId, 'admin');
    promoId = await createPromotion(gymId, { name: 'CB PUT Promo' });

    const chargeTypeId = await getMembershipFeeChargeTypeId();
    gymChargeId = await createGymCharge(gymId, chargeTypeId);
  });

  it('returns 401 without auth', async () => {
    const res = await request
      .put(`/promotions/${promoId}/charge-benefits`)
      .set('x-gym-id', gymId)
      .send({ items: [] });
    expect(res.status).toBe(401);
  });

  it('returns 400 when items is not an array', async () => {
    const res = await request
      .put(`/promotions/${promoId}/charge-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: 'not-array' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for promotion in a different gym', async () => {
    const gymB = await createTestGym('CB PUT GymB');
    await createTestMembership(gymB, 'admin');
    const res = await request
      .put(`/promotions/${promoId}/charge-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB)
      .send({ items: [] });
    expect(res.status).toBe(404);
  });

  it('returns 403 for front_desk role on write', async () => {
    const gymFD = await createTestGym('CB PUT FrontDesk Gym');
    await createTestMembership(gymFD, 'front_desk');
    const fdPromoId = await createPromotion(gymFD, { name: 'FD CB Promo' });
    const res = await request
      .put(`/promotions/${fdPromoId}/charge-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymFD)
      .send({ items: [] });
    expect(res.status).toBe(403);
  });

  it('saves charge benefits and returns them', async () => {
    const res = await request
      .put(`/promotions/${promoId}/charge-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        items: [{ gym_charge_id: gymChargeId, action: 'waive', value: null }],
      });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
    expect(res.body[0].action).toBe('waive');
    expect(res.body[0]).toHaveProperty('gym_charge_code');
  });

  it('replaces benefits on subsequent PUT', async () => {
    const res = await request
      .put(`/promotions/${promoId}/charge-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        items: [{ gym_charge_id: gymChargeId, action: 'fixed_discount', value: 15 }],
      });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].action).toBe('fixed_discount');
  });

  it('clears benefits when sending empty items array', async () => {
    const res = await request
      .put(`/promotions/${promoId}/charge-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('skips items with action=no_benefit', async () => {
    const res = await request
      .put(`/promotions/${promoId}/charge-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        items: [{ gym_charge_id: gymChargeId, action: 'no_benefit', value: null }],
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ─── GET /promotions/:id/period-benefits ─────────────────────────────────────

describe('GET /promotions/:id/period-benefits', () => {
  let gymId: string;
  let promoId: number;
  let chargeTypeId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Promotions PB GET Gym');
    await createTestMembership(gymId, 'admin');
    promoId = await createPromotion(gymId, { name: 'PB GET Promo' });

    chargeTypeId = await getPersonalTrainingChargeTypeId();

    await db.query(
      `INSERT INTO promotion_period_benefits (gym_id, promotion_id, charge_type_id, quantity, frequency_interval, frequency_unit, enabled)
       VALUES (?, ?, ?, 2, 1, 'month', 1)`,
      [gymId, promoId, chargeTypeId],
    );
  });

  it('returns 401 without auth', async () => {
    const res = await request.get(`/promotions/${promoId}/period-benefits`).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 200 with period benefits including charge_type_code and charge_type_name', async () => {
    const res = await request
      .get(`/promotions/${promoId}/period-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0]).toHaveProperty('charge_type_code');
    expect(res.body[0]).toHaveProperty('charge_type_name');
    expect(res.body[0].frequency_unit).toBe('month');
  });
});

// ─── PUT /promotions/:id/period-benefits ─────────────────────────────────────

describe('PUT /promotions/:id/period-benefits', () => {
  let gymId: string;
  let promoId: number;
  let chargeTypeId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Promotions PB PUT Gym');
    await createTestMembership(gymId, 'admin');
    promoId = await createPromotion(gymId, { name: 'PB PUT Promo' });
    chargeTypeId = await getPersonalTrainingChargeTypeId();
  });

  it('returns 401 without auth', async () => {
    const res = await request
      .put(`/promotions/${promoId}/period-benefits`)
      .set('x-gym-id', gymId)
      .send({ items: [] });
    expect(res.status).toBe(401);
  });

  it('returns 403 for front_desk role on write', async () => {
    const gymFD = await createTestGym('PB PUT FrontDesk Gym');
    await createTestMembership(gymFD, 'front_desk');
    const fdPromoId = await createPromotion(gymFD, { name: 'FD PB Promo' });
    const res = await request
      .put(`/promotions/${fdPromoId}/period-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymFD)
      .send({ items: [] });
    expect(res.status).toBe(403);
  });

  it('returns 400 when items is not an array', async () => {
    const res = await request
      .put(`/promotions/${promoId}/period-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: 'not-array' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid frequency_unit', async () => {
    const res = await request
      .put(`/promotions/${promoId}/period-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        items: [{ charge_type_id: chargeTypeId, quantity: 2, frequency_interval: 1, frequency_unit: 'year' }],
      });
    expect(res.status).toBe(400);
  });

  it('returns 400 for negative/zero quantity', async () => {
    const res = await request
      .put(`/promotions/${promoId}/period-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        items: [{ charge_type_id: chargeTypeId, quantity: 0, frequency_interval: 1, frequency_unit: 'month' }],
      });
    expect(res.status).toBe(400);
  });

  it('returns 400 for negative/zero frequency_interval', async () => {
    const res = await request
      .put(`/promotions/${promoId}/period-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        items: [{ charge_type_id: chargeTypeId, quantity: 2, frequency_interval: 0, frequency_unit: 'week' }],
      });
    expect(res.status).toBe(400);
  });

  it('returns 404 for promotion in a different gym', async () => {
    const gymB = await createTestGym('PB PUT GymB');
    await createTestMembership(gymB, 'admin');
    const res = await request
      .put(`/promotions/${promoId}/period-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB)
      .send({ items: [] });
    expect(res.status).toBe(404);
  });

  it('saves period benefits and returns them with charge_type metadata', async () => {
    const res = await request
      .put(`/promotions/${promoId}/period-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        items: [
          { charge_type_id: chargeTypeId, quantity: 4, frequency_interval: 1, frequency_unit: 'month', enabled: true },
        ],
      });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
    expect(res.body[0].quantity).toBe(4);
    expect(res.body[0].frequency_unit).toBe('month');
    expect(res.body[0]).toHaveProperty('charge_type_code');
    expect(res.body[0]).toHaveProperty('charge_type_name');
  });

  it('accepts frequency_unit=week', async () => {
    const res = await request
      .put(`/promotions/${promoId}/period-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        items: [
          { charge_type_id: chargeTypeId, quantity: 2, frequency_interval: 2, frequency_unit: 'week', enabled: true },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body[0].frequency_unit).toBe('week');
  });

  it('replaces existing period benefits on subsequent PUT', async () => {
    // First add some
    await request
      .put(`/promotions/${promoId}/period-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        items: [{ charge_type_id: chargeTypeId, quantity: 5, frequency_interval: 1, frequency_unit: 'month' }],
      });

    // Then clear with empty
    const res = await request
      .put(`/promotions/${promoId}/period-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
