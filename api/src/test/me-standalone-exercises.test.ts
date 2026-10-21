// #1916 — standalone exercises in My Training: add to a day, register sets, isolation.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, TEST_USER_ID, cleanupTestGyms, createTestGym, createTestMembership, request,
} from './helpers';

let gymId: string;
let otherGymId: string;
let memberId: number;
let squatId: number;
let rowId: number;
let inactiveId: number;
let otherGymExerciseId: number;

const asMember = (req: any) => req.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const DAY = '2026-10-21';

beforeAll(async () => {
  gymId = await createTestGym('Standalone Gym');
  otherGymId = await createTestGym('Standalone Other Gym');
  await createTestMembership(gymId, 'member');
  const email = `standalone-${Date.now()}@test.com`;
  await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, 'Standalone Member', ?, ?)
     ON DUPLICATE KEY UPDATE gym_id = VALUES(gym_id), name = VALUES(name), email = VALUES(email), deleted_at = NULL`,
    [gymId, email, TEST_USER_ID],
  );
  const { rows } = await db.query<{ id: number }>('SELECT id FROM members WHERE clerk_user_id = ?', [TEST_USER_ID]);
  memberId = rows[0].id;
  squatId = (await db.query(`INSERT INTO exercises (gym_id, name, status) VALUES (?, 'Standalone Squat', 'active')`, [gymId])).insertId;
  await db.query(`INSERT INTO exercises (gym_id, name, status) VALUES (?, 'Standalone Bench', 'active')`, [gymId]);
  inactiveId = (await db.query(`INSERT INTO exercises (gym_id, name, status) VALUES (?, 'Standalone Retired', 'inactive')`, [gymId])).insertId;
  otherGymExerciseId = (await db.query(`INSERT INTO exercises (gym_id, name, status) VALUES (?, 'Foreign Lift', 'active')`, [otherGymId])).insertId;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('standalone exercises (#1916)', () => {
  it('rejects an unauthenticated request', async () => {
    await request.get(`/me/standalone-exercises?date=${DAY}`).set('x-gym-id', gymId).expect(401);
  });

  it('searches only the gym\'s active exercises by name', async () => {
    const all = await asMember(request.get('/me/standalone-exercises/catalogue')).expect(200);
    const names = all.body.map((e: any) => e.name);
    expect(names).toContain('Standalone Squat');
    expect(names).not.toContain('Standalone Retired');
    expect(names).not.toContain('Foreign Lift');
    const found = await asMember(request.get('/me/standalone-exercises/catalogue?q=bench')).expect(200);
    expect(found.body.map((e: any) => e.name)).toEqual(['Standalone Bench']);
  });

  it('adds an exercise to a day, refuses a duplicate, an inactive and a foreign exercise', async () => {
    const res = await asMember(request.post('/me/standalone-exercises')).send({ exercise_id: squatId, date: DAY }).expect(201);
    rowId = res.body.id;
    await asMember(request.post('/me/standalone-exercises')).send({ exercise_id: squatId, date: DAY }).expect(409);
    await asMember(request.post('/me/standalone-exercises')).send({ exercise_id: inactiveId, date: DAY }).expect(404);
    await asMember(request.post('/me/standalone-exercises')).send({ exercise_id: otherGymExerciseId, date: DAY }).expect(404);
    await asMember(request.post('/me/standalone-exercises')).send({ exercise_id: squatId, date: 'nope' }).expect(400);
    const list = await asMember(request.get(`/me/standalone-exercises?date=${DAY}`)).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].exercise_name).toBe('Standalone Squat');
    expect(list.body[0].logs).toEqual([]);
    const other = await asMember(request.get('/me/standalone-exercises?date=2026-10-22')).expect(200);
    expect(other.body).toEqual([]);
  });

  it('registers weight and reps through the exercise log and returns them for the day', async () => {
    await asMember(request.post('/me/exercise-logs')).send({
      standalone_exercise_id: rowId, logged_date: DAY, sets: [{ weight: 60, reps: 8 }, { weight: 65, reps: 6 }],
    }).expect(201);
    const list = await asMember(request.get(`/me/standalone-exercises?date=${DAY}`)).expect(200);
    const sets = list.body[0].logs[0].sets;
    expect(sets.map((s: any) => [Number(s.weight), s.reps])).toEqual([[60, 8], [65, 6]]);
    // The history is the exercise's, so My Progress counts it.
    const progress = await asMember(request.get('/me/progress/exercises')).expect(200);
    expect(progress.body.find((e: any) => e.exercise_id === squatId)).toBeTruthy();
  });

  it('refuses a log on another day, on both ids, and on someone else\'s addition', async () => {
    await asMember(request.post('/me/exercise-logs')).send({ standalone_exercise_id: rowId, logged_date: '2026-10-22', sets: [{ reps: 1 }] }).expect(400);
    await asMember(request.post('/me/exercise-logs')).send({ standalone_exercise_id: rowId, workout_exercise_id: 1, logged_date: DAY }).expect(400);
    const { insertId: otherMember } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'Someone Else', `se-${Date.now()}@test.com`]);
    const { insertId: foreign } = await db.query(
      'INSERT INTO member_standalone_exercises (gym_id, member_id, exercise_id, exercise_date) VALUES (?, ?, ?, ?)', [gymId, otherMember, squatId, DAY]);
    await asMember(request.post('/me/exercise-logs')).send({ standalone_exercise_id: foreign, logged_date: DAY, sets: [{ reps: 1 }] }).expect(403);
    await asMember(request.delete(`/me/standalone-exercises/${foreign}`)).expect(404);
  });

  it('removes an addition only while nothing is registered', async () => {
    await asMember(request.delete(`/me/standalone-exercises/${rowId}`)).expect(409);
    const { body } = await asMember(request.post('/me/standalone-exercises')).send({ exercise_id: squatId, date: '2026-10-23' }).expect(201);
    await asMember(request.delete(`/me/standalone-exercises/${body.id}`)).expect(200);
  });

  it('is isolated per gym', async () => {
    await request.get(`/me/standalone-exercises?date=${DAY}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', otherGymId).expect(403);
  });
});
