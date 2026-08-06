import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  request, TEST_AUTH_HEADER, TEST_USER_ID, createTestGym, createTestMembership, cleanupTestGyms,
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

describe('audit columns — PUT and DELETE', () => {
  let membershipId: number;

  beforeAll(async () => {
    const { rows } = await db.query<{ id: number }>(
      'SELECT id FROM gym_memberships WHERE user_id = ? AND gym_id = ?',
      [TEST_USER_ID, gymId],
    );
    membershipId = rows[0].id;
  });

  it('PUT /:id stamps modified_at and modified_by_membership_id', async () => {
    await request
      .put(`/workout-templates/${templateId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Upper Body (Edited)' })
      .expect(200);

    const { rows } = await db.query<{ modified_at: Date | null; modified_by_membership_id: number | null }>(
      'SELECT modified_at, modified_by_membership_id FROM workout_templates WHERE id = ?',
      [templateId],
    );
    expect(rows[0].modified_at).not.toBeNull();
    expect(rows[0].modified_by_membership_id).toBe(membershipId);
  });

  it('DELETE /:id stamps deleted_by_membership_id', async () => {
    const createRes = await request
      .post('/workout-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Audit Delete Test', status: 'active' })
      .expect(201);
    const deleteId: number = createRes.body.id;

    await request
      .delete(`/workout-templates/${deleteId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .expect(204);

    // Query without deleted_at IS NULL so the soft-deleted row is visible.
    const { rows } = await db.query<{ deleted_by_membership_id: number | null }>(
      'SELECT deleted_by_membership_id FROM workout_templates WHERE id = ?',
      [deleteId],
    );
    expect(rows[0].deleted_by_membership_id).toBe(membershipId);
  });
});

describe('paginated GET / — new list fields', () => {
  it('returns blocks_count matching the actual number of non-deleted blocks', async () => {
    const res = await request
      .get('/workout-templates')
      .query({ limit: 20 })
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .expect(200);

    expect(res.body).toHaveProperty('items');
    expect(Array.isArray(res.body.items)).toBe(true);

    // templateId was given exactly 1 block in the module-level beforeAll.
    const item = res.body.items.find((t: any) => t.id === templateId);
    expect(item).toBeDefined();
    expect(Number(item.blocks_count)).toBe(1);
  });

  it('includes modified_by_name key in each paginated item', async () => {
    const res = await request
      .get('/workout-templates')
      .query({ limit: 20 })
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .expect(200);

    const item = res.body.items.find((t: any) => t.id === templateId);
    expect(item).toBeDefined();
    // The field must be present; it is null when the membership has no name set.
    expect('modified_by_name' in item).toBe(true);
  });

  it('includes notes in the paginated list when set on the template', async () => {
    const createRes = await request
      .post('/workout-templates')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Notes Template', status: 'active', notes: 'Trainer notes here' })
      .expect(201);
    const notesTemplateId: number = createRes.body.id;

    const res = await request
      .get('/workout-templates')
      .query({ limit: 100 })
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .expect(200);

    const item = res.body.items.find((t: any) => t.id === notesTemplateId);
    expect(item).toBeDefined();
    expect(item.notes).toBe('Trainer notes here');
  });
});
