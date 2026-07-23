// Tests for specialities.ts router

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

/** Insert a speciality row directly for test setup (bypasses auth). */
async function createTestSpeciality(
  gymId: string,
  overrides: Record<string, unknown> = {},
): Promise<number> {
  const name = (overrides.name as string) ?? `Test Speciality ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const { insertId } = await db.query(
    `INSERT INTO specialities (gym_id, name, description, status) VALUES (?, ?, ?, ?)`,
    [gymId, name, overrides.description ?? null, overrides.status ?? 'active'],
  );
  return insertId as number;
}

describe('specialities', () => {
  let gymId: string;   // test user is admin here
  let gymBId: string;  // test user has no membership here — used for 403 / cross-gym 404 tests
  let memberGymId: string; // test user is member here — used for role-guard 403 tests

  beforeAll(async () => {
    gymId = await createTestGym('Specialities Gym A');
    gymBId = await createTestGym('Specialities Gym B');
    memberGymId = await createTestGym('Specialities Member Gym');
    await createTestMembership(gymId, 'admin');
    // memberGymId: test user has member role, so admin-only routes must return 403
    await createTestMembership(memberGymId, 'member');
    // gymBId intentionally has no membership for TEST_USER_ID
  });

  // ------------------------------------------------------------------
  // Auth guard (401)
  // ------------------------------------------------------------------
  describe('auth guard', () => {
    it('GET /specialities returns 401 without auth', async () => {
      const res = await request.get('/specialities').set('x-gym-id', gymId);
      expect(res.status).toBe(401);
    });

    it('POST /specialities returns 401 without auth', async () => {
      const res = await request
        .post('/specialities')
        .set('x-gym-id', gymId)
        .send({ name: 'NoAuth' });
      expect(res.status).toBe(401);
    });
  });

  // ------------------------------------------------------------------
  // Tenant isolation (403 / 404)
  // ------------------------------------------------------------------
  describe('tenant isolation', () => {
    it('returns 403 when user has no membership in the requested gym', async () => {
      const res = await request
        .get('/specialities')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymBId);
      expect(res.status).toBe(403);
    });

    it('GET /specialities/:id returns 404 when the resource belongs to another gym', async () => {
      const id = await createTestSpeciality(gymBId, { name: `GymB Resource ${Date.now()}` });
      const res = await request
        .get(`/specialities/${id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId); // authenticated as gymA admin, resource lives in gymB
      expect(res.status).toBe(404);
    });

    it('DELETE /specialities/:id returns 404 when the resource belongs to another gym', async () => {
      const id = await createTestSpeciality(gymBId, { name: `GymB Del ${Date.now()}` });
      const res = await request
        .delete(`/specialities/${id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(res.status).toBe(404);
    });

    it('POST /specialities/:id/duplicate returns 404 when the resource belongs to another gym', async () => {
      const id = await createTestSpeciality(gymBId, { name: `GymB Dup ${Date.now()}` });
      const res = await request
        .post(`/specialities/${id}/duplicate`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(res.status).toBe(404);
    });
  });

  // ------------------------------------------------------------------
  // Role guard (403 for admin-only write endpoints)
  // ------------------------------------------------------------------
  describe('role guard — non-admin is rejected on write endpoints', () => {
    it('POST /specialities returns 403 for member user', async () => {
      const res = await request
        .post('/specialities')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', memberGymId)
        .send({ name: 'Should Be Blocked' });
      expect(res.status).toBe(403);
    });

    it('PUT /specialities/:id returns 403 for member user', async () => {
      const id = await createTestSpeciality(memberGymId, { name: `StaffPut ${Date.now()}` });
      const res = await request
        .put(`/specialities/${id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', memberGymId)
        .send({ name: 'Updated' });
      expect(res.status).toBe(403);
    });

    it('DELETE /specialities/:id returns 403 for member user', async () => {
      const id = await createTestSpeciality(memberGymId, { name: `StaffDel ${Date.now()}` });
      const res = await request
        .delete(`/specialities/${id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', memberGymId);
      expect(res.status).toBe(403);
    });

    it('POST /specialities/:id/duplicate returns 403 for member user', async () => {
      const id = await createTestSpeciality(memberGymId, { name: `StaffDup ${Date.now()}` });
      const res = await request
        .post(`/specialities/${id}/duplicate`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', memberGymId);
      expect(res.status).toBe(403);
    });
  });

  // ------------------------------------------------------------------
  // GET /specialities — list
  // ------------------------------------------------------------------
  describe('GET /specialities', () => {
    it('returns 200 with an array', async () => {
      await createTestSpeciality(gymId, { name: `ListSeed ${Date.now()}` });

      const res = await request
        .get('/specialities')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('excludes soft-deleted rows from the list', async () => {
      const id = await createTestSpeciality(gymId, { name: `SoftDeleted ${Date.now()}` });
      await db.query('UPDATE specialities SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [id]);

      const res = await request
        .get('/specialities')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);

      expect(res.status).toBe(200);
      const found = res.body.find((s: any) => s.id === id);
      expect(found).toBeUndefined();
    });

    it('does not return specialities from another gym', async () => {
      const id = await createTestSpeciality(gymBId, { name: `OtherGym ${Date.now()}` });

      const res = await request
        .get('/specialities')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);

      expect(res.status).toBe(200);
      const found = res.body.find((s: any) => s.id === id);
      expect(found).toBeUndefined();
    });
  });

  // ------------------------------------------------------------------
  // GET /specialities/:id — get one
  // ------------------------------------------------------------------
  describe('GET /specialities/:id', () => {
    it('returns 200 with the speciality', async () => {
      const id = await createTestSpeciality(gymId, { name: `GetOne ${Date.now()}` });

      const res = await request
        .get(`/specialities/${id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(id);
    });

    it('includes audit name fields in the response', async () => {
      const id = await createTestSpeciality(gymId, { name: `AuditFields ${Date.now()}` });

      const res = await request
        .get(`/specialities/${id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('created_by_name');
      expect(res.body).toHaveProperty('modified_by_name');
      expect(res.body).toHaveProperty('deleted_by_name');
    });

    it('returns 404 for a non-existent id', async () => {
      const res = await request
        .get('/specialities/9999999')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);

      expect(res.status).toBe(404);
    });
  });

  // ------------------------------------------------------------------
  // POST /specialities — create
  // ------------------------------------------------------------------
  describe('POST /specialities', () => {
    it('creates a speciality and returns 201 with full shape', async () => {
      const name = `Created ${Date.now()}`;
      const res = await request
        .post('/specialities')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name, description: 'Yoga for beginners', status: 'active' });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe(name);
      expect(res.body.description).toBe('Yoga for beginners');
      expect(res.body.status).toBe('active');
      expect(res.body.gym_id).toBe(gymId);
      expect(res.body.id).toBeDefined();
    });

    it('defaults status to active when not provided', async () => {
      const res = await request
        .post('/specialities')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name: `DefaultStatus ${Date.now()}` });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
    });

    it('persists inactive status', async () => {
      const res = await request
        .post('/specialities')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name: `Inactive ${Date.now()}`, status: 'inactive' });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('inactive');
    });

    it('returns 400 when name is missing', async () => {
      const res = await request
        .post('/specialities')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ description: 'No name provided' });

      expect(res.status).toBe(400);
    });

    it('returns 400 for an invalid status value', async () => {
      const res = await request
        .post('/specialities')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name: `BadStatus ${Date.now()}`, status: 'unknown' });

      expect(res.status).toBe(400);
    });

    it('returns 409 when a speciality with the same name already exists in the gym', async () => {
      const name = `Duplicate ${Date.now()}`;
      await request
        .post('/specialities')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name });

      const res = await request
        .post('/specialities')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name });

      expect(res.status).toBe(409);
    });
  });

  // ------------------------------------------------------------------
  // PUT /specialities/:id — update
  // ------------------------------------------------------------------
  describe('PUT /specialities/:id', () => {
    it('updates name and returns 200 with the updated record', async () => {
      const id = await createTestSpeciality(gymId, { name: `ToUpdate ${Date.now()}` });

      const res = await request
        .put(`/specialities/${id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name: 'Updated Speciality Name' });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Updated Speciality Name');
    });

    it('persists status change to inactive', async () => {
      const id = await createTestSpeciality(gymId, { name: `StatusChange ${Date.now()}`, status: 'active' });

      const res = await request
        .put(`/specialities/${id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ status: 'inactive' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('inactive');
    });

    it('returns 404 for a non-existent id', async () => {
      const res = await request
        .put('/specialities/9999999')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name: 'Ghost Update' });

      expect(res.status).toBe(404);
    });

    it('returns 404 when trying to update a soft-deleted speciality', async () => {
      const id = await createTestSpeciality(gymId, { name: `UpdateDeleted ${Date.now()}` });
      await db.query('UPDATE specialities SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [id]);

      const res = await request
        .put(`/specialities/${id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ name: 'Should Fail' });

      expect(res.status).toBe(404);
    });
  });

  // ------------------------------------------------------------------
  // DELETE /specialities/:id — soft delete
  // ------------------------------------------------------------------
  describe('DELETE /specialities/:id', () => {
    it('soft-deletes the speciality and returns 204', async () => {
      const id = await createTestSpeciality(gymId, { name: `ToDelete ${Date.now()}` });

      const res = await request
        .delete(`/specialities/${id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);

      expect(res.status).toBe(204);
    });

    it('hides the speciality from the list after soft-delete', async () => {
      const id = await createTestSpeciality(gymId, { name: `HiddenAfterDel ${Date.now()}` });

      await request
        .delete(`/specialities/${id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);

      const list = await request
        .get('/specialities')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);

      expect(list.status).toBe(200);
      const found = list.body.find((s: any) => s.id === id);
      expect(found).toBeUndefined();
    });

    it('returns 404 when soft-deleting an already-deleted speciality', async () => {
      const id = await createTestSpeciality(gymId, { name: `AlreadyDeleted ${Date.now()}` });
      await db.query('UPDATE specialities SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [id]);

      const res = await request
        .delete(`/specialities/${id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);

      expect(res.status).toBe(404);
    });
  });

  // ------------------------------------------------------------------
  // POST /specialities/:id/duplicate — duplicate
  // ------------------------------------------------------------------
  describe('POST /specialities/:id/duplicate', () => {
    it('creates a copy with " (Copy)" suffix and returns 201', async () => {
      const original = `OriginalSpec ${Date.now()}`;
      const id = await createTestSpeciality(gymId, {
        name: original,
        description: 'original description',
        status: 'inactive',
      });

      const res = await request
        .post(`/specialities/${id}/duplicate`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);

      expect(res.status).toBe(201);
      expect(res.body.name).toBe(`${original} (Copy)`);
      expect(res.body.description).toBe('original description');
      expect(res.body.status).toBe('inactive');
      expect(res.body.gym_id).toBe(gymId);
      expect(res.body.id).not.toBe(id);
    });

    it('returns 404 when duplicating a soft-deleted speciality', async () => {
      const id = await createTestSpeciality(gymId, { name: `DelDup ${Date.now()}` });
      await db.query('UPDATE specialities SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [id]);

      const res = await request
        .post(`/specialities/${id}/duplicate`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);

      expect(res.status).toBe(404);
    });

    it('returns 404 for a non-existent id', async () => {
      const res = await request
        .post('/specialities/9999999/duplicate')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);

      expect(res.status).toBe(404);
    });
  });
});
