// #3337 stage 1: the cascading import of System Training Plan Templates — the
// preview and the one-transaction import that brings their Workout Templates
// and missing Exercises along and re-points every gym-side link at gym records.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createBaseExercise, createTestGym, createTestMembership, deleteBaseExercises, request,
} from './helpers';

let gymId: string;
let otherGymId: string;
let roGymId: string;
let t1: number;
let t2: number;
let w1: number;
let w2: number;
let e1: number;
let e2: number;
let e3: number;
let gymE3: number;
let gymW2: number;
const tptIds: number[] = [];
const wtIds: number[] = [];
const stamp = Date.now();

const as = (gym: string) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gym });

async function insertWorkout(gym: string | null, name: string, exerciseIds: number[], extra: Record<string, unknown> = {}): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO workout_templates (gym_id, name, description, status, cloned_from_id) VALUES (?, ?, ?, \'active\', ?)',
    [gym, name, extra.description ?? `${name} description`, extra.cloned_from_id ?? null],
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

async function insertPlan(name: string, workoutIds: number[]): Promise<number> {
  const { insertId } = await db.query(
    "INSERT INTO training_plan_templates (gym_id, name, description, num_days, status) VALUES (NULL, ?, ?, 2, 'active')",
    [name, `${name} description`],
  );
  for (let i = 0; i < workoutIds.length; i++) {
    await db.query(
      `INSERT INTO training_plan_template_workouts (gym_id, training_plan_template_id, workout_template_id, position, scheduled_weekday)
       VALUES (NULL, ?, ?, ?, ?)`,
      [insertId, workoutIds[i], i + 1, i + 1],
    );
  }
  tptIds.push(insertId);
  return insertId;
}

async function gymExerciseCount(gym: string): Promise<number> {
  const { rows } = await db.query('SELECT COUNT(*) AS n FROM exercises WHERE gym_id = ?', [gym]);
  return Number(rows[0].n);
}

async function exerciseRefs(templateId: number) {
  const { rows } = await db.query(
    `SELECT wte.exercise_id, wte.base_exercise_id FROM workout_template_exercises wte
       JOIN workout_template_blocks b ON b.id = wte.workout_template_block_id
      WHERE b.workout_template_id = ? ORDER BY wte.position`,
    [templateId],
  );
  return rows.map((r: any) => ({ exercise_id: r.exercise_id == null ? null : Number(r.exercise_id), base_exercise_id: r.base_exercise_id }));
}

async function gymCopyOfBaseExercise(gym: string, baseId: number): Promise<number[]> {
  const { rows } = await db.query('SELECT id FROM exercises WHERE gym_id = ? AND base_exercise_id = ?', [gym, baseId]);
  return rows.map((r: any) => Number(r.id));
}

beforeAll(async () => {
  gymId = await createTestGym('TPT Cascade Gym');
  await createTestMembership(gymId, 'admin');
  otherGymId = await createTestGym('TPT Cascade Other Gym');
  await createTestMembership(otherGymId, 'admin');
  roGymId = await createTestGym('TPT Cascade Read-only Gym');
  await createTestMembership(roGymId, 'front_desk');

  e1 = await createBaseExercise({ name: `Cascade Ex One ${stamp}`, slug: `cascade-ex-one-${stamp}` });
  e2 = await createBaseExercise({ name: `Cascade Ex Two ${stamp}`, slug: `cascade-ex-two-${stamp}` });
  e3 = await createBaseExercise({ name: `Cascade Ex Three ${stamp}`, slug: `cascade-ex-three-${stamp}` });
  // The gym already holds E3.
  const { insertId } = await db.query(
    "INSERT INTO exercises (gym_id, name, slug, status, created_by, base_exercise_id) VALUES (?, ?, ?, 'active', 'Test', ?)",
    [gymId, `Cascade Ex Three ${stamp}`, `cascade-ex-three-${stamp}`, e3],
  );
  gymE3 = insertId;

  w1 = await insertWorkout(null, `Cascade Workout One ${stamp}`, [e1, e3]);
  w2 = await insertWorkout(null, `Cascade Workout Two ${stamp}`, [e1]);
  // The gym already imported W2 (#3335): its copy still names Base E2 and an old description.
  gymW2 = await insertWorkout(gymId, `Cascade Workout Two ${stamp}`, [e2], { cloned_from_id: w2, description: 'old text' });

  t1 = await insertPlan(`Cascade Plan One ${stamp}`, [w1, w2]);
  t2 = await insertPlan(`Cascade Plan Two ${stamp}`, [w2]);
});

afterAll(async () => {
  await cleanupTestGyms();
  const tm = tptIds.map(() => '?').join(',');
  await db.query(`DELETE FROM training_plan_template_workouts WHERE training_plan_template_id IN (${tm})`, tptIds);
  await db.query(`DELETE FROM training_plan_templates WHERE id IN (${tm})`, tptIds);
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

describe('POST /training-plan-templates/import/preview', () => {
  it('requires auth and write access', async () => {
    expect((await request.post('/training-plan-templates/import/preview').send({ baseTemplateIds: [t1] })).status).toBe(401);
    expect((await request.post('/training-plan-templates/import/preview').set(as(roGymId)).send({ baseTemplateIds: [t1] })).status).toBe(403);
  });

  it('refuses an id that is not an active System template', async () => {
    const res = await request.post('/training-plan-templates/import/preview').set(as(gymId)).send({ baseTemplateIds: [t1, 999999999] });
    expect(res.status).toBe(400);
    expect(res.body.invalid_ids).toEqual([999999999]);
  });

  it('aggregates shared dependencies once and lists only the missing exercises, writing nothing', async () => {
    const before = await gymExerciseCount(gymId);
    const res = await request.post('/training-plan-templates/import/preview').set(as(gymId)).send({ baseTemplateIds: [t1, t2] });
    expect(res.status).toBe(200);
    expect(res.body.training_plan_templates.map((t: any) => [t.id, t.action])).toEqual([[t1, 'create'], [t2, 'create']]);
    expect(res.body.workout_templates.map((w: any) => [w.id, w.action, w.gym_template_id])).toEqual([
      [w1, 'create', null],
      [w2, 'update', gymW2],
    ]);
    // E1 (W1 new copy) and E2 (W2's existing copy); E3 is already the gym's.
    expect(res.body.exercises.map((e: any) => e.id)).toEqual([e1, e2]);
    expect(await gymExerciseCount(gymId)).toBe(before);
  });

  it('answers per gym: another gym has nothing yet', async () => {
    const res = await request.post('/training-plan-templates/import/preview').set(as(otherGymId)).send({ baseTemplateIds: [t2] });
    expect(res.status).toBe(200);
    expect(res.body.workout_templates.map((w: any) => [w.id, w.action])).toEqual([[w2, 'create']]);
    expect(res.body.exercises.map((e: any) => e.id)).toEqual([e1]);
  });
});

describe('POST /training-plan-templates/import (cascading)', () => {
  it('does nothing when one id is invalid', async () => {
    const before = await gymExerciseCount(gymId);
    const res = await request.post('/training-plan-templates/import').set(as(gymId)).send({ baseTemplateIds: [t1, 999999999] });
    expect(res.status).toBe(400);
    expect(await gymExerciseCount(gymId)).toBe(before);
    const { rows } = await db.query('SELECT 1 FROM workout_templates WHERE gym_id = ? AND cloned_from_id = ?', [gymId, w1]);
    expect(rows).toHaveLength(0);
  });

  it('imports the plans, their workouts and missing exercises, re-pointing every link at gym records', async () => {
    const res = await request.post('/training-plan-templates/import').set(as(gymId)).send({ baseTemplateIds: [t1, t2] });
    expect(res.status).toBe(201);
    expect(res.body.imported).toHaveLength(2);
    expect(res.body.workout_templates.updated).toEqual([gymW2]);
    expect(res.body.workout_templates.created).toHaveLength(1);
    expect(res.body.exercises.imported).toHaveLength(2);
    const gymW1 = res.body.workout_templates.created[0];

    // Shared exercises imported once, provenance kept.
    const [gymE1] = await gymCopyOfBaseExercise(gymId, e1);
    const [gymE2] = await gymCopyOfBaseExercise(gymId, e2);
    expect(await gymCopyOfBaseExercise(gymId, e1)).toHaveLength(1);

    // Workout Templates reference gym exercises only.
    expect(await exerciseRefs(gymW1)).toEqual([
      { exercise_id: gymE1, base_exercise_id: null },
      { exercise_id: gymE3, base_exercise_id: null },
    ]);
    expect(await exerciseRefs(gymW2)).toEqual([{ exercise_id: gymE2, base_exercise_id: null }]);
    const { rows: w1Row } = await db.query('SELECT gym_id, cloned_from_id FROM workout_templates WHERE id = ?', [gymW1]);
    expect(Number(w1Row[0].cloned_from_id)).toBe(w1);
    // The existing copy took #3335's resync fields.
    const { rows: w2Row } = await db.query('SELECT description FROM workout_templates WHERE id = ?', [gymW2]);
    expect(w2Row[0].description).toBe(`Cascade Workout Two ${stamp} description`);

    // Training Plan Templates reference gym Workout Templates only.
    const [p1, p2] = res.body.imported;
    const links = async (id: number) => (await db.query(
      'SELECT workout_template_id FROM training_plan_template_workouts WHERE training_plan_template_id = ? ORDER BY position', [id],
    )).rows.map((r: any) => Number(r.workout_template_id));
    expect(await links(p1)).toEqual([gymW1, gymW2]);
    expect(await links(p2)).toEqual([gymW2]);
    const { rows: tRow } = await db.query('SELECT cloned_from_id FROM training_plan_templates WHERE id = ?', [p1]);
    expect(Number(tRow[0].cloned_from_id)).toBe(t1);

    // The imported tree reads back through the API.
    const hier = await request.get(`/training-plan-templates/${p1}/workouts`).set(as(gymId));
    expect(hier.status).toBe(200);
  });

  it('a second import creates nothing new', async () => {
    const before = await gymExerciseCount(gymId);
    const preview = await request.post('/training-plan-templates/import/preview').set(as(gymId)).send({ baseTemplateIds: [t1, t2] });
    expect(preview.body.exercises).toEqual([]);
    expect(preview.body.training_plan_templates.every((t: any) => t.action === 'existing')).toBe(true);
    // Every linked workout is already the gym's own, so nothing is listed.
    expect(preview.body.workout_templates).toEqual([]);
    const res = await request.post('/training-plan-templates/import').set(as(gymId)).send({ baseTemplateIds: [t1, t2] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ imported: [], skipped: [t1, t2], exercises: { imported: [] } });
    expect(await gymExerciseCount(gymId)).toBe(before);
  });
});
