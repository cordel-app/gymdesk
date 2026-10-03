// Tests for membership-plans.ts router

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

// ─── Shared setup helpers ─────────────────────────────────────────────────────

async function createPlan(
  gymId: string,
  overrides: Record<string, unknown> = {},
): Promise<number> {
  const name =
    (overrides.name as string | undefined) ??
    `Plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, ?, ?, ?)`,
    [
      gymId,
      name,
      (overrides.lifecycle_status as string | undefined) ?? 'draft',
      (overrides.enrollment_status as string | undefined) ?? 'staff_only',
      (overrides.member_limit as string | undefined) ?? '1',
    ],
  );
  return insertId;
}

async function createMember(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Plan Test Member', ?)`,
    [gymId, `pm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`],
  );
  return insertId;
}

async function createActiveUserMembership(
  gymId: string,
  memberId: number,
  planId: number,
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at)
     VALUES (?, ?, ?, 'active', CURDATE())`,
    [gymId, memberId, planId],
  );
  return insertId;
}

// #374: records a Member as covered by a Membership (owner or additional).
async function addCoveredMember(
  gymId: string,
  userMembershipId: number,
  memberId: number,
  isOwner = false,
): Promise<void> {
  await db.query(
    'INSERT INTO user_membership_members (gym_id, user_membership_id, member_id, is_owner) VALUES (?, ?, ?, ?)',
    [gymId, userMembershipId, memberId, isOwner ? 1 : 0],
  );
}

// Creates a gym-scoped charge (borrowing an existing gym-charge charge_type,
// seeded by migration 090) so a Benefit row can reference it. Picks a
// charge_type not yet used by this gym, since gym_charges has a unique constraint
// on (gym_id, charge_type_id) and this helper may be called more than once per gym.
async function createGymCharge(gymId: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT ct.id FROM charge_types ct
     WHERE ct.is_gym_charge = 1
     AND NOT EXISTS (SELECT 1 FROM gym_charges gc WHERE gc.gym_id = ? AND gc.charge_type_id = ct.id)
     LIMIT 1`,
    [gymId],
  );
  const chargeTypeId = rows[0].id;
  const { insertId } = await db.query(
    `INSERT INTO gym_charges (gym_id, charge_type_id, availability) VALUES (?, ?, 'available')`,
    [gymId, chargeTypeId],
  );
  return insertId;
}

// #512: creates a promotion and links it to a plan via promotion_membership_plans,
// so enrichPlan()'s promotion_count can be exercised.
async function createPromoTargetingPlan(gymId: string, planId: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status,
                            only_applicable_for_new_members)
     VALUES (?, ?, '2026-01-01', '2099-12-31', 'active', 0)`,
    [gymId, `Plan Detail Promo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`],
  );
  await db.query(
    'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
    [gymId, insertId, planId],
  );
  return insertId;
}

// #409: a custom (non-system) sellable item, created the same way POST
// /sellable-items does — no charge_type_id (only system items backed by a
// charge_types row have one).
async function createCustomGymCharge(gymId: string, name: string, status = 'active'): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO gym_charges (gym_id, name, type, status) VALUES (?, ?, ?, ?)',
    [gymId, name, 'fee', status],
  );
  return insertId;
}

// ─── Auth and access guards ───────────────────────────────────────────────────

describe('Auth and access guards', () => {
  let gymId: string;
  let gymNoAccess: string;
  let gymReadOnly: string;

  beforeAll(async () => {
    gymId = await createTestGym('Plans Auth Gym');
    await createTestMembership(gymId, 'admin');

    // trainer_performance has NONE on FINANCIALS → requireModuleAccess returns 403
    gymNoAccess = await createTestGym('Plans No Access Gym');
    await createTestMembership(gymNoAccess, 'trainer_performance');

    // front_desk has R on FINANCIALS → can GET but requireRole('admin') blocks writes
    gymReadOnly = await createTestGym('Plans Read Only Gym');
    await createTestMembership(gymReadOnly, 'front_desk');
  });

  it('returns 401 without an Authorization header', async () => {
    const res = await request.get('/membership-plans').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no FINANCIALS module access (trainer_performance)', async () => {
    const res = await request
      .get('/membership-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymNoAccess);
    expect(res.status).toBe(403);
  });

  it('returns 403 when a read-only role (front_desk) attempts POST', async () => {
    const res = await request
      .post('/membership-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymReadOnly)
      .send({ name: 'Forbidden Plan' });
    expect(res.status).toBe(403);
  });

  it('returns 403 when a read-only role (front_desk) attempts PUT', async () => {
    const planId = await createPlan(gymReadOnly, { name: 'Read Only PUT Target' });
    const res = await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymReadOnly)
      .send({ name: 'Should Fail' });
    expect(res.status).toBe(403);
  });

  it('returns 403 when a read-only role (front_desk) attempts DELETE', async () => {
    const planId = await createPlan(gymReadOnly, { name: 'Read Only DELETE Target' });
    const res = await request
      .delete(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymReadOnly);
    expect(res.status).toBe(403);
  });

  it('allows a read-only role (front_desk) to GET the plan list', async () => {
    const res = await request
      .get('/membership-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymReadOnly);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ─── Tenant isolation ─────────────────────────────────────────────────────────

describe('Tenant isolation', () => {
  let gymA: string;
  let gymB: string;
  let planBId: number;

  beforeAll(async () => {
    gymA = await createTestGym('Plans Tenant Gym A');
    await createTestMembership(gymA, 'admin');
    gymB = await createTestGym('Plans Tenant Gym B');
    // Insert plan directly; TEST_USER_ID has no membership in gymB
    planBId = await createPlan(gymB, { name: 'Gym B Plan' });
  });

  it('returns 403 when the user has no membership in the requested gym', async () => {
    const res = await request
      .get('/membership-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(403);
  });

  it('returns 404 when accessing a gymB plan with gymA credentials', async () => {
    const res = await request
      .get(`/membership-plans/${planBId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA);
    expect(res.status).toBe(404);
  });
});

// ─── GET /membership-plans ────────────────────────────────────────────────────

describe('GET /membership-plans', () => {
  let gymId: string;
  let planId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Plans List Gym');
    await createTestMembership(gymId, 'admin');
    planId = await createPlan(gymId, { name: 'Visible List Plan' });
  });

  it('returns 200 with an array', async () => {
    const res = await request
      .get('/membership-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('includes the created plan in the list', async () => {
    const res = await request
      .get('/membership-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    const ids = res.body.map((p: any) => p.id);
    expect(ids).toContain(planId);
  });

  it('filters by lifecycle_status query param', async () => {
    await createPlan(gymId, { name: 'Active Filter Plan', lifecycle_status: 'active' });
    const res = await request
      .get('/membership-plans?lifecycle_status=active')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.every((p: any) => p.lifecycle_status === 'active')).toBe(true);
  });

  it('does not include soft-deleted plans', async () => {
    const delId = await createPlan(gymId, { name: 'To Delete From List Plan' });
    await db.query('UPDATE membership_plans SET deleted_at = NOW() WHERE id = ?', [delId]);
    const res = await request
      .get('/membership-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    const ids = res.body.map((p: any) => p.id);
    expect(ids).not.toContain(delId);
  });

  it('enriched response includes member_count and price_history', async () => {
    const res = await request
      .get('/membership-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const plan = res.body.find((p: any) => p.id === planId);
    expect(plan).toBeDefined();
    expect(plan).toHaveProperty('member_count');
    expect(typeof plan.member_count).toBe('number');
    expect(plan).toHaveProperty('price_history');
    expect(Array.isArray(plan.price_history)).toBe(true);
  });

  it('enriched response includes promotion_count reflecting targeting promotions', async () => {
    const untouched = await request
      .get('/membership-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(untouched.body.find((p: any) => p.id === planId).promotion_count).toBe(0);

    await createPromoTargetingPlan(gymId, planId);
    await createPromoTargetingPlan(gymId, planId);

    const res = await request
      .get('/membership-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.body.find((p: any) => p.id === planId).promotion_count).toBe(2);
  });
});

// ─── GET /membership-plans/:id ────────────────────────────────────────────────

describe('GET /membership-plans/:id', () => {
  let gymId: string;
  let planId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Plans GetById Gym');
    await createTestMembership(gymId, 'admin');
    planId = await createPlan(gymId, { name: 'GetById Plan', lifecycle_status: 'draft' });
  });

  it('returns the enriched plan by id', async () => {
    const res = await request
      .get(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(planId);
    expect(res.body.name).toBe('GetById Plan');
    expect(res.body).toHaveProperty('price_history');
    expect(res.body).toHaveProperty('member_count');
    expect(res.body).toHaveProperty('centers');
  });

  it('returns 404 for a non-existent plan', async () => {
    const res = await request
      .get('/membership-plans/9999999')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a soft-deleted plan', async () => {
    const delId = await createPlan(gymId, { name: 'Soft Deleted GetById Plan' });
    await db.query('UPDATE membership_plans SET deleted_at = NOW() WHERE id = ?', [delId]);
    const res = await request
      .get(`/membership-plans/${delId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

// ─── POST /membership-plans ───────────────────────────────────────────────────

describe('POST /membership-plans', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Plans Create Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('creates a plan and returns 201 with enriched data', async () => {
    const res = await request
      .post('/membership-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        name: 'New Plan',
        description: 'A test plan',
        lifecycle_status: 'draft',
        enrollment_status: 'staff_only',
      });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('New Plan');
    expect(res.body.description).toBe('A test plan');
    expect(res.body.lifecycle_status).toBe('draft');
    expect(res.body.enrollment_status).toBe('staff_only');
    expect(res.body).toHaveProperty('price_history');
    expect(res.body).toHaveProperty('member_count');
  });

  it('defaults lifecycle_status to draft and enrollment_status to staff_only', async () => {
    const res = await request
      .post('/membership-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Defaults Plan' });
    expect(res.status).toBe(201);
    expect(res.body.lifecycle_status).toBe('draft');
    expect(res.body.enrollment_status).toBe('staff_only');
  });

  it('returns 400 when name is missing', async () => {
    const res = await request
      .post('/membership-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ description: 'No name provided' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when name is blank', async () => {
    const res = await request
      .post('/membership-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: '   ' });
    expect(res.status).toBe(400);
  });

  it('returns 409 when a plan with the same name already exists', async () => {
    await request
      .post('/membership-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Duplicate Plan Name' });
    const res = await request
      .post('/membership-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Duplicate Plan Name' });
    expect(res.status).toBe(409);
  });
});

// ─── PUT /membership-plans/:id ────────────────────────────────────────────────

describe('PUT /membership-plans/:id', () => {
  let gymId: string;
  let planId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Plans Update Gym');
    await createTestMembership(gymId, 'admin');
    planId = await createPlan(gymId, { name: 'Update Me Plan' });
  });

  it('updates a plan name and returns 200', async () => {
    const res = await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Updated Plan Name' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Plan Name');
  });

  it('returns 404 for a non-existent plan', async () => {
    const res = await request
      .put('/membership-plans/9999999')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Ghost Plan' });
    expect(res.status).toBe(404);
  });

  it('returns 400 for an invalid lifecycle_status value', async () => {
    const res = await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ lifecycle_status: 'zombie' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lifecycle_status/i);
  });

  it('returns 400 for an invalid enrollment_status value', async () => {
    const res = await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ enrollment_status: 'open' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/enrollment_status/i);
  });

  it('returns 400 for enrollment_status closed (removed from the model)', async () => {
    const res = await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ enrollment_status: 'closed' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/enrollment_status/i);
  });

  it('returns 400 when enrollment_status is public but lifecycle_status is draft', async () => {
    const res = await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ enrollment_status: 'public', lifecycle_status: 'draft' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when enrollment_status is staff_only but lifecycle_status is paused', async () => {
    const res = await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ enrollment_status: 'staff_only', lifecycle_status: 'paused' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when enrollment_status is staff_only but lifecycle_status is inactive', async () => {
    const res = await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ enrollment_status: 'staff_only', lifecycle_status: 'inactive' });
    expect(res.status).toBe(400);
  });

  it('accepts enrollment_status public when lifecycle_status is active', async () => {
    const activePlanId = await createPlan(gymId, { name: 'Active Enrollment Plan' });
    const res = await request
      .put(`/membership-plans/${activePlanId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ lifecycle_status: 'active', enrollment_status: 'public' });
    expect(res.status).toBe(200);
    expect(res.body.lifecycle_status).toBe('active');
    expect(res.body.enrollment_status).toBe('public');
  });

  it('accepts enrollment_status staff_only when lifecycle_status is active', async () => {
    const activePlanId = await createPlan(gymId, { name: 'Staff Only Active Plan' });
    const res = await request
      .put(`/membership-plans/${activePlanId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ lifecycle_status: 'active', enrollment_status: 'staff_only' });
    expect(res.status).toBe(200);
    expect(res.body.enrollment_status).toBe('staff_only');
  });

  it('returns 409 when renaming to a name that already exists', async () => {
    const otherPlanId = await createPlan(gymId, { name: 'Name Collision Plan' });
    const res = await request
      .put(`/membership-plans/${otherPlanId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Updated Plan Name' }); // already used above
    expect(res.status).toBe(409);
  });
});

// ─── member_limit (#374 — multi-member Membership Plans) ─────────────────────

describe('member_limit on create and update', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Plans MemberLimit Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('defaults member_limit to "1" when omitted on create', async () => {
    const res = await request
      .post('/membership-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Default Limit Plan' });
    expect(res.status).toBe(201);
    expect(res.body.member_limit).toBe('1');
  });

  it('accepts member_limit "2" on create', async () => {
    const res = await request
      .post('/membership-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Couple Limit Plan', member_limit: '2' });
    expect(res.status).toBe(201);
    expect(res.body.member_limit).toBe('2');
  });

  it('accepts member_limit "family" on create', async () => {
    const res = await request
      .post('/membership-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Family Limit Plan', member_limit: 'family' });
    expect(res.status).toBe(201);
    expect(res.body.member_limit).toBe('family');
  });

  it('returns 400 for an invalid member_limit value on create', async () => {
    const res = await request
      .post('/membership-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Bad Limit Create Plan', member_limit: '3' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/member_limit/i);
  });

  it('updates member_limit to "2" via PUT', async () => {
    const planId = await createPlan(gymId, { name: 'Update Limit Plan' });
    const res = await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_limit: '2' });
    expect(res.status).toBe(200);
    expect(res.body.member_limit).toBe('2');
  });

  it('returns 400 for an invalid member_limit value on update', async () => {
    const planId = await createPlan(gymId, { name: 'Update Bad Limit Plan' });
    const res = await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_limit: 'couple' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/member_limit/i);
  });

  it('copies member_limit when duplicating a plan', async () => {
    const planId = await createPlan(gymId, { name: 'Duplicate Source Plan', member_limit: 'family' });
    const res = await request
      .post(`/membership-plans/${planId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(201);
    expect(res.body.member_limit).toBe('family');
  });

  it('rejects shrinking member_limit below the covered Members of an existing active Membership', async () => {
    const planId = await createPlan(gymId, { name: 'Shrink Guard Plan', member_limit: '2' });
    const owner = await createMember(gymId);
    const partner = await createMember(gymId);
    const umId = await createActiveUserMembership(gymId, owner, planId);
    await addCoveredMember(gymId, umId, owner, true);
    await addCoveredMember(gymId, umId, partner, false);

    const res = await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_limit: '1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/member limit/i);
  });

  it('allows shrinking member_limit when covered Members already fit within the new cap', async () => {
    const planId = await createPlan(gymId, { name: 'Shrink OK Plan', member_limit: '2' });
    const owner = await createMember(gymId);
    const umId = await createActiveUserMembership(gymId, owner, planId);
    await addCoveredMember(gymId, umId, owner, true);

    const res = await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_limit: '1' });
    expect(res.status).toBe(200);
    expect(res.body.member_limit).toBe('1');
  });

  it('allows setting member_limit to "family" regardless of covered Members', async () => {
    const planId = await createPlan(gymId, { name: 'Shrink To Family Plan', member_limit: '2' });
    const owner = await createMember(gymId);
    const partner = await createMember(gymId);
    const umId = await createActiveUserMembership(gymId, owner, planId);
    await addCoveredMember(gymId, umId, owner, true);
    await addCoveredMember(gymId, umId, partner, false);

    const res = await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_limit: 'family' });
    expect(res.status).toBe(200);
    expect(res.body.member_limit).toBe('family');
  });
});

// ─── DELETE /membership-plans/:id ────────────────────────────────────────────

describe('DELETE /membership-plans/:id', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Plans Delete Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('soft-deletes a plan and returns 204', async () => {
    const planId = await createPlan(gymId, { name: 'Delete Me Plan' });
    const res = await request
      .delete(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);
  });

  it('hides the soft-deleted plan from GET list', async () => {
    const planId = await createPlan(gymId, { name: 'Hidden After Delete Plan' });
    await request
      .delete(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    const list = await request
      .get('/membership-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    const ids = list.body.map((p: any) => p.id);
    expect(ids).not.toContain(planId);
  });

  it('returns 404 when deleting an already-deleted plan', async () => {
    const planId = await createPlan(gymId, { name: 'Double Delete Plan' });
    await request
      .delete(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    const res = await request
      .delete(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 404 when deleting a non-existent plan', async () => {
    const res = await request
      .delete('/membership-plans/9999999')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 400 when plan has active user memberships', async () => {
    const planId = await createPlan(gymId, { name: 'Active Members Delete Plan' });
    const memberId = await createMember(gymId);
    await createActiveUserMembership(gymId, memberId, planId);
    const res = await request
      .delete(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/active memberships/i);
  });
});

// ─── POST /membership-plans/:id/archive ──────────────────────────────────────

describe('POST /membership-plans/:id/archive', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Plans Archive Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('archives an active plan (lifecycle → inactive, enrollment → staff_only)', async () => {
    const planId = await createPlan(gymId, {
      name: 'Archive Me Plan',
      lifecycle_status: 'active',
      enrollment_status: 'public',
    });
    const res = await request
      .post(`/membership-plans/${planId}/archive`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.lifecycle_status).toBe('inactive');
    expect(res.body.enrollment_status).toBe('staff_only');
  });

  it('returns 404 when plan is not active (draft)', async () => {
    const planId = await createPlan(gymId, {
      name: 'Draft Archive Plan',
      lifecycle_status: 'draft',
    });
    const res = await request
      .post(`/membership-plans/${planId}/archive`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 404 when plan is not active (paused)', async () => {
    const planId = await createPlan(gymId, {
      name: 'Paused Archive Plan',
      lifecycle_status: 'paused',
    });
    const res = await request
      .post(`/membership-plans/${planId}/archive`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 400 when an active plan has active user memberships', async () => {
    const planId = await createPlan(gymId, {
      name: 'Archive Active Members Plan',
      lifecycle_status: 'active',
    });
    const memberId = await createMember(gymId);
    await createActiveUserMembership(gymId, memberId, planId);
    const res = await request
      .post(`/membership-plans/${planId}/archive`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/active memberships/i);
  });

  it('returns 403 when called by a non-admin role', async () => {
    const gymRO = await createTestGym('Archive Role Guard Gym');
    await createTestMembership(gymRO, 'front_desk');
    const planId = await createPlan(gymRO, {
      name: 'Archive Role Guard Plan',
      lifecycle_status: 'active',
    });
    const res = await request
      .post(`/membership-plans/${planId}/archive`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymRO);
    expect(res.status).toBe(403);
  });
});

// ─── PUT /membership-plans/:id/enrollment ────────────────────────────────────

describe('PUT /membership-plans/:id/enrollment', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Plans Enrollment Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('sets enrollment_status to public on an active plan', async () => {
    const planId = await createPlan(gymId, {
      name: 'Enrollment Active Plan',
      lifecycle_status: 'active',
    });
    const res = await request
      .put(`/membership-plans/${planId}/enrollment`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ enrollment_status: 'public' });
    expect(res.status).toBe(200);
    expect(res.body.enrollment_status).toBe('public');
  });

  it('sets enrollment_status to staff_only on an active plan', async () => {
    const planId = await createPlan(gymId, {
      name: 'Enrollment Staff Only Plan',
      lifecycle_status: 'active',
    });
    const res = await request
      .put(`/membership-plans/${planId}/enrollment`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ enrollment_status: 'staff_only' });
    expect(res.status).toBe(200);
    expect(res.body.enrollment_status).toBe('staff_only');
  });

  it('returns 400 for an invalid enrollment_status value', async () => {
    const planId = await createPlan(gymId, { name: 'Enrollment Invalid Plan' });
    const res = await request
      .put(`/membership-plans/${planId}/enrollment`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ enrollment_status: 'open' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for enrollment_status closed (removed from the model)', async () => {
    const planId = await createPlan(gymId, { name: 'Enrollment Closed Removed Plan' });
    const res = await request
      .put(`/membership-plans/${planId}/enrollment`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ enrollment_status: 'closed' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when setting public enrollment on a draft plan', async () => {
    const planId = await createPlan(gymId, {
      name: 'Enrollment Public Draft Plan',
      lifecycle_status: 'draft',
    });
    const res = await request
      .put(`/membership-plans/${planId}/enrollment`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ enrollment_status: 'public' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-active/i);
  });

  it('returns 400 when setting staff_only enrollment on a paused plan', async () => {
    const planId = await createPlan(gymId, {
      name: 'Enrollment Staff Only Paused Plan',
      lifecycle_status: 'paused',
    });
    const res = await request
      .put(`/membership-plans/${planId}/enrollment`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ enrollment_status: 'staff_only' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for a non-existent plan', async () => {
    const res = await request
      .put('/membership-plans/9999999/enrollment')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ enrollment_status: 'public' });
    expect(res.status).toBe(404);
  });

  it('returns 403 when called by a non-admin role', async () => {
    const gymRO = await createTestGym('Enrollment Role Guard Gym');
    await createTestMembership(gymRO, 'front_desk');
    const planId = await createPlan(gymRO, {
      name: 'Enrollment Role Guard Plan',
      lifecycle_status: 'active',
    });
    const res = await request
      .put(`/membership-plans/${planId}/enrollment`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymRO)
      .send({ enrollment_status: 'public' });
    expect(res.status).toBe(403);
  });
});

// ─── #409: sellable items catalog + charge benefits in plan enrichment ───────

describe('sellable_items in enriched plan response', () => {
  let gymId: string;
  let planId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Plans Sellable Items Gym');
    await createTestMembership(gymId, 'admin');
    planId = await createPlan(gymId, { name: 'Sellable Items Plan' });
  });

  it('includes the full catalog of active sellable items for the gym', async () => {
    const activeId = await createCustomGymCharge(gymId, 'Active Custom Item');
    const res = await request
      .get(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sellable_items)).toBe(true);
    const ids = res.body.sellable_items.map((si: any) => si.id);
    expect(ids).toContain(activeId);
  });

  it('excludes inactive sellable items from the catalog', async () => {
    const inactiveId = await createCustomGymCharge(gymId, 'Inactive Custom Item', 'inactive');
    const res = await request
      .get(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.sellable_items.map((si: any) => si.id);
    expect(ids).not.toContain(inactiveId);
  });

  it('is scoped to the requesting gym (tenant isolation)', async () => {
    const otherGym = await createTestGym('Sellable Items Other Gym');
    const otherItemId = await createCustomGymCharge(otherGym, 'Other Gym Item');
    const res = await request
      .get(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.sellable_items.map((si: any) => si.id);
    expect(ids).not.toContain(otherItemId);
  });
});

// #413: Plans align with Sellable Items' financial config — applicable tax
// (tax_rate_id + tax_behavior) and computed price-incl/excl-tax fields.
describe('Applicable tax on membership plans', () => {
  let gymId: string;

  async function createTaxRate(
    gId: string,
    ratePercent: number,
    isSystem = false,
  ): Promise<number> {
    const { insertId } = await db.query(
      `INSERT INTO tax_rates (gym_id, name, rate_percent, is_system, status) VALUES (?, ?, ?, ?, 'active')`,
      [gId, `Tax ${ratePercent}%`, ratePercent, isSystem ? 1 : 0],
    );
    return insertId;
  }

  beforeAll(async () => {
    gymId = await createTestGym('Plans Tax Rate Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('defaults tax_behavior to inclusive and tax_rate_id to the gym system tax rate on create', async () => {
    const systemTaxRateId = await createTaxRate(gymId, 21, true);
    const res = await request
      .post('/membership-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Tax Default Plan' });
    expect(res.status).toBe(201);
    expect(res.body.tax_behavior).toBe('inclusive');
    expect(res.body.tax_rate_id).toBe(systemTaxRateId);
  });

  it('accepts an explicit tax_rate_id and tax_behavior on create, and returns tax_rate_name/percent', async () => {
    const customTaxRateId = await createTaxRate(gymId, 10);
    const res = await request
      .post('/membership-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Tax Custom Plan', tax_rate_id: customTaxRateId, tax_behavior: 'exclusive' });
    expect(res.status).toBe(201);
    expect(res.body.tax_rate_id).toBe(customTaxRateId);
    expect(res.body.tax_behavior).toBe('exclusive');
    expect(res.body.tax_rate_name).toBe('Tax 10%');
    expect(res.body.tax_rate_percent).toBe('10.00');
  });

  it('returns 400 for a tax_rate_id belonging to another gym', async () => {
    const otherGym = await createTestGym('Tax Rate Other Gym');
    const otherTaxRateId = await createTaxRate(otherGym, 5);
    const res = await request
      .post('/membership-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Cross Gym Tax Plan', tax_rate_id: otherTaxRateId });
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid tax_behavior value', async () => {
    const res = await request
      .post('/membership-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Invalid Tax Behavior Plan', tax_behavior: 'both' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tax_behavior/i);
  });

  it('updates tax_rate_id and tax_behavior via PUT', async () => {
    const planId = await createPlan(gymId, { name: 'Tax Update Plan' });
    const newTaxRateId = await createTaxRate(gymId, 15);
    const res = await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ tax_rate_id: newTaxRateId, tax_behavior: 'exclusive' });
    expect(res.status).toBe(200);
    expect(res.body.tax_rate_id).toBe(newTaxRateId);
    expect(res.body.tax_behavior).toBe('exclusive');
  });

  it('computes amount_excl_tax/amount_incl_tax from the current price and tax rate', async () => {
    const taxRateId = await createTaxRate(gymId, 20);
    const planId = await createPlan(gymId, { name: 'Tax Price Plan' });
    await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ tax_rate_id: taxRateId, tax_behavior: 'exclusive' });
    await request
      .post(`/membership-plans/${planId}/prices`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ price: 100, valid_from: '2020-01-01', valid_to: null });

    const res = await request
      .get(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.current_price).toBe('100.00');
    expect(res.body.amount_excl_tax).toBeCloseTo(100, 2);
    expect(res.body.amount_incl_tax).toBeCloseTo(120, 2);
  });

  // #817 §2: the Current price is shown as the tax-inclusive total *and* the net,
  // so a Plan that never picked a Tax rate of its own — "Default" in the Pricing
  // editor, which bills at the gym's system rate — must still come back with a
  // split. Before #817 it came back as nulls and the card read "—" for a Plan
  // with a perfectly good price.
  //
  // `createTestGym()` inserts the gym row directly and does not seed the system
  // rate `POST /gyms` would, so these three use a gym of their own that has one.
  describe('the split falls back to the gym system tax rate (#817)', () => {
    let defaultGymId: string;
    let systemRateId: number;

    async function priceOf(planId: number) {
      const res = await request
        .get(`/membership-plans/${planId}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', defaultGymId);
      expect(res.status).toBe(200);
      return res.body;
    }

    async function setPrice(planId: number, price: number) {
      const res = await request
        .post(`/membership-plans/${planId}/prices`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', defaultGymId)
        .send({ price, valid_from: '2020-01-01', valid_to: null });
      expect(res.status).toBe(201);
    }

    beforeAll(async () => {
      defaultGymId = await createTestGym('Plans Default Tax Rate Gym');
      await createTestMembership(defaultGymId, 'admin');
      const { insertId } = await db.query(
        `INSERT INTO tax_rates (gym_id, name, rate_percent, is_system, status)
         VALUES (?, 'Standard VAT', 21.00, 1, 'active')`,
        [defaultGymId],
      );
      systemRateId = insertId;
    });

    it('splits at the system rate when the plan has no tax_rate_id of its own', async () => {
      const planId = await createPlan(defaultGymId, { name: 'Default Tax Rate Plan' });
      await setPrice(planId, 60.5);
      const body = await priceOf(planId);
      expect(body.tax_rate_id).toBeNull();
      // The Tax rate row still reads "Default" — the Plan's own columns are untouched.
      expect(body.tax_rate_name).toBeNull();
      expect(body.tax_rate_percent).toBeNull();
      // ...but the money is split, at the system rate, and says which one it used.
      expect(body.applied_tax_rate).toBeCloseTo(21, 2);
      expect(body.amount_incl_tax).toBeCloseTo(60.5, 2);
      expect(body.amount_excl_tax).toBeCloseTo(50, 2);
    });

    it("prefers the plan's own tax rate over the system rate", async () => {
      const { insertId: ownRateId } = await db.query(
        `INSERT INTO tax_rates (gym_id, name, rate_percent, is_system, status)
         VALUES (?, 'Reduced', 4.00, 0, 'active')`,
        [defaultGymId],
      );
      const planId = await createPlan(defaultGymId, { name: 'Own Tax Rate Wins Plan' });
      await request
        .put(`/membership-plans/${planId}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', defaultGymId)
        .send({ tax_rate_id: ownRateId });
      await setPrice(planId, 104);
      const body = await priceOf(planId);
      expect(body.tax_rate_id).toBe(ownRateId);
      expect(body.tax_rate_percent).not.toBeNull();
      expect(body.applied_tax_rate).toBeCloseTo(4, 2);
      expect(body.amount_incl_tax).toBeCloseTo(104, 2);
      expect(body.amount_excl_tax).toBeCloseTo(100, 2);
      expect(systemRateId).not.toBe(ownRateId);
    });

    it('leaves the split null for a plan with no price at all', async () => {
      const planId = await createPlan(defaultGymId, { name: 'No Price Plan' });
      const body = await priceOf(planId);
      expect(body.current_price).toBeNull();
      expect(body.amount_excl_tax).toBeNull();
      expect(body.amount_incl_tax).toBeNull();
    });
  });

  it('carries tax_rate_id and tax_behavior over to the duplicated plan', async () => {
    const taxRateId = await createTaxRate(gymId, 8);
    const planId = await createPlan(gymId, { name: 'Tax Duplicate Source Plan' });
    await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ tax_rate_id: taxRateId, tax_behavior: 'exclusive' });

    const res = await request
      .post(`/membership-plans/${planId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(201);
    expect(res.body.tax_rate_id).toBe(taxRateId);
    expect(res.body.tax_behavior).toBe('exclusive');
  });
});

// ─── GET /membership-plans/:id/example-timeline (#485, reshaped by #818) ──────

async function setPlanPrice(gymId: string, planId: number, price: number): Promise<void> {
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from) VALUES (?, ?, ?, CURDATE())`,
    [gymId, planId, price],
  );
}

async function setBillingPolicy(
  gymId: string,
  planId: number,
  interval: number,
  unit: string,
): Promise<void> {
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, ?, ?)`,
    [gymId, planId, interval, unit],
  );
}

describe('GET /membership-plans/:id/example-timeline', () => {
  let gymId: string;
  let otherGymId: string;
  let planId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Plans Example Timeline Gym');
    await createTestMembership(gymId, 'admin');
    otherGymId = await createTestGym('Plans Example Timeline Gym B');
    planId = await createPlan(gymId, { name: 'Timeline Plan' });
  });

  it('returns 401 without an Authorization header', async () => {
    const res = await request.get(`/membership-plans/${planId}/example-timeline`).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 404 when the plan belongs to a different gym', async () => {
    const otherPlanId = await createPlan(otherGymId, { name: 'Other Gym Timeline Plan' });
    const res = await request
      .get(`/membership-plans/${otherPlanId}/example-timeline`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('reports unavailable when the plan has no billing frequency', async () => {
    const bareId = await createPlan(gymId, { name: 'Bare Timeline Plan' });
    const res = await request
      .get(`/membership-plans/${bareId}/example-timeline`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.periods).toEqual([]);
  });

  // #818: the durations decide the Status of every row, which the #485 forecast
  // never looked at — and the projection charges nobody, as before.
  it('expands the plan durations into billing periods without creating any billing events', async () => {
    await setPlanPrice(gymId, planId, 60);
    await setBillingPolicy(gymId, planId, 1, 'month');
    // Free 1 / Paid 2 (1 of them pre-paid) / Bonus 1 → 4 configured periods + 2.
    await request
      .put(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ free_periods: 1, paid_periods: 2, pay_beforehand_periods: 1, bonus_periods: 1 });

    const { rows: beforeRows } = await db.query('SELECT COUNT(*) AS n FROM billing_events');

    const res = await request
      .get(`/membership-plans/${planId}/example-timeline`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.currency).toBe('EUR');
    expect(res.body.periods.map((p: any) => p.status)).toEqual([
      'free_plan', 'prepaid_plan', 'pay_plan', 'bonus_plan', 'pay_regular', 'pay_regular',
    ]);
    // Only a charged period quotes a price; a waived one says so. #946 — the
    // single Pre-paid period charges: it is where the Pre-paid Duration is
    // collected, one period's worth of it here.
    expect(res.body.periods.map((p: any) => p.amount)).toEqual([null, 60, 60, null, 60, 60]);
    expect(res.body.periods.map((p: any) => p.waived)).toEqual([true, false, false, true, false, false]);
    expect(res.body.periods.map((p: any) => p.prepaidPeriods)).toEqual([null, 1, null, null, null, null]);
    // The rows tile the calendar: each one ends the day before the next begins,
    // starting from the hypothetical enrollment date the response names.
    expect(res.body.periods[0].startsOn).toBe(res.body.anchorDate);
    for (let i = 0; i < res.body.periods.length - 1; i++) {
      const dayAfter = new Date(`${res.body.periods[i].endsOn}T00:00:00Z`);
      dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
      expect(dayAfter.toISOString().slice(0, 10)).toBe(res.body.periods[i + 1].startsOn);
    }
    // Only the trailing regular period is open-ended.
    expect(res.body.periods.filter((p: any) => p.endsOn === null)).toHaveLength(1);
    expect(res.body.periods[res.body.periods.length - 1].endsOn).toBeNull();

    const { rows: afterRows } = await db.query('SELECT COUNT(*) AS n FROM billing_events');
    expect(Number(afterRows[0].n)).toBe(Number(beforeRows[0].n));
  });

  it('embeds the same projection on GET /membership-plans/:id as example_timeline', async () => {
    const res = await request
      .get(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.example_timeline.available).toBe(true);
    expect(res.body.example_timeline.periods).toHaveLength(6);
    expect(res.body.billing_forecast).toBeUndefined();
  });
});

// ─── POST /membership-plans/:id/assign (#376 — instantiate a Plan into a Membership) ──

describe('POST /membership-plans/:id/assign', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Plans Assign Gym');
    await createTestMembership(gymId, 'admin');
  });

  // ── Auth / role / tenant guards ──

  it('returns 401 without auth', async () => {
    const res = await request
      .post('/membership-plans/1/assign')
      .set('x-gym-id', gymId)
      .send({});
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no membership in this gym', async () => {
    const otherGym = await createTestGym('Assign No Membership Gym');
    const res = await request
      .post('/membership-plans/1/assign')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGym)
      .send({ member_ids: [1], owner_member_id: 1, starts_at: '2026-01-01' });
    expect(res.status).toBe(403);
  });

  it('returns 403 when called by a non-admin role', async () => {
    const gymRO = await createTestGym('Assign Role Guard Gym');
    await createTestMembership(gymRO, 'front_desk');
    const planId = await createPlan(gymRO, { name: 'Assign Role Guard Plan', member_limit: '1' });
    const memberId = await createMember(gymRO);
    const res = await request
      .post(`/membership-plans/${planId}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymRO)
      .send({ member_ids: [memberId], owner_member_id: memberId, starts_at: '2026-01-01' });
    expect(res.status).toBe(403);
  });

  it('returns 404 for a non-existent plan', async () => {
    const res = await request
      .post('/membership-plans/9999999/assign')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_ids: [1], owner_member_id: 1, starts_at: '2026-01-01' });
    expect(res.status).toBe(404);
  });

  it('returns 404 for a soft-deleted plan', async () => {
    const planId = await createPlan(gymId, { name: 'Assign Soft Deleted Plan', member_limit: '1' });
    await db.query('UPDATE membership_plans SET deleted_at = NOW() WHERE id = ?', [planId]);
    const memberId = await createMember(gymId);
    const res = await request
      .post(`/membership-plans/${planId}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_ids: [memberId], owner_member_id: memberId, starts_at: '2026-01-01' });
    expect(res.status).toBe(404);
  });

  it('returns 404 when the plan belongs to another gym (cross-gym tenant isolation)', async () => {
    const gymOther = await createTestGym('Assign Cross Gym Plan Owner');
    const planInOtherGym = await createPlan(gymOther, { name: 'Cross Gym Assign Plan', member_limit: '1' });
    const memberId = await createMember(gymId);
    const res = await request
      // caller has admin access to gymId; the plan itself lives in gymOther.
      .post(`/membership-plans/${planInOtherGym}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_ids: [memberId], owner_member_id: memberId, starts_at: '2026-01-01' });
    expect(res.status).toBe(404);
  });

  // ── Body validation ──

  it('returns 400 when member_ids is missing', async () => {
    const planId = await createPlan(gymId, { name: 'Assign Missing MemberIds Plan', member_limit: '1' });
    const memberId = await createMember(gymId);
    const res = await request
      .post(`/membership-plans/${planId}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ owner_member_id: memberId, starts_at: '2026-01-01' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/member_ids/i);
  });

  it('returns 400 when member_ids is an empty array', async () => {
    const planId = await createPlan(gymId, { name: 'Assign Empty MemberIds Plan', member_limit: '1' });
    const res = await request
      .post(`/membership-plans/${planId}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_ids: [], owner_member_id: 1, starts_at: '2026-01-01' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/member_ids/i);
  });

  it('returns 400 when starts_at is missing', async () => {
    const planId = await createPlan(gymId, { name: 'Assign Missing StartsAt Plan', member_limit: '1' });
    const memberId = await createMember(gymId);
    const res = await request
      .post(`/membership-plans/${planId}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_ids: [memberId], owner_member_id: memberId });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/starts_at/i);
  });

  it('returns 400 when owner_member_id is not one of member_ids', async () => {
    const planId = await createPlan(gymId, { name: 'Assign Bad Owner Plan', member_limit: '1' });
    const memberId = await createMember(gymId);
    const otherMemberId = await createMember(gymId);
    const res = await request
      .post(`/membership-plans/${planId}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_ids: [memberId], owner_member_id: otherMemberId, starts_at: '2026-01-01' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/owner_member_id/i);
  });

  it('returns 400 when a member_limit="1" plan is submitted with 2 members', async () => {
    const planId = await createPlan(gymId, { name: 'Assign Limit1 Overflow Plan', member_limit: '1' });
    const m1 = await createMember(gymId);
    const m2 = await createMember(gymId);
    const res = await request
      .post(`/membership-plans/${planId}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_ids: [m1, m2], owner_member_id: m1, starts_at: '2026-01-01' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exactly 1 member/i);
  });

  it('returns 400 when a member_limit="2" plan is submitted with only 1 member', async () => {
    const planId = await createPlan(gymId, { name: 'Assign Limit2 Underflow Plan', member_limit: '2' });
    const m1 = await createMember(gymId);
    const res = await request
      .post(`/membership-plans/${planId}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_ids: [m1], owner_member_id: m1, starts_at: '2026-01-01' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exactly 2 member/i);
  });

  it('returns 400 when a submitted member_id does not exist', async () => {
    const planId = await createPlan(gymId, { name: 'Assign Nonexistent Member Plan', member_limit: '1' });
    const res = await request
      .post(`/membership-plans/${planId}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_ids: [9999999], owner_member_id: 9999999, starts_at: '2026-01-01' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns 400 when a submitted member_id is soft-deleted', async () => {
    const planId = await createPlan(gymId, { name: 'Assign Deleted Member Plan', member_limit: '1' });
    const memberId = await createMember(gymId);
    await db.query('UPDATE members SET deleted_at = NOW() WHERE id = ?', [memberId]);
    const res = await request
      .post(`/membership-plans/${planId}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_ids: [memberId], owner_member_id: memberId, starts_at: '2026-01-01' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns 400 when a submitted member_id belongs to another gym', async () => {
    const planId = await createPlan(gymId, { name: 'Assign Cross Gym Member Plan', member_limit: '1' });
    const otherGym = await createTestGym('Assign Foreign Member Gym');
    const foreignMemberId = await createMember(otherGym);
    const res = await request
      .post(`/membership-plans/${planId}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_ids: [foreignMemberId], owner_member_id: foreignMemberId, starts_at: '2026-01-01' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found/i);
  });

  // ── Happy path: member_limit = '1' ──

  it('assigns a member_limit="1" plan: creates the membership, the covered member, and a billing event', async () => {
    const planId = await createPlan(gymId, { name: 'Assign Single Happy Plan', member_limit: '1' });
    const memberId = await createMember(gymId);

    const res = await request
      .post(`/membership-plans/${planId}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_ids: [memberId], owner_member_id: memberId, starts_at: '2026-01-01' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');
    expect(res.body.member_id).toBe(memberId);
    expect(res.body.membership_plan_id).toBe(planId);
    expect(Array.isArray(res.body.members)).toBe(true);
    expect(res.body.members).toHaveLength(1);
    expect(res.body.members[0].member_id).toBe(memberId);
    expect(Number(res.body.members[0].is_owner)).toBe(1);

    const userMembershipId = res.body.id;

    const { rows: umRows } = await db.query(
      'SELECT * FROM user_memberships WHERE id = ?',
      [userMembershipId],
    );
    expect(umRows).toHaveLength(1);
    expect(umRows[0].status).toBe('active');
    expect(umRows[0].member_id).toBe(memberId);

    const { rows: ummRows } = await db.query(
      'SELECT * FROM user_membership_members WHERE user_membership_id = ?',
      [userMembershipId],
    );
    expect(ummRows).toHaveLength(1);
    expect(ummRows[0].member_id).toBe(memberId);
    expect(Number(ummRows[0].is_owner)).toBe(1);

    const { rows: beRows } = await db.query(
      `SELECT * FROM billing_events WHERE user_membership_id = ? AND event_type = 'status_changed'`,
      [userMembershipId],
    );
    expect(beRows).toHaveLength(1);
    expect(beRows[0].new_status).toBe('active');
    expect(beRows[0].previous_status).toBeNull();
    expect(beRows[0].member_id).toBe(memberId);
  });

  // ── Happy path: member_limit = '2' ──

  it('assigns a member_limit="2" plan with two members and an explicit owner', async () => {
    const planId = await createPlan(gymId, { name: 'Assign Couple Happy Plan', member_limit: '2' });
    const owner = await createMember(gymId);
    const partner = await createMember(gymId);

    const res = await request
      .post(`/membership-plans/${planId}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_ids: [owner, partner], owner_member_id: owner, starts_at: '2026-01-01' });

    expect(res.status).toBe(201);
    expect(res.body.member_id).toBe(owner);
    expect(res.body.members).toHaveLength(2);

    const userMembershipId = res.body.id;

    const { rows: umRows } = await db.query(
      'SELECT member_id FROM user_memberships WHERE id = ?',
      [userMembershipId],
    );
    expect(umRows[0].member_id).toBe(owner);

    const { rows: ummRows } = await db.query(
      'SELECT member_id, is_owner FROM user_membership_members WHERE user_membership_id = ?',
      [userMembershipId],
    );
    expect(ummRows).toHaveLength(2);
    const ownerRow = ummRows.find((r: any) => r.member_id === owner);
    const partnerRow = ummRows.find((r: any) => r.member_id === partner);
    expect(ownerRow).toBeDefined();
    expect(partnerRow).toBeDefined();
    expect(Number(ownerRow.is_owner)).toBe(1);
    expect(Number(partnerRow.is_owner)).toBe(0);
  });

  // ── The member already has a Membership Plan (409) ──
  // #956 (migration 213) reverses #634 §6/§14: a Member holds zero or one
  // Membership Plan, so the 409 fires on *any* second live assignment and not
  // only on a second assignment of the same Plan. The replacement path this
  // route grew for it is covered in one-active-membership-plan.test.ts.

  it('returns 409 for a second live membership on a different plan, and cancels nothing', async () => {
    const existingPlanId = await createPlan(gymId, { name: 'Assign Existing Active Plan', member_limit: '1' });
    const newPlanId = await createPlan(gymId, { name: 'Assign Parallel Target Plan', member_limit: '1' });
    const memberId = await createMember(gymId);
    await createActiveUserMembership(gymId, memberId, existingPlanId);

    const res = await request
      .post(`/membership-plans/${newPlanId}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_ids: [memberId], owner_member_id: memberId, starts_at: '2026-01-01' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('active_plan_exists');

    // Nothing is cancelled until the admin confirms the replacement.
    const { rows } = await db.query(
      'SELECT status FROM user_memberships WHERE gym_id = ? AND member_id = ? AND membership_plan_id = ?',
      [gymId, memberId, existingPlanId],
    );
    expect(rows.map((r: any) => r.status)).toEqual(['active']);
  });

  it('returns 409 when the member already has an active membership on the same plan', async () => {
    const planId = await createPlan(gymId, { name: 'Assign Duplicate Target Plan', member_limit: '1' });
    const memberId = await createMember(gymId);
    await createActiveUserMembership(gymId, memberId, planId);

    const res = await request
      .post(`/membership-plans/${planId}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_ids: [memberId], owner_member_id: memberId, starts_at: '2026-01-01' });
    expect(res.status).toBe(409);
  });
});

// ─── Pricing (#547) ──────────────────────────────────────────────────────────
// PUT /:id/pricing replaces the plan's current VAT-inclusive price; the
// superseded price stays in the history untouched. POST
// /:id/pricing/apply-to-assigned-plans pushes the current price onto the
// Assigned Plans still running on the plan.

describe('Membership Plan Pricing (#547)', () => {
  let gymId: string;
  let otherGymId: string;
  let taxRate21: number;
  let taxRate10: number;

  async function createPricingTaxRate(gId: string, ratePercent: number): Promise<number> {
    const { insertId } = await db.query(
      `INSERT INTO tax_rates (gym_id, name, rate_percent, is_system, status) VALUES (?, ?, ?, 0, 'active')`,
      [gId, `Pricing Tax ${ratePercent}%-${Math.random().toString(36).slice(2, 6)}`, ratePercent],
    );
    return insertId;
  }

  async function priceRows(planId: number): Promise<any[]> {
    const { rows } = await db.query(
      'SELECT * FROM membership_plan_prices WHERE membership_plan_id = ? ORDER BY id ASC',
      [planId],
    );
    return rows;
  }

  function savePricing(planId: number, body: Record<string, unknown>, gId = gymId) {
    return request
      .put(`/membership-plans/${planId}/pricing`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gId)
      .send(body);
  }

  beforeAll(async () => {
    gymId = await createTestGym('Plans Pricing Gym');
    await createTestMembership(gymId, 'admin');
    otherGymId = await createTestGym('Plans Pricing Gym B');
    taxRate21 = await createPricingTaxRate(gymId, 21);
    taxRate10 = await createPricingTaxRate(gymId, 10);
  });

  // ── Auth / roles ──

  it('returns 401 without an Authorization header', async () => {
    const planId = await createPlan(gymId, { name: 'Pricing Auth Plan' });
    const res = await request
      .put(`/membership-plans/${planId}/pricing`)
      .set('x-gym-id', gymId)
      .send({ price: 50 });
    expect(res.status).toBe(401);
  });

  it('returns 403 when a read-only role saves pricing', async () => {
    const gymRO = await createTestGym('Pricing Role Guard Gym');
    await createTestMembership(gymRO, 'front_desk');
    const planId = await createPlan(gymRO, { name: 'Pricing Role Guard Plan' });
    const res = await savePricing(planId, { price: 50 }, gymRO);
    expect(res.status).toBe(403);
  });

  it('returns 403 when a read-only role applies the price to assigned plans', async () => {
    const gymRO = await createTestGym('Pricing Apply Role Guard Gym');
    await createTestMembership(gymRO, 'front_desk');
    const planId = await createPlan(gymRO, { name: 'Pricing Apply Role Guard Plan' });
    const res = await request
      .post(`/membership-plans/${planId}/pricing/apply-to-assigned-plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymRO);
    expect(res.status).toBe(403);
  });

  // ── Tenant isolation ──

  it("returns 404 for a plan belonging to another gym", async () => {
    const planId = await createPlan(otherGymId, { name: 'Pricing Other Gym Plan' });
    const res = await savePricing(planId, { price: 50 });
    expect(res.status).toBe(404);
  });

  it("rejects a tax rate belonging to another gym", async () => {
    const foreignTaxRateId = await createPricingTaxRate(otherGymId, 7);
    const planId = await createPlan(gymId, { name: 'Pricing Foreign Tax Plan' });
    const res = await savePricing(planId, { price: 50, tax_rate_id: foreignTaxRateId });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tax_rate_id/i);
  });

  // ── Validation ──

  it('rejects a negative price', async () => {
    const planId = await createPlan(gymId, { name: 'Pricing Negative Plan' });
    const res = await savePricing(planId, { price: -1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-negative/i);
  });

  it('rejects a missing price', async () => {
    const planId = await createPlan(gymId, { name: 'Pricing Missing Price Plan' });
    const res = await savePricing(planId, { tax_rate_id: taxRate21 });
    expect(res.status).toBe(400);
  });

  // ── Happy path ──

  it('saves the price as the VAT-inclusive customer price and derives the net from it', async () => {
    const planId = await createPlan(gymId, { name: 'Pricing Happy Plan' });
    const res = await savePricing(planId, { price: 121, tax_rate_id: taxRate21 });
    expect(res.status).toBe(200);
    expect(res.body.current_price).toBe('121.00');
    expect(res.body.tax_behavior).toBe('inclusive');
    expect(res.body.tax_rate_id).toBe(taxRate21);
    expect(res.body.amount_incl_tax).toBeCloseTo(121, 2);
    expect(res.body.amount_excl_tax).toBeCloseTo(100, 2);

    const rows = await priceRows(planId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('active');
    expect(Number(rows[0].tax_rate_percent)).toBeCloseTo(21, 2);
  });

  it('a 0% tax rate leaves the price unchanged', async () => {
    const zeroRate = await createPricingTaxRate(gymId, 0);
    const planId = await createPlan(gymId, { name: 'Pricing Zero Rate Plan' });
    const res = await savePricing(planId, { price: 45.5, tax_rate_id: zeroRate });
    expect(res.status).toBe(200);
    expect(res.body.amount_excl_tax).toBeCloseTo(45.5, 2);
    expect(res.body.amount_incl_tax).toBeCloseTo(45.5, 2);
  });

  // ── Price history invariants ──

  it('moves the superseded price to the history and keeps its amount untouched', async () => {
    const planId = await createPlan(gymId, { name: 'Pricing History Plan' });
    await savePricing(planId, { price: 100, tax_rate_id: taxRate21 });
    const res = await savePricing(planId, { price: 120, tax_rate_id: taxRate21 });
    expect(res.status).toBe(200);
    expect(res.body.current_price).toBe('120.00');

    const rows = await priceRows(planId);
    expect(rows).toHaveLength(2);
    const [old_, current] = rows;
    expect(Number(old_.price)).toBeCloseTo(100, 2);
    expect(old_.status).toBe('inactive');
    expect(Number(current.price)).toBeCloseTo(120, 2);
    expect(current.status).toBe('active');
    expect(res.body.price_history).toHaveLength(2);
  });

  it('a VAT change also opens a new price and files the old one in the history', async () => {
    const planId = await createPlan(gymId, { name: 'Pricing VAT Change Plan' });
    await savePricing(planId, { price: 100, tax_rate_id: taxRate21 });
    const res = await savePricing(planId, { price: 100, tax_rate_id: taxRate10 });
    expect(res.status).toBe(200);
    expect(res.body.tax_rate_id).toBe(taxRate10);
    expect(res.body.amount_excl_tax).toBeCloseTo(90.91, 2);

    const rows = await priceRows(planId);
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe('inactive');
    expect(Number(rows[0].tax_rate_percent)).toBeCloseTo(21, 2);
    expect(rows[1].status).toBe('active');
    expect(Number(rows[1].tax_rate_percent)).toBeCloseTo(10, 2);
  });

  it('saving the same price and VAT again does not add a history row', async () => {
    const planId = await createPlan(gymId, { name: 'Pricing Idempotent Plan' });
    await savePricing(planId, { price: 80, tax_rate_id: taxRate21 });
    const res = await savePricing(planId, { price: 80, tax_rate_id: taxRate21 });
    expect(res.status).toBe(200);
    expect(await priceRows(planId)).toHaveLength(1);
  });

  it("an explicit null tax_rate_id falls back to the gym's system tax rate", async () => {
    const { insertId: systemRateId } = await db.query(
      `INSERT INTO tax_rates (gym_id, name, rate_percent, is_system, status) VALUES (?, 'System VAT', 21, 1, 'active')`,
      [gymId],
    );
    const planId = await createPlan(gymId, { name: 'Pricing Default Tax Plan' });
    await savePricing(planId, { price: 100, tax_rate_id: taxRate10 });
    const res = await savePricing(planId, { price: 100, tax_rate_id: null });
    expect(res.status).toBe(200);
    expect(res.body.tax_rate_id).toBe(systemRateId);
  });

  it('reports a price whose window has expired as inactive without a rewrite', async () => {
    const planId = await createPlan(gymId, { name: 'Pricing Expired Window Plan' });
    await savePricing(planId, { price: 55, tax_rate_id: taxRate21 });
    // Simulate the calendar moving past the window: the row keeps its stored
    // 'active' status, which only a later price write would recompute.
    await db.query(
      `UPDATE membership_plan_prices SET valid_to = DATE_SUB(UTC_DATE(), INTERVAL 1 DAY)
        WHERE membership_plan_id = ?`,
      [planId],
    );
    const res = await request
      .get(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.current_price).toBeNull();
    expect(res.body.price_history).toHaveLength(1);
    expect(res.body.price_history[0].status).toBe('inactive');
  });

  // ── Apply to assigned plans ──

  it('applies the current price to the assigned plans still running on the plan', async () => {
    const planId = await createPlan(gymId, { name: 'Pricing Apply Plan' });
    await savePricing(planId, { price: 60, tax_rate_id: taxRate21 });
    const memberId = await createMember(gymId);
    const membershipId = await createActiveUserMembership(gymId, memberId, planId);
    await db.query('UPDATE user_memberships SET base_price = 40, membership_fee_price = 40 WHERE id = ?', [membershipId]);

    await savePricing(planId, { price: 75, tax_rate_id: taxRate21 });
    const res = await request
      .post(`/membership-plans/${planId}/pricing/apply-to-assigned-plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
    expect(res.body.kept_discounted).toBe(0);
    expect(res.body.price).toBeCloseTo(75, 2);

    const { rows } = await db.query('SELECT * FROM user_memberships WHERE id = ?', [membershipId]);
    expect(Number(rows[0].base_price)).toBeCloseTo(75, 2);
    expect(Number(rows[0].membership_fee_price)).toBeCloseTo(75, 2);

    const prices = await priceRows(planId);
    const current = prices.find((p) => Number(p.price) === 75);
    expect(current.status).toBe('applied');
    expect(current.applied_at).not.toBeNull();
  });

  it('keeps the agreed price of an assigned plan that has a discount', async () => {
    const planId = await createPlan(gymId, { name: 'Pricing Apply Discount Plan' });
    await savePricing(planId, { price: 100, tax_rate_id: taxRate21 });
    const memberId = await createMember(gymId);
    const membershipId = await createActiveUserMembership(gymId, memberId, planId);
    await db.query(
      "UPDATE user_memberships SET base_price = 100, membership_fee_price = 80, discount_reason = 'Loyalty' WHERE id = ?",
      [membershipId],
    );

    await savePricing(planId, { price: 130, tax_rate_id: taxRate21 });
    const res = await request
      .post(`/membership-plans/${planId}/pricing/apply-to-assigned-plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(0);
    expect(res.body.kept_discounted).toBe(1);

    const { rows } = await db.query('SELECT * FROM user_memberships WHERE id = ?', [membershipId]);
    expect(Number(rows[0].base_price)).toBeCloseTo(130, 2);
    expect(Number(rows[0].membership_fee_price)).toBeCloseTo(80, 2);
  });

  it('never touches a cancelled assigned plan or an already-generated billing event', async () => {
    const planId = await createPlan(gymId, { name: 'Pricing Apply History Plan' });
    await savePricing(planId, { price: 50, tax_rate_id: taxRate21 });
    const memberId = await createMember(gymId);
    const membershipId = await createActiveUserMembership(gymId, memberId, planId);
    await db.query(
      "UPDATE user_memberships SET status = 'cancelled', base_price = 50, membership_fee_price = 50 WHERE id = ?",
      [membershipId],
    );
    const { insertId: eventId } = await db.query(
      `INSERT INTO billing_events (gym_id, user_membership_id, member_id, event_type, amount, source)
       VALUES (?, ?, ?, 'charge_created', 50.00, 'admin')`,
      [gymId, membershipId, memberId],
    );

    await savePricing(planId, { price: 90, tax_rate_id: taxRate21 });
    const res = await request
      .post(`/membership-plans/${planId}/pricing/apply-to-assigned-plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(0);

    const { rows: umRows } = await db.query('SELECT * FROM user_memberships WHERE id = ?', [membershipId]);
    expect(Number(umRows[0].membership_fee_price)).toBeCloseTo(50, 2);
    const { rows: beRows } = await db.query('SELECT * FROM billing_events WHERE id = ?', [eventId]);
    expect(Number(beRows[0].amount)).toBeCloseTo(50, 2);
  });

  it('returns 400 when the plan has no current price to apply', async () => {
    const planId = await createPlan(gymId, { name: 'Pricing Apply No Price Plan' });
    const res = await request
      .post(`/membership-plans/${planId}/pricing/apply-to-assigned-plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no current price/i);
  });

  it("returns 404 when applying the price of another gym's plan", async () => {
    const planId = await createPlan(otherGymId, { name: 'Pricing Apply Other Gym Plan' });
    const res = await request
      .post(`/membership-plans/${planId}/pricing/apply-to-assigned-plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  // ── Duplication (req. 17) ──

  it('carries the price and its VAT snapshot to a duplicated plan without the applied marker', async () => {
    const planId = await createPlan(gymId, { name: 'Pricing Duplicate Source' });
    await savePricing(planId, { price: 110, tax_rate_id: taxRate10 });
    const memberId = await createMember(gymId);
    await createActiveUserMembership(gymId, memberId, planId);
    await request
      .post(`/membership-plans/${planId}/pricing/apply-to-assigned-plans`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    const res = await request
      .post(`/membership-plans/${planId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(201);
    expect(res.body.current_price).toBe('110.00');
    expect(res.body.tax_rate_id).toBe(taxRate10);

    const copies = await priceRows(res.body.id);
    expect(copies).toHaveLength(1);
    expect(copies[0].status).toBe('active');
    expect(copies[0].applied_at).toBeNull();
    expect(Number(copies[0].tax_rate_percent)).toBeCloseTo(10, 2);
  });
});

// #820 — the Billing frequency is a choice of two.
//
// The dropdown is the UI half; this is the rule. `PUT
// /membership-plans/:id/billing-policy` is the only route that configures a
// Plan's cadence, and it now accepts Month (1 month) and 4 Weeks (4 week) only,
// so the single dropdown cannot be worked around by a caller and a cadence
// nobody sells can never reach an assignment's snapshot.
describe('PUT /membership-plans/:id/billing-policy — the two accepted cadences (#820)', () => {
  let gymId: string;
  let planId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Plans Billing Frequency Gym');
    await createTestMembership(gymId, 'admin');
    planId = await createPlan(gymId, { name: 'Billing Frequency Plan' });
  });

  const put = (body: Record<string, unknown>) =>
    request
      .put(`/membership-plans/${planId}/billing-policy`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send(body);

  it('accepts Month — 1 month', async () => {
    const res = await put({ recurring_billing_interval: 1, recurring_billing_unit: 'month', auto_renew: true });
    expect(res.status).toBe(200);
    expect(Number(res.body.recurring_billing_interval)).toBe(1);
    expect(res.body.recurring_billing_unit).toBe('month');
  });

  it('accepts 4 Weeks — 4 week', async () => {
    const res = await put({ recurring_billing_interval: 4, recurring_billing_unit: 'week', auto_renew: true });
    expect(res.status).toBe(200);
    expect(Number(res.body.recurring_billing_interval)).toBe(4);
    expect(res.body.recurring_billing_unit).toBe('week');
  });

  it.each([
    [2, 'month'],
    [1, 'week'],
    [3, 'day'],
    [1, 'year'],
  ])('rejects %i %s with 400', async (interval, unit) => {
    const res = await put({ recurring_billing_interval: interval, recurring_billing_unit: unit, auto_renew: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('1 month, 4 week');
  });

  it('keeps the cadence it had when a rejected pair is sent', async () => {
    await put({ recurring_billing_interval: 4, recurring_billing_unit: 'week', auto_renew: true });
    const rejected = await put({ recurring_billing_interval: 2, recurring_billing_unit: 'month', auto_renew: true });
    expect(rejected.status).toBe(400);
    const { rows } = await db.query<{ recurring_billing_interval: number; recurring_billing_unit: string }>(
      'SELECT recurring_billing_interval, recurring_billing_unit FROM billing_policies WHERE membership_plan_id = ? AND gym_id = ?',
      [planId, gymId],
    );
    expect(Number(rows[0].recurring_billing_interval)).toBe(4);
    expect(rows[0].recurring_billing_unit).toBe('week');
  });

  it('still rejects a malformed pair before it reaches the cadence rule', async () => {
    const noInterval = await put({ recurring_billing_unit: 'month', auto_renew: true });
    expect(noInterval.status).toBe(400);
    expect(noInterval.body.error).toContain('recurring_billing_interval must be a positive integer');

    const badUnit = await put({ recurring_billing_interval: 1, recurring_billing_unit: 'fortnight', auto_renew: true });
    expect(badUnit.status).toBe(400);
    expect(badUnit.body.error).toContain('recurring_billing_unit must be one of');
  });

  it('leaves a legacy cadence readable — it is only writing one that is refused', async () => {
    // A Plan configured before #820. Nothing rewrites it, and the card must
    // keep showing what it bills on, so the read path never filters it.
    const legacyPlanId = await createPlan(gymId, { name: 'Legacy Cadence Plan' });
    await db.query(
      `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit, auto_renew)
       VALUES (?, ?, 2, 'month', 1)`,
      [gymId, legacyPlanId],
    );
    const res = await request
      .get(`/membership-plans/${legacyPlanId}/billing-policy`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Number(res.body.recurring_billing_interval)).toBe(2);
    expect(res.body.recurring_billing_unit).toBe('month');
  });
});

// ─── GET /membership-plans/:id/billing-event-simulation (#915) ─────────────────
//
// The projection is unit-tested in `plan-billing-event-simulation.test.ts`; what
// is checked here is the wiring the engine cannot see: tenancy, auth, that the
// three Benefit sections and their prices actually reach it, and that reading it
// bills nobody.

async function createSellableItem(
  gymId: string,
  name: string,
  type: string,
  billingFrequency: string,
  amount: number,
  overrides: { mandatory?: boolean } = {},
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO gym_charges (gym_id, name, type, billing_frequency, amount, status, is_system, currency, mandatory, tax_behavior)
     VALUES (?, ?, ?, ?, ?, 'active', 0, 'EUR', ?, 'inclusive')`,
    [gymId, name, type, billingFrequency, amount, overrides.mandatory ? 1 : 0],
  );
  return insertId;
}

describe('GET /membership-plans/:id/billing-event-simulation', () => {
  let gymId: string;
  let otherGymId: string;
  let planId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Plans Billing Event Simulation Gym');
    await createTestMembership(gymId, 'admin');
    otherGymId = await createTestGym('Plans Billing Event Simulation Gym B');
    planId = await createPlan(gymId, { name: 'Simulation Plan' });
  });

  it('returns 401 without an Authorization header', async () => {
    const res = await request
      .get(`/membership-plans/${planId}/billing-event-simulation`)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 404 when the plan belongs to a different gym', async () => {
    const otherPlanId = await createPlan(otherGymId, { name: 'Other Gym Simulation Plan' });
    const res = await request
      .get(`/membership-plans/${otherPlanId}/billing-event-simulation`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('reports unavailable when the plan has no billing frequency', async () => {
    const bareId = await createPlan(gymId, { name: 'Bare Simulation Plan' });
    const res = await request
      .get(`/membership-plans/${bareId}/billing-event-simulation`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toBeTruthy();
    expect(res.body.dates).toEqual([]);
  });

  it('groups the fee and every configured Sellable Item by billing date, and charges nobody', async () => {
    await setPlanPrice(gymId, planId, 70);
    await setBillingPolicy(gymId, planId, 4, 'week');

    const registration = await createSellableItem(gymId, `Registration ${Date.now()}`, 'fee', 'once', 100);
    const locker = await createSellableItem(gymId, `Locker ${Date.now()}`, 'service', 'month', 15);
    await request
      .put(`/membership-plans/${planId}/oneoff-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ gym_charge_id: registration, quantity: 1 }] });
    await request
      .put(`/membership-plans/${planId}/periodical-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ items: [{ gym_charge_id: locker, quantity: 1, action: 'waive' }] });

    const { rows: before } = await db.query('SELECT COUNT(*) AS n FROM billing_events');
    const res = await request
      .get(`/membership-plans/${planId}/billing-event-simulation`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.currency).toBe('EUR');
    expect(res.body.tax_included).toBe(true);
    expect(res.body.dates.length).toBeGreaterThanOrEqual(3);

    // The first date carries everything that falls on it: the one-off, the
    // waived periodical and the Membership Fee.
    const first = res.body.dates[0];
    expect(first.date).toBe(res.body.anchor_date);
    const byCharge = new Map<number | null, any>(first.lines.map((l: any) => [l.gym_charge_id, l]));
    expect(byCharge.get(registration).actual_charge).toBe(100);
    // `Waive` still produces an event, at €0 (the ticket's §Waive).
    expect(byCharge.get(locker).regular_price).toBe(15);
    expect(byCharge.get(locker).actual_charge).toBe(0);
    expect(byCharge.get(null).kind).toBe('membership_fee');
    expect(byCharge.get(null).actual_charge).toBe(70);
    expect(first.total).toBe(170);

    // A `Once` item is billed once and never repeats.
    const repeats = res.body.dates
      .slice(1)
      .flatMap((g: any) => g.lines.map((l: any) => l.gym_charge_id));
    expect(repeats).not.toContain(registration);

    // Read-only: no billing event, payment request or charge is created.
    const { rows: after } = await db.query('SELECT COUNT(*) AS n FROM billing_events');
    expect(Number(after[0].n)).toBe(Number(before[0].n));
  });

  // #893 — a Mandatory item is part of every Plan even before the Plan is saved
  // again, so it has to reach the simulation from the catalogue, priced.
  it('includes a Mandatory item the plan has no stored benefit row for', async () => {
    const mandatoryGymId = await createTestGym('Plans Simulation Mandatory Gym');
    await createTestMembership(mandatoryGymId, 'admin');
    const insuranceId = await createSellableItem(
      mandatoryGymId, `Insurance ${Date.now()}`, 'fee', 'once', 20, { mandatory: true },
    );
    const mandatoryPlanId = await createPlan(mandatoryGymId, { name: 'Mandatory Simulation Plan' });
    await setPlanPrice(mandatoryGymId, mandatoryPlanId, 70);
    await setBillingPolicy(mandatoryGymId, mandatoryPlanId, 1, 'month');

    const res = await request
      .get(`/membership-plans/${mandatoryPlanId}/billing-event-simulation`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', mandatoryGymId);
    expect(res.status).toBe(200);
    const line = res.body.dates[0].lines.find((l: any) => l.gym_charge_id === insuranceId);
    expect(line).toBeTruthy();
    expect(line.mandatory).toBe(true);
    expect(line.actual_charge).toBe(20);
    expect(res.body.dates[0].total).toBe(90);
  });

  // The card renders the embedded copy; the route exists so a client can refresh
  // one Plan. They must be the same calculation, not two.
  it('is embedded on the plan itself as billing_event_simulation', async () => {
    const res = await request
      .get(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const direct = await request
      .get(`/membership-plans/${planId}/billing-event-simulation`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.body.billing_event_simulation).toEqual(direct.body);
  });
});
