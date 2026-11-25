// #3339: the standalone import of System Workout Templates brings the Base
// Exercises the gym lacks (each once across the selection) and re-points every
// exercise of the new gym copies at gym Exercises; the preview writes nothing
// and lists exactly what the import does.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createBaseExercise, createTestGym, createTestMembership, deleteBaseExercises, request,
} from './helpers';

let gymId: string;
let otherGymId: string;
let roGymId: string;
let w1: number;
let w2: number;
let w3: number;
let e1: number;
let e2: number;
let e3: number;
let gymE3: number;
let gymW3: number;
const wtIds: number[] = [];
const stamp = Date.now();

const as = (gym: string) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gym });

async function insertWorkout(gym: string | null, name: string, exerciseIds: number[], clonedFrom: number | null = null): Promise<number> {
  const { insertId } = await db.query(
    "INSERT INTO workout_templates (gym_id, name, description, status, cloned_from_id) VALUES (?, ?, ?, 'active', ?)",
    [gym, name, `${name} description`, clonedFrom],
  );
  const { insertId: block } = await db.query(
    "INSERT INTO workout_template_blocks (gym_id, workout_template_id, position, name, type) VALUES (?, ?, 1, 'Block', 'GiantSet')",
    [gym, insertId],
  );
  for (let i = 0; i < exerciseIds.length; i++) {
    await db.query(
      `INSERT INTO workout_template_exercises (gym_id, workout_template_block_id, base_exercise_id, position, sets)
       VALUES (?, ?, ?, ?, 3)`,
      [gym, block, exerciseIds[i], i + 1],
    );
  }
  if (gym === null) wtIds.push(insertId);
  return insertId;
}

async function gymExerciseCount(gym: string): Promise<number> {
  const { rows } = await db.query('SELECT COUNT(*) AS n FROM exercises WHERE gym_id = ?', [gym]);
  return Number(rows[0].n);
}

async function gymWorkoutCount(gym: string): Promise<number> {
  const { rows } = await db.query('SELECT COUNT(*) AS n FROM workout_templates WHERE gym_id = ?', [gym]);
  return Number(rows[0].n);
}

async function exerciseRefs(templateId: number) {
  const { rows } = await db.query(
    `SELECT wte.exercise_id, wte.base_exercise_id FROM workout_template_exercises wte
       JOIN workout_template_blocks b ON b.id = wte.workout_template_block_id
      WHERE b.workout_template_id = ? ORDER BY wte.position`,
    [templateId],
  );
  return rows.map((r: any) => ({
    exercise_id: r.exercise_id == null ? null : Number(r.exercise_id),
    base_exercise_id: r.base_exercise_id == null ? null : Number(r.base_exercise_id),
  }));
}

async function gymCopiesOf(gym: string, baseId: number): Promise<number[]> {
  const { rows } = await db.query('SELECT id FROM exercises WHERE gym_id = ? AND base_exercise_id = ?', [gym, baseId]);
  return rows.map((r: any) => Number(r.id));
}

beforeAll(async () => {
  gymId = await createTestGym('WT Cascade Gym');
  await createTestMembership(gymId, 'admin');
  otherGymId = await createTestGym('WT Cascade Other Gym');
  await createTestMembership(otherGymId, 'admin');
  roGymId = await createTestGym('WT Cascade Read-only Gym');
  await createTestMembership(roGymId, 'front_desk');

  e1 = await createBaseExercise({ name: `WT Cascade Ex One ${stamp}`, slug: `wt-cascade-ex-one-${stamp}` });
  e2 = await createBaseExercise({ name: `WT Cascade Ex Two ${stamp}`, slug: `wt-cascade-ex-two-${stamp}` });
  e3 = await createBaseExercise({ name: `WT Cascade Ex Three ${stamp}`, slug: `wt-cascade-ex-three-${stamp}` });
  // The gym already holds E3.
  const { insertId } = await db.query(
    "INSERT INTO exercises (gym_id, name, slug, status, created_by, base_exercise_id) VALUES (?, ?, ?, 'active', 'Test', ?)",
    [gymId, `WT Cascade Ex Three ${stamp}`, `wt-cascade-ex-three-${stamp}`, e3],
  );
  gymE3 = insertId;

  w1 = await insertWorkout(null, `WT Cascade One ${stamp}`, [e1, e3]);
  w2 = await insertWorkout(null, `WT Cascade Two ${stamp}`, [e1]);
  w3 = await insertWorkout(null, `WT Cascade Three ${stamp}`, [e2]);
  // The gym already imported W3 (#3335): its copy still names Base E2 and is left alone.
  gymW3 = await insertWorkout(gymId, `WT Cascade Three ${stamp}`, [e2], w3);
});

afterAll(async () => {
  await cleanupTestGyms();
  const wm = wtIds.map(() => '?').join(',');
  await db.query(
    `DELETE wte FROM workout_template_exercises wte
       JOIN workout_template_blocks b ON b.id = wte.workout_template_block_id
      WHERE b.workout_template_id IN (${wm})`,
    wtIds,
  );
  await db.query(`DELETE FROM workout_template_blocks WHERE workout_template_id IN (${wm})`, wtIds);
  await db.query(`DELETE FROM workout_templates WHERE id IN (${wm})`, wtIds);
  await deleteBaseExercises([e1, e2, e3]);
  await db.end();
});

describe('POST /workout-templates/import/preview', () => {
  it('requires auth and write access', async () => {
    expect((await request.post('/workout-templates/import/preview').send({ baseTemplateIds: [w1] })).status).toBe(401);
    expect((await request.post('/workout-templates/import/preview').set(as(roGymId)).send({ baseTemplateIds: [w1] })).status).toBe(403);
  });

  it('refuses an id that is not an active System template', async () => {
    const res = await request.post('/workout-templates/import/preview').set(as(gymId)).send({ baseTemplateIds: [w1, gymW3] });
    expect(res.status).toBe(400);
    expect(res.body.invalid_ids).toEqual([gymW3]);
  });

  it('aggregates shared exercises once and lists only the missing ones, writing nothing', async () => {
    const before = await gymExerciseCount(gymId);
    const res = await request.post('/workout-templates/import/preview').set(as(gymId)).send({ baseTemplateIds: [w1, w2, w3] });
    expect(res.status).toBe(200);
    expect(res.body.workout_templates.map((w: any) => [w.id, w.action, w.gym_template_id])).toEqual([
      [w1, 'create', null],
      [w2, 'create', null],
      [w3, 'existing', gymW3],
    ]);
    // E1 once (W1 and W2 share it); E3 is the gym's already; W3's copy is left alone, so E2 is not needed.
    expect(res.body.exercises.map((e: any) => e.id)).toEqual([e1]);
    expect(await gymExerciseCount(gymId)).toBe(before);
  });

  it('answers per gym', async () => {
    const res = await request.post('/workout-templates/import/preview').set(as(otherGymId)).send({ baseTemplateIds: [w1, w3] });
    expect(res.status).toBe(200);
    expect(res.body.exercises.map((e: any) => e.id)).toEqual([e1, e3, e2]);
  });
});

describe('POST /workout-templates/import (cascading)', () => {
  it('does nothing when one id is invalid', async () => {
    const exercises = await gymExerciseCount(gymId);
    const workouts = await gymWorkoutCount(gymId);
    const res = await request.post('/workout-templates/import').set(as(gymId)).send({ baseTemplateIds: [w1, 999999999] });
    expect(res.status).toBe(400);
    expect(await gymExerciseCount(gymId)).toBe(exercises);
    expect(await gymWorkoutCount(gymId)).toBe(workouts);
  });

  it('imports the templates and missing exercises, each copy naming gym exercises only', async () => {
    const res = await request.post('/workout-templates/import').set(as(gymId)).send({ baseTemplateIds: [w1, w2, w3] });
    expect(res.status).toBe(201);
    expect(res.body.imported).toHaveLength(2);
    expect(res.body.skipped).toEqual([w3]);
    expect(res.body.exercises.imported).toHaveLength(1);

    const copiesOfE1 = await gymCopiesOf(gymId, e1);
    expect(copiesOfE1).toEqual([res.body.exercises.imported[0]]);
    const [gymW1, gymW2] = res.body.imported;
    expect(await exerciseRefs(gymW1)).toEqual([
      { exercise_id: copiesOfE1[0], base_exercise_id: null },
      { exercise_id: gymE3, base_exercise_id: null },
    ]);
    expect(await exerciseRefs(gymW2)).toEqual([{ exercise_id: copiesOfE1[0], base_exercise_id: null }]);
    // The skipped copy is untouched.
    expect(await exerciseRefs(gymW3)).toEqual([{ exercise_id: null, base_exercise_id: e2 }]);
    expect(await gymCopiesOf(gymId, e2)).toEqual([]);

    const tree = await request.get(`/workout-templates/${gymW1}`).set(as(gymId));
    expect(tree.status).toBe(200);
    expect(tree.body.blocks[0].exercises.map((e: any) => e.exercise_id)).toEqual([copiesOfE1[0], gymE3]);
  });

  it('a second import creates nothing new', async () => {
    const exercises = await gymExerciseCount(gymId);
    const preview = await request.post('/workout-templates/import/preview').set(as(gymId)).send({ baseTemplateIds: [w1, w2] });
    expect(preview.body.exercises).toEqual([]);
    expect(preview.body.workout_templates.every((w: any) => w.action === 'existing')).toBe(true);
    const res = await request.post('/workout-templates/import').set(as(gymId)).send({ baseTemplateIds: [w1, w2] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ imported: [], skipped: [w1, w2], exercises: { imported: [] } });
    expect(await gymExerciseCount(gymId)).toBe(exercises);
  });
});
