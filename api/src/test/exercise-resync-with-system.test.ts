// #2302 — "Resync with System" moves name, description, short description (+ their
// translations) and a *missing* male/female image from the originating Base Exercise
// and nothing else.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createBaseExercise, createTestGym, createTestMembership, deleteBaseExercises, request } from './helpers';

const PREFIX = `rs-${Date.now()}`;
let gymA: string;
let gymB: string;
let frontDesk: string;
let baseId: number;
let copyId: number;
let ownId: number;

const as = (gym: string) => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gym });
const url = (id: number) => `/exercises/${id}/resync-with-system`;
const row = async (id: number) => (await db.query<any>('SELECT * FROM exercises WHERE id = ?', [id])).rows[0];

beforeAll(async () => {
  gymA = await createTestGym('Resync A');
  await createTestMembership(gymA, 'admin');
  gymB = await createTestGym('Resync B');
  await createTestMembership(gymB, 'admin');
  frontDesk = await createTestGym('Resync FD');
  await createTestMembership(frontDesk, 'front_desk');
  baseId = await createBaseExercise({
    name: `${PREFIX}-base`,
    description: 'base desc',
    short_description: 'base short',
    image_male_url: 'https://example.test/base-male.webp',
    image_female_url: 'https://example.test/base-female.webp',
    video_male_url: 'https://example.test/base-video.mp4',
  });
  await db.query("INSERT INTO base_exercise_translations (exercise_id, locale, name) VALUES (?, 'es', 'Base ES')", [baseId]);
  await db.query(
    "INSERT INTO base_exercise_description_translations (exercise_id, locale, short_description, description) VALUES (?, 'es', 'corta', 'larga')",
    [baseId],
  );
  const imp = await request.post('/exercises/import').set(as(gymA)).send({ baseExerciseIds: [baseId] });
  expect(imp.status).toBe(201);
  copyId = imp.body.imported[0].id;
  ownId = (await request.post('/exercises').set(as(gymA)).send({ name: `${PREFIX}-own` })).body.id;
});

afterAll(async () => {
  await cleanupTestGyms();
  await deleteBaseExercises([baseId]);
  await db.end();
});

describe('POST /exercises/:id/resync-with-system', () => {
  it('requires auth and write access', async () => {
    expect((await request.post(url(copyId)).set('x-gym-id', gymA)).status).toBe(401);
    expect((await request.post(url(copyId)).set(as(frontDesk))).status).toBe(403);
  });

  it('is isolated per gym and refuses an exercise the gym created itself', async () => {
    expect((await request.post(url(copyId)).set(as(gymB))).status).toBe(404);
    const res = await request.post(url(ownId)).set(as(gymA));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('no_base_exercise');
  });

  it('reports up to date right after an import', async () => {
    const res = await request.post(url(copyId)).set(as(gymA));
    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([]);
  });

  it('updates text and translations, fills only the missing image, keeps everything else', async () => {
    await db.query(
      `UPDATE exercises SET name = ?, description = 'edited', short_description = 'edited', image_male_url = NULL,
         image_female_url = 'https://example.test/own-female.webp', video_male_url = NULL, sets_default = 9 WHERE id = ?`,
      [`${PREFIX}-renamed`, copyId],
    );
    await db.query("UPDATE exercise_translations SET name = 'Edited ES' WHERE exercise_id = ? AND locale = 'es'", [copyId]);
    await db.query("UPDATE exercise_description_translations SET description = 'x' WHERE exercise_id = ? AND locale = 'es'", [copyId]);

    const res = await request.post(url(copyId)).set(as(gymA));
    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual(expect.arrayContaining(['name', 'description', 'image_male']));
    expect(res.body.updated).not.toContain('image_female');

    const after = await row(copyId);
    expect(after.name).toBe(`${PREFIX}-base`);
    expect(after.description).toBe('base desc');
    expect(after.short_description).toBe('base short');
    expect(after.image_male_url).toBe('https://example.test/base-male.webp');
    expect(after.image_female_url).toBe('https://example.test/own-female.webp');
    expect(after.video_male_url).toBeNull();
    expect(after.sets_default).toBe(9);
    expect(Number(after.base_exercise_id)).toBe(baseId);
    const tr = (await db.query<any>("SELECT name FROM exercise_translations WHERE exercise_id = ? AND locale = 'es'", [copyId])).rows[0];
    expect(tr.name).toBe('Base ES');
    const d = (await db.query<any>("SELECT description FROM exercise_description_translations WHERE exercise_id = ? AND locale = 'es'", [copyId])).rows[0];
    expect(d.description).toBe('larga');
    // the Base Exercise is untouched
    const base = (await db.query<any>('SELECT name, image_male_url FROM base_exercises WHERE id = ?', [baseId])).rows[0];
    expect(base.name).toBe(`${PREFIX}-base`);

    expect((await request.post(url(copyId)).set(as(gymA))).body.updated).toEqual([]);
  });

  it('refuses when the Base Exercise is gone', async () => {
    await db.query("UPDATE base_exercises SET status = 'deleted', deleted_at = UTC_TIMESTAMP() WHERE id = ?", [baseId]);
    const res = await request.post(url(copyId)).set(as(gymA));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('base_unavailable');
  });
});

describe('equipment (#2376)', () => {
  it('import copies equipment from the Base Exercise and resync follows its current value', async () => {
    await db.query("UPDATE base_exercises SET equipment = 'barbell' WHERE id = ?", [baseId]);
    const second = await createBaseExercise({ name: `${PREFIX}-eq` });
    await db.query("UPDATE base_exercises SET equipment = 'dumbbell' WHERE id = ?", [second]);
    try {
      const imp = await request.post('/exercises/import').set(as(gymB)).send({ baseExerciseIds: [second] });
      expect(imp.status).toBe(201);
      expect((await row(imp.body.imported[0].id)).equipment).toBe('dumbbell');

      await db.query("UPDATE exercises SET equipment = 'machine' WHERE id = ?", [copyId]);
      const res = await request.post(url(copyId)).set(as(gymA));
      expect(res.status).toBe(200);
      expect(res.body.updated).toContain('equipment');
      expect((await row(copyId)).equipment).toBe('barbell');
      const again = await request.post(url(copyId)).set(as(gymA));
      expect(again.body.updated).toEqual([]);
    } finally {
      await deleteBaseExercises([second]);
    }
  });
});
