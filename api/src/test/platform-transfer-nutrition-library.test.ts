// #2952 stage 5: Cordel → Export / Import of the Base Nutrition Library.

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
const SLUG = `transfer-food-${STAMP}`;
let gymId: string;

const ids = async (table: string, slugs: string[]) => {
  const { rows } = await db.query<{ id: number; slug: string }>(
    `SELECT id, slug FROM ${table} WHERE slug IN (${slugs.map(() => '?').join(',')})`, slugs,
  );
  return slugs.map((s) => rows.find((r) => r.slug === s)!.id);
};

beforeAll(async () => {
  gymId = await createTestGym('Transfer Foods Gym');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  const { rows } = await db.query<{ id: number }>("SELECT id FROM base_nutrition_library_items WHERE slug LIKE 'transfer-food%'");
  for (const { id } of rows) {
    for (const t of ['categories', 'qualities', 'translations', 'description_translations']) {
      await db.query(`DELETE FROM base_nutrition_library_item_${t} WHERE item_id = ?`, [id]).catch(() => undefined);
    }
    await db.query('DELETE FROM base_nutrition_library_items WHERE id = ?', [id]);
  }
  await cleanupTestGyms();
  await db.end();
});

describe('Export / Import of the Base Nutrition Library (#2952 stage 5)', () => {
  it('refuses a caller who is not a superadmin', async () => {
    platformRole.value = undefined;
    try {
      expect((await request.get('/platform/transfer/base_nutrition_library').set(H).set('x-gym-id', gymId)).status).toBe(403);
      expect((await request.post('/platform/transfer/base_nutrition_library').set(H).set('x-gym-id', gymId)
        .send({ slug: SLUG, name: 'X', category_slugs: ['drink'] })).status).toBe(403);
    } finally {
      platformRole.value = 'superadmin';
    }
  });

  it('creates a food under the archive slug, resolving its categories and qualities by slug', async () => {
    const created = await request.post('/platform/transfer/base_nutrition_library').set(H)
      .send({
        slug: SLUG, name: `Transfer Food ${STAMP}`, description: 'One',
        translations: { es: `Comida ${STAMP}` },
        description_translations: { es: 'Uno' },
        category_slugs: ['drink'], quality_slugs: ['fiber', 'fat'],
        id: 999999999, gym_id: gymId,
      });
    expect(created.status).toBe(201);
    expect(created.body.action).toBe('created');
    const e = created.body.entity;
    expect(e.slug).toBe(SLUG);
    expect(e.id).not.toBe(999999999);
    expect(e.status).toBe('active');
    expect(e.translations.es).toBe(`Comida ${STAMP}`);
    expect(e.description_translations.es).toBe('Uno');
    expect(e.categories.map((c: any) => c.slug)).toEqual(['drink']);
    expect(e.qualities.map((q: any) => q.slug).sort()).toEqual(['fat', 'fiber']);
  });

  it('exports the food as its slug, its own fields, its lookup slugs and its image slot', async () => {
    const res = await request.get('/platform/transfer/base_nutrition_library').set(H);
    expect(res.status).toBe(200);
    const f = res.body.entities.find((x: any) => x.slug === SLUG);
    expect(Object.keys(f.data).sort()).toEqual([
      'category_slugs', 'description', 'description_translations', 'name', 'quality_slugs', 'translations',
    ]);
    expect(f.data.category_slugs).toEqual(['drink']);
    expect(f.images).toEqual({ image: null });
  });

  it('updates the content in place and leaves its categories and qualities as they were', async () => {
    const { rows } = await db.query<{ id: number }>('SELECT id FROM base_nutrition_library_items WHERE slug = ?', [SLUG]);
    const id = rows[0].id;
    const updated = await request.post('/platform/transfer/base_nutrition_library').set(H)
      .send({
        slug: SLUG, name: `Transfer Food ${STAMP} Renamed`, description: 'Two',
        translations: { ca: `Menjar ${STAMP}` }, description_translations: {},
        category_slugs: ['dessert'], quality_slugs: [],
      });
    expect(updated.status).toBe(200);
    expect(updated.body.action).toBe('updated');
    const e = updated.body.entity;
    expect(e.id).toBe(id);
    expect(e.slug).toBe(SLUG);
    expect(e.name).toBe(`Transfer Food ${STAMP} Renamed`);
    expect(e.description).toBe('Two');
    expect(e.translations).toEqual({ ca: `Menjar ${STAMP}` });
    expect(e.description_translations).toEqual({});
    expect(e.categories.map((c: any) => c.id)).toEqual(await ids('nutrition_library_categories', ['drink']));
    expect(e.qualities.map((q: any) => q.slug).sort()).toEqual(['fat', 'fiber']);
    const count = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM base_nutrition_library_items WHERE slug = ?', [SLUG]);
    expect(Number(count.rows[0].n)).toBe(1);
  });

  it('keeps the editor\'s rules: a new food needs a category, and an unknown lookup slug is refused', async () => {
    const none = await request.post('/platform/transfer/base_nutrition_library').set(H)
      .send({ slug: `transfer-food-none-${STAMP}`, name: `No Category ${STAMP}` });
    expect(none.status).toBe(400);
    const unknown = await request.post('/platform/transfer/base_nutrition_library').set(H)
      .send({ slug: `transfer-food-unknown-${STAMP}`, name: `Unknown ${STAMP}`, category_slugs: ['no-such-category'] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/no-such-category/);
  });

  it('refuses a malformed slug, an image for an unknown slug or slot, and a soft-deleted slug', async () => {
    expect((await request.post('/platform/transfer/base_nutrition_library').set(H)
      .send({ slug: 'Bad Slug', name: 'X', category_slugs: ['drink'] })).status).toBe(400);
    const unknown = await request.post('/platform/transfer/base_nutrition_library/transfer-food-missing/image/image').set(H)
      .set('Content-Type', 'image/png').send(Buffer.from([1, 2, 3]));
    expect(unknown.status).toBe(404);
    const slot = await request.post(`/platform/transfer/base_nutrition_library/${SLUG}/image/other`).set(H)
      .set('Content-Type', 'image/png').send(Buffer.from([1, 2, 3]));
    expect(slot.status).toBe(400);

    await db.query('UPDATE base_nutrition_library_items SET deleted_at = UTC_TIMESTAMP() WHERE slug = ?', [SLUG]);
    const res = await request.post('/platform/transfer/base_nutrition_library').set(H)
      .send({ slug: SLUG, name: 'Resurrected', category_slugs: ['drink'] });
    expect(res.status).toBe(409);
  });
});
