// Tests for #723 — the member's own Training Plan carries each exercise's
// media, so Members → My Training Plan can render an image/video at the
// exercise level without one request per exercise.
//
// `GET /me/training-plans` reads the same PLAN_TREE_SELECT the staff-facing
// plan tree does (#720), so what is asserted here is the member-facing half of
// that contract: the media is present for the caller's own plans, it is null
// (not missing) for an exercise that has none, it is read live off `exercises`
// rather than copied into the workout, and it stays inside the caller's gym.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, TEST_USER_ID, cleanupTestGyms, createTestGym, createTestMembership, request,
} from './helpers';

const IMAGE_URL = 'https://cdn.example.test/gyms/1-Gym/Exercises/Images/squat.png';
const VIDEO_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

let gymId: string;
let otherGymId: string;
let memberId: number;
let withMediaId: number;
let noMediaId: number;

async function createExercise(gid: string, name: string, imageUrl: string | null, videoUrl: string | null): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO exercises (gym_id, name, status, image_url, video_url) VALUES (?, ?, 'active', ?, ?)`,
    [gid, name, imageUrl, videoUrl],
  );
  return insertId;
}

/** An active plan with one workout, one block and the given exercises, in order. */
async function createActivePlan(gid: string, mid: number, exerciseIds: number[]): Promise<number> {
  const { insertId: planId } = await db.query(
    `INSERT INTO training_plans (gym_id, member_id, name, status, start_date)
     VALUES (?, ?, 'Media Plan', 'active', CURRENT_DATE)`,
    [gid, mid],
  );
  await db.query(
    `INSERT INTO member_training_plans (gym_id, member_id, training_plan_id, status) VALUES (?, ?, ?, 'active')`,
    [gid, mid, planId],
  );
  const { insertId: workoutId } = await db.query(
    `INSERT INTO workouts (gym_id, training_plan_id, name, position, scheduled_weekday) VALUES (?, ?, 'Day 1', 1, 1)`,
    [gid, planId],
  );
  const { insertId: blockId } = await db.query(
    `INSERT INTO workout_blocks (gym_id, workout_id, position, type) VALUES (?, ?, 1, 'Circuit')`,
    [gid, workoutId],
  );
  for (const [index, exerciseId] of exerciseIds.entries()) {
    await db.query(
      `INSERT INTO workout_exercises (gym_id, workout_block_id, exercise_id, position, sets) VALUES (?, ?, ?, ?, 3)`,
      [gid, blockId, exerciseId, index + 1],
    );
  }
  return planId;
}

/** Every exercise of every workout of every plan in the response. */
function exercisesOf(body: any[]): any[] {
  return body
    .flatMap((plan) => plan.workouts ?? [])
    .flatMap((workout: any) => workout.blocks ?? [])
    .flatMap((block: any) => block.exercises ?? []);
}

const asMember = (req: any) => req.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

beforeAll(async () => {
  gymId = await createTestGym('Me Training Media Gym');
  await createTestMembership(gymId, 'member');

  await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, 'Media Member', ?, ?)
     ON DUPLICATE KEY UPDATE gym_id = VALUES(gym_id), email = VALUES(email)`,
    [gymId, `me-training-media-${Date.now()}@test.com`, TEST_USER_ID],
  );
  const { rows } = await db.query<{ id: number }>(
    'SELECT id FROM members WHERE clerk_user_id = ?',
    [TEST_USER_ID],
  );
  memberId = rows[0].id;

  withMediaId = await createExercise(gymId, 'Back Squat', IMAGE_URL, VIDEO_URL);
  noMediaId = await createExercise(gymId, 'Air Squat', null, null);
  await createActivePlan(gymId, memberId, [withMediaId, noMediaId]);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('GET /me/training-plans exercise media (#723)', () => {
  it('returns the image and video of each exercise of the caller\'s plan', async () => {
    const res = await asMember(request.get('/me/training-plans')).expect(200);

    const exercises = exercisesOf(res.body);
    const withMedia = exercises.find((e) => e.exercise_id === withMediaId);
    expect(withMedia.exercise_image_url).toBe(IMAGE_URL);
    expect(withMedia.exercise_video_url).toBe(VIDEO_URL);
  });

  it('returns null media — not a missing field — for an exercise that has none', async () => {
    const res = await asMember(request.get('/me/training-plans')).expect(200);

    const without = exercisesOf(res.body).find((e) => e.exercise_id === noMediaId);
    expect(without).toHaveProperty('exercise_image_url');
    expect(without).toHaveProperty('exercise_video_url');
    expect(without.exercise_image_url).toBeNull();
    expect(without.exercise_video_url).toBeNull();
  });

  it('keeps the media inside the exercise, at its own level of the hierarchy', async () => {
    const res = await asMember(request.get('/me/training-plans')).expect(200);

    const plan = res.body[0];
    expect(plan).not.toHaveProperty('exercise_image_url');
    const workout = plan.workouts[0];
    expect(workout).not.toHaveProperty('exercise_image_url');
    const block = workout.blocks[0];
    expect(block).not.toHaveProperty('exercise_image_url');
    // Ordering is the workout's own — the media rides along, it does not regroup.
    expect(block.exercises.map((e: any) => e.exercise_id)).toEqual([withMediaId, noMediaId]);
  });

  it('carries the media in the one plan-tree response, so no per-exercise request is needed', async () => {
    const res = await asMember(request.get('/me/training-plans')).expect(200);

    const exercises = exercisesOf(res.body);
    expect(exercises).toHaveLength(2);
    for (const exercise of exercises) {
      expect(exercise).toHaveProperty('exercise_name');
      expect(exercise).toHaveProperty('exercise_image_url');
      expect(exercise).toHaveProperty('exercise_video_url');
    }
  });

  it('reflects an exercise whose media changed — the plan holds no copy', async () => {
    const newVideo = 'https://cdn.example.test/gyms/1-Gym/Exercises/Videos/squat.mp4';
    await db.query('UPDATE exercises SET video_url = ? WHERE id = ?', [newVideo, withMediaId]);

    const res = await asMember(request.get('/me/training-plans')).expect(200);
    expect(exercisesOf(res.body).find((e) => e.exercise_id === withMediaId).exercise_video_url)
      .toBe(newVideo);

    await db.query('UPDATE exercises SET video_url = ? WHERE id = ?', [VIDEO_URL, withMediaId]);
  });

  it('shows the same exercise\'s media at every occurrence it has in the plan', async () => {
    const { rows: blockRows } = await db.query<{ id: number }>(
      `SELECT b.id FROM workout_blocks b
       JOIN workouts w ON w.id = b.workout_id
       JOIN training_plans tp ON tp.id = w.training_plan_id
       WHERE tp.gym_id = ? AND tp.member_id = ? LIMIT 1`,
      [gymId, memberId],
    );
    await db.query(
      `INSERT INTO workout_exercises (gym_id, workout_block_id, exercise_id, position, sets) VALUES (?, ?, ?, 3, 3)`,
      [gymId, blockRows[0].id, withMediaId],
    );

    const res = await asMember(request.get('/me/training-plans')).expect(200);
    const occurrences = exercisesOf(res.body).filter((e) => e.exercise_id === withMediaId);

    expect(occurrences).toHaveLength(2);
    for (const occurrence of occurrences) {
      expect(occurrence.exercise_image_url).toBe(IMAGE_URL);
      expect(occurrence.exercise_video_url).toBe(VIDEO_URL);
    }

    await db.query(
      'DELETE FROM workout_exercises WHERE workout_block_id = ? AND position = 3',
      [blockRows[0].id],
    );
  });

  it('returns no plans — and no media — for another gym\'s tenant context', async () => {
    otherGymId = await createTestGym('Other Training Media Gym');
    await createTestMembership(otherGymId, 'member');

    const res = await request
      .get('/me/training-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId)
      .expect(200);

    expect(res.body).toEqual([]);
  });

  it('rejects an unauthenticated read of the plan tree', async () => {
    await request.get('/me/training-plans').set('x-gym-id', gymId).expect(401);
  });
});
