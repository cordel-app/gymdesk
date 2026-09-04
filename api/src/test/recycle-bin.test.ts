// Tests for recycle-bin.ts router

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

async function createPlan(gymId: string, name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'draft', 'closed')`,
    [gymId, name],
  );
  return insertId;
}

async function softDeletePlan(id: number, gymId: string): Promise<void> {
  await db.query(
    'UPDATE membership_plans SET deleted_at = NOW() WHERE id = ? AND gym_id = ?',
    [id, gymId],
  );
}

// ─── Auth and module access guards ───────────────────────────────────────────

describe('Auth and module access guards', () => {
  let gymId: string;
  let gymNoAccess: string;

  beforeAll(async () => {
    gymId = await createTestGym('Recycle Bin Auth Gym');
    await createTestMembership(gymId, 'admin');

    // trainer_performance has NONE access to the SYSTEM module → 403
    gymNoAccess = await createTestGym('Recycle Bin No Access Gym');
    await createTestMembership(gymNoAccess, 'trainer_performance');
  });

  it('returns 401 without an Authorization header', async () => {
    const res = await request.get('/recycle-bin').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no SYSTEM module access (trainer_performance)', async () => {
    const res = await request
      .get('/recycle-bin')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymNoAccess);
    expect(res.status).toBe(403);
  });

  it('returns 403 when user has no membership in the requested gym', async () => {
    const otherGym = await createTestGym('Recycle Bin Tenant Guard Gym');
    const res = await request
      .get('/recycle-bin')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGym);
    expect(res.status).toBe(403);
  });
});

// ─── GET /recycle-bin ────────────────────────────────────────────────────────

describe('GET /recycle-bin', () => {
  let gymId: string;
  let deletedPlanId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Recycle Bin List Gym');
    await createTestMembership(gymId, 'admin');
    deletedPlanId = await createPlan(gymId, 'Soft Deleted List Plan');
    await softDeletePlan(deletedPlanId, gymId);
  });

  it('returns 200 with { items, total, limit, offset }', async () => {
    const res = await request
      .get('/recycle-bin')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('items');
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('limit');
    expect(res.body).toHaveProperty('offset');
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('includes the soft-deleted membership_plan in items', async () => {
    const res = await request
      .get('/recycle-bin')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((item: any) => Number(item.id));
    expect(ids).toContain(deletedPlanId);
  });

  it('items include entity_type field', async () => {
    const res = await request
      .get('/recycle-bin?entity_type=membership_plan')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.every((item: any) => item.entity_type === 'membership_plan')).toBe(true);
  });

  it('filters correctly by entity_type=membership_plan and finds the deleted plan', async () => {
    const res = await request
      .get('/recycle-bin?entity_type=membership_plan')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((item: any) => Number(item.id));
    expect(ids).toContain(deletedPlanId);
  });

  it('returns 400 for an invalid entity_type filter', async () => {
    const res = await request
      .get('/recycle-bin?entity_type=bogus_type')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });
});

// ─── GET /recycle-bin/:entityType/:id ────────────────────────────────────────

describe('GET /recycle-bin/:entityType/:id', () => {
  let gymId: string;
  let deletedPlanId: number;
  let activePlanId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Recycle Bin Detail Gym');
    await createTestMembership(gymId, 'admin');
    deletedPlanId = await createPlan(gymId, 'Detail Deleted Plan');
    await softDeletePlan(deletedPlanId, gymId);
    // This plan is not soft-deleted — used to verify 404 for non-deleted
    activePlanId = await createPlan(gymId, 'Detail Active Plan');
  });

  it('returns 200 with full entity detail for a soft-deleted plan', async () => {
    const res = await request
      .get(`/recycle-bin/membership_plan/${deletedPlanId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Number(res.body.id)).toBe(deletedPlanId);
    expect(res.body).toHaveProperty('deleted_at');
    expect(res.body.deleted_at).not.toBeNull();
    expect(res.body).toHaveProperty('name');
    expect(res.body).toHaveProperty('lifecycle_status');
  });

  it('returns 400 for an invalid entityType', async () => {
    const res = await request
      .get(`/recycle-bin/bogus_type/${deletedPlanId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });

  it('returns 404 for a plan that exists but is NOT soft-deleted', async () => {
    const res = await request
      .get(`/recycle-bin/membership_plan/${activePlanId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-existent plan id', async () => {
    const res = await request
      .get('/recycle-bin/membership_plan/9999999')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

// ─── Tenant isolation ─────────────────────────────────────────────────────────

describe('Tenant isolation', () => {
  let gymA: string;
  let gymB: string;
  let planBId: number;

  beforeAll(async () => {
    gymA = await createTestGym('Recycle Bin Tenant A');
    await createTestMembership(gymA, 'admin');

    // gymB has no membership for TEST_USER_ID — inserted directly via db
    gymB = await createTestGym('Recycle Bin Tenant B');
    planBId = await createPlan(gymB, 'Gym B Deleted Plan');
    await softDeletePlan(planBId, gymB);
  });

  it('returns 404 when accessing gymB deleted entity with gymA credentials (detail)', async () => {
    const res = await request
      .get(`/recycle-bin/membership_plan/${planBId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA);
    expect(res.status).toBe(404);
  });

  it('does not include gymB items in gymA recycle-bin list', async () => {
    const res = await request
      .get('/recycle-bin?entity_type=membership_plan')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((item: any) => Number(item.id));
    expect(ids).not.toContain(planBId);
  });
});

// ─── POST /recycle-bin/:entityType/:id/recover ───────────────────────────────

describe('POST /recycle-bin/:entityType/:id/recover', () => {
  let gymId: string;
  let deletedPlanId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Recycle Bin Recover Gym');
    await createTestMembership(gymId, 'admin');
    deletedPlanId = await createPlan(gymId, 'Recover Me Plan');
    await softDeletePlan(deletedPlanId, gymId);
  });

  it('returns 204 and clears deleted_at on the recovered plan', async () => {
    const res = await request
      .post(`/recycle-bin/membership_plan/${deletedPlanId}/recover`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);

    // Verify via direct DB query that deleted_at is now NULL
    const { rows } = await db.query<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM membership_plans WHERE id = ?',
      [deletedPlanId],
    );
    expect(rows[0].deleted_at).toBeNull();
  });

  it('plan no longer appears in GET /recycle-bin after recovery', async () => {
    const res = await request
      .get('/recycle-bin?entity_type=membership_plan')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((item: any) => Number(item.id));
    expect(ids).not.toContain(deletedPlanId);
  });

  it('returns 404 when recovering a plan that is not soft-deleted', async () => {
    const activePlanId = await createPlan(gymId, 'Already Active Recover Plan');
    const res = await request
      .post(`/recycle-bin/membership_plan/${activePlanId}/recover`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 400 for an invalid entityType on recover', async () => {
    const res = await request
      .post(`/recycle-bin/bogus_type/1/recover`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });
});

// ─── Member entity in Recycle Bin ─────────────────────────────────────────────

async function createMember(gymId: string): Promise<number> {
  const email = `rb-member-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`;
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Recycle Test Member', ?)`,
    [gymId, email],
  );
  return insertId as number;
}

async function softDeleteMember(id: number, gymId: string): Promise<void> {
  await db.query(
    'UPDATE members SET deleted_at = NOW(), deleted_by_name = ? WHERE id = ? AND gym_id = ?',
    ['Test Admin', id, gymId],
  );
}

describe('Member in GET /recycle-bin', () => {
  let gymId: string;
  let deletedMemberId: number;
  let activeMemberId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Recycle Bin Member List Gym');
    await createTestMembership(gymId, 'admin');
    deletedMemberId = await createMember(gymId);
    await softDeleteMember(deletedMemberId, gymId);
    activeMemberId = await createMember(gymId);
  });

  it('includes the deleted member in the full list', async () => {
    const res = await request
      .get('/recycle-bin')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((item: any) => Number(item.id));
    expect(ids).toContain(deletedMemberId);
  });

  it('filters correctly by entity_type=member', async () => {
    const res = await request
      .get('/recycle-bin?entity_type=member')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.items.every((item: any) => item.entity_type === 'member')).toBe(true);
    const ids = res.body.items.map((item: any) => Number(item.id));
    expect(ids).toContain(deletedMemberId);
  });

  it('does not include active (non-deleted) members', async () => {
    const res = await request
      .get('/recycle-bin?entity_type=member')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((item: any) => Number(item.id));
    expect(ids).not.toContain(activeMemberId);
  });

  it('exposes deleted_by_name on the member list item', async () => {
    const res = await request
      .get('/recycle-bin?entity_type=member')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const item = res.body.items.find((i: any) => Number(i.id) === deletedMemberId);
    expect(item).toBeDefined();
    expect(item.deleted_by_name).toBe('Test Admin');
  });
});

describe('Member in GET /recycle-bin/:entityType/:id', () => {
  let gymId: string;
  let deletedMemberId: number;
  let activeMemberId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Recycle Bin Member Detail Gym');
    await createTestMembership(gymId, 'admin');
    deletedMemberId = await createMember(gymId);
    await softDeleteMember(deletedMemberId, gymId);
    activeMemberId = await createMember(gymId);
  });

  it('returns 200 with member detail fields', async () => {
    const res = await request
      .get(`/recycle-bin/member/${deletedMemberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Number(res.body.id)).toBe(deletedMemberId);
    expect(res.body).toHaveProperty('name');
    expect(res.body).toHaveProperty('email');
    expect(res.body).toHaveProperty('deleted_at');
    expect(res.body.deleted_at).not.toBeNull();
    expect(res.body.deleted_by_name).toBe('Test Admin');
  });

  it('returns 404 for an active (non-deleted) member', async () => {
    const res = await request
      .get(`/recycle-bin/member/${activeMemberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

describe('Member in POST /recycle-bin/member/:id/recover', () => {
  let gymId: string;
  let deletedMemberId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Recycle Bin Member Recover Gym');
    await createTestMembership(gymId, 'admin');
    deletedMemberId = await createMember(gymId);
    await softDeleteMember(deletedMemberId, gymId);
  });

  it('returns 204 and clears deleted_at on the member', async () => {
    const res = await request
      .post(`/recycle-bin/member/${deletedMemberId}/recover`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);

    const { rows } = await db.query<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM members WHERE id = ?',
      [deletedMemberId],
    );
    expect(rows[0].deleted_at).toBeNull();
  });

  it('recovered member no longer appears in the recycle bin', async () => {
    const res = await request
      .get('/recycle-bin?entity_type=member')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((item: any) => Number(item.id));
    expect(ids).not.toContain(deletedMemberId);
  });

  it('recovered member appears again in GET /members', async () => {
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((m: any) => m.id);
    expect(ids).toContain(deletedMemberId);
  });

  it('returns 404 when recovering a member that is not deleted', async () => {
    const activeMemberId = await createMember(gymId);
    const res = await request
      .post(`/recycle-bin/member/${activeMemberId}/recover`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});
