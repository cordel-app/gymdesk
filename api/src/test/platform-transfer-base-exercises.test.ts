// #2952 stage 6: Cordel → Export / Import of the Base Exercises.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { BASE_EXERCISE_TABLES as B } from '../domain/exerciseTables';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

const platformRole = vi.hoisted(() => ({ value: 'superadmin' as string | undefined }));

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: {
        getUser: vi.fn().mockImplementation(async () => ({
          publicMetadata: platformRole.value ? { platform_role: platformRole.value } : {},
          fullName: 'Super Admin', firstName: 'Super', lastName: 'Admin',
        })),
        getUserList: vi.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      },
      invitations: { createInvitation: vi.fn().mockResolvedValue({ id: 'inv' }), revokeInvitation: vi.fn().mockResolvedValue({}) },
      emailAddresses: { getEmailAddress: vi.fn().mockResolvedValue({ emailAddress: 't@example.com' }) },
    })),
  };
});

const H = { Authorization: TEST_AUTH_HEADER };
const STAMP = Date.now();
const SLUG = `transfer-exercise-${STAMP}`;
let gymId: string;

const muscleKeys = (e: any) => (e.muscles ?? []).map((m: any) => `${m.key}:${m.role}`).sort();
const metricSlugs = (e: any) => (e.allowed_result_types ?? []).map((r: any) => r.slug).sort();

beforeAll(async () => {
  gymId = await createTestGym('Transfer Exercises Gym');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  const { rows } = await db.query<{ id: number }>(`SELECT id FROM ${B.exercises} WHERE slug LIKE 'transfer-exercise%'`);
  for (const { id } of rows) {
    for (const t of [B.muscles, B.resultTypes, B.translations, B.descriptions]) {
      await db.query(`DELETE FROM ${t} WHERE exercise_id = ?`, [id]).catch(() => undefined);
    }
    await db.query(`DELETE FROM ${B.exercises} WHERE id = ?`, [id]);
  }
  await cleanupTestGyms();
  await db.end();
});

describe('Export / Import of the Base Exercises (#2952 stage 6)', () => {
  it('refuses a caller who is not a superadmin', async () => {
    platformRole.value = undefined;
    try {
      expect((await request.get('/platform/transfer/base_exercises').set(H).set('x-gym-id', gymId)).status).toBe(403);
      expect((await request.post('/platform/transfer/base_exercises').set(H).set('x-gym-id', gymId)
        .send({ slug: SLUG, name: 'X' })).status).toBe(403);
    } finally {
      platformRole.value = 'superadmin';
    }
  });

  it('creates an exercise under the archive slug, with its muscles and Recorded Metrics resolved by slug', async () => {
    const created = await request.post('/platform/transfer/base_exercises').set(H)
      .send({
        slug: SLUG, name: `Transfer Exercise ${STAMP}`, description: 'One', short_description: 'Short',
        category: 'strength', equipment: 'dumbbell', sets_default: 3, min_reps_default: 8, max_reps_default: 12,
        translations: { es: `Ejercicio ${STAMP}` }, description_translations: { es: { description: 'Uno' } },
        muscles: [{ key: 'chest', role: 'principal' }, { key: 'triceps', role: 'secondary' }],
        result_type_slugs: ['repetitions', 'weight'],
        id: 999999999, gym_id: gymId,
      });
    expect(created.status).toBe(201);
    expect(created.body.action).toBe('created');
    const e = created.body.entity;
    expect(e.slug).toBe(SLUG);
    expect(e.id).not.toBe(999999999);
    expect(e.gym_id).toBeNull();
    expect(e.sets_default).toBe(3);
    expect(e.translations.es).toBe(`Ejercicio ${STAMP}`);
    expect(muscleKeys(e)).toEqual(['chest:principal', 'triceps:secondary']);
    expect(metricSlugs(e)).toEqual(['repetitions', 'weight']);
  });

  it('exports the exercise as its slug, its own fields, its relationship slugs and its two image slots', async () => {
    const res = await request.get('/platform/transfer/base_exercises').set(H);
    expect(res.status).toBe(200);
    const x = res.body.entities.find((r: any) => r.slug === SLUG);
    expect(Object.keys(x.data).sort()).toEqual([
      'category', 'description', 'description_translations', 'equipment', 'max_reps_default', 'min_reps_default',
      'muscles', 'name', 'rest_default_seconds', 'result_type_slugs', 'sets_default', 'short_description', 'status',
      'translations',
    ]);
    expect(x.data.result_type_slugs).toEqual(['repetitions', 'weight']);
    expect(x.data.muscles.map((m: any) => m.key).sort()).toEqual(['chest', 'triceps']);
    expect(x.images).toEqual({ image_male: null, image_female: null });
  });

  it('updates the content in place and leaves its muscles and Recorded Metrics as they were', async () => {
    const { rows } = await db.query<{ id: number }>(`SELECT id FROM ${B.exercises} WHERE slug = ?`, [SLUG]);
    const id = rows[0].id;
    const updated = await request.post('/platform/transfer/base_exercises').set(H)
      .send({
        slug: SLUG, name: `Transfer Exercise ${STAMP} Renamed`, description: 'Two', sets_default: 5,
        translations: { ca: `Exercici ${STAMP}` },
        muscles: [{ key: 'quads', role: 'principal' }], result_type_slugs: ['duration'],
      });
    expect(updated.status).toBe(200);
    expect(updated.body.action).toBe('updated');
    const e = updated.body.entity;
    expect(e.id).toBe(id);
    expect(e.slug).toBe(SLUG);
    expect(e.name).toBe(`Transfer Exercise ${STAMP} Renamed`);
    expect(e.description).toBe('Two');
    expect(e.sets_default).toBe(5);
    expect(e.translations).toEqual({ ca: `Exercici ${STAMP}` });
    expect(muscleKeys(e)).toEqual(['chest:principal', 'triceps:secondary']);
    expect(metricSlugs(e)).toEqual(['repetitions', 'weight']);
    const count = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${B.exercises} WHERE slug = ?`, [SLUG]);
    expect(Number(count.rows[0].n)).toBe(1);
  });

  it('keeps the editor\'s rules: a taken name and an unknown Recorded Metric slug are refused', async () => {
    const taken = await request.post('/platform/transfer/base_exercises').set(H)
      .send({ slug: `transfer-exercise-dup-${STAMP}`, name: `Transfer Exercise ${STAMP} Renamed` });
    expect(taken.status).toBe(409);
    const unknown = await request.post('/platform/transfer/base_exercises').set(H)
      .send({ slug: `transfer-exercise-unknown-${STAMP}`, name: `Unknown ${STAMP}`, result_type_slugs: ['no_such_metric'] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/no_such_metric/);
  });

  it('refuses a malformed slug, an image for an unknown slug or slot, and a soft-deleted slug', async () => {
    expect((await request.post('/platform/transfer/base_exercises').set(H)
      .send({ slug: 'Bad Slug', name: 'X' })).status).toBe(400);
    const unknown = await request.post('/platform/transfer/base_exercises/transfer-exercise-missing/image/image_male').set(H)
      .set('Content-Type', 'image/png').send(Buffer.from([1, 2, 3]));
    expect(unknown.status).toBe(404);
    const slot = await request.post(`/platform/transfer/base_exercises/${SLUG}/image/video_male`).set(H)
      .set('Content-Type', 'image/png').send(Buffer.from([1, 2, 3]));
    expect(slot.status).toBe(400);

    await db.query(`UPDATE ${B.exercises} SET status = 'deleted', deleted_at = UTC_TIMESTAMP() WHERE slug = ?`, [SLUG]);
    const res = await request.post('/platform/transfer/base_exercises').set(H)
      .send({ slug: SLUG, name: 'Resurrected' });
    expect(res.status).toBe(409);
  });
});
