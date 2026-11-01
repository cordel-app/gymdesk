// #2225 — Recorded Metrics are configured per exercise; removing one with recordings needs confirmation.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let otherGymId: string;
let exerciseId: number;
let otherExerciseId: number;
let logId: number;
let otherLogId: number;
let repsId: number;
let weightId: number;

const staff = (req: any, gid = gymId) => req.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gid);

async function logFor(gid: string, exId: number, weight: number, reps: number): Promise<number> {
  const { insertId: mid } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gid, 'M', `m${Date.now()}${Math.random()}@t.test`]);
  const { insertId: planId } = await db.query(
    `INSERT INTO training_plans (gym_id, member_id, name, status, start_date) VALUES (?, ?, 'P', 'active', CURRENT_DATE)`, [gid, mid]);
  const { insertId: wId } = await db.query(
    `INSERT INTO workouts (gym_id, training_plan_id, name, position, scheduled_weekday) VALUES (?, ?, 'W', 1, 1)`, [gid, planId]);
  const { insertId: bId } = await db.query(
    `INSERT INTO workout_blocks (gym_id, workout_id, position, type) VALUES (?, ?, 1, 'Circuit')`, [gid, wId]);
  const { insertId: weId } = await db.query(
    `INSERT INTO workout_exercises (gym_id, workout_block_id, exercise_id, position) VALUES (?, ?, ?, 1)`, [gid, bId, exId]);
  const { insertId } = await db.query(
    `INSERT INTO exercise_logs (gym_id, member_id, workout_exercise_id, exercise_id, logged_date) VALUES (?, ?, ?, ?, CURRENT_DATE)`,
    [gid, mid, weId, exId]);
  await db.query('INSERT INTO exercise_log_sets (gym_id, exercise_log_id, set_number, weight, reps) VALUES (?, ?, 1, ?, ?)', [gid, insertId, weight, reps]);
  return insertId;
}

async function createExercise(gid: string, name: string): Promise<number> {
  const res = await staff(request.post('/exercises'), gid).send({ name, category: 'strength' });
  expect(res.status).toBe(201);
  return res.body.id;
}

beforeAll(async () => {
  gymId = await createTestGym('Metrics Gym');
  otherGymId = await createTestGym('Metrics Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
  const { rows } = await db.query('SELECT id, slug FROM result_types');
  repsId = rows.find((r: any) => r.slug === 'repetitions').id;
  weightId = rows.find((r: any) => r.slug === 'weight').id;
  exerciseId = await createExercise(gymId, 'Metrics Press');
  otherExerciseId = await createExercise(otherGymId, 'Metrics Press');
  logId = await logFor(gymId, exerciseId, 80, 5);
  otherLogId = await logFor(otherGymId, otherExerciseId, 60, 8);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('Recorded Metrics (#2225)', () => {
  it('a new exercise gets its category default', async () => {
    const res = await staff(request.get(`/exercises/${exerciseId}`));
    expect(res.body.allowed_result_types.map((r: any) => r.id).sort()).toEqual([repsId, weightId].sort());
  });

  it('changing the category does not overwrite the configured metrics', async () => {
    const res = await staff(request.put(`/exercises/${exerciseId}`)).send({ category: 'stretching' });
    expect(res.status).toBe(200);
    expect(res.body.allowed_result_types).toHaveLength(2);
    await staff(request.put(`/exercises/${exerciseId}`)).send({ category: 'strength' });
  });

  it('removing a metric with recordings is refused without confirmation and changes nothing', async () => {
    const res = await staff(request.put(`/exercises/${exerciseId}`)).send({ allowed_result_type_ids: [repsId] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('metric_removal_requires_confirmation');
    expect(res.body.metrics[0]).toMatchObject({ slug: 'weight', count: 1 });
    const { rows } = await db.query('SELECT weight FROM exercise_log_sets WHERE exercise_log_id = ?', [logId]);
    expect(Number(rows[0].weight)).toBe(80);
  });

  it('confirming deletes that metric\'s recordings only, in this gym only', async () => {
    const res = await staff(request.put(`/exercises/${exerciseId}`)).send({ allowed_result_type_ids: [repsId], confirm_metric_removal: true });
    expect(res.status).toBe(200);
    expect(res.body.allowed_result_types.map((r: any) => r.id)).toEqual([repsId]);
    const { rows } = await db.query('SELECT weight, reps FROM exercise_log_sets WHERE exercise_log_id = ?', [logId]);
    expect(rows[0].weight).toBeNull();
    expect(rows[0].reps).toBe(5);
    const { rows: other } = await db.query('SELECT weight FROM exercise_log_sets WHERE exercise_log_id = ?', [otherLogId]);
    expect(Number(other[0].weight)).toBe(60);
  });

  it('refuses an empty or unknown metric selection', async () => {
    expect((await staff(request.put(`/exercises/${exerciseId}`)).send({ allowed_result_type_ids: [] })).status).toBe(400);
    expect((await staff(request.put(`/exercises/${exerciseId}`)).send({ allowed_result_type_ids: [999999] })).status).toBe(400);
  });
});
