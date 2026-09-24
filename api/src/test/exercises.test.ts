// Tests for exercises.ts router

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

// Single top-level afterAll — runs after all describe blocks in this file.
afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ─── GET /exercises ────────────────────────────────────────────────────────────

describe('GET /exercises', () => {
  let gymId: string;
  let gymNoAccess: string;
  let gymNoMembership: string;

  beforeAll(async () => {
    gymId = await createTestGym('Exercises GET Gym');
    await createTestMembership(gymId, 'admin');

    // accountant has NONE on TRAINING → requireModuleAccess blocks → 403
    gymNoAccess = await createTestGym('Exercises GET No Access Gym');
    await createTestMembership(gymNoAccess, 'accountant');

    // no membership row at all → tenantContext returns 403
    gymNoMembership = await createTestGym('Exercises GET No Membership Gym');
  });

  it('returns 401 without auth', async () => {
    const res = await request.get('/exercises').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no membership in this gym', async () => {
    const res = await request
      .get('/exercises')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymNoMembership);
    expect(res.status).toBe(403);
  });

  it('returns 403 for accountant role (TRAINING module NONE)', async () => {
    const res = await request
      .get('/exercises')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymNoAccess);
    expect(res.status).toBe(403);
  });

  it('returns 200 with an array for admin', async () => {
    const res = await request
      .get('/exercises')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('excludes soft-deleted exercises from the list', async () => {
    const { insertId } = await db.query(
      `INSERT INTO exercises (gym_id, name, status) VALUES (?, 'Deleted List Exercise', 'deleted')`,
      [gymId],
    );
    const res = await request
      .get('/exercises')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((e: any) => e.id);
    expect(ids).not.toContain(insertId);
  });

  it('filters by status=inactive', async () => {
    await db.query(
      `INSERT INTO exercises (gym_id, name, status) VALUES (?, 'Inactive Exercise', 'inactive')`,
      [gymId],
    );
    const res = await request
      .get('/exercises?status=inactive')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const e of res.body) {
      expect(e.status).toBe('inactive');
    }
  });

  it('returns 400 for an invalid status filter', async () => {
    const res = await request
      .get('/exercises?status=deleted')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });

  it('filters by q (name search)', async () => {
    const uniqueName = `UniqueExercise-${Date.now()}`;
    await db.query(
      `INSERT INTO exercises (gym_id, name, status) VALUES (?, ?, 'active')`,
      [gymId, uniqueName],
    );
    const res = await request
      .get(`/exercises?q=${encodeURIComponent(uniqueName)}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.some((e: any) => e.name === uniqueName)).toBe(true);
  });
});

// ─── GET /exercises/:id ────────────────────────────────────────────────────────

describe('GET /exercises/:id', () => {
  let gymA: string;
  let gymB: string;
  let exerciseId: number;

  beforeAll(async () => {
    gymA = await createTestGym('Exercises GET Single GymA');
    await createTestMembership(gymA, 'admin');
    gymB = await createTestGym('Exercises GET Single GymB');
    await createTestMembership(gymB, 'admin');

    const { insertId } = await db.query(
      `INSERT INTO exercises (gym_id, name, status) VALUES (?, 'Single Exercise', 'active')`,
      [gymA],
    );
    exerciseId = insertId;
  });

  it('returns 200 with the exercise and expected fields', async () => {
    const res = await request
      .get(`/exercises/${exerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(exerciseId);
    expect(res.body.name).toBe('Single Exercise');
    expect(res.body).toHaveProperty('muscles');
    expect(res.body).toHaveProperty('allowed_result_types');
    expect(res.body).toHaveProperty('modified_at');
  });

  it('returns 404 for exercise in another gym (cross-gym isolation)', async () => {
    const res = await request
      .get(`/exercises/${exerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a soft-deleted exercise', async () => {
    const { insertId } = await db.query(
      `INSERT INTO exercises (gym_id, name, status) VALUES (?, 'Deleted Single', 'deleted')`,
      [gymA],
    );
    const res = await request
      .get(`/exercises/${insertId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA);
    expect(res.status).toBe(404);
  });
});

// ─── POST /exercises ───────────────────────────────────────────────────────────

describe('POST /exercises', () => {
  let gymId: string;
  let gymFrontDesk: string;

  beforeAll(async () => {
    gymId = await createTestGym('Exercises POST Gym');
    await createTestMembership(gymId, 'admin');

    // front_desk has R on TRAINING → requireModuleWrite blocks → 403
    gymFrontDesk = await createTestGym('Exercises POST FrontDesk Gym');
    await createTestMembership(gymFrontDesk, 'front_desk');
  });

  it('returns 401 without auth', async () => {
    const res = await request
      .post('/exercises')
      .set('x-gym-id', gymId)
      .send({ name: 'Test Exercise' });
    expect(res.status).toBe(401);
  });

  it('returns 403 for front_desk role (requireModuleWrite TRAINING)', async () => {
    const res = await request
      .post('/exercises')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymFrontDesk)
      .send({ name: 'Test Exercise' });
    expect(res.status).toBe(403);
  });

  it('returns 400 when name is missing', async () => {
    const res = await request
      .post('/exercises')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid status value', async () => {
    const res = await request
      .post('/exercises')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Bad Status', status: 'deleted' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid muscle key', async () => {
    const res = await request
      .post('/exercises')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Bad Muscle', muscles: [{ key: 'not-a-real-muscle', role: 'principal' }] });
    expect(res.status).toBe(400);
  });

  it('returns 201 and creates an exercise with default active status', async () => {
    const res = await request
      .post('/exercises')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        name: 'New Exercise',
        sets_default: 3,
        min_reps_default: 8,
        max_reps_default: 12,
        rest_default_seconds: 60,
      });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('New Exercise');
    expect(res.body.gym_id).toBe(gymId);
    expect(res.body.status).toBe('active');
    expect(res.body.sets_default).toBe(3);
  });

  it('returns 201 with muscles stored and returned', async () => {
    const res = await request
      .post('/exercises')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        name: `Muscled Exercise ${Date.now()}`,
        muscles: [
          { key: 'chest', role: 'principal' },
          { key: 'triceps', role: 'secondary' },
        ],
      });
    expect(res.status).toBe(201);
    const muscles = res.body.muscles ?? [];
    expect(muscles.some((m: any) => m.key === 'chest' && m.role === 'principal')).toBe(true);
    expect(muscles.some((m: any) => m.key === 'triceps' && m.role === 'secondary')).toBe(true);
  });

  it('returns 409 when exercise name already exists (non-deleted)', async () => {
    const name = `Dup Exercise ${Date.now()}`;
    const first = await request
      .post('/exercises')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name });
    expect(first.status).toBe(201);

    const second = await request
      .post('/exercises')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name });
    expect(second.status).toBe(409);
  });
});

// ─── PUT /exercises/:id ────────────────────────────────────────────────────────

describe('PUT /exercises/:id', () => {
  let gymId: string;
  let gymB: string;
  let exerciseId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Exercises PUT Gym');
    await createTestMembership(gymId, 'admin');
    gymB = await createTestGym('Exercises PUT GymB');
    await createTestMembership(gymB, 'admin');

    const { insertId } = await db.query(
      `INSERT INTO exercises (gym_id, name, status) VALUES (?, 'Update Me', 'active')`,
      [gymId],
    );
    exerciseId = insertId;
  });

  it('returns 401 without auth', async () => {
    const res = await request
      .put(`/exercises/${exerciseId}`)
      .set('x-gym-id', gymId)
      .send({ name: 'Updated' });
    expect(res.status).toBe(401);
  });

  it('returns 200 and updates the exercise name and description', async () => {
    const res = await request
      .put(`/exercises/${exerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Updated Name', description: 'Updated description' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Name');
    expect(res.body.description).toBe('Updated description');
  });

  it('sets modified_at to a non-null value after update', async () => {
    const res = await request
      .put(`/exercises/${exerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ notes_default: 'hold 30s' });
    expect(res.status).toBe(200);
    expect(res.body.modified_at).not.toBeNull();
  });

  it('replaces muscles on update', async () => {
    const res = await request
      .put(`/exercises/${exerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        muscles: [
          { key: 'back', role: 'principal' },
          { key: 'biceps', role: 'secondary' },
        ],
      });
    expect(res.status).toBe(200);
    const muscles = res.body.muscles ?? [];
    expect(muscles.some((m: any) => m.key === 'back' && m.role === 'principal')).toBe(true);
    expect(muscles.some((m: any) => m.key === 'biceps' && m.role === 'secondary')).toBe(true);
  });

  // #673: the context-menu Activate/Deactivate toggle sends `status` on its own.
  it('toggles status with a status-only body, leaving the other fields intact', async () => {
    const deactivated = await request
      .put(`/exercises/${exerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ status: 'inactive' });
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.status).toBe('inactive');
    expect(deactivated.body.name).toBe('Updated Name');
    expect(deactivated.body.description).toBe('Updated description');
    expect(deactivated.body.notes_default).toBe('hold 30s');
    expect((deactivated.body.muscles ?? []).length).toBe(2);

    const reactivated = await request
      .put(`/exercises/${exerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ status: 'active' });
    expect(reactivated.status).toBe(200);
    expect(reactivated.body.status).toBe('active');
    expect(reactivated.body.name).toBe('Updated Name');
  });

  it('returns 404 for exercise in another gym (cross-gym isolation)', async () => {
    const res = await request
      .put(`/exercises/${exerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB)
      .send({ name: 'Cross gym attempt' });
    expect(res.status).toBe(404);
  });

  it('returns 409 when updating to a name already taken by another exercise', async () => {
    const takenName = `Taken-${Date.now()}`;
    await db.query(
      `INSERT INTO exercises (gym_id, name, status) VALUES (?, ?, 'active')`,
      [gymId, takenName],
    );
    const res = await request
      .put(`/exercises/${exerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: takenName });
    expect(res.status).toBe(409);
  });

  it('returns 403 for front_desk role on PUT (requireModuleWrite TRAINING)', async () => {
    const gymFD = await createTestGym('Exercises PUT FrontDesk Gym');
    await createTestMembership(gymFD, 'front_desk');
    const { insertId } = await db.query(
      `INSERT INTO exercises (gym_id, name, status) VALUES (?, 'FD Exercise', 'active')`,
      [gymFD],
    );
    const res = await request
      .put(`/exercises/${insertId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymFD)
      .send({ name: 'Should be 403' });
    expect(res.status).toBe(403);
  });
});

// ─── DELETE /exercises/:id ─────────────────────────────────────────────────────

describe('DELETE /exercises/:id', () => {
  let gymId: string;
  let exerciseId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Exercises DELETE Gym');
    await createTestMembership(gymId, 'admin');

    const { insertId } = await db.query(
      `INSERT INTO exercises (gym_id, name, status) VALUES (?, 'Delete Me', 'active')`,
      [gymId],
    );
    exerciseId = insertId;
  });

  it('returns 401 without auth', async () => {
    const res = await request
      .delete(`/exercises/${exerciseId}`)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 204 on successful soft-delete', async () => {
    const res = await request
      .delete(`/exercises/${exerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);
  });

  it('soft-deleted exercise no longer appears in GET /exercises list', async () => {
    const res = await request
      .get('/exercises')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((e: any) => e.id);
    expect(ids).not.toContain(exerciseId);
  });

  it('GET /exercises/:id returns 404 for soft-deleted exercise', async () => {
    const res = await request
      .get(`/exercises/${exerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 404 when attempting to delete an already-deleted exercise', async () => {
    const res = await request
      .delete(`/exercises/${exerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 403 for front_desk role on DELETE (requireModuleWrite TRAINING)', async () => {
    const gymFD = await createTestGym('Exercises DELETE FrontDesk Gym');
    await createTestMembership(gymFD, 'front_desk');
    const { insertId } = await db.query(
      `INSERT INTO exercises (gym_id, name, status) VALUES (?, 'FD Delete Exercise', 'active')`,
      [gymFD],
    );
    const res = await request
      .delete(`/exercises/${insertId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymFD);
    expect(res.status).toBe(403);
  });
});

// ─── POST /exercises/:id/duplicate ────────────────────────────────────────────

describe('POST /exercises/:id/duplicate', () => {
  let gymA: string;
  let gymB: string;
  let exerciseId: number;

  beforeAll(async () => {
    gymA = await createTestGym('Exercises Dup GymA');
    await createTestMembership(gymA, 'admin');
    gymB = await createTestGym('Exercises Dup GymB');
    await createTestMembership(gymB, 'admin');

    // Create a source exercise with muscles for the duplicate tests.
    const { insertId } = await db.query(
      `INSERT INTO exercises
         (gym_id, name, status, sets_default, min_reps_default, max_reps_default, rest_default_seconds)
       VALUES (?, 'Original Exercise', 'active', 4, 8, 12, 90)`,
      [gymA],
    );
    exerciseId = insertId;

    await db.query(
      `INSERT INTO exercise_muscles (gym_id, exercise_id, muscle, role) VALUES (?, ?, 'chest', 'principal')`,
      [gymA, exerciseId],
    );
    await db.query(
      `INSERT INTO exercise_muscles (gym_id, exercise_id, muscle, role) VALUES (?, ?, 'triceps', 'secondary')`,
      [gymA, exerciseId],
    );
  });

  it('returns 401 without auth', async () => {
    const res = await request
      .post(`/exercises/${exerciseId}/duplicate`)
      .set('x-gym-id', gymA);
    expect(res.status).toBe(401);
  });

  it('returns 201 with (Copy) name suffix and a new id', async () => {
    const res = await request
      .post(`/exercises/${exerciseId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA);
    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe(exerciseId);
    expect(res.body.name).toBe('Original Exercise (Copy)');
    expect(res.body.gym_id).toBe(gymA);
    expect(res.body.status).toBe('active');
    expect(res.body.sets_default).toBe(4);
  });

  it('copies muscles to the duplicate', async () => {
    // Use the HTTP API to get a fresh duplicate (a second copy).
    const res = await request
      .post(`/exercises/${exerciseId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA);
    expect(res.status).toBe(201);
    const muscles = res.body.muscles ?? [];
    expect(muscles.some((m: any) => m.key === 'chest' && m.role === 'principal')).toBe(true);
    expect(muscles.some((m: any) => m.key === 'triceps' && m.role === 'secondary')).toBe(true);
  });

  it('returns 404 when exercise belongs to another gym (tenant isolation)', async () => {
    const res = await request
      .post(`/exercises/${exerciseId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(404);
  });

  it('returns 404 when trying to duplicate a deleted exercise', async () => {
    const { insertId } = await db.query(
      `INSERT INTO exercises (gym_id, name, status) VALUES (?, 'Deleted Source', 'deleted')`,
      [gymA],
    );
    const res = await request
      .post(`/exercises/${insertId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA);
    expect(res.status).toBe(404);
  });

  it('returns 403 for front_desk role on duplicate (requireModuleWrite TRAINING)', async () => {
    const gymFD = await createTestGym('Exercises Dup FrontDesk Gym');
    await createTestMembership(gymFD, 'front_desk');
    const { insertId } = await db.query(
      `INSERT INTO exercises (gym_id, name, status) VALUES (?, 'FD Dup Source', 'active')`,
      [gymFD],
    );
    const res = await request
      .post(`/exercises/${insertId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymFD);
    expect(res.status).toBe(403);
  });
});

// ─── GET /exercises/base (#718) ───────────────────────────────────────────────

describe('GET /exercises/base', () => {
  let gymId: string;
  let otherGym: string;
  let gymNoAccess: string;
  let activeBaseId: number;
  let inactiveBaseId: number;
  let otherBaseId: number;
  const baseIds: number[] = [];

  async function createBaseExercise(name: string, status = 'active'): Promise<number> {
    const { insertId } = await db.query(
      `INSERT INTO exercises (gym_id, name, status) VALUES (NULL, ?, ?)`,
      [name, status],
    );
    baseIds.push(insertId);
    return insertId;
  }

  beforeAll(async () => {
    gymId = await createTestGym('Exercises Base List Gym');
    await createTestMembership(gymId, 'admin');
    otherGym = await createTestGym('Exercises Base List Other Gym');
    await createTestMembership(otherGym, 'admin');
    gymNoAccess = await createTestGym('Exercises Base List No Access Gym');
    await createTestMembership(gymNoAccess, 'accountant');

    activeBaseId = await createBaseExercise('Zz718 Barbell Bench Press');
    await db.query(
      `INSERT INTO exercise_muscles (gym_id, exercise_id, muscle, role) VALUES (NULL, ?, 'chest', 'principal')`,
      [activeBaseId],
    );
    await db.query(
      `INSERT INTO exercise_muscles (gym_id, exercise_id, muscle, role) VALUES (NULL, ?, 'triceps', 'secondary')`,
      [activeBaseId],
    );

    otherBaseId = await createBaseExercise('Zz718 Lat Pulldown');
    await db.query(
      `INSERT INTO exercise_muscles (gym_id, exercise_id, muscle, role) VALUES (NULL, ?, 'back', 'principal')`,
      [otherBaseId],
    );

    inactiveBaseId = await createBaseExercise('Zz718 Retired Machine Press', 'inactive');
  });

  // Base exercises are platform rows (gym_id IS NULL), so cleanupTestGyms — which
  // deletes by gym_id — cannot reach them. Remove them by id instead.
  afterAll(async () => {
    if (baseIds.length === 0) return;
    const marks = baseIds.map(() => '?').join(',');
    await db.query(`DELETE FROM exercise_muscles WHERE exercise_id IN (${marks})`, baseIds);
    await db.query(`DELETE FROM exercises WHERE cloned_from_id IN (${marks})`, baseIds);
    await db.query(`DELETE FROM exercises WHERE id IN (${marks})`, baseIds);
  });

  function get(path: string, gym = gymId) {
    return request.get(path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
  }

  it('returns 401 without auth', async () => {
    const res = await request.get('/exercises/base').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 for accountant role (TRAINING module NONE)', async () => {
    const res = await get('/exercises/base', gymNoAccess);
    expect(res.status).toBe(403);
  });

  it('lists active base exercises with their muscles', async () => {
    const res = await get('/exercises/base');
    expect(res.status).toBe(200);
    const row = res.body.find((e: any) => e.id === activeBaseId);
    expect(row).toBeDefined();
    expect(row.name).toBe('Zz718 Barbell Bench Press');
    expect(row.imported_exercise_id).toBeNull();
    expect(row.muscles.some((m: any) => m.key === 'chest' && m.role === 'principal')).toBe(true);
  });

  it('excludes inactive base exercises', async () => {
    const res = await get('/exercises/base');
    expect(res.body.map((e: any) => e.id)).not.toContain(inactiveBaseId);
  });

  it("excludes the gym's own exercises and other gyms' custom ones", async () => {
    const { insertId: ownId } = await db.query(
      `INSERT INTO exercises (gym_id, name, status) VALUES (?, 'Zz718 Own Custom', 'active')`,
      [gymId],
    );
    const { insertId: foreignId } = await db.query(
      `INSERT INTO exercises (gym_id, name, status) VALUES (?, 'Zz718 Foreign Custom', 'active')`,
      [otherGym],
    );
    const res = await get('/exercises/base');
    const ids = res.body.map((e: any) => e.id);
    expect(ids).not.toContain(ownId);
    expect(ids).not.toContain(foreignId);
  });

  it('filters by name, case-insensitively', async () => {
    const res = await get('/exercises/base?q=zz718%20barbell');
    expect(res.status).toBe(200);
    expect(res.body.map((e: any) => e.id)).toEqual([activeBaseId]);
  });

  it('filters by muscle', async () => {
    const res = await get('/exercises/base?muscle=back');
    expect(res.status).toBe(200);
    const ids = res.body.map((e: any) => e.id);
    expect(ids).toContain(otherBaseId);
    expect(ids).not.toContain(activeBaseId);
  });

  it('combines the name and muscle filters', async () => {
    const both = await get('/exercises/base?q=Zz718&muscle=chest');
    expect(both.body.map((e: any) => e.id)).toEqual([activeBaseId]);
    const neither = await get('/exercises/base?q=Zz718%20Lat&muscle=chest');
    expect(neither.body).toEqual([]);
  });

  it('returns 400 for an invalid muscle key', async () => {
    const res = await get('/exercises/base?muscle=not a muscle');
    expect(res.status).toBe(400);
  });

  it('marks a base exercise the gym imported (cloned_from_id) as already imported', async () => {
    const { insertId: copyId } = await db.query(
      `INSERT INTO exercises (gym_id, name, status, cloned_from_id) VALUES (?, 'Zz718 Renamed Copy', 'active', ?)`,
      [gymId, activeBaseId],
    );
    const res = await get('/exercises/base');
    const row = res.body.find((e: any) => e.id === activeBaseId);
    expect(row.imported_exercise_id).toBe(copyId);

    // …and only for that gym: the copy belongs to gymId alone.
    const other = await get('/exercises/base', otherGym);
    expect(other.body.find((e: any) => e.id === activeBaseId).imported_exercise_id).toBeNull();

    await db.query('DELETE FROM exercises WHERE id = ?', [copyId]);
  });

  it('marks a same-named copy with no provenance as already imported', async () => {
    const { insertId: legacyId } = await db.query(
      `INSERT INTO exercises (gym_id, name, status) VALUES (?, 'Zz718 Lat Pulldown', 'active')`,
      [gymId],
    );
    const res = await get('/exercises/base');
    expect(res.body.find((e: any) => e.id === otherBaseId).imported_exercise_id).toBe(legacyId);
    await db.query('DELETE FROM exercises WHERE id = ?', [legacyId]);
  });

  it('ignores a soft-deleted copy when deciding whether it is imported', async () => {
    const { insertId: deletedCopy } = await db.query(
      `INSERT INTO exercises (gym_id, name, status, cloned_from_id) VALUES (?, 'Zz718 Deleted Copy', 'deleted', ?)`,
      [gymId, activeBaseId],
    );
    const res = await get('/exercises/base');
    expect(res.body.find((e: any) => e.id === activeBaseId).imported_exercise_id).toBeNull();
    await db.query('DELETE FROM exercises WHERE id = ?', [deletedCopy]);
  });
});

// ─── POST /exercises/import (#718) ────────────────────────────────────────────

describe('POST /exercises/import', () => {
  let gymId: string;
  let otherGym: string;
  let benchId: number;
  let squatId: number;
  let inactiveBaseId: number;
  let resultTypeId: number;
  const baseIds: number[] = [];

  async function createBaseExercise(name: string, status = 'active'): Promise<number> {
    const { insertId } = await db.query(
      `INSERT INTO exercises (gym_id, name, status, sets_default, rest_default_seconds) VALUES (NULL, ?, ?, 4, 90)`,
      [name, status],
    );
    baseIds.push(insertId);
    return insertId;
  }

  beforeAll(async () => {
    gymId = await createTestGym('Exercises Import Gym');
    await createTestMembership(gymId, 'admin');
    otherGym = await createTestGym('Exercises Import Other Gym');
    await createTestMembership(otherGym, 'admin');

    benchId = await createBaseExercise('Zz718i Bench Press');
    squatId = await createBaseExercise('Zz718i Back Squat');
    inactiveBaseId = await createBaseExercise('Zz718i Withdrawn Exercise', 'inactive');

    await db.query(
      `INSERT INTO exercise_muscles (gym_id, exercise_id, muscle, role) VALUES (NULL, ?, 'chest', 'principal')`,
      [benchId],
    );
    await db.query(
      `INSERT INTO exercise_muscles (gym_id, exercise_id, muscle, role) VALUES (NULL, ?, 'triceps', 'secondary')`,
      [benchId],
    );
    const { rows: rts } = await db.query<{ id: number }>('SELECT id FROM result_types ORDER BY id LIMIT 1');
    resultTypeId = rts[0].id;
    await db.query(
      'INSERT IGNORE INTO exercise_allowed_result_types (exercise_id, result_type_id) VALUES (?, ?)',
      [benchId, resultTypeId],
    );
  });

  afterAll(async () => {
    if (baseIds.length === 0) return;
    const marks = baseIds.map(() => '?').join(',');
    await db.query(`DELETE FROM exercise_muscles WHERE exercise_id IN (${marks})`, baseIds);
    await db.query(`DELETE FROM exercise_allowed_result_types WHERE exercise_id IN (${marks})`, baseIds);
    await db.query(`DELETE FROM exercises WHERE cloned_from_id IN (${marks})`, baseIds);
    await db.query(`DELETE FROM exercises WHERE id IN (${marks})`, baseIds);
  });

  function post(body: unknown, gym = gymId) {
    return request
      .post('/exercises/import')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gym)
      .send(body as any);
  }

  it('returns 401 without auth', async () => {
    const res = await request.post('/exercises/import').set('x-gym-id', gymId).send({ baseExerciseIds: [benchId] });
    expect(res.status).toBe(401);
  });

  it('returns 403 for front_desk role (requireModuleWrite TRAINING)', async () => {
    const gymFD = await createTestGym('Exercises Import FrontDesk Gym');
    await createTestMembership(gymFD, 'front_desk');
    const res = await post({ baseExerciseIds: [benchId] }, gymFD);
    expect(res.status).toBe(403);
  });

  it('returns 400 when baseExerciseIds is missing, empty or not an array', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ baseExerciseIds: [] })).status).toBe(400);
    expect((await post({ baseExerciseIds: 'all' })).status).toBe(400);
  });

  it('returns 400 for a non-integer id', async () => {
    const res = await post({ baseExerciseIds: ['abc'] });
    expect(res.status).toBe(400);
  });

  it('returns 400 for more ids than one request may carry', async () => {
    const res = await post({ baseExerciseIds: Array.from({ length: 501 }, (_, i) => i + 1) });
    expect(res.status).toBe(400);
  });

  it("rejects a gym exercise id — a gym cannot import another gym's custom exercise", async () => {
    const { insertId: foreignId } = await db.query(
      `INSERT INTO exercises (gym_id, name, status) VALUES (?, 'Zz718i Foreign Custom', 'active')`,
      [otherGym],
    );
    const res = await post({ baseExerciseIds: [foreignId] });
    expect(res.status).toBe(400);
    expect(res.body.invalid_ids).toEqual([foreignId]);
    const { rows } = await db.query(
      "SELECT id FROM exercises WHERE gym_id = ? AND name = 'Zz718i Foreign Custom'",
      [gymId],
    );
    expect(rows).toHaveLength(0);
  });

  it('rejects an inactive base exercise and an unknown id', async () => {
    expect((await post({ baseExerciseIds: [inactiveBaseId] })).status).toBe(400);
    expect((await post({ baseExerciseIds: [999999999] })).status).toBe(400);
  });

  it('imports several base exercises in one request, keeping their names', async () => {
    const res = await post({ baseExerciseIds: [benchId, squatId] });
    expect(res.status).toBe(201);
    expect(res.body.skipped).toEqual([]);
    expect(res.body.imported).toHaveLength(2);
    const names = res.body.imported.map((e: any) => e.name).sort();
    expect(names).toEqual(['Zz718i Back Squat', 'Zz718i Bench Press']);
    for (const row of res.body.imported) {
      expect(row.gym_id).toBe(gymId);
      expect(row.status).toBe('active');
      expect(row.name).not.toContain('(Copy)');
    }
    const bench = res.body.imported.find((e: any) => e.name === 'Zz718i Bench Press');
    expect(bench.cloned_from_id).toBe(benchId);
    expect(bench.sets_default).toBe(4);
    expect(bench.muscles.some((m: any) => m.key === 'chest' && m.role === 'principal')).toBe(true);
    expect(bench.muscles.some((m: any) => m.key === 'triceps' && m.role === 'secondary')).toBe(true);
    expect(bench.allowed_result_types.map((rt: any) => rt.id)).toContain(resultTypeId);
  });

  it('makes the imported exercises visible in the gym list', async () => {
    const res = await request.get('/exercises').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    const names = res.body.filter((e: any) => e.gym_id === gymId).map((e: any) => e.name);
    expect(names).toContain('Zz718i Bench Press');
  });

  it('skips an exercise the gym already has instead of importing it twice', async () => {
    const res = await post({ baseExerciseIds: [benchId] });
    expect(res.status).toBe(201);
    expect(res.body.imported).toEqual([]);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0]).toMatchObject({ id: benchId, reason: 'already_imported' });
    const { rows } = await db.query(
      "SELECT id FROM exercises WHERE gym_id = ? AND name = 'Zz718i Bench Press' AND status != 'deleted'",
      [gymId],
    );
    expect(rows).toHaveLength(1);
  });

  it('skips a same-named copy that carries no provenance', async () => {
    const legacyBaseId = await createBaseExercise('Zz718i Legacy Seeded Name');
    await db.query(
      `INSERT INTO exercises (gym_id, name, status) VALUES (?, 'Zz718i Legacy Seeded Name', 'active')`,
      [gymId],
    );
    const res = await post({ baseExerciseIds: [legacyBaseId] });
    expect(res.status).toBe(201);
    expect(res.body.imported).toEqual([]);
    expect(res.body.skipped[0].reason).toBe('already_imported');
  });

  it('imports into the requesting gym only (tenant isolation)', async () => {
    const res = await post({ baseExerciseIds: [squatId] }, otherGym);
    expect(res.status).toBe(201);
    expect(res.body.imported).toHaveLength(1);
    expect(res.body.imported[0].gym_id).toBe(otherGym);
    const { rows } = await db.query(
      "SELECT gym_id FROM exercises WHERE name = 'Zz718i Back Squat' AND gym_id IS NOT NULL AND status != 'deleted'",
    );
    expect(rows.map((r: any) => r.gym_id).sort()).toEqual([gymId, otherGym].sort());
  });

  it('no longer exposes the retired import-defaults endpoint', async () => {
    const res = await request
      .post('/exercises/import-defaults')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});
