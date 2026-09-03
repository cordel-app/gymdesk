// Tests for activity-types.ts router

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

let gymId: string;
let activityTypeId: number;

const BASE = '/activity-types';

beforeAll(async () => {
  gymId = await createTestGym('AT Test Gym');
  await createTestMembership(gymId, 'admin');

  // Create the main activity type used across most tests
  const res = await request
    .post(BASE)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ name: 'Yoga', duration_minutes: 60, max_capacity: 20, status: 'active' });
  activityTypeId = res.body.id;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ── Auth guard ─────────────────────────────────────────────────────────────

describe('auth guard', () => {
  it('returns 401 without auth on GET /activity-types', async () => {
    const res = await request.get(BASE).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 401 without auth on POST /activity-types', async () => {
    const res = await request
      .post(BASE)
      .set('x-gym-id', gymId)
      .send({ name: 'Boxing', duration_minutes: 45, max_capacity: 10 });
    expect(res.status).toBe(401);
  });

  it('returns 401 without auth on DELETE /activity-types/:id', async () => {
    const res = await request
      .delete(`${BASE}/${activityTypeId}`)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });
});

// ── Tenant isolation ───────────────────────────────────────────────────────

describe('tenant isolation', () => {
  it('returns 403 when user has no membership in the requested gym', async () => {
    const otherGymId = await createTestGym('AT Other Gym');
    // TEST_USER_ID has no membership in otherGymId
    const res = await request
      .get(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId);
    expect(res.status).toBe(403);
  });

  it('returns 404 when fetching an activity type that belongs to another gym', async () => {
    const gymA = await createTestGym('AT Gym A');
    const gymB = await createTestGym('AT Gym B');
    await createTestMembership(gymA, 'admin');
    await createTestMembership(gymB, 'admin');

    const createRes = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA)
      .send({ name: 'Cross-Tenant AT', duration_minutes: 30, max_capacity: 10 });
    expect(createRes.status).toBe(201);
    const crossId = createRes.body.id;

    const res = await request
      .get(`${BASE}/${crossId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(404);
  });
});

// ── Role guard ─────────────────────────────────────────────────────────────

describe('role guard', () => {
  it('returns 403 when front_desk user tries to POST /activity-types', async () => {
    // front_desk has R access on ORGANIZATION module but is not admin → requireRole('admin') rejects
    const fdGymId = await createTestGym('AT FD Gym');
    await createTestMembership(fdGymId, 'front_desk');

    const res = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', fdGymId)
      .send({ name: 'Yoga', duration_minutes: 60, max_capacity: 20 });
    expect(res.status).toBe(403);
  });

  it('returns 403 when accountant user tries to GET /activity-types (no ORGANIZATION access)', async () => {
    // accountant has NONE on ORGANIZATION → requireModuleAccess rejects at module level
    const accGymId = await createTestGym('AT ACC Gym');
    await createTestMembership(accGymId, 'accountant');

    const res = await request
      .get(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', accGymId);
    expect(res.status).toBe(403);
  });
});

// ── Happy path: GET / ──────────────────────────────────────────────────────

describe('GET /activity-types', () => {
  it('returns 200 with an array', async () => {
    const res = await request
      .get(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('returns 400 for invalid status query param', async () => {
    const res = await request
      .get(`${BASE}?status=invalid`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });
});

// ── Happy path: GET /:id ───────────────────────────────────────────────────

describe('GET /activity-types/:id', () => {
  it('returns 200 with schedule_rules array', async () => {
    const res = await request
      .get(`${BASE}/${activityTypeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(activityTypeId);
    expect(Array.isArray(res.body.schedule_rules)).toBe(true);
  });

  it('returns 404 for a non-existent id', async () => {
    const res = await request
      .get(`${BASE}/999999`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

// ── Happy path: POST ───────────────────────────────────────────────────────

describe('POST /activity-types', () => {
  it('returns 400 when required fields are missing', async () => {
    const res = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Incomplete' }); // missing duration_minutes and max_capacity
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid intensity_level', async () => {
    const res = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Bad Intensity', duration_minutes: 30, max_capacity: 10, intensity_level: 10 });
    expect(res.status).toBe(400);
  });

  it('creates an activity type and returns 201 with correct shape', async () => {
    const res = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        name: 'Pilates',
        duration_minutes: 50,
        max_capacity: 12,
        intensity_level: 3,
        status: 'active',
        color: '#FF5733',
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Pilates',
      duration_minutes: 50,
      max_capacity: 12,
      intensity_level: 3,
      status: 'active',
      color: '#FF5733',
    });
    expect(Array.isArray(res.body.schedule_rules)).toBe(true);
    expect(res.body.schedule_rules).toHaveLength(0);
    expect(typeof res.body.id).toBe('number');
  });
});

// ── Happy path: PUT ────────────────────────────────────────────────────────

describe('PUT /activity-types/:id', () => {
  it('updates fields and returns 200 with updated values', async () => {
    const res = await request
      .put(`${BASE}/${activityTypeId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Yoga Updated', duration_minutes: 45 });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Yoga Updated');
    expect(res.body.duration_minutes).toBe(45);
  });

  it('returns 404 when updating a non-existent activity type', async () => {
    const res = await request
      .put(`${BASE}/999999`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Ghost' });
    expect(res.status).toBe(404);
  });
});

// ── Soft-delete & restore ──────────────────────────────────────────────────

describe('soft-delete and restore', () => {
  let deleteId: number;

  beforeAll(async () => {
    const res = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'To Be Deleted AT', duration_minutes: 30, max_capacity: 5 });
    expect(res.status).toBe(201);
    deleteId = res.body.id;
  });

  it('DELETE returns 204', async () => {
    const res = await request
      .delete(`${BASE}/${deleteId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);
  });

  it('soft-deleted row is hidden from GET /', async () => {
    const res = await request
      .get(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((a: any) => a.id);
    expect(ids).not.toContain(deleteId);
  });

  it('soft-deleted row has deleted_at set in the database', async () => {
    const { rows } = await db.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM activity_types WHERE id = ?',
      [deleteId],
    );
    expect(rows[0].deleted_at).not.toBeNull();
  });

  it('GET /:id returns 404 for the soft-deleted row', async () => {
    const res = await request
      .get(`${BASE}/${deleteId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('POST /:id/restore returns 204', async () => {
    const res = await request
      .post(`${BASE}/${deleteId}/restore`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);
  });

  it('restored row reappears in GET /', async () => {
    const res = await request
      .get(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((a: any) => a.id);
    expect(ids).toContain(deleteId);
  });

  it('restored row has deleted_at cleared in the database', async () => {
    const { rows } = await db.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM activity_types WHERE id = ?',
      [deleteId],
    );
    expect(rows[0].deleted_at).toBeNull();
  });
});

// ── Audit metadata ────────────────────────────────────────────────────────

describe('audit metadata', () => {
  let auditGymId: string;
  let testMembershipId: number;
  let otherMembershipId: number;

  beforeAll(async () => {
    auditGymId = await createTestGym('AT Audit Gym');
    // Primary test user membership
    await createTestMembership(auditGymId, 'admin');
    const { rows: tm } = await db.query<{ id: number }>(
      'SELECT id FROM gym_memberships WHERE user_id = ? AND gym_id = ?',
      ['test-user-id', auditGymId],
    );
    testMembershipId = tm[0].id;

    // Secondary membership for the "different user" scenarios
    await createTestMembership(auditGymId, 'admin', 'other-user-id');
    const { rows: om } = await db.query<{ id: number }>(
      'SELECT id FROM gym_memberships WHERE user_id = ? AND gym_id = ?',
      ['other-user-id', auditGymId],
    );
    otherMembershipId = om[0].id;
  });

  it('create sets created_by and modified_by to the authenticated user', async () => {
    const res = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', auditGymId)
      .send({ name: 'Audit Create', duration_minutes: 30, max_capacity: 10 });
    expect(res.status).toBe(201);
    const { rows } = await db.query<{ created_by_membership_id: number; modified_by_membership_id: number }>(
      'SELECT created_by_membership_id, modified_by_membership_id FROM activity_types WHERE id = ?',
      [res.body.id],
    );
    expect(rows[0].created_by_membership_id).toBe(testMembershipId);
    expect(rows[0].modified_by_membership_id).toBe(testMembershipId);
  });

  it('update by same user keeps created_by and updates modified_by', async () => {
    const createRes = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', auditGymId)
      .send({ name: 'Audit Same User', duration_minutes: 30, max_capacity: 10 });
    expect(createRes.status).toBe(201);
    const id = createRes.body.id;

    const putRes = await request
      .put(`${BASE}/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', auditGymId)
      .send({ name: 'Audit Same User Updated' });
    expect(putRes.status).toBe(200);

    const { rows } = await db.query<{ created_by_membership_id: number; modified_by_membership_id: number }>(
      'SELECT created_by_membership_id, modified_by_membership_id FROM activity_types WHERE id = ?',
      [id],
    );
    expect(rows[0].created_by_membership_id).toBe(testMembershipId);
    expect(rows[0].modified_by_membership_id).toBe(testMembershipId);
  });

  it('update by different user preserves created_by and sets modified_by to the new user', async () => {
    // Insert activity directly with the other user as creator
    const { insertId } = await db.query(
      `INSERT INTO activity_types
       (gym_id, name, duration_minutes, max_capacity, status,
        created_by_membership_id, modified_at, modified_by_membership_id)
       VALUES (?,?,?,?,'active',?,UTC_TIMESTAMP(),?)`,
      [auditGymId, 'Audit Diff User', 30, 10, otherMembershipId, otherMembershipId],
    );

    // Update as the primary test user
    const putRes = await request
      .put(`${BASE}/${insertId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', auditGymId)
      .send({ name: 'Audit Diff User Updated' });
    expect(putRes.status).toBe(200);

    const { rows } = await db.query<{ created_by_membership_id: number; modified_by_membership_id: number }>(
      'SELECT created_by_membership_id, modified_by_membership_id FROM activity_types WHERE id = ?',
      [insertId],
    );
    expect(rows[0].created_by_membership_id).toBe(otherMembershipId);
    expect(rows[0].modified_by_membership_id).toBe(testMembershipId);
  });

  it('multiple updates keep created_by stable', async () => {
    // Insert activity with the other user as creator
    const { insertId } = await db.query(
      `INSERT INTO activity_types
       (gym_id, name, duration_minutes, max_capacity, status,
        created_by_membership_id, modified_at, modified_by_membership_id)
       VALUES (?,?,?,?,'active',?,UTC_TIMESTAMP(),?)`,
      [auditGymId, 'Audit Multi Update', 30, 10, otherMembershipId, otherMembershipId],
    );

    // Two sequential updates as the test user
    for (const name of ['Round 1', 'Round 2']) {
      const res = await request
        .put(`${BASE}/${insertId}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', auditGymId)
        .send({ name: `Audit Multi ${name}` });
      expect(res.status).toBe(200);
    }

    const { rows } = await db.query<{ created_by_membership_id: number; modified_by_membership_id: number }>(
      'SELECT created_by_membership_id, modified_by_membership_id FROM activity_types WHERE id = ?',
      [insertId],
    );
    expect(rows[0].created_by_membership_id).toBe(otherMembershipId);
    expect(rows[0].modified_by_membership_id).toBe(testMembershipId);
  });

  it('failed update does not change modified_by', async () => {
    // Insert activity with the other user as creator+modifier
    const { insertId } = await db.query(
      `INSERT INTO activity_types
       (gym_id, name, duration_minutes, max_capacity, status,
        created_by_membership_id, modified_at, modified_by_membership_id)
       VALUES (?,?,?,?,'active',?,UTC_TIMESTAMP(),?)`,
      [auditGymId, 'Audit Failed Update', 30, 10, otherMembershipId, otherMembershipId],
    );

    // Attempt invalid update (bad intensity_level)
    const putRes = await request
      .put(`${BASE}/${insertId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', auditGymId)
      .send({ intensity_level: 99 });
    expect(putRes.status).toBe(400);

    const { rows } = await db.query<{ created_by_membership_id: number; modified_by_membership_id: number }>(
      'SELECT created_by_membership_id, modified_by_membership_id FROM activity_types WHERE id = ?',
      [insertId],
    );
    expect(rows[0].created_by_membership_id).toBe(otherMembershipId);
    expect(rows[0].modified_by_membership_id).toBe(otherMembershipId);
  });

  it('client-supplied audit fields in request body are ignored', async () => {
    const res = await request
      .post(BASE)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', auditGymId)
      .send({
        name: 'Audit Client Fields',
        duration_minutes: 30,
        max_capacity: 10,
        created_by_membership_id: otherMembershipId,
        modified_by_membership_id: otherMembershipId,
      });
    expect(res.status).toBe(201);

    const { rows } = await db.query<{ created_by_membership_id: number; modified_by_membership_id: number }>(
      'SELECT created_by_membership_id, modified_by_membership_id FROM activity_types WHERE id = ?',
      [res.body.id],
    );
    // Backend must use the authenticated user's membership, not the client-supplied value
    expect(rows[0].created_by_membership_id).toBe(testMembershipId);
    expect(rows[0].modified_by_membership_id).toBe(testMembershipId);
  });
});

// ── Duplicate ──────────────────────────────────────────────────────────────

describe('POST /activity-types/:id/duplicate', () => {
  it('creates a copy with " (copy)" suffix and returns 201', async () => {
    // activityTypeId was renamed to "Yoga Updated" by the PUT test above
    const res = await request
      .post(`${BASE}/${activityTypeId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(201);
    expect(res.body.name).toContain('(copy)');
    expect(res.body.id).not.toBe(activityTypeId);
    expect(Array.isArray(res.body.schedule_rules)).toBe(true);
  });

  it('returns 404 when duplicating a non-existent activity type', async () => {
    const res = await request
      .post(`${BASE}/999999/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 404 when duplicating an activity type from another gym', async () => {
    const gymC = await createTestGym('AT Gym C');
    await createTestMembership(gymC, 'admin');

    const res = await request
      .post(`${BASE}/${activityTypeId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymC);
    expect(res.status).toBe(404);
  });
});
