// #1849 stages E3-E4 (Exercises): the five places that reference an exercise by id carry
// base_exercise_id beside the old column; writers set it, copies keep it, the audit checks it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { EXERCISE_REFERENCE_TABLES, baseExerciseLinkChecks } from '../domain/baseExerciseLinkAudit';
import { TEST_AUTH_HEADER, cleanupTestGyms, createBaseExercise, createTestGym, createTestMembership, deleteBaseExercises, request } from './helpers';

let gymId: string;
let baseExerciseId: number;
let ownExerciseId: number;
let baseTemplateId: number;
let baseBlockId: number;
const created: number[] = [];

async function auditCounts() {
  const { checks, params } = baseExerciseLinkChecks(gymId);
  const out: Record<string, number> = {};
  for (const [i, c] of checks.entries()) {
    const { rows } = await db.query<{ n: number }>(c.sql, params[i]);
    out[c.key] = Number(rows[0].n);
  }
  return out;
}

beforeAll(async () => {
  gymId = await createTestGym();
  await createTestMembership(gymId, 'admin');
  baseExerciseId = await createBaseExercise({ name: 'Test Exercise Links System' });
  created.push(baseExerciseId);
  const own = await db.query("INSERT INTO exercises (gym_id, name, status) VALUES (?, 'Test Exercise Links Own', 'active')", [gymId]);
  ownExerciseId = own.insertId as number;
  const t = await db.query("INSERT INTO workout_templates (gym_id, name, status) VALUES (NULL, ?, 'active')", [`Test Exercise Links Base Template ${Date.now()}`]);
  baseTemplateId = t.insertId as number;
  const b = await db.query("INSERT INTO workout_template_blocks (gym_id, workout_template_id, position, name, type) VALUES (NULL, ?, 1, 'B', 'Standard')", [baseTemplateId]);
  baseBlockId = b.insertId as number;
});

afterAll(async () => {
  await db.query('DELETE FROM workout_template_exercises WHERE workout_template_block_id = ? OR exercise_id = ?', [baseBlockId, baseExerciseId]);
  await db.query('DELETE FROM workout_template_blocks WHERE workout_template_id = ?', [baseTemplateId]);
  await db.query('DELETE FROM workout_templates WHERE id = ?', [baseTemplateId]);
  await deleteBaseExercises(created);
  await cleanupTestGyms();
  await db.end();
});

describe('base_exercise_id (#1849 stage E3)', () => {
  it('exists on the five places, nullable, with the old FK rule', async () => {
    const { rows } = await db.query<any>(
      `SELECT k.TABLE_NAME AS t, k.COLUMN_NAME AS c, r.DELETE_RULE AS rule
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.CONSTRAINT_SCHEMA = k.TABLE_SCHEMA
        WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IN ('base_exercises', 'exercises')`,
    );
    for (const { table, column } of EXERCISE_REFERENCE_TABLES) {
      const old = rows.find((r: any) => r.t === table && r.c === column)?.rule;
      expect(old, `${table} old`).toBeDefined();
      expect(rows.find((r: any) => r.t === table && r.c === 'base_exercise_id')?.rule, `${table} new`).toBe(old);
    }
  });

  it('every exercise-referencing FK in the schema is covered by the audit list', async () => {
    const { rows } = await db.query<any>(
      `SELECT DISTINCT TABLE_NAME AS t FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'exercises'
          AND TABLE_NAME NOT IN ('exercise_translations','exercise_description_translations','exercise_muscles','exercise_allowed_result_types')`,
    );
    expect(rows.map((r: any) => r.t).sort()).toEqual(EXERCISE_REFERENCE_TABLES.map((r) => r.table).sort());
  });

  it('the audit passes for a template row naming a System exercise with its Base link, and flags a missing or wrong one', async () => {
    let pos = 10;
    const ins = (exId: number, base: number | null) => db.query(
      `INSERT INTO workout_template_exercises (gym_id, workout_template_block_id, exercise_id, base_exercise_id, position)
       VALUES (NULL, ?, ?, ?, ?)`, [baseBlockId, exId, base, pos++]);
    await ins(baseExerciseId, baseExerciseId);
    expect((await auditCounts()).workout_template_exercises_system_without_base_link).toBe(0);
    const { rows } = await db.query<any>('SELECT COUNT(*) AS n FROM workout_template_exercises WHERE exercise_id = ? AND base_exercise_id IS NULL', [baseExerciseId]);
    expect(Number(rows[0].n)).toBe(0);
    // Unscoped checks (the Base template carries no gym): system reference without link, and a link on a gym-owned exercise.
    const unscoped = baseExerciseLinkChecks();
    const run = async (key: string) => {
      const i = unscoped.checks.findIndex((c) => c.key === key);
      return Number((await db.query<any>(unscoped.checks[i].sql)).rows[0].n);
    };
    const before = await run('workout_template_exercises_system_without_base_link');
    const row = await ins(baseExerciseId, null);
    expect(await run('workout_template_exercises_system_without_base_link')).toBe(before + 1);
    await db.query('DELETE FROM workout_template_exercises WHERE id = ?', [row.insertId]);
    const beforeMismatch = await run('workout_template_exercises_base_link_mismatch');
    const bad = await ins(ownExerciseId, baseExerciseId);
    expect(await run('workout_template_exercises_base_link_mismatch')).toBe(beforeMismatch + 1);
    await db.query('DELETE FROM workout_template_exercises WHERE id = ?', [bad.insertId]);
  });
});

describe('writers and readers use base_exercise_id (#1849 stage E4)', () => {
  const asGym = () => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gymId });

  it('cloning a Base workout template into a gym keeps the Base link on the copied exercise rows', async () => {
    await db.query('DELETE FROM workout_template_exercises WHERE workout_template_block_id = ?', [baseBlockId]);
    await db.query(
      `INSERT INTO workout_template_exercises (gym_id, workout_template_block_id, exercise_id, base_exercise_id, position)
       VALUES (NULL, ?, ?, ?, 1)`, [baseBlockId, baseExerciseId, baseExerciseId]);
    const res = await request.post(`/workout-templates/${baseTemplateId}/clone`).set(asGym());
    expect(res.status).toBe(201);
    const { rows } = await db.query<any>(
      `SELECT wte.exercise_id AS old, wte.base_exercise_id AS base FROM workout_template_exercises wte
         JOIN workout_template_blocks b ON b.id = wte.workout_template_block_id WHERE b.workout_template_id = ?`, [res.body.id]);
    expect(rows).toEqual([{ old: baseExerciseId, base: baseExerciseId }]);
    const tree = await request.get(`/workout-templates/${res.body.id}`).set(asGym());
    expect(tree.status).toBe(200);
    expect(JSON.stringify(tree.body)).toContain('Test Exercise Links System');
    const counts = await auditCounts();
    for (const [key, n] of Object.entries(counts)) if (key !== 'legacy_system_rows_remaining') expect(n, key).toBe(0);
  });

  it('importing a Base exercise records the Base link on the gym copy, and the copy reads as imported', async () => {
    const res = await request.post('/exercises/import').set(asGym()).send({ baseExerciseIds: [baseExerciseId] });
    expect(res.status).toBeLessThan(300);
    const { rows } = await db.query<any>('SELECT cloned_from_id AS old, base_exercise_id AS base FROM exercises WHERE gym_id = ? AND cloned_from_id = ?', [gymId, baseExerciseId]);
    expect(rows).toEqual([{ old: baseExerciseId, base: baseExerciseId }]);
    const again = await request.post('/exercises/import').set(asGym()).send({ baseExerciseIds: [baseExerciseId] });
    expect(again.body.skipped?.length ?? 0).toBe(1);
    const counts = await auditCounts();
    for (const [key, n] of Object.entries(counts)) if (key !== 'legacy_system_rows_remaining') expect(n, key).toBe(0);
  });
});
