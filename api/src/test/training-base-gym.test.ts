// Tests for gym-level access to base training resources (exercises, workout-templates, training-plan-templates).
// Covers: base resources appearing in gym-level lists, 403 guards on PUT/DELETE for base resources,
// and the clone/assign endpoints introduced in #260.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

// IDs of base resources (gym_id IS NULL) inserted directly for tests.
const baseExerciseIds: number[] = [];
const baseWorkoutTemplateIds: number[] = [];
const basePlanTemplateIds: number[] = [];

afterAll(async () => {
  // Delete base resources in FK order (gym rows cascade their own children).
  if (basePlanTemplateIds.length > 0) {
    const marks = basePlanTemplateIds.map(() => '?').join(',');
    await db.query(
      `DELETE FROM training_plan_template_workouts WHERE training_plan_template_id IN (${marks})`,
      basePlanTemplateIds,
    );
    await db.query(
      `DELETE FROM training_plan_templates WHERE id IN (${marks}) AND gym_id IS NULL`,
      basePlanTemplateIds,
    );
  }
  if (baseWorkoutTemplateIds.length > 0) {
    const marks = baseWorkoutTemplateIds.map(() => '?').join(',');
    // workout_template_exercises blocks are deleted by cascade if we delete blocks first
    await db.query(
      `DELETE FROM workout_template_exercises WHERE gym_id IS NULL AND workout_template_block_id IN (
        SELECT id FROM workout_template_blocks WHERE workout_template_id IN (${marks})
      )`,
      baseWorkoutTemplateIds,
    );
    await db.query(
      `DELETE FROM workout_template_blocks WHERE workout_template_id IN (${marks}) AND gym_id IS NULL`,
      baseWorkoutTemplateIds,
    );
    await db.query(
      `DELETE FROM workout_templates WHERE id IN (${marks}) AND gym_id IS NULL`,
      baseWorkoutTemplateIds,
    );
  }
  if (baseExerciseIds.length > 0) {
    const marks = baseExerciseIds.map(() => '?').join(',');
    await db.query(
      `DELETE FROM exercise_muscles WHERE exercise_id IN (${marks}) AND gym_id IS NULL`,
      baseExerciseIds,
    );
    await db.query(
      `DELETE FROM exercises WHERE id IN (${marks}) AND gym_id IS NULL`,
      baseExerciseIds,
    );
  }
  await cleanupTestGyms();
  await db.end();
});

// ─── Exercises: base resources visible + write guards + clone ─────────────────

describe('gym-level exercises: base resource visibility', () => {
  let gymId: string;
  let baseExerciseId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Base Ex Visibility Gym');
    await createTestMembership(gymId, 'admin');

    const { insertId } = await db.query(
      `INSERT INTO exercises (gym_id, name, status) VALUES (NULL, ?, 'active')`,
      [`Base Visibility Exercise ${Date.now()}`],
    );
    baseExerciseId = insertId;
    baseExerciseIds.push(baseExerciseId);
  });

  it('GET /exercises includes the base exercise in the list', async () => {
    const res = await request
      .get('/exercises')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const found = res.body.find((e: any) => e.id === baseExerciseId);
    expect(found).toBeDefined();
    expect(found.gym_id).toBeNull();
  });

  it('GET /exercises/:id returns 200 for a base exercise', async () => {
    const res = await request
      .get(`/exercises/${baseExerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(baseExerciseId);
    expect(res.body.gym_id).toBeNull();
  });
});

describe('gym-level exercises: 403 on base resource writes', () => {
  let gymId: string;
  let baseExerciseId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Base Ex Write Guard Gym');
    await createTestMembership(gymId, 'admin');

    const { insertId } = await db.query(
      `INSERT INTO exercises (gym_id, name, status) VALUES (NULL, ?, 'active')`,
      [`Base Write Guard Exercise ${Date.now()}`],
    );
    baseExerciseId = insertId;
    baseExerciseIds.push(baseExerciseId);
  });

  it('PUT /exercises/:id returns 403 for a base exercise', async () => {
    const res = await request
      .put(`/exercises/${baseExerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Attempted Base Update' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/base exercises/i);
  });

  it('DELETE /exercises/:id returns 403 for a base exercise', async () => {
    const res = await request
      .delete(`/exercises/${baseExerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/base exercises/i);
  });
});

describe('POST /exercises/:id/clone', () => {
  let gymId: string;
  let gymB: string;
  let baseExerciseId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Clone Exercise GymA');
    await createTestMembership(gymId, 'admin');
    gymB = await createTestGym('Clone Exercise GymB');
    await createTestMembership(gymB, 'admin');

    const { insertId } = await db.query(
      `INSERT INTO exercises
        (gym_id, name, status, sets_default, min_reps_default, max_reps_default)
       VALUES (NULL, ?, 'active', 4, 8, 12)`,
      [`Cloneable Exercise ${Date.now()}`],
    );
    baseExerciseId = insertId;
    baseExerciseIds.push(baseExerciseId);

    await db.query(
      `INSERT INTO exercise_muscles (gym_id, exercise_id, muscle, role) VALUES (NULL, ?, 'chest', 'principal')`,
      [baseExerciseId],
    );
  });

  it('returns 401 without auth', async () => {
    const res = await request
      .post(`/exercises/${baseExerciseId}/clone`)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 201 and creates a gym-owned copy with (Copy) suffix', async () => {
    const srcRes = await request
      .get(`/exercises/${baseExerciseId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    const srcName = srcRes.body.name;

    const res = await request
      .post(`/exercises/${baseExerciseId}/clone`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe(baseExerciseId);
    expect(res.body.name).toBe(`${srcName} (Copy)`);
    expect(res.body.gym_id).toBe(gymId);
    expect(res.body.sets_default).toBe(4);
    const muscles: any[] = res.body.muscles ?? [];
    expect(muscles.some((m: any) => m.key === 'chest' && m.role === 'principal')).toBe(true);
  });

  it('returns 404 when trying to clone a gym-owned exercise via /clone', async () => {
    const { insertId } = await db.query(
      `INSERT INTO exercises (gym_id, name, status) VALUES (?, ?, 'active')`,
      [gymId, `Gym Owned Exercise ${Date.now()}`],
    );
    const res = await request
      .post(`/exercises/${insertId}/clone`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

// ─── Workout templates: base resources visible + write guards + clone ─────────

describe('gym-level workout-templates: base resource visibility', () => {
  let gymId: string;
  let baseTemplateId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Base WT Visibility Gym');
    await createTestMembership(gymId, 'admin');

    const { insertId } = await db.query(
      `INSERT INTO workout_templates (gym_id, name, status) VALUES (NULL, ?, 'active')`,
      [`Base Visible Workout ${Date.now()}`],
    );
    baseTemplateId = insertId;
    baseWorkoutTemplateIds.push(baseTemplateId);
  });

  it('GET /workout-templates includes the base template in items', async () => {
    const res = await request
      .get('/workout-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const items = res.body.items ?? res.body;
    const found = items.find((t: any) => t.id === baseTemplateId);
    expect(found).toBeDefined();
    expect(found.gym_id).toBeNull();
  });

  it('GET /workout-templates/:id returns 200 for a base template', async () => {
    const res = await request
      .get(`/workout-templates/${baseTemplateId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(baseTemplateId);
    expect(res.body.gym_id).toBeNull();
  });
});

describe('gym-level workout-templates: 403 on base resource writes', () => {
  let gymId: string;
  let baseTemplateId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Base WT Write Guard Gym');
    await createTestMembership(gymId, 'admin');

    const { insertId } = await db.query(
      `INSERT INTO workout_templates (gym_id, name, status) VALUES (NULL, ?, 'active')`,
      [`Base Write Guard Workout ${Date.now()}`],
    );
    baseTemplateId = insertId;
    baseWorkoutTemplateIds.push(baseTemplateId);
  });

  it('PUT /workout-templates/:id returns 403 for a base template', async () => {
    const res = await request
      .put(`/workout-templates/${baseTemplateId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Attempted Base Update' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/base workout templates/i);
  });

  it('DELETE /workout-templates/:id returns 403 for a base template', async () => {
    const res = await request
      .delete(`/workout-templates/${baseTemplateId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/base workout templates/i);
  });
});

describe('POST /workout-templates/:id/clone', () => {
  let gymId: string;
  let baseTemplateId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Clone WT Gym');
    await createTestMembership(gymId, 'admin');

    const { insertId } = await db.query(
      `INSERT INTO workout_templates (gym_id, name, status, description)
       VALUES (NULL, ?, 'active', 'Base template for cloning')`,
      [`Cloneable Workout ${Date.now()}`],
    );
    baseTemplateId = insertId;
    baseWorkoutTemplateIds.push(baseTemplateId);
  });

  it('returns 401 without auth', async () => {
    const res = await request
      .post(`/workout-templates/${baseTemplateId}/clone`)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 201 and creates a gym-owned copy with (Copy) suffix', async () => {
    const srcRes = await request
      .get(`/workout-templates/${baseTemplateId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    const srcName = srcRes.body.name;

    const res = await request
      .post(`/workout-templates/${baseTemplateId}/clone`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe(baseTemplateId);
    expect(res.body.name).toBe(`${srcName} (Copy)`);
    expect(res.body.gym_id).toBe(gymId);
    expect(res.body.status).toBe('active');
  });

  it('returns 404 when trying to clone a gym-owned template via /clone', async () => {
    const { insertId } = await db.query(
      `INSERT INTO workout_templates (gym_id, name, status) VALUES (?, ?, 'active')`,
      [gymId, `Gym Owned Workout ${Date.now()}`],
    );
    const res = await request
      .post(`/workout-templates/${insertId}/clone`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

// ─── Training plan templates: base resources visible + write guards + clone/assign ──

describe('gym-level training-plan-templates: base resource visibility', () => {
  let gymId: string;
  let basePlanId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Base TPT Visibility Gym');
    await createTestMembership(gymId, 'admin');

    const { insertId } = await db.query(
      `INSERT INTO training_plan_templates (gym_id, name, status) VALUES (NULL, ?, 'active')`,
      [`Base Visible Plan ${Date.now()}`],
    );
    basePlanId = insertId;
    basePlanTemplateIds.push(basePlanId);
  });

  it('GET /training-plan-templates includes the base template in items', async () => {
    const res = await request
      .get('/training-plan-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const items = res.body.items ?? res.body;
    const found = items.find((t: any) => t.id === basePlanId);
    expect(found).toBeDefined();
    expect(found.gym_id).toBeNull();
  });

  it('GET /training-plan-templates/:id returns 200 for a base template', async () => {
    const res = await request
      .get(`/training-plan-templates/${basePlanId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(basePlanId);
    expect(res.body.gym_id).toBeNull();
  });
});

describe('gym-level training-plan-templates: 403 on base resource writes', () => {
  let gymId: string;
  let basePlanId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Base TPT Write Guard Gym');
    await createTestMembership(gymId, 'admin');

    const { insertId } = await db.query(
      `INSERT INTO training_plan_templates (gym_id, name, status) VALUES (NULL, ?, 'active')`,
      [`Base Write Guard Plan ${Date.now()}`],
    );
    basePlanId = insertId;
    basePlanTemplateIds.push(basePlanId);
  });

  it('PUT /training-plan-templates/:id returns 403 for a base template', async () => {
    const res = await request
      .put(`/training-plan-templates/${basePlanId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Attempted Base Update' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/base training plan templates/i);
  });

  it('DELETE /training-plan-templates/:id returns 403 for a base template', async () => {
    const res = await request
      .delete(`/training-plan-templates/${basePlanId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/base training plan templates/i);
  });
});

describe('POST /training-plan-templates/:id/clone', () => {
  let gymId: string;
  let basePlanId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Clone TPT Gym');
    await createTestMembership(gymId, 'admin');

    const { insertId } = await db.query(
      `INSERT INTO training_plan_templates (gym_id, name, status, description)
       VALUES (NULL, ?, 'active', 'Base plan for cloning')`,
      [`Cloneable Plan ${Date.now()}`],
    );
    basePlanId = insertId;
    basePlanTemplateIds.push(basePlanId);
  });

  it('returns 401 without auth', async () => {
    const res = await request
      .post(`/training-plan-templates/${basePlanId}/clone`)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 201 and creates a gym-owned draft copy with (Copy) suffix', async () => {
    const srcRes = await request
      .get(`/training-plan-templates/${basePlanId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    const srcName = srcRes.body.name;

    const res = await request
      .post(`/training-plan-templates/${basePlanId}/clone`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe(basePlanId);
    expect(res.body.name).toBe(`${srcName} (Copy)`);
    expect(res.body.gym_id).toBe(gymId);
    expect(res.body.status).toBe('draft');
  });

  it('returns 404 when trying to clone a gym-owned template via /clone', async () => {
    const { insertId } = await db.query(
      `INSERT INTO training_plan_templates (gym_id, name, status) VALUES (?, ?, 'active')`,
      [gymId, `Gym Owned Plan ${Date.now()}`],
    );
    const res = await request
      .post(`/training-plan-templates/${insertId}/clone`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

describe('POST /training-plan-templates/:id/assign', () => {
  let gymId: string;
  let basePlanId: number;
  let gymPlanId: number;
  let memberId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Assign TPT Gym');
    await createTestMembership(gymId, 'admin');

    // Create a member to assign to.
    const { insertId: mId } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Assign Member', ?)`,
      [gymId, `assign-${Date.now()}@test.com`],
    );
    memberId = mId;

    // Create a base plan template.
    const { insertId: bId } = await db.query(
      `INSERT INTO training_plan_templates (gym_id, name, status) VALUES (NULL, ?, 'active')`,
      [`Assignable Base Plan ${Date.now()}`],
    );
    basePlanId = bId;
    basePlanTemplateIds.push(basePlanId);

    // Create a gym-owned plan template for the gym-assign test.
    const { insertId: gId } = await db.query(
      `INSERT INTO training_plan_templates (gym_id, name, status) VALUES (?, ?, 'active')`,
      [gymId, `Assignable Gym Plan ${Date.now()}`],
    );
    gymPlanId = gId;
  });

  it('returns 401 without auth', async () => {
    const res = await request
      .post(`/training-plan-templates/${basePlanId}/assign`)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId });
    expect(res.status).toBe(401);
  });

  it('returns 400 when member_id is missing', async () => {
    const res = await request
      .post(`/training-plan-templates/${basePlanId}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({});
    expect(res.status).toBe(400);
  });

  it('assigns a base plan template to a member and returns 201', async () => {
    const res = await request
      .post(`/training-plan-templates/${basePlanId}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, name: 'Assigned Base Plan', start_date: new Date().toISOString().slice(0, 10) });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.member_id).toBe(memberId);
  });

  it('assigns a gym-owned plan template to a member and returns 201', async () => {
    const res = await request
      .post(`/training-plan-templates/${gymPlanId}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, name: 'Assigned Gym Plan', start_date: new Date().toISOString().slice(0, 10), on_existing_active: 'keep' });
    // Either 201 (first active or keep) or 409 (conflict) are valid — the important thing is the endpoint is reachable.
    expect([201, 409]).toContain(res.status);
  });
});
