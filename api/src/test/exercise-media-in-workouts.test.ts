import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  request, TEST_AUTH_HEADER, createTestGym, createTestMembership, cleanupTestGyms,
} from './helpers';

/**
 * #720 — every endpoint that returns a workout exercise also returns the media
 * the exercise itself carries, so a workout row can render an image/video
 * thumbnail without one lookup per exercise.
 *
 * The workout layer does no source/ownership resolution: it reads back exactly
 * what `exercises.image_url` / `exercises.video_url` hold right now.
 */

const IMAGE_URL = 'https://cdn.example.test/gyms/1-Gym/Exercises/Images/press.png';
const VIDEO_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

let gymId: string;
let memberId: number;
let withMediaId: number;
let noMediaId: number;

async function createExercise(name: string, imageUrl: string | null, videoUrl: string | null): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO exercises (gym_id, name, status, image_url, video_url) VALUES (?, ?, 'active', ?, ?)`,
    [gymId, name, imageUrl, videoUrl],
  );
  return insertId;
}

beforeAll(async () => {
  gymId = await createTestGym('Exercise Media Gym');
  await createTestMembership(gymId, 'admin');

  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Media Member', ?)`,
    [gymId, `media-${Date.now()}@test.com`],
  );
  memberId = insertId;

  withMediaId = await createExercise('Barbell Press', IMAGE_URL, VIDEO_URL);
  noMediaId = await createExercise('Air Squat', null, null);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

const auth = (req: any) => req.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

describe('workout template exercises (#720)', () => {
  let templateId: number;
  let blockId: number;

  beforeAll(async () => {
    const tpl = await auth(request.post('/workout-templates')).send({ name: 'Media Template', status: 'active' });
    templateId = tpl.body.id;
    const block = await auth(request.post(`/workout-templates/${templateId}/blocks`))
      .send({ type: 'Circuit', result_type: 'None' });
    blockId = block.body.id;
  });

  it('returns the exercise media when an exercise is added to a block', async () => {
    const res = await auth(request.post(`/workout-templates/${templateId}/blocks/${blockId}/exercises`))
      .send({ exercise_id: withMediaId, sets: 3 })
      .expect(201);

    expect(res.body.exercise_image_url).toBe(IMAGE_URL);
    expect(res.body.exercise_video_url).toBe(VIDEO_URL);
  });

  it('returns null media for an exercise that has none', async () => {
    const res = await auth(request.post(`/workout-templates/${templateId}/blocks/${blockId}/exercises`))
      .send({ exercise_id: noMediaId, sets: 2 })
      .expect(201);

    expect(res.body.exercise_image_url).toBeNull();
    expect(res.body.exercise_video_url).toBeNull();
  });

  it('lists block exercises with their media', async () => {
    const res = await auth(request.get(`/workout-templates/${templateId}/blocks/${blockId}/exercises`)).expect(200);

    const withMedia = res.body.find((e: any) => e.exercise_id === withMediaId);
    const without = res.body.find((e: any) => e.exercise_id === noMediaId);
    expect(withMedia.exercise_image_url).toBe(IMAGE_URL);
    expect(withMedia.exercise_video_url).toBe(VIDEO_URL);
    expect(without.exercise_image_url).toBeNull();
    expect(without.exercise_video_url).toBeNull();
  });

  it('carries the media down the template tree, so no per-exercise lookup is needed', async () => {
    const res = await auth(request.get(`/workout-templates/${templateId}`)).expect(200);

    const exercises = res.body.blocks.flatMap((b: any) => b.exercises ?? []);
    const withMedia = exercises.find((e: any) => e.exercise_id === withMediaId);
    expect(withMedia.exercise_image_url).toBe(IMAGE_URL);
    expect(withMedia.exercise_video_url).toBe(VIDEO_URL);
  });

  it('reflects an exercise whose media changed — the workout holds no copy', async () => {
    const newImage = 'https://cdn.example.test/gyms/1-Gym/Exercises/Images/press-v2.png';
    await db.query('UPDATE exercises SET image_url = ? WHERE id = ?', [newImage, withMediaId]);

    const res = await auth(request.get(`/workout-templates/${templateId}`)).expect(200);
    const exercises = res.body.blocks.flatMap((b: any) => b.exercises ?? []);
    expect(exercises.find((e: any) => e.exercise_id === withMediaId).exercise_image_url).toBe(newImage);

    await db.query('UPDATE exercises SET image_url = ? WHERE id = ?', [IMAGE_URL, withMediaId]);
  });
});

describe('training plan exercises (#720)', () => {
  let planId: number;

  beforeAll(async () => {
    const plan = await auth(request.post('/training-plans'))
      .send({ member_id: memberId, name: 'Media Plan', start_date: new Date().toISOString().slice(0, 10) });
    planId = plan.body.id;

    const workout = await auth(request.post(`/members/${memberId}/training-plans/${planId}/workouts`))
      .send({ name: 'Day 1' });
    const block = await auth(
      request.post(`/members/${memberId}/training-plans/${planId}/workouts/${workout.body.id}/blocks`),
    ).send({ type: 'Circuit', result_type: 'None' });

    await auth(
      request.post(
        `/members/${memberId}/training-plans/${planId}/workouts/${workout.body.id}/blocks/${block.body.id}/exercises`,
      ),
    ).send({ exercise_id: withMediaId, sets: 4 });
    await auth(
      request.post(
        `/members/${memberId}/training-plans/${planId}/workouts/${workout.body.id}/blocks/${block.body.id}/exercises`,
      ),
    ).send({ exercise_id: noMediaId, sets: 4 });
  });

  it('carries the media down the plan tree', async () => {
    const res = await auth(request.get(`/members/${memberId}/training-plans/${planId}`)).expect(200);

    const exercises = res.body.workouts
      .flatMap((w: any) => w.blocks ?? [])
      .flatMap((b: any) => b.exercises ?? []);
    const withMedia = exercises.find((e: any) => e.exercise_id === withMediaId);
    const without = exercises.find((e: any) => e.exercise_id === noMediaId);

    expect(withMedia.exercise_image_url).toBe(IMAGE_URL);
    expect(withMedia.exercise_video_url).toBe(VIDEO_URL);
    expect(without.exercise_image_url).toBeNull();
    expect(without.exercise_video_url).toBeNull();
  });
});
