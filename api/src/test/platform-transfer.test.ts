// #2952 stage 1: Cordel → Export / Import, the API half, for Muscles.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
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
const SLUG = `transfer_test_${Date.now()}`;
const NAME = `Transfer Test Muscle ${Date.now()}`;
let gymId: string;

beforeAll(async () => {
  gymId = await createTestGym('Transfer GymA');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  await db.query('DELETE FROM exercise_muscles WHERE muscle_id IN (SELECT id FROM muscles WHERE slug LIKE ?)', ['transfer_test_%']);
  await db.query('DELETE FROM muscles WHERE slug LIKE ?', ['transfer_test_%']);
  await cleanupTestGyms();
  await db.end();
});

describe('Cordel → Export / Import (#2952)', () => {
  it('refuses an unauthenticated caller and a caller who is not a superadmin', async () => {
    expect((await request.get('/platform/transfer/types')).status).toBe(401);
    platformRole.value = undefined;
    try {
      const res = await request.get('/platform/transfer/muscles').set(H).set('x-gym-id', gymId);
      expect(res.status).toBe(403);
      const imp = await request.post('/platform/transfer/muscles').set(H).set('x-gym-id', gymId)
        .send({ slug: SLUG, name: NAME });
      expect(imp.status).toBe(403);
    } finally {
      platformRole.value = 'superadmin';
    }
  });

  it('lists the transferable types', async () => {
    const res = await request.get('/platform/transfer/types').set(H);
    expect(res.status).toBe(200);
    expect(res.body.types).toEqual(['muscles', 'payment_providers', 'base_payment_methods', 'base_professional_services',
      'base_personal_goals', 'base_nutrition_goals', 'base_nutrition_library', 'base_exercises']);
  });

  it('exports every muscle as a slug, its content and its image URLs', async () => {
    const res = await request.get('/platform/transfer/muscles').set(H);
    expect(res.status).toBe(200);
    const chest = res.body.entities.find((e: any) => e.slug === 'chest');
    expect(chest.data.name).toBeTruthy();
    expect(chest.data.translations.es).toBe('Pecho');
    expect(chest.images).toHaveProperty('male');
    expect(chest.images).toHaveProperty('female');
  });

  it('creates a muscle under the slug the archive names, then updates the same row on a second import', async () => {
    const created = await request.post('/platform/transfer/muscles').set(H)
      .send({ slug: SLUG, name: NAME, translations: { es: 'Músculo transferido' } });
    expect(created.status).toBe(201);
    expect(created.body.action).toBe('created');
    expect(created.body.entity.slug).toBe(SLUG);
    const id = created.body.entity.id;

    // A relationship to another entity: an exercise linked to the muscle.
    const ex = await db.query(
      `INSERT INTO exercises (gym_id, name, slug, status, sets_default, min_reps_default, max_reps_default, rest_default_seconds)
       VALUES (?, 'Transfer Linked Exercise', ?, 'active', 3, 8, 12, 60)`,
      [gymId, `transfer-linked-${Date.now()}`],
    );
    await db.query(
      `INSERT INTO exercise_muscles (gym_id, exercise_id, muscle, muscle_id, role) VALUES (?, ?, ?, ?, 'principal')`,
      [gymId, (ex as any).insertId, SLUG, id],
    );

    // The imported content takes priority, the slug does not move, no duplicate is created.
    const updated = await request.post('/platform/transfer/muscles').set(H)
      .send({ slug: SLUG, name: `${NAME} Renamed`, translations: { ca: 'Múscul transferit' } });
    expect(updated.status).toBe(200);
    expect(updated.body.action).toBe('updated');
    expect(updated.body.entity.id).toBe(id);
    expect(updated.body.entity.slug).toBe(SLUG);
    expect(updated.body.entity.name).toBe(`${NAME} Renamed`);
    expect(updated.body.entity.translations).toEqual({ ca: 'Múscul transferit' });

    const count = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM muscles WHERE slug = ?', [SLUG]);
    expect(Number(count.rows[0].n)).toBe(1);
    const links = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM exercise_muscles WHERE muscle_id = ?', [id]);
    expect(Number(links.rows[0].n)).toBe(1);
  });

  it('refuses a record with an unusable slug or no name, and an image for an unknown slug', async () => {
    expect((await request.post('/platform/transfer/muscles').set(H).send({ slug: 'Bad Slug', name: 'X' })).status).toBe(400);
    expect((await request.post('/platform/transfer/muscles').set(H).send({ slug: `${SLUG}_x` })).status).toBe(400);
    const img = await request.post(`/platform/transfer/muscles/transfer_test_missing/image/male`).set(H)
      .set('Content-Type', 'image/png').send(Buffer.from([1, 2, 3]));
    expect(img.status).toBe(404);
    const slot = await request.post(`/platform/transfer/muscles/${SLUG}/image/other`).set(H)
      .set('Content-Type', 'image/png').send(Buffer.from([1, 2, 3]));
    expect(slot.status).toBe(400);
  });

  it('reads back only platform objects', async () => {
    const res = await request.get('/platform/transfer/object').query({ url: 'https://example.com/gyms/x/members/a.webp' }).set(H);
    expect(res.status).toBe(404);
  });
});
