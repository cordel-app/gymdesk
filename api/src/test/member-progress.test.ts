// #1231 — /members/:memberId/progress: the staff Progress tab (edit + hard delete of readings).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let otherGymId: string;
let memberId: number;
let otherMemberId: number;
let exerciseId: number;
const logIds: number[] = [];
let otherLogId: number;

async function logFor(gid: string, mid: number, exId: number, date: string, weight: number, reps: number): Promise<number> {
  const { insertId: planId } = await db.query(
    `INSERT INTO training_plans (gym_id, member_id, name, status, start_date) VALUES (?, ?, 'P', 'active', CURRENT_DATE)`, [gid, mid]);
  const { insertId: wId } = await db.query(
    `INSERT INTO workouts (gym_id, training_plan_id, name, position, scheduled_weekday) VALUES (?, ?, 'W', 1, 1)`, [gid, planId]);
  const { insertId: bId } = await db.query(
    `INSERT INTO workout_blocks (gym_id, workout_id, position, type) VALUES (?, ?, 1, 'Circuit')`, [gid, wId]);
  const { insertId: weId } = await db.query(
    `INSERT INTO workout_exercises (gym_id, workout_block_id, exercise_id, position) VALUES (?, ?, ?, 1)`, [gid, bId, exId]);
  const { insertId } = await db.query(
    `INSERT INTO exercise_logs (gym_id, member_id, workout_exercise_id, exercise_id, logged_date, notes) VALUES (?, ?, ?, ?, ?, 'n')`,
    [gid, mid, weId, exId, date]);
  await db.query('INSERT INTO exercise_log_sets (gym_id, exercise_log_id, set_number, weight, reps) VALUES (?, ?, 1, ?, ?)', [gid, insertId, weight, reps]);
  return insertId;
}

const staff = (req: any, gid = gymId) => req.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gid);

beforeAll(async () => {
  gymId = await createTestGym('Member Progress Gym');
  otherGymId = await createTestGym('Member Progress Other Gym');
  await createTestMembership(gymId, 'admin');
  const mk = async (gid: string, name: string) =>
    (await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gid, name, `${name.replace(/\W/g, '')}-${Date.now()}@test.com`])).insertId;
  memberId = await mk(gymId, 'Staff View Member');
  otherMemberId = await mk(gymId, 'Other Member');
  exerciseId = (await db.query(`INSERT INTO exercises (gym_id, name) VALUES (?, 'Staff Squat')`, [gymId])).insertId;
  const { rows: rt } = await db.query<{ id: number }>(`SELECT id FROM result_types WHERE slug = 'weight'`);
  await db.query('INSERT INTO exercise_allowed_result_types (exercise_id, result_type_id) VALUES (?, ?)', [exerciseId, rt[0].id]);
  logIds.push(await logFor(gymId, memberId, exerciseId, '2026-10-01', 60, 10));
  logIds.push(await logFor(gymId, memberId, exerciseId, '2026-10-03', 80, 3));
  otherLogId = await logFor(gymId, otherMemberId, exerciseId, '2026-10-02', 999, 1);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('/members/:memberId/progress (#1231)', () => {
  it('rejects unauthenticated requests and unknown gyms', async () => {
    await request.get(`/members/${memberId}/progress/exercises`).set('x-gym-id', gymId).expect(401);
    await staff(request.get(`/members/${memberId}/progress/exercises`), otherGymId).expect(403);
  });

  it('lists the exercises with the shared summary and the readings', async () => {
    const list = await staff(request.get(`/members/${memberId}/progress/exercises`)).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ exercise_id: exerciseId, days_exercised: 2, max_weight: 80 });
    const detail = await staff(request.get(`/members/${memberId}/progress/exercises/${exerciseId}`)).expect(200);
    expect(detail.body.readings.map((r: any) => r.id)).toEqual([logIds[1], logIds[0]]);
    expect(detail.body.days).toHaveLength(2);
  });

  it('edits value and notes, never the date, and recalculates', async () => {
    const detail = await staff(request.get(`/members/${memberId}/progress/exercises/${exerciseId}`)).expect(200);
    const reading = detail.body.readings.find((r: any) => r.id === logIds[1]);
    const res = await staff(request.put(`/members/${memberId}/progress/readings/${logIds[1]}`))
      .send({ notes: 'edited', logged_date: '2020-01-01', sets: [{ id: reading.sets[0].id, weight: 50 }] })
      .expect(200);
    expect(res.body.max_weight).toBe(60);
    const r = res.body.readings.find((x: any) => x.id === logIds[1]);
    expect(r.notes).toBe('edited');
    expect(r.logged_date).toBe('2026-10-03');
  });

  it('refuses a reading that belongs to another member', async () => {
    await staff(request.put(`/members/${memberId}/progress/readings/${otherLogId}`)).send({ notes: 'x' }).expect(404);
    await staff(request.delete(`/members/${memberId}/progress/readings/${otherLogId}`)).expect(404);
  });

  it('hard-deletes a reading and drops an exercise with none left', async () => {
    await staff(request.delete(`/members/${memberId}/progress/readings/${logIds[0]}`)).expect(200);
    const { rows } = await db.query('SELECT id FROM exercise_logs WHERE id = ?', [logIds[0]]);
    expect(rows).toHaveLength(0);
    await staff(request.delete(`/members/${memberId}/progress/readings/${logIds[1]}`)).expect(200);
    const list = await staff(request.get(`/members/${memberId}/progress/exercises`)).expect(200);
    expect(list.body).toEqual([]);
  });
});
