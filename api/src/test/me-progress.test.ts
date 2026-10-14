// #1224 — GET /me/progress/*: derived exercise history for the signed-in member.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, TEST_USER_ID, cleanupTestGyms, createTestGym, createTestMembership, request,
} from './helpers';

let gymId: string;
let otherGymId: string;
let memberId: number;
let exerciseId: number;
let otherMemberExerciseId: number;

async function member(gid: string, name: string, clerk: string | null): Promise<number> {
  const email = `${name.toLowerCase().replace(/\W+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`;
  if (clerk === null) {
    return (await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gid, name, email])).insertId;
  }
  await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE gym_id = VALUES(gym_id), name = VALUES(name), email = VALUES(email), deleted_at = NULL`,
    [gid, name, email, clerk],
  );
  const { rows } = await db.query<{ id: number }>('SELECT id FROM members WHERE clerk_user_id = ?', [clerk]);
  return rows[0].id;
}

/** A log on a (possibly deleted) plan's workout exercise, with its sets. */
async function logOn(gid: string, mid: number, exId: number, date: string, sets: Array<[number, number]>, planStatus = 'active') {
  const { insertId: planId } = await db.query(
    `INSERT INTO training_plans (gym_id, member_id, name, status, start_date) VALUES (?, ?, 'P', ?, CURRENT_DATE)`,
    [gid, mid, planStatus],
  );
  const { insertId: wId } = await db.query(
    `INSERT INTO workouts (gym_id, training_plan_id, name, position, scheduled_weekday) VALUES (?, ?, 'W', 1, 1)`, [gid, planId]);
  const { insertId: bId } = await db.query(
    `INSERT INTO workout_blocks (gym_id, workout_id, position, type) VALUES (?, ?, 1, 'Circuit')`, [gid, wId]);
  const { insertId: weId } = await db.query(
    `INSERT INTO workout_exercises (gym_id, workout_block_id, exercise_id, position) VALUES (?, ?, ?, 1)`, [gid, bId, exId]);
  const { insertId: logId } = await db.query(
    `INSERT INTO exercise_logs (gym_id, member_id, workout_exercise_id, exercise_id, logged_date) VALUES (?, ?, ?, ?, ?)`,
    [gid, mid, weId, exId, date]);
  for (let i = 0; i < sets.length; i++) {
    await db.query(
      'INSERT INTO exercise_log_sets (gym_id, exercise_log_id, set_number, weight, reps) VALUES (?, ?, ?, ?, ?)',
      [gid, logId, i + 1, sets[i][0], sets[i][1]]);
  }
}

const asMember = (req: any) => req.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

beforeAll(async () => {
  gymId = await createTestGym('Me Progress Gym');
  otherGymId = await createTestGym('Me Progress Other Gym');
  await createTestMembership(gymId, 'member');
  memberId = await member(gymId, 'Progress Member', TEST_USER_ID);
  const { insertId } = await db.query(`INSERT INTO exercises (gym_id, name) VALUES (?, 'Progress Squat')`, [gymId]);
  exerciseId = insertId;
  const { rows: rt } = await db.query<{ id: number }>(`SELECT id FROM result_types WHERE slug = 'weight'`);
  await db.query('INSERT INTO exercise_allowed_result_types (exercise_id, result_type_id) VALUES (?, ?)', [exerciseId, rt[0].id]);
  await logOn(gymId, memberId, exerciseId, '2026-10-01', [[60, 10], [70, 5]]);
  // A deleted plan's log still counts: history belongs to the member and exercise.
  await logOn(gymId, memberId, exerciseId, '2026-10-03', [[80, 3]], 'deleted');

  const other = await member(gymId, 'Other Member', null);
  const ex2 = await db.query(`INSERT INTO exercises (gym_id, name) VALUES (?, 'Other Member Lift')`, [gymId]);
  otherMemberExerciseId = ex2.insertId;
  await logOn(gymId, other, otherMemberExerciseId, '2026-10-02', [[999, 1]]);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('GET /me/progress/exercises (#1224)', () => {
  it('rejects an unauthenticated request', async () => {
    await request.get('/me/progress/exercises').set('x-gym-id', gymId).expect(401);
  });

  it('summarizes the member\'s own history, deleted plans included', async () => {
    const res = await asMember(request.get('/me/progress/exercises')).expect(200);
    expect(res.body).toHaveLength(1);
    const e = res.body[0];
    expect(e.exercise_id).toBe(exerciseId);
    expect(e.days_exercised).toBe(2);
    expect(e.max_weight).toBe(80);
    expect(e.best_result).toEqual({ slug: 'weight', value: 80 });
  });

  it('never exposes another member\'s or gym\'s history', async () => {
    const res = await asMember(request.get('/me/progress/exercises')).expect(200);
    expect(res.body.find((e: any) => e.exercise_id === otherMemberExerciseId)).toBeUndefined();
    await asMember(request.get(`/me/progress/exercises/${otherMemberExerciseId}`)).expect(404);
    await request.get('/me/progress/exercises').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', otherGymId).expect(403);
  });
});

describe('GET /me/progress/exercises/:exerciseId (#1224)', () => {
  it('returns one point per date with that day\'s sets', async () => {
    const res = await asMember(request.get(`/me/progress/exercises/${exerciseId}`)).expect(200);
    expect(res.body.days.map((d: any) => d.logged_date)).toEqual(['2026-10-01', '2026-10-03']);
    expect(res.body.days[0].value).toBe(70);
    expect(res.body.days[0].sets).toHaveLength(2);
  });

  it('rejects a malformed id', async () => {
    await asMember(request.get('/me/progress/exercises/abc')).expect(400);
  });
});
