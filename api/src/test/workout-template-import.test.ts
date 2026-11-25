// #3335 stage 1: System Workout Templates imported into a gym, resynced, the
// gym's section list scoped to its own templates, and num_blocks derived.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createBaseExercise, createTestGym, createTestMembership, deleteBaseExercises, request,
} from './helpers';

let gymId: string;
let otherGymId: string;
let roGymId: string;
let baseId: number;
let secondBaseId: number;
let inactiveBaseId: number;
let baseExerciseId: number;
const baseIds: number[] = [];
const stamp = Date.now();

const as = (gym: string) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gym });

async function insertBase(name: string, status = 'active'): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO workout_templates (gym_id, name, description, notes, status) VALUES (NULL, ?, ?, ?, ?)',
    [name, `${name} description`, `${name} notes`, status],
  );
  baseIds.push(insertId);
  return insertId;
}

async function insertBlock(templateId: number, position: number, type = 'Standard'): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO workout_template_blocks (gym_id, workout_template_id, position, name, type) VALUES (NULL, ?, ?, ?, ?)',
    [templateId, position, `Block ${position}`, type],
  );
  return insertId;
}

beforeAll(async () => {
  gymId = await createTestGym('WT Import Gym');
  await createTestMembership(gymId, 'admin');
  otherGymId = await createTestGym('WT Import Other Gym');
  await createTestMembership(otherGymId, 'admin');
  roGymId = await createTestGym('WT Import Read-only Gym');
  await createTestMembership(roGymId, 'front_desk');

  baseExerciseId = await createBaseExercise({ name: `WT Import Exercise ${stamp}`, slug: `wt-import-exercise-${stamp}` });
  baseId = await insertBase(`WT Import Base ${stamp}`);
  secondBaseId = await insertBase(`WT Import Base Two ${stamp}`);
  inactiveBaseId = await insertBase(`WT Import Inactive ${stamp}`, 'inactive');

  const b1 = await insertBlock(baseId, 1);
  await insertBlock(baseId, 2, 'AMRAP');
  const deleted = await insertBlock(baseId, 3);
  await db.query('UPDATE workout_template_blocks SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [deleted]);
  await db.query(
    `INSERT INTO workout_template_exercises (gym_id, workout_template_block_id, base_exercise_id, position, sets, min_reps, max_reps)
     VALUES (NULL, ?, ?, 1, 4, 8, 12)`,
    [b1, baseExerciseId],
  );
});

afterAll(async () => {
  await cleanupTestGyms();
  const marks = baseIds.map(() => '?').join(',');
  await db.query(
    `DELETE wte FROM workout_template_exercises wte
       JOIN workout_template_blocks b ON b.id = wte.workout_template_block_id
      WHERE b.workout_template_id IN (${marks})`,
    baseIds,
  );
  await db.query(`DELETE FROM workout_template_blocks WHERE workout_template_id IN (${marks})`, baseIds);
  await db.query(`DELETE FROM workout_templates WHERE id IN (${marks})`, baseIds);
  await deleteBaseExercises([baseExerciseId]);
  await db.end();
});

describe('GET /workout-templates/base', () => {
  it('lists active System templates with their live block count and import state', async () => {
    const res = await request.get('/workout-templates/base').set(as(gymId));
    expect(res.status).toBe(200);
    const row = res.body.find((t: any) => t.id === baseId);
    expect(row).toMatchObject({ name: `WT Import Base ${stamp}`, num_blocks: 2, imported_template_id: null });
    expect(res.body.find((t: any) => t.id === inactiveBaseId)).toBeUndefined();
  });

  it('narrows by name', async () => {
    const res = await request.get(`/workout-templates/base?name=${encodeURIComponent(`Base Two ${stamp}`)}`).set(as(gymId));
    expect(res.status).toBe(200);
    expect(res.body.map((t: any) => t.id)).toEqual([secondBaseId]);
  });

  it('requires auth', async () => {
    expect((await request.get('/workout-templates/base')).status).toBe(401);
  });
});

describe('POST /workout-templates/import', () => {
  let copyId: number;

  it('refuses an empty list, a bad id and a non-importable id', async () => {
    expect((await request.post('/workout-templates/import').set(as(gymId)).send({ baseTemplateIds: [] })).status).toBe(400);
    expect((await request.post('/workout-templates/import').set(as(gymId)).send({ baseTemplateIds: ['x'] })).status).toBe(400);
    const res = await request.post('/workout-templates/import').set(as(gymId)).send({ baseTemplateIds: [baseId, inactiveBaseId] });
    expect(res.status).toBe(400);
    expect(res.body.invalid_ids).toEqual([inactiveBaseId]);
    const own = await request.post('/workout-templates').set(as(gymId)).send({ name: `WT Own ${stamp}` });
    expect(own.status).toBe(201);
    const r2 = await request.post('/workout-templates/import').set(as(gymId)).send({ baseTemplateIds: [own.body.id] });
    expect(r2.status).toBe(400);
    const { rows } = await db.query('SELECT 1 FROM workout_templates WHERE gym_id = ? AND cloned_from_id = ?', [gymId, baseId]);
    expect(rows).toHaveLength(0);
  });

  it('refuses a read-only role', async () => {
    const res = await request.post('/workout-templates/import').set(as(roGymId)).send({ baseTemplateIds: [baseId] });
    expect(res.status).toBe(403);
  });

  it('creates an active gym copy recording its System source, live blocks and exercises included', async () => {
    const res = await request.post('/workout-templates/import').set(as(gymId)).send({ baseTemplateIds: [baseId] });
    expect(res.status).toBe(201);
    expect(res.body.skipped).toEqual([]);
    expect(res.body.imported).toHaveLength(1);
    copyId = res.body.imported[0];
    const { rows } = await db.query<any>('SELECT * FROM workout_templates WHERE id = ?', [copyId]);
    expect(rows[0]).toMatchObject({
      gym_id: gymId, name: `WT Import Base ${stamp}`, status: 'active', cloned_from_id: baseId,
      description: `WT Import Base ${stamp} description`, notes: `WT Import Base ${stamp} notes`,
    });
    const tree = await request.get(`/workout-templates/${copyId}`).set(as(gymId));
    expect(tree.body.blocks.map((b: any) => b.type)).toEqual(['Standard', 'AMRAP']);
    expect(tree.body.blocks[0].exercises).toHaveLength(1);
    // #3339: the Base Exercise came along and the copy names the gym's own exercise.
    expect(res.body.exercises.imported).toHaveLength(1);
    const gymExerciseId = res.body.exercises.imported[0];
    const { rows: ex } = await db.query<any>('SELECT gym_id, base_exercise_id FROM exercises WHERE id = ?', [gymExerciseId]);
    expect(ex[0]).toMatchObject({ gym_id: gymId, base_exercise_id: baseExerciseId });
    expect(tree.body.blocks[0].exercises[0]).toMatchObject({ exercise_id: gymExerciseId, sets: 4, min_reps: 8, max_reps: 12 });
    const { rows: blockGyms } = await db.query<any>('SELECT DISTINCT gym_id FROM workout_template_blocks WHERE workout_template_id = ?', [copyId]);
    expect(blockGyms).toEqual([{ gym_id: gymId }]);
  });

  it('skips a template the gym already has, and the base list reports the copy', async () => {
    const res = await request.post('/workout-templates/import').set(as(gymId)).send({ baseTemplateIds: [baseId, secondBaseId] });
    expect(res.status).toBe(201);
    expect(res.body.skipped).toEqual([baseId]);
    expect(res.body.imported).toHaveLength(1);
    const base = await request.get('/workout-templates/base').set(as(gymId));
    expect(base.body.find((t: any) => t.id === baseId).imported_template_id).toBe(copyId);
    const other = await request.get('/workout-templates/base').set(as(otherGymId));
    expect(other.body.find((t: any) => t.id === baseId).imported_template_id).toBeNull();
  });

  it('lists only the gym\'s own templates, each with a derived source and num_blocks', async () => {
    const res = await request.get('/workout-templates?limit=100').set(as(gymId));
    expect(res.status).toBe(200);
    const ids = res.body.items.map((t: any) => t.id);
    expect(ids).not.toContain(baseId);
    expect(res.body.items.every((t: any) => t.gym_id === gymId)).toBe(true);
    const copy = res.body.items.find((t: any) => t.id === copyId);
    expect(copy).toMatchObject({ source: 'system', num_blocks: 2 });
    expect(res.body.items.find((t: any) => t.name === `WT Own ${stamp}`)).toMatchObject({ source: 'custom', num_blocks: 0 });
  });

  it('keeps the unpaginated selector list (System workouts still named by Training Plans)', async () => {
    const res = await request.get('/workout-templates?status=active').set(as(gymId));
    expect(res.status).toBe(200);
    expect(res.body.map((t: any) => t.id)).toContain(baseId);
  });

  it('num_blocks follows block adds and deletes on the copy', async () => {
    const add = await request.post(`/workout-templates/${copyId}/blocks`).set(as(gymId)).send({ type: 'Standard' });
    expect(add.status).toBe(201);
    let list = await request.get('/workout-templates?limit=100').set(as(gymId));
    expect(list.body.items.find((t: any) => t.id === copyId).num_blocks).toBe(3);
    const del = await request.delete(`/workout-templates/${copyId}/blocks/${add.body.id}`).set(as(gymId));
    expect([200, 204]).toContain(del.status);
    list = await request.get('/workout-templates?limit=100').set(as(gymId));
    expect(list.body.items.find((t: any) => t.id === copyId).num_blocks).toBe(2);
  });

  describe('POST /:id/resync-with-system', () => {
    it('moves name, description and notes and keeps the blocks', async () => {
      await db.query(
        "UPDATE workout_templates SET name = ?, description = 'Updated', notes = 'New notes' WHERE id = ?",
        [`WT Import Base Renamed ${stamp}`, baseId],
      );
      await insertBlock(baseId, 4);
      const res = await request.post(`/workout-templates/${copyId}/resync-with-system`).set(as(gymId));
      expect(res.status).toBe(200);
      expect(res.body.updated.sort()).toEqual(['description', 'name', 'notes']);
      expect(res.body.template).toMatchObject({
        name: `WT Import Base Renamed ${stamp}`, description: 'Updated', notes: 'New notes', source: 'system', num_blocks: 2,
      });
      const again = await request.post(`/workout-templates/${copyId}/resync-with-system`).set(as(gymId));
      expect(again.body).toEqual({ updated: [], message: 'up_to_date' });
    });

    it('refuses a custom template, a taken name and a missing System template', async () => {
      const own = await request.get('/workout-templates?limit=100').set(as(gymId));
      const ownId = own.body.items.find((t: any) => t.name === `WT Own ${stamp}`).id;
      const r1 = await request.post(`/workout-templates/${ownId}/resync-with-system`).set(as(gymId));
      expect(r1.status).toBe(400);
      expect(r1.body.code).toBe('no_base_template');

      await db.query('UPDATE workout_templates SET name = ? WHERE id = ?', [`WT Own ${stamp}`, baseId]);
      const r2 = await request.post(`/workout-templates/${copyId}/resync-with-system`).set(as(gymId));
      expect(r2.status).toBe(409);
      expect(r2.body.code).toBe('name_taken');

      await db.query("UPDATE workout_templates SET status = 'deleted', deleted_at = UTC_TIMESTAMP() WHERE id = ?", [baseId]);
      const r3 = await request.post(`/workout-templates/${copyId}/resync-with-system`).set(as(gymId));
      expect(r3.status).toBe(409);
      expect(r3.body.code).toBe('base_unavailable');
    });

    it('answers 404 for another gym\'s copy', async () => {
      const res = await request.post(`/workout-templates/${copyId}/resync-with-system`).set(as(otherGymId));
      expect(res.status).toBe(404);
    });
  });
});
