// Tests for class-packages.ts router

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
let otherGymId: string;

beforeAll(async () => {
  gymId = await createTestGym('Class Packages Test Gym');
  await createTestMembership(gymId, 'admin');

  otherGymId = await createTestGym('Other Class Packages Gym');
  await createTestMembership(otherGymId, 'admin', 'other-user');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ---------------------------------------------------------------------------
// GET /class-packages
// ---------------------------------------------------------------------------

describe('GET /class-packages', () => {
  it('returns 401 without auth', async () => {
    const res = await request.get('/class-packages').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no membership in this gym', async () => {
    const res = await request
      .get('/class-packages')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId);
    expect(res.status).toBe(403);
  });

  it('returns 200 with an array of active packages', async () => {
    // Create one active package via the API
    await request
      .post('/class-packages')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'List Test Package', number_of_sessions: 10 });

    const res = await request
      .get('/class-packages')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((p: any) => p.name === 'List Test Package')).toBe(true);
  });

  it('excludes soft-deleted packages', async () => {
    const create = await request
      .post('/class-packages')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'To Soft-Delete Package', number_of_sessions: 5 });
    const id = create.body.id;

    await request
      .delete(`/class-packages/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    const res = await request
      .get('/class-packages')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.some((p: any) => p.id === id)).toBe(false);
  });

  it('does not return packages from another gym (tenant isolation)', async () => {
    await db.query(
      `INSERT INTO class_packages (gym_id, name, number_of_sessions, price, validity_days, status)
       VALUES (?, 'Other Gym Package', 8, 0, 0, 'active')`,
      [otherGymId],
    );

    const res = await request
      .get('/class-packages')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.some((p: any) => p.name === 'Other Gym Package')).toBe(false);
  });

  it('filters by status', async () => {
    await request
      .post('/class-packages')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Inactive Package Filter', number_of_sessions: 4, status: 'inactive' });

    const res = await request
      .get('/class-packages?status=inactive')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.every((p: any) => p.status === 'inactive')).toBe(true);
  });

  it('returns 400 for invalid status filter', async () => {
    const res = await request
      .get('/class-packages?status=bogus')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /class-packages/:id
// ---------------------------------------------------------------------------

describe('GET /class-packages/:id', () => {
  it('returns package shape including created_by_name', async () => {
    const create = await request
      .post('/class-packages')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Get By Id Package', number_of_sessions: 6, description: 'A description' });
    const id = create.body.id;

    const res = await request
      .get(`/class-packages/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.name).toBe('Get By Id Package');
    expect(res.body.description).toBe('A description');
    expect('created_by_name' in res.body).toBe(true);
    expect('modified_by_name' in res.body).toBe(true);
  });

  it('also returns soft-deleted packages by id', async () => {
    const create = await request
      .post('/class-packages')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Soft Deleted Get Package', number_of_sessions: 3 });
    const id = create.body.id;

    await request
      .delete(`/class-packages/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    const res = await request
      .get(`/class-packages/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.deleted_at).not.toBeNull();
  });

  it('returns 404 for a package from another gym (tenant isolation)', async () => {
    const { rows } = await db.query<{ id: number }>(
      `SELECT id FROM class_packages WHERE gym_id = ? AND name = 'Other Gym Package' LIMIT 1`,
      [otherGymId],
    );
    const res = await request
      .get(`/class-packages/${rows[0].id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /class-packages
// ---------------------------------------------------------------------------

describe('POST /class-packages', () => {
  it('returns 401 without auth', async () => {
    const res = await request
      .post('/class-packages')
      .set('x-gym-id', gymId)
      .send({ name: 'No Auth Package', number_of_sessions: 5 });
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin role', async () => {
    const staffGymId = await createTestGym('Staff Only Gym Packages');
    await createTestMembership(staffGymId, 'front_desk');
    const res = await request
      .post('/class-packages')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', staffGymId)
      .send({ name: 'Should Fail', number_of_sessions: 5 });
    expect(res.status).toBe(403);
  });

  it('returns 201 with correct fields and default price and validity_days', async () => {
    const res = await request
      .post('/class-packages')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Defaults Package', number_of_sessions: 12 });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Defaults Package');
    expect(res.body.number_of_sessions).toBe(12);
    expect(Number(res.body.price)).toBe(0);
    expect(res.body.validity_days).toBe(0);
    expect(res.body.status).toBe('active');
    expect(typeof res.body.id).toBe('number');
  });

  it('creates with all optional fields', async () => {
    const res = await request
      .post('/class-packages')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        name: 'Full Package',
        description: 'Full desc',
        number_of_sessions: 20,
        price: 99.99,
        validity_days: 90,
        status: 'inactive',
        notes: 'Some notes',
      });
    expect(res.status).toBe(201);
    expect(res.body.description).toBe('Full desc');
    expect(Number(res.body.price)).toBeCloseTo(99.99);
    expect(res.body.validity_days).toBe(90);
    expect(res.body.status).toBe('inactive');
    expect(res.body.notes).toBe('Some notes');
  });

  it('returns 400 when name is missing', async () => {
    const res = await request
      .post('/class-packages')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ number_of_sessions: 5 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when number_of_sessions is missing', async () => {
    const res = await request
      .post('/class-packages')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Missing Sessions' });
    expect(res.status).toBe(400);
  });

  it('returns 409 on duplicate name within the same gym', async () => {
    await request
      .post('/class-packages')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Duplicate Package', number_of_sessions: 5 });

    const res = await request
      .post('/class-packages')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Duplicate Package', number_of_sessions: 8 });
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// PUT /class-packages/:id
// ---------------------------------------------------------------------------

describe('PUT /class-packages/:id', () => {
  it('returns 403 for non-admin role', async () => {
    const staffGymId = await createTestGym('Staff Only Gym Packages Put');
    await createTestMembership(staffGymId, 'front_desk');
    // Insert a package directly for this gym
    await db.query(
      `INSERT INTO class_packages (gym_id, name, number_of_sessions, price, validity_days, status)
       VALUES (?, 'Staff Put Package', 5, 0, 0, 'active')`,
      [staffGymId],
    );
    const { rows } = await db.query<{ id: number }>(
      `SELECT id FROM class_packages WHERE gym_id = ? AND name = 'Staff Put Package' LIMIT 1`,
      [staffGymId],
    );
    const res = await request
      .put(`/class-packages/${rows[0].id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', staffGymId)
      .send({ name: 'Should Fail' });
    expect(res.status).toBe(403);
  });

  it('updates package and stamps modified_at', async () => {
    const create = await request
      .post('/class-packages')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Update Me Package', number_of_sessions: 8 });
    const id = create.body.id;

    const res = await request
      .put(`/class-packages/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Updated Package Name', number_of_sessions: 15, price: 50 });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Package Name');
    expect(res.body.number_of_sessions).toBe(15);
    expect(Number(res.body.price)).toBeCloseTo(50);
    expect(res.body.modified_at).not.toBeNull();
  });

  it('returns 404 for a soft-deleted package', async () => {
    const create = await request
      .post('/class-packages')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Put On Deleted Package', number_of_sessions: 4 });
    const id = create.body.id;

    await request
      .delete(`/class-packages/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    const res = await request
      .put(`/class-packages/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Should 404' });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /class-packages/:id (soft delete)
// ---------------------------------------------------------------------------

describe('DELETE /class-packages/:id', () => {
  it('returns 403 for non-admin role', async () => {
    const staffGymId = await createTestGym('Staff Only Gym Packages Delete');
    await createTestMembership(staffGymId, 'front_desk');
    await db.query(
      `INSERT INTO class_packages (gym_id, name, number_of_sessions, price, validity_days, status)
       VALUES (?, 'Staff Delete Package', 5, 0, 0, 'active')`,
      [staffGymId],
    );
    const { rows } = await db.query<{ id: number }>(
      `SELECT id FROM class_packages WHERE gym_id = ? AND name = 'Staff Delete Package' LIMIT 1`,
      [staffGymId],
    );
    const res = await request
      .delete(`/class-packages/${rows[0].id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', staffGymId);
    expect(res.status).toBe(403);
  });

  it('soft-deletes and returns 204; row is excluded from list but remains in DB', async () => {
    const create = await request
      .post('/class-packages')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Delete Me Package', number_of_sessions: 7 });
    const id = create.body.id;

    const del = await request
      .delete(`/class-packages/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(del.status).toBe(204);

    // Excluded from list
    const list = await request
      .get('/class-packages')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(list.body.some((p: any) => p.id === id)).toBe(false);

    // Row still in DB with deleted_at set
    const { rows } = await db.query<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM class_packages WHERE id = ?`,
      [id],
    );
    expect(rows[0]).toBeDefined();
    expect(rows[0].deleted_at).not.toBeNull();
  });

  it('returns 404 on second delete attempt', async () => {
    const create = await request
      .post('/class-packages')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Double Delete Package', number_of_sessions: 3 });
    const id = create.body.id;

    await request
      .delete(`/class-packages/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    const res = await request
      .delete(`/class-packages/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /class-packages/:id/duplicate
// ---------------------------------------------------------------------------

describe('POST /class-packages/:id/duplicate', () => {
  it('returns 403 for non-admin role', async () => {
    const staffGymId = await createTestGym('Staff Only Gym Packages Duplicate');
    await createTestMembership(staffGymId, 'front_desk');
    await db.query(
      `INSERT INTO class_packages (gym_id, name, number_of_sessions, price, validity_days, status)
       VALUES (?, 'Staff Dup Package', 5, 0, 0, 'active')`,
      [staffGymId],
    );
    const { rows } = await db.query<{ id: number }>(
      `SELECT id FROM class_packages WHERE gym_id = ? AND name = 'Staff Dup Package' LIMIT 1`,
      [staffGymId],
    );
    const res = await request
      .post(`/class-packages/${rows[0].id}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', staffGymId);
    expect(res.status).toBe(403);
  });

  it('returns 201 with name suffixed with " (Copy)" and same fields', async () => {
    const create = await request
      .post('/class-packages')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        name: 'Original Dup Package',
        description: 'Dup desc',
        number_of_sessions: 10,
        price: 49.99,
        validity_days: 30,
        status: 'inactive',
      });
    const id = create.body.id;

    const res = await request
      .post(`/class-packages/${id}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Original Dup Package (Copy)');
    expect(res.body.number_of_sessions).toBe(10);
    expect(Number(res.body.price)).toBeCloseTo(49.99);
    expect(res.body.validity_days).toBe(30);
    // Duplicate always resets to active
    expect(res.body.status).toBe('active');
    expect(typeof res.body.id).toBe('number');
    expect(res.body.id).not.toBe(id);
  });

  it('returns 404 when duplicating a non-existent package', async () => {
    const res = await request
      .post('/class-packages/999999/duplicate')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 404 when duplicating a soft-deleted package', async () => {
    const create = await request
      .post('/class-packages')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Dup Deleted Package', number_of_sessions: 2 });
    const id = create.body.id;

    await request
      .delete(`/class-packages/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    const res = await request
      .post(`/class-packages/${id}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});
