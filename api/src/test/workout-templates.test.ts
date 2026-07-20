import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  request, TEST_AUTH_HEADER, createTestGym, createTestMembership, cleanupTestGyms,
} from './helpers';

let gymId: string;
let gymBId: string;
let templateId: number;
let exerciseId: number;

beforeAll(async () => {
  gymId = await createTestGym('WT Test Gym');
  gymBId = await createTestGym('WT Test Gym B');
  await createTestMembership(gymId);
  await createTestMembership(gymBId);

  const { insertId } = await db.query(
    `INSERT INTO exercises (gym_id, name, status) VALUES (?, 'Push-up', 'active')`,
    [gymId],
  );
  exerciseId = insertId;

  const res = await request
    .post('/workout-templates')
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ name: 'Upper Body', description: 'Chest day', status: 'active' });
  templateId = res.body.id;

  // Add a block with an exercise so the deep-copy has something to clone.
  const blockRes = await request
    .post(`/workout-templates/${templateId}/blocks`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ type: 'Standard', result_type: 'None' });
  const blockId = blockRes.body.id;

  await request
    .post(`/workout-templates/${templateId}/blocks/${blockId}/exercises`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ exercise_id: exerciseId, sets: 3, min_reps: 10, max_reps: 15 });
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('POST /workout-templates/:id/duplicate', () => {
  it('returns 201 with (Copy) suffix and new id', async () => {
    const res = await request
      .post(`/workout-templates/${templateId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .expect(201);

    expect(res.body.id).not.toBe(templateId);
    expect(res.body.name).toBe('Upper Body (Copy)');
    expect(res.body.status).toBe('active');
    expect(res.body.description).toBe('Chest day');
  });

  it('appends (Copy 2) when (Copy) already exists', async () => {
    const res = await request
      .post(`/workout-templates/${templateId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .expect(201);

    expect(res.body.name).toBe('Upper Body (Copy 2)');
  });

  it('deep-copies blocks and exercises', async () => {
    // Create a fresh template with one block + one exercise and duplicate it.
    const tplRes = await request
      .post('/workout-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Deep Copy Test', status: 'active' });
    const tplId = tplRes.body.id;

    const blkRes = await request
      .post(`/workout-templates/${tplId}/blocks`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ type: 'Superset', result_type: 'None' });
    const blkId = blkRes.body.id;

    await request
      .post(`/workout-templates/${tplId}/blocks/${blkId}/exercises`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ exercise_id: exerciseId, sets: 4 });

    const dupRes = await request
      .post(`/workout-templates/${tplId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .expect(201);

    const newId = dupRes.body.id;
    const { rows: newBlocks } = await db.query(
      'SELECT * FROM workout_template_blocks WHERE workout_template_id = ? AND deleted_at IS NULL',
      [newId],
    );
    expect(newBlocks).toHaveLength(1);
    expect(newBlocks[0].type).toBe('Superset');
    expect(newBlocks[0].id).not.toBe(blkId);

    const { rows: newExercises } = await db.query(
      'SELECT * FROM workout_template_exercises WHERE workout_template_block_id = ? AND deleted_at IS NULL',
      [newBlocks[0].id],
    );
    expect(newExercises).toHaveLength(1);
    expect(newExercises[0].sets).toBe(4);
  });

  it('returns 404 for unknown template', async () => {
    await request
      .post('/workout-templates/999999/duplicate')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .expect(404);
  });

  it('returns 404 when template belongs to another gym (tenant isolation)', async () => {
    await request
      .post(`/workout-templates/${templateId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymBId)
      .expect(404);
  });

  it('returns 401 without auth', async () => {
    await request
      .post(`/workout-templates/${templateId}/duplicate`)
      .set('x-gym-id', gymId)
      .expect(401);
  });
});
