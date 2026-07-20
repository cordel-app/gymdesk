import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
  TEST_AUTH_HEADER,
  TEST_USER_ID,
} from './helpers';

let gymId: string;
let membershipId: number;
let otherGymId: string;
let centerId: number;
let activityTypeId: number;

beforeAll(async () => {
  gymId = await createTestGym('Spaces Test Gym');
  await createTestMembership(gymId, 'admin');
  const { rows: ms } = await db.query<{ id: number }>(
    `SELECT id FROM gym_memberships WHERE gym_id = ? AND user_id = ?`,
    [gymId, TEST_USER_ID],
  );
  membershipId = ms[0].id;

  await db.query(`INSERT INTO centers (gym_id, name) VALUES (?, 'Main Center')`, [gymId]);
  const { rows: cr } = await db.query<{ id: number }>('SELECT LAST_INSERT_ID() AS id');
  centerId = cr[0].id;

  await db.query(
    `INSERT INTO activity_types (gym_id, name, max_capacity, duration_minutes, status) VALUES (?, 'Yoga', 20, 60, 'active')`,
    [gymId],
  );
  const { rows: ar } = await db.query<{ id: number }>('SELECT LAST_INSERT_ID() AS id');
  activityTypeId = ar[0].id;

  otherGymId = await createTestGym('Other Spaces Gym');
  await createTestMembership(otherGymId, 'admin', 'other-user');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('POST /spaces', () => {
  it('creates a space', async () => {
    const res = await request
      .post('/spaces')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Studio A', capacity: 20, center_id: centerId });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Studio A');
    expect(res.body.capacity).toBe(20);
    expect(res.body.status).toBe('active');
  });

  it('returns 400 when name missing', async () => {
    const res = await request
      .post('/spaces')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ capacity: 10 });
    expect(res.status).toBe(400);
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request.post('/spaces').set('x-gym-id', gymId).send({ name: 'X', capacity: 5 });
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin', async () => {
    // Create a second gym where TEST_USER_ID is only staff
    const staffGymId = await createTestGym('Staff Only Gym Spaces');
    await createTestMembership(staffGymId, 'staff');
    const res = await request
      .post('/spaces')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', staffGymId)
      .send({ name: 'X', capacity: 5 });
    expect(res.status).toBe(403);
  });

  it('returns 409 on duplicate name', async () => {
    await request
      .post('/spaces')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Dup Space', capacity: 10 });
    const res = await request
      .post('/spaces')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Dup Space', capacity: 10 });
    expect(res.status).toBe(409);
  });
});

describe('GET /spaces', () => {
  it('lists spaces for the gym', async () => {
    const res = await request
      .get('/spaces')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.every((s: any) => s.deleted_at === null || s.deleted_at === undefined)).toBe(true);
  });

  it('filters by status', async () => {
    await request
      .post('/spaces')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Inactive Space', capacity: 5, status: 'inactive' });
    const res = await request
      .get('/spaces?status=inactive')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.every((s: any) => s.status === 'inactive')).toBe(true);
  });

  it('does not return spaces from another gym (tenant isolation)', async () => {
    await db.query(
      `INSERT INTO spaces (gym_id, name, capacity, status, center_id) VALUES (?, 'Other Gym Space', 10, 'active', NULL)`,
      [otherGymId],
    );
    const res = await request
      .get('/spaces')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.some((s: any) => s.name === 'Other Gym Space')).toBe(false);
  });
});

describe('GET /spaces/:id', () => {
  it('returns 404 for a space from another gym', async () => {
    const { rows } = await db.query<{ id: number }>(
      `SELECT id FROM spaces WHERE gym_id = ? AND name = 'Other Gym Space' LIMIT 1`,
      [otherGymId],
    );
    const res = await request
      .get(`/spaces/${rows[0].id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

describe('PUT /spaces/:id', () => {
  it('updates a space', async () => {
    const create = await request
      .post('/spaces')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Update Me', capacity: 10 });
    const id = create.body.id;

    const res = await request
      .put(`/spaces/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Updated Name', capacity: 25 });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Name');
    expect(res.body.capacity).toBe(25);
  });

  it('accepts under_maintenance status', async () => {
    const create = await request
      .post('/spaces')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Maintenance Space', capacity: 10 });
    const id = create.body.id;

    const res = await request
      .put(`/spaces/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ status: 'under_maintenance' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('under_maintenance');
  });
});

describe('PUT /spaces/:id/activity-types', () => {
  it('assigns and replaces activity types', async () => {
    const create = await request
      .post('/spaces')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'AT Space', capacity: 15 });
    const id = create.body.id;

    await request
      .put(`/spaces/${id}/activity-types`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ activity_type_ids: [activityTypeId] });

    const list = await request
      .get(`/spaces/${id}/activity-types`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(list.status).toBe(200);
    expect(list.body.length).toBe(1);
    expect(list.body[0].id).toBe(activityTypeId);

    // Replace with empty
    await request
      .put(`/spaces/${id}/activity-types`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ activity_type_ids: [] });

    const list2 = await request
      .get(`/spaces/${id}/activity-types`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(list2.body.length).toBe(0);
  });
});

describe('POST /spaces/:id/duplicate', () => {
  it('duplicates a space with "(Copy)" suffix', async () => {
    const create = await request
      .post('/spaces')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Original Space', capacity: 30, notes: 'some notes' });
    const id = create.body.id;

    const res = await request
      .post(`/spaces/${id}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Original Space (Copy)');
    expect(res.body.capacity).toBe(30);
    expect(res.body.status).toBe('active');
  });
});

describe('DELETE /spaces/:id (soft delete)', () => {
  it('soft-deletes and hides from list', async () => {
    const create = await request
      .post('/spaces')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Delete Me Space', capacity: 5 });
    const id = create.body.id;

    const del = await request
      .delete(`/spaces/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(del.status).toBe(204);

    const list = await request
      .get('/spaces')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(list.body.some((s: any) => s.id === id)).toBe(false);

    // Second delete returns 404
    const del2 = await request
      .delete(`/spaces/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(del2.status).toBe(404);
  });
});
