// #966: GET /training-plan-templates/:id/hierarchy — the 4-level tree the
// Training Plan Templates page fetches on first expand of a row.
//
// The endpoint selected `b.result_type`, a column migration 074 (#154) dropped
// when it moved the result type from the block down to the exercise instance,
// so every expand answered `Unknown column 'b.result_type' in 'field list'`
// and the row stayed on `Loading…`. These tests pin the shape the client
// expects (`HierBlock`/`HierExercise` in
// apps/admin/src/app/[locale]/workout-templates/summaries.ts) rather than only
// the 200: a block carries no `result_type`, and each exercise carries the
// result type it is actually configured with.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  request, TEST_AUTH_HEADER, createTestGym, createTestMembership, cleanupTestGyms,
} from './helpers';

let gymId: string;
let gymBId: string;
let exerciseId: number;
let durationResultTypeId: number;

/** One workout template with a single Standard block; returns both ids. */
async function createWorkoutTemplate(name: string): Promise<{ templateId: number; blockId: number }> {
  const tpl = await request
    .post('/workout-templates')
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ name, status: 'active' })
    .expect(201);
  const block = await request
    .post(`/workout-templates/${tpl.body.id}/blocks`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ type: 'Standard' })
    .expect(201);
  return { templateId: tpl.body.id, blockId: block.body.id };
}

async function addExercise(templateId: number, blockId: number, body: Record<string, unknown>) {
  return request
    .post(`/workout-templates/${templateId}/blocks/${blockId}/exercises`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ exercise_id: exerciseId, ...body })
    .expect(201);
}

async function createPlanTemplate(name: string): Promise<number> {
  const res = await request
    .post('/training-plan-templates')
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ name, description: 'Expanded by the page', status: 'active' })
    .expect(201);
  return res.body.id;
}

async function linkWorkout(planTemplateId: number, workoutTemplateId: number, weekday?: number) {
  return request
    .post(`/training-plan-templates/${planTemplateId}/workouts`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ workout_template_id: workoutTemplateId, scheduled_weekday: weekday ?? '' })
    .expect(201);
}

function hierarchy(planTemplateId: number, gym = gymId) {
  return request
    .get(`/training-plan-templates/${planTemplateId}/hierarchy`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gym);
}

beforeAll(async () => {
  gymId = await createTestGym('TPT Hierarchy Gym');
  gymBId = await createTestGym('TPT Hierarchy Gym B');
  await createTestMembership(gymId);
  await createTestMembership(gymBId);

  const { insertId } = await db.query(
    "INSERT INTO exercises (gym_id, name, status) VALUES (?, 'Plank', 'active')",
    [gymId],
  );
  exerciseId = insertId;

  // `result_types` is the seeded, gym-less catalogue (migration 073).
  const { rows } = await db.query("SELECT id FROM result_types WHERE slug = 'duration'");
  durationResultTypeId = rows[0].id;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('GET /training-plan-templates/:id/hierarchy', () => {
  it('loads a template with one workout, one block and its exercises', async () => {
    const { templateId, blockId } = await createWorkoutTemplate('Core Day');
    await addExercise(templateId, blockId, { sets: 3, min_reps: 10, max_reps: 12 });
    const planId = await createPlanTemplate('One Workout Plan');
    await linkWorkout(planId, templateId, 1);

    const res = await hierarchy(planId).expect(200);

    expect(res.body.id).toBe(planId);
    expect(res.body.workouts).toHaveLength(1);
    const workout = res.body.workouts[0];
    expect(workout.workout_template_name).toBe('Core Day');
    expect(workout.scheduled_weekday).toBe(1);
    expect(workout.blocks).toHaveLength(1);
    expect(workout.blocks[0].exercises).toHaveLength(1);
    expect(workout.blocks[0].exercises[0].exercise_name).toBe('Plank');
  });

  it('never selects a block-level result_type — #154 moved it to the exercise', async () => {
    const { templateId, blockId } = await createWorkoutTemplate('No Block Result Type');
    await addExercise(templateId, blockId, { sets: 2 });
    const planId = await createPlanTemplate('Block Shape Plan');
    await linkWorkout(planId, templateId);

    const res = await hierarchy(planId).expect(200);
    const block = res.body.workouts[0].blocks[0];
    expect(block).not.toHaveProperty('result_type');
    expect(block.type).toBe('Standard');
  });

  it('reports each exercise instance\'s own result type, from result_types', async () => {
    const { templateId, blockId } = await createWorkoutTemplate('Result Types Day');
    await addExercise(templateId, blockId, {
      sets: 4, result_type_id: durationResultTypeId, target_value: 45, unit: 's',
    });
    await addExercise(templateId, blockId, { sets: 3, min_reps: 8, max_reps: 8 });
    const planId = await createPlanTemplate('Result Types Plan');
    await linkWorkout(planId, templateId);

    const res = await hierarchy(planId).expect(200);
    const exercises = res.body.workouts[0].blocks[0].exercises;
    expect(exercises).toHaveLength(2);

    // The configured one carries the id, the catalogue's slug and its name —
    // the three keys `exerciseSummary()` reads.
    expect(exercises[0].result_type_id).toBe(durationResultTypeId);
    expect(exercises[0].result_type_slug).toBe('duration');
    expect(typeof exercises[0].result_type_name).toBe('string');
    expect(Number(exercises[0].target_value)).toBe(45);
    expect(exercises[0].unit).toBe('s');

    // An exercise with no result type still loads, with nulls rather than a
    // dropped row — the LEFT JOIN is what keeps it in the tree.
    expect(exercises[1].result_type_id).toBeNull();
    expect(exercises[1].result_type_slug).toBeNull();
    expect(exercises[1].min_reps).toBe(8);
  });

  it('loads multiple workouts in their configured order', async () => {
    const first = await createWorkoutTemplate('Day A');
    const second = await createWorkoutTemplate('Day B');
    await addExercise(first.templateId, first.blockId, { sets: 1 });
    await addExercise(second.templateId, second.blockId, { sets: 2 });
    const planId = await createPlanTemplate('Two Workout Plan');
    await linkWorkout(planId, first.templateId, 1);
    await linkWorkout(planId, second.templateId, 3);

    const res = await hierarchy(planId).expect(200);
    expect(res.body.workouts.map((w: any) => w.workout_template_name)).toEqual(['Day A', 'Day B']);
    expect(res.body.workouts.map((w: any) => w.position)).toEqual([1, 2]);
  });

  it('loads a template with no workouts, and a workout whose block has no exercises', async () => {
    const emptyPlanId = await createPlanTemplate('Empty Plan');
    const emptyRes = await hierarchy(emptyPlanId).expect(200);
    expect(emptyRes.body.workouts).toBeNull();

    const { templateId } = await createWorkoutTemplate('Empty Block Day');
    const planId = await createPlanTemplate('Empty Block Plan');
    await linkWorkout(planId, templateId);
    const res = await hierarchy(planId).expect(200);
    expect(res.body.workouts[0].blocks[0].exercises).toBeNull();
  });

  it('404s a template of another gym, and an unknown id', async () => {
    const { templateId, blockId } = await createWorkoutTemplate('Tenant Day');
    await addExercise(templateId, blockId, { sets: 1 });
    const planId = await createPlanTemplate('Tenant Plan');
    await linkWorkout(planId, templateId);

    await hierarchy(planId, gymBId).expect(404);
    await hierarchy(999999).expect(404);
  });

  it('401s without authentication', async () => {
    const planId = await createPlanTemplate('Auth Plan');
    await request
      .get(`/training-plan-templates/${planId}/hierarchy`)
      .set('x-gym-id', gymId)
      .expect(401);
  });
});
