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

// #376: creates a gym-scoped charge (borrowing an existing gym-charge charge_type,
// seeded by migration 090) so a plan_charge_benefits row can reference it. Picks a
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

async function addPlanChargeBenefit(
  gymId: string,
  planId: number,
  gymChargeId: number,
  action: string,
  value: number | null,
): Promise<void> {
  await db.query(
    'INSERT INTO plan_charge_benefits (gym_id, membership_plan_id, gym_charge_id, action, value) VALUES (?, ?, ?, ?, ?)',
    [gymId, planId, gymChargeId, action, value],
  );
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
    expect(res.body).toHaveProperty('allowances');
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

// #409: GET /:id/charge-benefits used to INNER JOIN charge_types, which
// silently dropped any benefit whose gym_charge is a custom sellable item
// (charge_type_id is NULL for those — only system items have one).
describe('GET /membership-plans/:id/charge-benefits', () => {
  let gymId: string;
  let planId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Plans Charge Benefits Gym');
    await createTestMembership(gymId, 'admin');
    planId = await createPlan(gymId, { name: 'Charge Benefits Plan' });
  });

  it('includes a benefit assigned to a custom sellable item (no charge_type_id)', async () => {
    const customChargeId = await createCustomGymCharge(gymId, 'Custom Discount Item');
    await addPlanChargeBenefit(gymId, planId, customChargeId, 'percentage_discount', 10);

    const res = await request
      .get(`/membership-plans/${planId}/charge-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const benefit = res.body.find((b: any) => b.gym_charge_id === customChargeId);
    expect(benefit).toBeDefined();
    expect(benefit.gym_charge_name).toBe('Custom Discount Item');
  });

  it('includes a benefit assigned to a system sellable item (has charge_type_id)', async () => {
    const systemChargeId = await createGymCharge(gymId);
    await addPlanChargeBenefit(gymId, planId, systemChargeId, 'waive', null);

    const res = await request
      .get(`/membership-plans/${planId}/charge-benefits`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const benefit = res.body.find((b: any) => b.gym_charge_id === systemChargeId);
    expect(benefit).toBeDefined();
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

  // ── Charge benefit snapshot (#376 item 6/9) ──

  it("snapshots the plan's current charge benefits onto the new membership", async () => {
    const planId = await createPlan(gymId, { name: 'Assign Benefit Snapshot Plan', member_limit: '1' });
    const gymChargeId = await createGymCharge(gymId);
    await addPlanChargeBenefit(gymId, planId, gymChargeId, 'percentage_discount', 25);
    const memberId = await createMember(gymId);

    const res = await request
      .post(`/membership-plans/${planId}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_ids: [memberId], owner_member_id: memberId, starts_at: '2026-01-01' });
    expect(res.status).toBe(201);
    const userMembershipId = res.body.id;

    const { rows: benefitRows } = await db.query(
      'SELECT * FROM user_membership_charge_benefits WHERE user_membership_id = ?',
      [userMembershipId],
    );
    expect(benefitRows).toHaveLength(1);
    expect(benefitRows[0].gym_charge_id).toBe(gymChargeId);
    expect(benefitRows[0].action).toBe('percentage_discount');
    expect(Number(benefitRows[0].value)).toBe(25);
  });

  it('does not snapshot a "no_benefit" charge benefit row', async () => {
    const planId = await createPlan(gymId, { name: 'Assign No Benefit Snapshot Plan', member_limit: '1' });
    const gymChargeId = await createGymCharge(gymId);
    await addPlanChargeBenefit(gymId, planId, gymChargeId, 'no_benefit', null);
    const memberId = await createMember(gymId);

    const res = await request
      .post(`/membership-plans/${planId}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_ids: [memberId], owner_member_id: memberId, starts_at: '2026-01-01' });
    expect(res.status).toBe(201);
    const userMembershipId = res.body.id;

    const { rows: benefitRows } = await db.query(
      'SELECT * FROM user_membership_charge_benefits WHERE user_membership_id = ?',
      [userMembershipId],
    );
    expect(benefitRows).toHaveLength(0);
  });

  // ── Duplicate active membership (409) ──

  it('returns 409 when the member already has an active membership on any plan', async () => {
    const existingPlanId = await createPlan(gymId, { name: 'Assign Existing Active Plan', member_limit: '1' });
    const newPlanId = await createPlan(gymId, { name: 'Assign Duplicate Target Plan', member_limit: '1' });
    const memberId = await createMember(gymId);
    await createActiveUserMembership(gymId, memberId, existingPlanId);

    const res = await request
      .post(`/membership-plans/${newPlanId}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_ids: [memberId], owner_member_id: memberId, starts_at: '2026-01-01' });
    expect(res.status).toBe(409);
  });
});
