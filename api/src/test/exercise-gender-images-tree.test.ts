// #3407 — the Training Plan trees report both sex positions' images.
//
// The tree rows used to carry one effective image (the male one, else the
// female one), so a female image was never shown and the detail modal could
// only enlarge the thumbnail. Each exercise now carries each sex position's
// original and thumbnail: its own image of that sex, else its primary muscle's
// image of that sex (#1704), never the other sex's.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  request, TEST_AUTH_HEADER, createTestGym, createTestMembership, cleanupTestGyms,
} from './helpers';

const R2 = 'https://pub.example.r2.dev/gyms/test/exercises/images';
const MUSCLE_SLUG = 'test_3407_muscle';
let gymId: string;
let ownImagesExerciseId: number;
let muscleOnlyExerciseId: number;
let planTemplateId: number;
let workoutTemplateId: number;

const api = (method: 'get' | 'post', path: string) =>
  request[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

beforeAll(async () => {
  gymId = await createTestGym('Gender Images Tree Gym');
  await createTestMembership(gymId);

  ownImagesExerciseId = (await db.query(
    `INSERT INTO exercises (gym_id, name, slug, status, image_male_url, image_female_url)
     VALUES (?, 'Both Images', 'both-images-3407', 'active', ?, ?)`,
    [gymId, `${R2}/1-squat-male.webp`, `${R2}/1-squat-female.webp`],
  )).insertId;
  muscleOnlyExerciseId = (await db.query(
    "INSERT INTO exercises (gym_id, name, slug, status) VALUES (?, 'Muscle Only', 'muscle-only-3407', 'active')",
    [gymId],
  )).insertId;
  await db.query('DELETE FROM muscles WHERE slug = ?', [MUSCLE_SLUG]);
  const muscleId = (await db.query(
    `INSERT INTO muscles (slug, name, image_male_url, image_male_url_thumbnail)
     VALUES (?, 'Test 3407 Muscle', ?, ?)`,
    [MUSCLE_SLUG, `${R2}/muscle-male.webp`, `${R2}/muscle-male-thumbnail.webp`],
  )).insertId;
  await db.query(
    `INSERT INTO exercise_muscles (gym_id, exercise_id, muscle, muscle_id, role) VALUES (?, ?, ?, ?, 'principal')`,
    [gymId, muscleOnlyExerciseId, MUSCLE_SLUG, muscleId],
  );

  workoutTemplateId = (await api('post', '/workout-templates').send({ name: 'Gender Day', status: 'active' }).expect(201)).body.id;
  const block = await api('post', `/workout-templates/${workoutTemplateId}/blocks`).send({ type: 'Superset' }).expect(201);
  for (const exercise_id of [ownImagesExerciseId, muscleOnlyExerciseId]) {
    await api('post', `/workout-templates/${workoutTemplateId}/blocks/${block.body.id}/exercises`).send({ exercise_id, sets: 3 }).expect(201);
  }
  planTemplateId = (await api('post', '/training-plan-templates').send({ name: 'Gender Plan', status: 'active' }).expect(201)).body.id;
  await api('post', `/training-plan-templates/${planTemplateId}/workouts`).send({ workout_template_id: workoutTemplateId, scheduled_weekday: 1 }).expect(201);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.query('DELETE FROM muscles WHERE slug = ?', [MUSCLE_SLUG]);
  await db.end();
});

function exercisesOf(res: { body: any }) {
  const ex = res.body.workouts[0].blocks[0].exercises as any[];
  return Object.fromEntries(ex.map((e) => [e.exercise_id, e]));
}

describe('Training Plan Template tree (#3407)', () => {
  it('reports both sexes\' originals and thumbnails of an exercise with its own images', async () => {
    const ex = exercisesOf(await api('get', `/training-plan-templates/${planTemplateId}/hierarchy`).expect(200))[ownImagesExerciseId];
    expect(ex).toMatchObject({
      exercise_image_male_url: `${R2}/1-squat-male.webp`,
      exercise_image_female_url: `${R2}/1-squat-female.webp`,
      exercise_image_male_thumbnail_url: `${R2}/1-squat-male-thumbnail.webp`,
      exercise_image_female_thumbnail_url: `${R2}/1-squat-female-thumbnail.webp`,
      // The default image is unchanged.
      exercise_image_url: `${R2}/1-squat-male.webp`,
    });
  });

  it('falls back per sex to the primary muscle\'s image and never to the other sex', async () => {
    const ex = exercisesOf(await api('get', `/training-plan-templates/${planTemplateId}/hierarchy`).expect(200))[muscleOnlyExerciseId];
    expect(ex).toMatchObject({
      exercise_image_male_url: `${R2}/muscle-male.webp`,
      exercise_image_male_thumbnail_url: `${R2}/muscle-male-thumbnail.webp`,
      exercise_image_female_url: null,
      exercise_image_female_thumbnail_url: null,
      exercise_image_url: `${R2}/muscle-male.webp`,
    });
  });
});

describe('Workout Template tree (#3407)', () => {
  it('reports the same per-sex fields', async () => {
    const res = await api('get', `/workout-templates/${workoutTemplateId}`).expect(200);
    const ex = (res.body.blocks[0].exercises as any[]).find((e) => e.exercise_id === ownImagesExerciseId);
    expect(ex.exercise_image_female_url).toBe(`${R2}/1-squat-female.webp`);
    expect(ex.exercise_image_female_thumbnail_url).toBe(`${R2}/1-squat-female-thumbnail.webp`);
  });
});
