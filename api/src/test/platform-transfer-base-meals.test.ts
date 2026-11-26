// #3433: Cordel → Export / Import of Base Meals.

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
const STAMP = Date.now();
const SLUG = `transfer-meal-${STAMP}`;
const SNAKE_SLUG = `transfer_meal_${STAMP}`;
let gymId: string;

beforeAll(async () => {
  gymId = await createTestGym('Transfer Base Meals Gym');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  const { rows } = await db.query<{ id: number }>("SELECT id FROM base_meals WHERE slug LIKE 'transfer%'");
  for (const { id } of rows) {
    await db.query('DELETE FROM base_meal_translations WHERE base_meal_id = ?', [id]).catch(() => undefined);
    await db.query('DELETE FROM base_meals WHERE id = ?', [id]);
  }
  await cleanupTestGyms();
  await db.end();
});

describe('Export / Import of Base Meals (#3433)', () => {
  it('lists Base Meals among the transferable types', async () => {
    const res = await request.get('/platform/transfer/types').set(H);
    expect(res.status).toBe(200);
    expect(res.body.types).toContain('base_meals');
  });

  it('refuses a caller who is not a superadmin', async () => {
    platformRole.value = undefined;
    try {
      expect((await request.get('/platform/transfer/base_meals').set(H).set('x-gym-id', gymId)).status).toBe(403);
      expect((await request.post('/platform/transfer/base_meals').set(H).set('x-gym-id', gymId)
        .send({ slug: SLUG, name: 'X' })).status).toBe(403);
    } finally {
      platformRole.value = 'superadmin';
    }
  });

  it('creates a Base Meal under the archive slug, ignoring what is not its own content', async () => {
    const created = await request.post('/platform/transfer/base_meals').set(H)
      .send({
        slug: SLUG, name: `Transfer Meal ${STAMP}`, description: 'One', status: 'inactive',
        translations: { es: { name: `Comida ${STAMP}`, description: 'Uno' } },
        id: 999999999, position: 1, image_url: 'https://evil.example/x.webp',
      });
    expect(created.status).toBe(201);
    expect(created.body.action).toBe('created');
    const e = created.body.entity;
    expect(e.slug).toBe(SLUG);
    expect(e.id).not.toBe(999999999);
    expect(e.status).toBe('inactive');
    expect(e.image_url).toBeNull();
    expect(e.translations.es.name).toBe(`Comida ${STAMP}`);
  });

  it('accepts a seeded meal\'s snake_case slug', async () => {
    const created = await request.post('/platform/transfer/base_meals').set(H)
      .send({ slug: SNAKE_SLUG, name: `Transfer Snake Meal ${STAMP}` });
    expect(created.status).toBe(201);
    expect(created.body.entity.slug).toBe(SNAKE_SLUG);
    expect(created.body.entity.status).toBe('active');
  });

  it('exports each meal as its slug, its own fields and its image slot', async () => {
    const res = await request.get('/platform/transfer/base_meals').set(H);
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('base_meals');
    const m = res.body.entities.find((x: any) => x.slug === SLUG);
    expect(Object.keys(m.data).sort()).toEqual(['description', 'name', 'status', 'translations']);
    expect(m.data).toEqual({
      name: `Transfer Meal ${STAMP}`, description: 'One', status: 'inactive',
      translations: { es: { name: `Comida ${STAMP}`, description: 'Uno' } },
    });
    expect(m.images).toEqual({ image: null });
  });

  it('updates the meal in place, keeping its identity, without duplicating it', async () => {
    const { rows } = await db.query<{ id: number }>('SELECT id FROM base_meals WHERE slug = ?', [SLUG]);
    const id = rows[0].id;
    const updated = await request.post('/platform/transfer/base_meals').set(H)
      .send({
        slug: SLUG, name: `Transfer Meal ${STAMP} Renamed`, description: 'Two', status: 'active',
        translations: { ca: { name: `Àpat ${STAMP}`, description: null } },
      });
    expect(updated.status).toBe(200);
    expect(updated.body.action).toBe('updated');
    expect(updated.body.entity.id).toBe(id);
    expect(updated.body.entity.slug).toBe(SLUG);
    expect(updated.body.entity.name).toBe(`Transfer Meal ${STAMP} Renamed`);
    expect(updated.body.entity.status).toBe('active');
    expect(updated.body.entity.translations).toEqual({ ca: { name: `Àpat ${STAMP}`, description: null } });
    const count = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM base_meals WHERE slug = ?', [SLUG]);
    expect(Number(count.rows[0].n)).toBe(1);
  });

  it('keeps the editor\'s rules: an unknown status and a duplicate name are refused', async () => {
    expect((await request.post('/platform/transfer/base_meals').set(H)
      .send({ slug: SLUG, status: 'archived' })).status).toBe(400);
    const dup = await request.post('/platform/transfer/base_meals').set(H)
      .send({ slug: `transfer-meal-dup-${STAMP}`, name: `Transfer Meal ${STAMP} Renamed` });
    expect(dup.status).toBe(409);
  });

  it('refuses a malformed slug, an image for an unknown slug or slot, and a soft-deleted slug', async () => {
    expect((await request.post('/platform/transfer/base_meals').set(H)
      .send({ slug: 'Bad Slug', name: 'X' })).status).toBe(400);
    const unknown = await request.post('/platform/transfer/base_meals/transfer-missing/image/image').set(H)
      .set('Content-Type', 'image/png').send(Buffer.from([1, 2, 3]));
    expect(unknown.status).toBe(404);
    const slot = await request.post(`/platform/transfer/base_meals/${SLUG}/image/other`).set(H)
      .set('Content-Type', 'image/png').send(Buffer.from([1, 2, 3]));
    expect(slot.status).toBe(400);

    await db.query('UPDATE base_meals SET deleted_at = UTC_TIMESTAMP() WHERE slug = ?', [SNAKE_SLUG]);
    const res = await request.post('/platform/transfer/base_meals').set(H)
      .send({ slug: SNAKE_SLUG, name: 'Resurrected' });
    expect(res.status).toBe(409);
  });
});
