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
