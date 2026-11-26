import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

// #3466: an Assigned Training Plan's Workout carries editable notes (the
// existing `workouts.description`), and editing them — or the name — leaves the
// Workout's scheduled weekday alone.

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('PUT /members/:memberId/training-plans/:planId/workouts/:workoutId notes (#3466)', () => {
  let gymId: string;
  let otherGymId: string;
  let memberId: number;
  let planId: number;
  let workoutA: number;
  let workoutB: number;

  const base = () => `/members/${memberId}/training-plans/${planId}`;
  const put = (workoutId: number, body: Record<string, unknown>, gym = gymId) =>
    request.put(`${base()}/workouts/${workoutId}`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym).send(body);
  const readPlan = async () => {
    const res = await request.get(base()).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const workouts = typeof res.body.workouts === 'string' ? JSON.parse(res.body.workouts) : res.body.workouts;
    return (id: number) => workouts.find((w: any) => w.id === id);
  };

  beforeAll(async () => {
    gymId = await createTestGym('Workout Notes Gym');
    otherGymId = await createTestGym('Workout Notes Other Gym');
    await createTestMembership(gymId, 'admin');
    await createTestMembership(otherGymId, 'admin');
    const { insertId: m } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Notes Member', ?)`,
      [gymId, `workout-notes-${Date.now()}@test.com`],
    );
    memberId = m;
    const { insertId: p } = await db.query(
      `INSERT INTO training_plans (gym_id, member_id, name, status, start_date) VALUES (?, ?, 'Notes Plan', 'active', CURRENT_DATE)`,
      [gymId, memberId],
    );
    planId = p;
    const { insertId: a } = await db.query(
      `INSERT INTO workouts (gym_id, training_plan_id, name, description, position, scheduled_weekday) VALUES (?, ?, 'Legs', NULL, 1, 1)`,
      [gymId, planId],
    );
    const { insertId: b } = await db.query(
      `INSERT INTO workouts (gym_id, training_plan_id, name, description, position, scheduled_weekday) VALUES (?, ?, 'Push', 'Existing note', 2, 3)`,
      [gymId, planId],
    );
    workoutA = a;
    workoutB = b;
  });

  it('reads existing notes back on the plan tree', async () => {
    const byId = await readPlan();
    expect(byId(workoutB).description).toBe('Existing note');
    expect(byId(workoutA).description).toBeNull();
  });

  it('saves notes on one workout without touching its weekday or the other workout', async () => {
    const res = await put(workoutA, { description: 'Warm up 10 min\nKeep the back straight' });
    expect(res.status).toBe(200);

    const byId = await readPlan();
    expect(byId(workoutA).description).toBe('Warm up 10 min\nKeep the back straight');
    expect(byId(workoutA).scheduled_weekday).toBe(1);
    expect(byId(workoutA).name).toBe('Legs');
    expect(byId(workoutB).description).toBe('Existing note');
    expect(byId(workoutB).scheduled_weekday).toBe(3);
  });

  it('keeps the weekday when only the name is edited (regression)', async () => {
    const res = await put(workoutB, { name: 'Push Day' });
    expect(res.status).toBe(200);
    const byId = await readPlan();
    expect(byId(workoutB).name).toBe('Push Day');
    expect(byId(workoutB).scheduled_weekday).toBe(3);
    expect(byId(workoutB).description).toBe('Existing note');
  });

  it('still clears the weekday when the body names it as null', async () => {
    const res = await put(workoutB, { scheduled_weekday: null });
    expect(res.status).toBe(200);
    const byId = await readPlan();
    expect(byId(workoutB).scheduled_weekday).toBeNull();
  });

  it('clears notes with null or a blank value', async () => {
    expect((await put(workoutA, { description: '   ' })).status).toBe(200);
    expect((await readPlan())(workoutA).description).toBeNull();
    expect((await put(workoutB, { description: null })).status).toBe(200);
    expect((await readPlan())(workoutB).description).toBeNull();
  });

  it('refuses a non-string description', async () => {
    const res = await put(workoutA, { description: 42 });
    expect(res.status).toBe(400);
  });

  it('does not let another gym edit the workout', async () => {
    const res = await put(workoutA, { description: 'Intruder' }, otherGymId);
    expect(res.status).toBe(404);
  });
});
