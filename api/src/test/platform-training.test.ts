// Tests for platform-exercises.ts, platform-workout-templates.ts, and platform-training-plan-templates.ts routers

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, request } from './helpers';

// Override the default @clerk/backend mock: make test-user-id a superadmin.
const mockGetUser = vi.hoisted(() =>
  vi.fn().mockImplementation(async () => ({
    publicMetadata: { platform_role: 'superadmin' },
    fullName: 'Super Admin',
    firstName: 'Super',
    lastName: 'Admin',
  })),
);

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: {
        getUser: mockGetUser,
        getUserList: vi.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      },
      invitations: {
        createInvitation: vi.fn().mockResolvedValue({ id: 'inv-test-id' }),
        revokeInvitation: vi.fn().mockResolvedValue({}),
      },
      emailAddresses: {
        getEmailAddress: vi.fn().mockResolvedValue({ emailAddress: 'test@example.com' }),
      },
    })),
  };
});

// Track base resource ids (gym_id IS NULL) created via API — cleanupTestGyms won't touch them.
const createdExerciseIds: number[] = [];
const createdWorkoutTemplateIds: number[] = [];
const createdTrainingPlanTemplateIds: number[] = [];

beforeAll(async () => {
  // No gym required — superadmin-only routes.
});

afterAll(async () => {
  // Clean platform resources in FK order.
  if (createdTrainingPlanTemplateIds.length > 0) {
    const marks = createdTrainingPlanTemplateIds.map(() => '?').join(',');
    await db.query(
      `DELETE FROM training_plan_template_workouts WHERE training_plan_template_id IN (${marks})`,
      createdTrainingPlanTemplateIds,
    );
    await db.query(
      `DELETE FROM training_plan_templates WHERE id IN (${marks}) AND gym_id IS NULL`,
      createdTrainingPlanTemplateIds,
    );
  }
  if (createdWorkoutTemplateIds.length > 0) {
    const marks = createdWorkoutTemplateIds.map(() => '?').join(',');
    await db.query(
      `DELETE FROM workout_template_exercises WHERE gym_id IS NULL AND workout_template_block_id IN (
        SELECT id FROM workout_template_blocks WHERE workout_template_id IN (${marks})
      )`,
      createdWorkoutTemplateIds,
    );
    await db.query(
      `DELETE FROM workout_template_blocks WHERE workout_template_id IN (${marks}) AND gym_id IS NULL`,
      createdWorkoutTemplateIds,
    );
    await db.query(
      `DELETE FROM workout_templates WHERE id IN (${marks}) AND gym_id IS NULL`,
      createdWorkoutTemplateIds,
    );
  }
  if (createdExerciseIds.length > 0) {
    const marks = createdExerciseIds.map(() => '?').join(',');
    await db.query(
      `DELETE FROM exercise_muscles WHERE exercise_id IN (${marks}) AND gym_id IS NULL`,
      createdExerciseIds,
    );
    await db.query(
      `DELETE FROM exercises WHERE id IN (${marks}) AND gym_id IS NULL`,
      createdExerciseIds,
    );
  }
  await cleanupTestGyms();
  await db.end();
});

// ─── /platform/exercises ──────────────────────────────────────────────────────

describe('GET /platform/exercises auth', () => {
  it('returns 401 without auth', async () => {
    const res = await request.get('/platform/exercises');
    expect(res.status).toBe(401);
  });

  it('returns 403 when user is not a superadmin', async () => {
    mockGetUser.mockResolvedValueOnce({ publicMetadata: {}, fullName: 'Regular', firstName: 'Regular', lastName: 'User' });
    const res = await request.get('/platform/exercises').set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(403);
  });
});

describe('platform exercises CRUD', () => {
  let exerciseId: number;
  const suffix = `${Date.now()}`;

  it('POST /platform/exercises returns 400 when name is missing', async () => {
    const res = await request
      .post('/platform/exercises')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ status: 'active' });
    expect(res.status).toBe(400);
  });

  it('POST /platform/exercises returns 201 and creates a base exercise', async () => {
    const res = await request
      .post('/platform/exercises')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({
        name: `Platform Exercise ${suffix}`,
        description: 'A platform exercise',
        sets_default: 3,
        min_reps_default: 8,
        max_reps_default: 12,
        muscles: [{ key: 'chest', role: 'principal' }, { key: 'triceps', role: 'secondary' }],
      });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe(`Platform Exercise ${suffix}`);
    expect(res.body.gym_id).toBeNull();
    expect(res.body.status).toBe('active');
    expect(res.body.sets_default).toBe(3);
    const muscles: any[] = res.body.muscles ?? [];
    expect(muscles.some((m: any) => m.key === 'chest' && m.role === 'principal')).toBe(true);
    exerciseId = res.body.id;
    createdExerciseIds.push(exerciseId);
  });

  it('POST /platform/exercises returns 409 when name already exists', async () => {
    const res = await request
      .post('/platform/exercises')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `Platform Exercise ${suffix}` });
    expect(res.status).toBe(409);
  });

  it('GET /platform/exercises returns 200 with an array', async () => {
    const res = await request.get('/platform/exercises').set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const found = res.body.find((e: any) => e.id === exerciseId);
    expect(found).toBeDefined();
  });

  it('GET /platform/exercises does not include deleted exercises', async () => {
    const res = await request.get('/platform/exercises').set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    for (const e of res.body) {
      expect(e.status).not.toBe('deleted');
    }
  });

  it('GET /platform/exercises/:id returns 200 with the exercise', async () => {
    const res = await request
      .get(`/platform/exercises/${exerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(exerciseId);
    expect(res.body.gym_id).toBeNull();
    expect(res.body).toHaveProperty('muscles');
    expect(res.body).toHaveProperty('allowed_result_types');
  });

  it('GET /platform/exercises/:id returns 404 for unknown id', async () => {
    const res = await request
      .get('/platform/exercises/999999')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(404);
  });

  it('PUT /platform/exercises/:id returns 200 and updates the exercise', async () => {
    const res = await request
      .put(`/platform/exercises/${exerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `Platform Exercise Updated ${suffix}`, sets_default: 4 });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(`Platform Exercise Updated ${suffix}`);
    expect(res.body.sets_default).toBe(4);
    expect(res.body.modified_at).not.toBeNull();
  });

  it('PUT /platform/exercises/:id returns 400 for invalid status', async () => {
    const res = await request
      .put(`/platform/exercises/${exerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ status: 'deleted' });
    expect(res.status).toBe(400);
  });

  it('PUT /platform/exercises/:id returns 404 for unknown id', async () => {
    const res = await request
      .put('/platform/exercises/999999')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: 'Ghost' });
    expect(res.status).toBe(404);
  });

  it('DELETE /platform/exercises/:id returns 204 (soft delete)', async () => {
    const res = await request
      .delete(`/platform/exercises/${exerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(204);
  });

  it('GET /platform/exercises/:id returns 404 after soft delete', async () => {
    const res = await request
      .get(`/platform/exercises/${exerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(404);
  });

  it('GET /platform/exercises hides deleted exercise by default', async () => {
    const res = await request.get('/platform/exercises').set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    const found = res.body.find((e: any) => e.id === exerciseId);
    expect(found).toBeUndefined();
  });

  it('DELETE /platform/exercises/:id returns 404 when already deleted', async () => {
    const res = await request
      .delete(`/platform/exercises/${exerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(404);
  });
});

// ─── /platform/workout-templates ─────────────────────────────────────────────

describe('GET /platform/workout-templates auth', () => {
  it('returns 401 without auth', async () => {
    const res = await request.get('/platform/workout-templates');
    expect(res.status).toBe(401);
  });

  it('returns 403 when user is not a superadmin', async () => {
    mockGetUser.mockResolvedValueOnce({ publicMetadata: {}, fullName: 'Regular', firstName: 'Regular', lastName: 'User' });
    const res = await request.get('/platform/workout-templates').set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(403);
  });
});

describe('platform workout templates CRUD', () => {
  let templateId: number;
  let blockId: number;
  const suffix = `${Date.now()}`;

  it('POST /platform/workout-templates returns 400 when name is missing', async () => {
    const res = await request
      .post('/platform/workout-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ description: 'no name' });
    expect(res.status).toBe(400);
  });

  it('POST /platform/workout-templates returns 201 and creates a base template', async () => {
    const res = await request
      .post('/platform/workout-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `Platform Workout ${suffix}`, description: 'Base template', notes: 'Focus on form' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe(`Platform Workout ${suffix}`);
    expect(res.body.gym_id).toBeNull();
    expect(res.body.status).toBe('active');
    templateId = res.body.id;
    createdWorkoutTemplateIds.push(templateId);
  });

  it('GET /platform/workout-templates returns 200 with items array and total', async () => {
    const res = await request
      .get('/platform/workout-templates')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe('number');
    const found = res.body.items.find((t: any) => t.id === templateId);
    expect(found).toBeDefined();
  });

  it('GET /platform/workout-templates/:id returns 200 with blocks array', async () => {
    const res = await request
      .get(`/platform/workout-templates/${templateId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(templateId);
    expect(res.body.gym_id).toBeNull();
    expect(res.body).toHaveProperty('blocks');
  });

  it('GET /platform/workout-templates/:id returns 404 for unknown id', async () => {
    const res = await request
      .get('/platform/workout-templates/999999')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(404);
  });

  it('PUT /platform/workout-templates/:id returns 200 and updates the template', async () => {
    const res = await request
      .put(`/platform/workout-templates/${templateId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `Platform Workout Updated ${suffix}`, status: 'inactive' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(`Platform Workout Updated ${suffix}`);
    expect(res.body.status).toBe('inactive');
  });

  it('PUT /platform/workout-templates/:id returns 400 for invalid status', async () => {
    const res = await request
      .put(`/platform/workout-templates/${templateId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ status: 'deleted' });
    expect(res.status).toBe(400);
  });

  it('PUT /platform/workout-templates/:id returns 404 for unknown id', async () => {
    const res = await request
      .put('/platform/workout-templates/999999')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: 'Ghost' });
    expect(res.status).toBe(404);
  });

  it('POST /platform/workout-templates/:id/blocks returns 201 and creates a block', async () => {
    const res = await request
      .post(`/platform/workout-templates/${templateId}/blocks`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ type: 'Standard', name: 'Block A', rounds: 3 });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe('Standard');
    expect(res.body.workout_template_id).toBe(templateId);
    expect(res.body.gym_id).toBeNull();
    blockId = res.body.id;
  });

  it('POST /platform/workout-templates/:id/blocks returns 400 for invalid block type', async () => {
    const res = await request
      .post(`/platform/workout-templates/${templateId}/blocks`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ type: 'Invalid' });
    expect(res.status).toBe(400);
  });

  it('GET /platform/workout-templates/:id/blocks returns 200 with blocks array', async () => {
    const res = await request
      .get(`/platform/workout-templates/${templateId}/blocks`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const found = res.body.find((b: any) => b.id === blockId);
    expect(found).toBeDefined();
  });

  it('DELETE /platform/workout-templates/:id/blocks/:blockId returns 204', async () => {
    const res = await request
      .delete(`/platform/workout-templates/${templateId}/blocks/${blockId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(204);
  });

  it('DELETE /platform/workout-templates/:id returns 204 (soft delete)', async () => {
    const res = await request
      .delete(`/platform/workout-templates/${templateId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(204);
  });

  it('GET /platform/workout-templates/:id returns 404 after soft delete', async () => {
    const res = await request
      .get(`/platform/workout-templates/${templateId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(404);
  });

  it('GET /platform/workout-templates hides deleted template by default', async () => {
    const res = await request
      .get('/platform/workout-templates')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    const found = res.body.items.find((t: any) => t.id === templateId);
    expect(found).toBeUndefined();
  });

  it('DELETE /platform/workout-templates/:id returns 404 when already deleted', async () => {
    const res = await request
      .delete(`/platform/workout-templates/${templateId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(404);
  });
});

// ─── /platform/training-plan-templates ───────────────────────────────────────

describe('GET /platform/training-plan-templates auth', () => {
  it('returns 401 without auth', async () => {
    const res = await request.get('/platform/training-plan-templates');
    expect(res.status).toBe(401);
  });

  it('returns 403 when user is not a superadmin', async () => {
    mockGetUser.mockResolvedValueOnce({ publicMetadata: {}, fullName: 'Regular', firstName: 'Regular', lastName: 'User' });
    const res = await request
      .get('/platform/training-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(403);
  });
});

describe('platform training plan templates CRUD', () => {
  let planTemplateId: number;
  const suffix = `${Date.now()}`;

  it('POST /platform/training-plan-templates returns 400 when name is missing', async () => {
    const res = await request
      .post('/platform/training-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ description: 'no name' });
    expect(res.status).toBe(400);
  });

  it('POST /platform/training-plan-templates returns 400 for invalid status', async () => {
    const res = await request
      .post('/platform/training-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `Base Plan ${suffix}`, status: 'unknown' });
    expect(res.status).toBe(400);
  });

  it('POST /platform/training-plan-templates returns 201 and creates a base plan template', async () => {
    const res = await request
      .post('/platform/training-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `Base Plan ${suffix}`, description: 'A base plan' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe(`Base Plan ${suffix}`);
    expect(res.body.gym_id).toBeNull();
    expect(res.body.status).toBe('active');
    planTemplateId = res.body.id;
    createdTrainingPlanTemplateIds.push(planTemplateId);
  });

  it('GET /platform/training-plan-templates returns 200 with items array and total', async () => {
    const res = await request
      .get('/platform/training-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe('number');
    const found = res.body.items.find((t: any) => t.id === planTemplateId);
    expect(found).toBeDefined();
  });

  it('GET /platform/training-plan-templates does not include deleted templates', async () => {
    const res = await request
      .get('/platform/training-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    for (const t of res.body.items) {
      expect(t.status).not.toBe('deleted');
    }
  });

  it('GET /platform/training-plan-templates/:id returns 200 with workouts array', async () => {
    const res = await request
      .get(`/platform/training-plan-templates/${planTemplateId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(planTemplateId);
    expect(res.body.gym_id).toBeNull();
    expect(res.body).toHaveProperty('workouts');
  });

  it('GET /platform/training-plan-templates/:id returns 404 for unknown id', async () => {
    const res = await request
      .get('/platform/training-plan-templates/999999')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(404);
  });

  it('PUT /platform/training-plan-templates/:id returns 200 and updates the template', async () => {
    const res = await request
      .put(`/platform/training-plan-templates/${planTemplateId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `Base Plan Updated ${suffix}`, status: 'inactive' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(`Base Plan Updated ${suffix}`);
    expect(res.body.status).toBe('inactive');
    expect(res.body.modified_at).not.toBeNull();
  });

  it('PUT /platform/training-plan-templates/:id returns 400 for invalid status', async () => {
    const res = await request
      .put(`/platform/training-plan-templates/${planTemplateId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ status: 'bogus' });
    expect(res.status).toBe(400);
  });

  it('PUT /platform/training-plan-templates/:id returns 404 for unknown id', async () => {
    const res = await request
      .put('/platform/training-plan-templates/999999')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: 'Ghost' });
    expect(res.status).toBe(404);
  });

  it('DELETE /platform/training-plan-templates/:id returns 204 (soft delete)', async () => {
    const res = await request
      .delete(`/platform/training-plan-templates/${planTemplateId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(204);
  });

  it('GET /platform/training-plan-templates/:id returns 404 after soft delete', async () => {
    const res = await request
      .get(`/platform/training-plan-templates/${planTemplateId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(404);
  });

  it('GET /platform/training-plan-templates hides deleted template by default', async () => {
    const res = await request
      .get('/platform/training-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    const found = res.body.items.find((t: any) => t.id === planTemplateId);
    expect(found).toBeUndefined();
  });

  it('DELETE /platform/training-plan-templates/:id returns 404 when already deleted', async () => {
    const res = await request
      .delete(`/platform/training-plan-templates/${planTemplateId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(404);
  });
});
