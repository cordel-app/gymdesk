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
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, ?, ?)`,
    [
      gymId,
      name,
      (overrides.lifecycle_status as string | undefined) ?? 'draft',
      (overrides.enrollment_status as string | undefined) ?? 'closed',
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
): Promise<void> {
  await db.query(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at)
     VALUES (?, ?, ?, 'active', CURDATE())`,
    [gymId, memberId, planId],
  );
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
        enrollment_status: 'closed',
      });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('New Plan');
    expect(res.body.description).toBe('A test plan');
    expect(res.body.lifecycle_status).toBe('draft');
    expect(res.body.enrollment_status).toBe('closed');
    expect(res.body).toHaveProperty('price_history');
    expect(res.body).toHaveProperty('member_count');
  });

  it('defaults lifecycle_status to draft and enrollment_status to closed', async () => {
    const res = await request
      .post('/membership-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Defaults Plan' });
    expect(res.status).toBe(201);
    expect(res.body.lifecycle_status).toBe('draft');
    expect(res.body.enrollment_status).toBe('closed');
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

  it('archives an active plan (lifecycle → inactive, enrollment → closed)', async () => {
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
    expect(res.body.enrollment_status).toBe('closed');
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

  it('allows setting enrollment to closed on a non-active plan', async () => {
    const planId = await createPlan(gymId, {
      name: 'Enrollment Closed Draft Plan',
      lifecycle_status: 'draft',
    });
    const res = await request
      .put(`/membership-plans/${planId}/enrollment`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ enrollment_status: 'closed' });
    expect(res.status).toBe(200);
    expect(res.body.enrollment_status).toBe('closed');
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
      .send({ enrollment_status: 'closed' });
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
