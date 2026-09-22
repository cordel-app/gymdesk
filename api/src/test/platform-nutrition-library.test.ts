// Tests for platform-nutrition-library.ts router

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, request } from './helpers';

// Override the default @clerk/backend mock: make test-user-id a superadmin.
const mockGetUser = vi.hoisted(() =>
  vi.fn().mockImplementation(async () => ({
    publicMetadata: { platform_role: 'superadmin' },
    fullName: 'Super Admin',
    firstName: 'Super',
    lastName: 'Admin',
  })),
);

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: {
        getUser: mockGetUser,
        getUserList: vi.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      },
      invitations: {
        createInvitation: vi.fn().mockResolvedValue({ id: 'inv-test-id' }),
        revokeInvitation: vi.fn().mockResolvedValue({}),
      },
      emailAddresses: {
        getEmailAddress: vi.fn().mockResolvedValue({ emailAddress: 'test@example.com' }),
      },
    })),
  };
});

// Track items created via the API (gym_id IS NULL) — cleanupTestGyms won't touch them.
const createdItemIds: number[] = [];

let mainDishId: number;
let sideId: number;
let sauceId: number;
let drinkId: number;
let dessertId: number;

async function getCategoryId(slug: string): Promise<number> {
  const { rows } = await db.query<{ id: number }>('SELECT id FROM nutrition_library_categories WHERE slug = ?', [slug]);
  return rows[0]?.id;
}

beforeAll(async () => {
  mainDishId = await getCategoryId('main_dish');
  sideId = await getCategoryId('side');
  sauceId = await getCategoryId('sauce');
  drinkId = await getCategoryId('drink');
  dessertId = await getCategoryId('dessert');
});

afterAll(async () => {
  await cleanupTestGyms();
  if (createdItemIds.length > 0) {
    const marks = createdItemIds.map(() => '?').join(',');
    await db.query(
      `DELETE FROM nutrition_library_items WHERE id IN (${marks})`,
      createdItemIds,
    );
  }
  await db.end();
});

// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------

describe('auth guard', () => {
  it('returns 401 without auth on GET /platform/nutrition-library', async () => {
    const res = await request.get('/platform/nutrition-library');
    expect(res.status).toBe(401);
  });

  it('returns 401 without auth on POST /platform/nutrition-library', async () => {
    const res = await request
      .post('/platform/nutrition-library')
      .send({ name: 'X', category_ids: [1] });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Superadmin guard
// ---------------------------------------------------------------------------

describe('superadmin guard', () => {
  it('returns 403 when user is not a superadmin', async () => {
    mockGetUser.mockResolvedValueOnce({
      publicMetadata: {},
      fullName: 'Regular User',
      firstName: 'Regular',
      lastName: 'User',
    });
    const res = await request
      .get('/platform/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Happy path — CRUD
// ---------------------------------------------------------------------------

describe('platform nutrition library CRUD', () => {
  let itemId: number;
  const uniqueSuffix = `${Date.now()}`;

  it('creates a library item and returns 201', async () => {
    const res = await request
      .post('/platform/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `PNL Chicken ${uniqueSuffix}`, category_ids: [mainDishId] });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe(`PNL Chicken ${uniqueSuffix}`);
    expect(res.body.categories.map((c: any) => c.id)).toEqual([mainDishId]);
    expect(res.body.status).toBe('active');
    itemId = res.body.id;
    createdItemIds.push(itemId);
  });

  it('lists library items and excludes deleted ones by default', async () => {
    const res = await request
      .get('/platform/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe('number');
    const found = res.body.items.find((i: any) => i.id === itemId);
    expect(found).toBeDefined();
    for (const item of res.body.items) {
      expect(item.status).not.toBe('deleted');
    }
  });

  it('filters by ?search= (case-insensitive partial match)', async () => {
    const res = await request
      .get(`/platform/nutrition-library?search=${encodeURIComponent(`chicken ${uniqueSuffix}`.toLowerCase())}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    const found = res.body.items.find((i: any) => i.id === itemId);
    expect(found).toBeDefined();
  });

  it('filters by ?category_id= and returns only matching items', async () => {
    const res = await request
      .get(`/platform/nutrition-library?category_id=${mainDishId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    for (const item of res.body.items) {
      expect(item.categories.some((c: any) => c.id === mainDishId)).toBe(true);
    }
    const found = res.body.items.find((i: any) => i.id === itemId);
    expect(found).toBeDefined();
  });

  it('paginates with ?limit= and ?offset=', async () => {
    const res = await request
      .get('/platform/nutrition-library?limit=1&offset=0')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeLessThanOrEqual(1);
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(0);
    expect(res.body.total).toBeGreaterThan(0);
  });

  it('updates the item name and returns 200', async () => {
    const res = await request
      .put(`/platform/nutrition-library/${itemId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `PNL Chicken Updated ${uniqueSuffix}` });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(`PNL Chicken Updated ${uniqueSuffix}`);
    expect(res.body.categories.map((c: any) => c.id)).toEqual([mainDishId]);
  });

  it('replaces categories and returns 200', async () => {
    const res = await request
      .put(`/platform/nutrition-library/${itemId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ category_ids: [sideId] });
    expect(res.status).toBe(200);
    expect(res.body.categories.map((c: any) => c.id)).toEqual([sideId]);
  });

  it('assigns multiple categories to the same item (e.g. peas: main dish + side)', async () => {
    const res = await request
      .put(`/platform/nutrition-library/${itemId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ category_ids: [mainDishId, sideId] });
    expect(res.status).toBe(200);
    expect(res.body.categories.map((c: any) => c.id).sort()).toEqual([mainDishId, sideId].sort());
  });

  it('soft-deletes the item and hides it from the default list', async () => {
    const delRes = await request
      .delete(`/platform/nutrition-library/${itemId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(delRes.status).toBe(204);

    const listRes = await request
      .get('/platform/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(listRes.status).toBe(200);
    const found = listRes.body.items.find((i: any) => i.id === itemId);
    expect(found).toBeUndefined();
  });

  it('shows deleted item when ?status=deleted', async () => {
    const res = await request
      .get('/platform/nutrition-library?status=deleted')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    const found = res.body.items.find((i: any) => i.id === itemId);
    expect(found).toBeDefined();
    expect(found.status).toBe('deleted');
  });

  it('returns 409 when deleting an already-deleted item', async () => {
    const res = await request
      .delete(`/platform/nutrition-library/${itemId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(409);
  });

  it('returns 409 when updating a deleted item', async () => {
    const res = await request
      .put(`/platform/nutrition-library/${itemId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: 'Ghost Update' });
    expect(res.status).toBe(409);
  });

  it('returns 404 when updating a non-existent item', async () => {
    const res = await request
      .put('/platform/nutrition-library/999999')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: 'Ghost' });
    expect(res.status).toBe(404);
  });

  it('returns 404 when deleting a non-existent item', async () => {
    const res = await request
      .delete('/platform/nutrition-library/999999')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('platform nutrition library validation', () => {
  it('returns 400 when creating without a name', async () => {
    const res = await request
      .post('/platform/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ category_ids: [mainDishId] });
    expect(res.status).toBe(400);
  });

  it('returns 400 when creating without any category', async () => {
    const res = await request
      .post('/platform/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `PNL No Category ${Date.now()}`, category_ids: [] });
    expect(res.status).toBe(400);
  });

  it('returns 400 when creating with an invalid category id', async () => {
    const res = await request
      .post('/platform/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `PNL Bad Category ${Date.now()}`, category_ids: [999999] });
    expect(res.status).toBe(400);
  });

  it('returns 400 when listing with a non-numeric ?category_id value', async () => {
    const res = await request
      .get('/platform/nutrition-library?category_id=invalid')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(400);
  });

  it('returns 400 when updating with an invalid category id', async () => {
    // Create a valid item first
    const createRes = await request
      .post('/platform/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `PNL Valid For BadUpdate ${Date.now()}`, category_ids: [drinkId] });
    expect(createRes.status).toBe(201);
    createdItemIds.push(createRes.body.id);

    const res = await request
      .put(`/platform/nutrition-library/${createRes.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ category_ids: [999999] });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Duplicate — uniqueness is now scoped to (gym, name) only, not category
// ---------------------------------------------------------------------------

describe('platform nutrition library duplicate', () => {
  it('returns 409 when creating an item with the same name, regardless of category', async () => {
    const uniqueName = `PNL Dup Item ${Date.now()}`;

    const first = await request
      .post('/platform/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: uniqueName, category_ids: [drinkId] });
    expect(first.status).toBe(201);
    createdItemIds.push(first.body.id);

    const second = await request
      .post('/platform/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: uniqueName, category_ids: [dessertId] });
    expect(second.status).toBe(409);
  });

  it('allows a different name with the same categories', async () => {
    const first = await request
      .post('/platform/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `PNL Sauce A ${Date.now()}`, category_ids: [sauceId] });
    expect(first.status).toBe(201);
    createdItemIds.push(first.body.id);

    const second = await request
      .post('/platform/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `PNL Sauce B ${Date.now()}`, category_ids: [sauceId] });
    expect(second.status).toBe(201);
    createdItemIds.push(second.body.id);
  });
});

// ---------------------------------------------------------------------------
// Categories catalogue
// ---------------------------------------------------------------------------

describe('GET /platform/nutrition-library/categories', () => {
  it('returns the seeded categories', async () => {
    const res = await request
      .get('/platform/nutrition-library/categories')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const slugs = res.body.map((c: any) => c.slug);
    expect(slugs).toEqual(expect.arrayContaining(['main_dish', 'side', 'sauce', 'drink', 'dessert', 'other']));
  });

  it('returns 401 without auth', async () => {
    const res = await request.get('/platform/nutrition-library/categories');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Categories assignment (multi-category, e.g. peas = main_dish + side)
// ---------------------------------------------------------------------------

describe('categories assignment', () => {
  let itemId: number;
  const suffix = `${Date.now()}-cat`;

  beforeAll(async () => {
    const createRes = await request
      .post('/platform/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `Peas ${suffix}`, category_ids: [mainDishId] });
    expect(createRes.status).toBe(201);
    itemId = createRes.body.id;
    createdItemIds.push(itemId);
  });

  it('PUT /:id/categories assigns multiple categories and returns them', async () => {
    const res = await request
      .put(`/platform/nutrition-library/${itemId}/categories`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ category_ids: [mainDishId, sideId] });
    expect(res.status).toBe(200);
    expect(res.body.categories).toHaveLength(2);
    const ids = res.body.categories.map((c: any) => c.id).sort();
    expect(ids).toEqual([mainDishId, sideId].sort());
  });

  it('GET /platform/nutrition-library includes all assigned categories per item', async () => {
    const res = await request
      .get('/platform/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    const found = res.body.items.find((i: any) => i.id === itemId);
    expect(found).toBeDefined();
    expect(found.categories).toHaveLength(2);
  });

  it('PUT /:id/categories replaces (not appends) on second call', async () => {
    const res = await request
      .put(`/platform/nutrition-library/${itemId}/categories`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ category_ids: [sideId] });
    expect(res.status).toBe(200);
    expect(res.body.categories).toHaveLength(1);
    expect(res.body.categories[0].id).toBe(sideId);
  });

  it('PUT /:id/categories returns 400 for an empty array (at least one category required)', async () => {
    const res = await request
      .put(`/platform/nutrition-library/${itemId}/categories`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ category_ids: [] });
    expect(res.status).toBe(400);
  });

  it('PUT /:id/categories returns 400 for invalid category_ids', async () => {
    const res = await request
      .put(`/platform/nutrition-library/${itemId}/categories`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ category_ids: [99999] });
    expect(res.status).toBe(400);
  });

  it('PUT /:id/categories returns 400 when category_ids is not an array', async () => {
    const res = await request
      .put(`/platform/nutrition-library/${itemId}/categories`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ category_ids: mainDishId });
    expect(res.status).toBe(400);
  });

  it('PUT /:id/categories returns 404 for unknown item', async () => {
    const res = await request
      .put('/platform/nutrition-library/999999/categories')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ category_ids: [mainDishId] });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Nutritional Qualities catalogue
// ---------------------------------------------------------------------------

describe('GET /platform/nutrition-library/nutritional-qualities', () => {
  it('returns the seeded qualities, including fat and fiber', async () => {
    const res = await request
      .get('/platform/nutrition-library/nutritional-qualities')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const slugs = res.body.map((q: any) => q.slug);
    expect(slugs).toEqual(expect.arrayContaining(['protein', 'carbohydrate', 'fat', 'fiber']));
  });

  it('returns 401 without auth', async () => {
    const res = await request.get('/platform/nutrition-library/nutritional-qualities');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Nutritional Qualities assignment
// ---------------------------------------------------------------------------

describe('nutritional qualities assignment', () => {
  let itemId: number;
  let proteinId: number;
  let carbId: number;
  let fatId: number;
  let fiberId: number;
  const suffix = `${Date.now()}-nq`;

  beforeAll(async () => {
    // Create a fresh item for quality tests
    const createRes = await request
      .post('/platform/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `NQ Lentils ${suffix}`, category_ids: [mainDishId] });
    expect(createRes.status).toBe(201);
    itemId = createRes.body.id;
    createdItemIds.push(itemId);

    // Resolve quality IDs from the catalogue
    const qualRes = await request
      .get('/platform/nutrition-library/nutritional-qualities')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(qualRes.status).toBe(200);
    proteinId = qualRes.body.find((q: any) => q.slug === 'protein').id;
    carbId    = qualRes.body.find((q: any) => q.slug === 'carbohydrate').id;
    fatId     = qualRes.body.find((q: any) => q.slug === 'fat').id;
    fiberId   = qualRes.body.find((q: any) => q.slug === 'fiber').id;
  });

  it('POST with quality_ids returns item with qualities', async () => {
    const res = await request
      .post('/platform/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `NQ Chicken ${suffix}`, category_ids: [mainDishId], quality_ids: [proteinId] });
    expect(res.status).toBe(201);
    expect(res.body.qualities).toHaveLength(1);
    expect(res.body.qualities[0].slug).toBe('protein');
    createdItemIds.push(res.body.id);
  });

  it('POST with fat and fiber quality_ids returns them', async () => {
    const res = await request
      .post('/platform/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `NQ Avocado ${suffix}`, category_ids: [sideId], quality_ids: [fatId, fiberId] });
    expect(res.status).toBe(201);
    const slugs = res.body.qualities.map((q: any) => q.slug).sort();
    expect(slugs).toEqual(['fat', 'fiber']);
    createdItemIds.push(res.body.id);
  });

  it('PUT /:id/qualities assigns qualities and returns them', async () => {
    const res = await request
      .put(`/platform/nutrition-library/${itemId}/qualities`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ quality_ids: [proteinId, carbId] });
    expect(res.status).toBe(200);
    expect(res.body.qualities).toHaveLength(2);
    const slugs = res.body.qualities.map((q: any) => q.slug).sort();
    expect(slugs).toEqual(['carbohydrate', 'protein']);
  });

  it('GET /platform/nutrition-library includes qualities per item', async () => {
    const res = await request
      .get('/platform/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    const found = res.body.items.find((i: any) => i.id === itemId);
    expect(found).toBeDefined();
    expect(Array.isArray(found.qualities)).toBe(true);
    expect(found.qualities).toHaveLength(2);
  });

  it('filters by ?quality_id= (AND semantics across multiple values)', async () => {
    const res = await request
      .get(`/platform/nutrition-library?quality_id=${proteinId}&quality_id=${carbId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    const found = res.body.items.find((i: any) => i.id === itemId);
    expect(found).toBeDefined();

    const onlyProtein = await request
      .get(`/platform/nutrition-library?quality_id=${proteinId}&quality_id=${carbId}&search=${encodeURIComponent(`Chicken ${suffix}`)}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(onlyProtein.status).toBe(200);
    // The "NQ Chicken" item only has 'protein' assigned, so requiring both must exclude it.
    expect(onlyProtein.body.items.find((i: any) => i.name === `NQ Chicken ${suffix}`)).toBeUndefined();
  });

  it('PUT /:id/qualities replaces (not appends) on second call', async () => {
    // Assign only protein
    const res = await request
      .put(`/platform/nutrition-library/${itemId}/qualities`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ quality_ids: [proteinId] });
    expect(res.status).toBe(200);
    expect(res.body.qualities).toHaveLength(1);
    expect(res.body.qualities[0].slug).toBe('protein');
  });

  it('PUT /:id/qualities with empty array removes all qualities', async () => {
    const res = await request
      .put(`/platform/nutrition-library/${itemId}/qualities`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ quality_ids: [] });
    expect(res.status).toBe(200);
    expect(res.body.qualities).toHaveLength(0);
  });

  it('PUT /:id/qualities returns 400 for invalid quality_ids', async () => {
    const res = await request
      .put(`/platform/nutrition-library/${itemId}/qualities`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ quality_ids: [99999] });
    expect(res.status).toBe(400);
  });

  it('PUT /:id/qualities returns 400 when quality_ids is not an array', async () => {
    const res = await request
      .put(`/platform/nutrition-library/${itemId}/qualities`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ quality_ids: proteinId });
    expect(res.status).toBe(400);
  });

  it('PUT /:id/qualities returns 404 for unknown item', async () => {
    const res = await request
      .put('/platform/nutrition-library/999999/qualities')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ quality_ids: [proteinId] });
    expect(res.status).toBe(404);
  });

  it('PUT update with quality_ids replaces qualities', async () => {
    const res = await request
      .put(`/platform/nutrition-library/${itemId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `NQ Lentils Updated ${suffix}`, quality_ids: [carbId] });
    expect(res.status).toBe(200);
    expect(res.body.qualities).toHaveLength(1);
    expect(res.body.qualities[0].slug).toBe('carbohydrate');
  });
});

// ---------------------------------------------------------------------------
// Translations (#643)
// ---------------------------------------------------------------------------

describe('translations', () => {
  const suffix = `${Date.now()}-i18n`;
  let itemId: number;

  it('GET /locales lists the configured locales and which need translating', async () => {
    const res = await request
      .get('/platform/nutrition-library/locales')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.locales).toContain('en');
    expect(res.body.base_locale).toBe('en');
    expect(res.body.translatable).not.toContain(res.body.base_locale);
  });

  it('POST stores translations alongside the base name', async () => {
    const res = await request
      .post('/platform/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({
        name: `Lentils ${suffix}`,
        category_ids: [mainDishId],
        translations: { es: `Lentejas ${suffix}`, ca: `Llenties ${suffix}` },
      });
    expect(res.status).toBe(201);
    itemId = res.body.id;
    createdItemIds.push(itemId);
    expect(res.body.name).toBe(`Lentils ${suffix}`);
    expect(res.body.translations).toEqual({ es: `Lentejas ${suffix}`, ca: `Llenties ${suffix}` });
  });

  it('resolves display_name from the x-locale header, leaving name as the base value', async () => {
    const res = await request
      .get(`/platform/nutrition-library?search=${suffix}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-locale', 'ca');
    expect(res.status).toBe(200);
    const item = res.body.items.find((i: any) => i.id === itemId);
    expect(item.display_name).toBe(`Llenties ${suffix}`);
    expect(item.name).toBe(`Lentils ${suffix}`);
  });

  it('falls back to the base name when the locale has no translation', async () => {
    const created = await request
      .post('/platform/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `Untranslated ${suffix}`, category_ids: [sideId], translations: { es: `Sin catalán ${suffix}` } });
    expect(created.status).toBe(201);
    createdItemIds.push(created.body.id);

    const res = await request
      .get(`/platform/nutrition-library?search=Untranslated ${suffix}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-locale', 'ca');
    const item = res.body.items.find((i: any) => i.id === created.body.id);
    expect(item.display_name).toBe(`Untranslated ${suffix}`);
  });

  it('serves the base name when no locale is requested', async () => {
    const res = await request
      .get(`/platform/nutrition-library?search=${suffix}`)
      .set('Authorization', TEST_AUTH_HEADER);
    const item = res.body.items.find((i: any) => i.id === itemId);
    expect(item.display_name).toBe(`Lentils ${suffix}`);
  });

  it('search matches the translated name shown in that locale', async () => {
    const res = await request
      .get(`/platform/nutrition-library?search=Llenties ${suffix}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-locale', 'ca');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.id)).toContain(itemId);
  });

  it('PUT /:id replaces the full translation set', async () => {
    const res = await request
      .put(`/platform/nutrition-library/${itemId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `Lentils ${suffix}`, translations: { es: `Lentejas editadas ${suffix}` } });
    expect(res.status).toBe(200);
    // ca was omitted, so it is cleared and falls back to the base name again.
    expect(res.body.translations).toEqual({ es: `Lentejas editadas ${suffix}` });
  });

  it('PUT /:id/translations updates them without touching the rest of the item', async () => {
    const res = await request
      .put(`/platform/nutrition-library/${itemId}/translations`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ translations: { es: `Lentejas ${suffix}`, ca: `Llenties ${suffix}` } });
    expect(res.status).toBe(200);
    expect(res.body.item_id).toBe(itemId);
    expect(res.body.translations).toEqual({ es: `Lentejas ${suffix}`, ca: `Llenties ${suffix}` });

    const after = await request
      .get(`/platform/nutrition-library?search=${suffix}`)
      .set('Authorization', TEST_AUTH_HEADER);
    const item = after.body.items.find((i: any) => i.id === itemId);
    expect(item.categories).toHaveLength(1);
  });

  it('rejects an unsupported locale', async () => {
    const res = await request
      .put(`/platform/nutrition-library/${itemId}/translations`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ translations: { de: 'Linsen' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('de');
  });

  it('rejects the base locale — that is the name column', async () => {
    const res = await request
      .put(`/platform/nutrition-library/${itemId}/translations`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ translations: { en: 'Lentils' } });
    expect(res.status).toBe(400);
  });

  it('PUT /:id/translations returns 404 for an unknown item', async () => {
    const res = await request
      .put('/platform/nutrition-library/999999/translations')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ translations: { es: 'Lentejas' } });
    expect(res.status).toBe(404);
  });

  it('requires superadmin', async () => {
    mockGetUser.mockResolvedValueOnce({
      publicMetadata: {}, fullName: 'Regular User', firstName: 'Regular', lastName: 'User',
    });
    const res = await request
      .put(`/platform/nutrition-library/${itemId}/translations`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ translations: { es: 'Lentejas' } });
    expect(res.status).toBe(403);
  });

  it('returns 401 without auth', async () => {
    const res = await request
      .put(`/platform/nutrition-library/${itemId}/translations`)
      .send({ translations: { es: 'Lentejas' } });
    expect(res.status).toBe(401);
  });

  it('seeded system items resolve to their Spanish and Catalan names', async () => {
    for (const [locale, expected] of [['es', 'Pollo'], ['ca', 'Pollastre']] as const) {
      const res = await request
        .get('/platform/nutrition-library?search=Chicken')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-locale', locale);
      expect(res.status).toBe(200);
      const chicken = res.body.items.find((i: any) => i.name === 'Chicken');
      expect(chicken?.display_name).toBe(expected);
    }
  });

  // The acceptance criterion is that nothing renders untranslated *or blank*.
  // A food whose name is the same in all three languages (Tofu, Pasta, Quinoa)
  // is deliberately left without a row so a later rename of the base item still
  // propagates — so assert the resolved name, not the presence of a row.
  it('no system item resolves to an empty name in any supported locale', async () => {
    for (const locale of ['es', 'ca']) {
      const { rows } = await db.query<{ blank: number }>(`
        SELECT COUNT(*) AS blank
        FROM nutrition_library_items nli
        WHERE nli.gym_id IS NULL
          AND nli.status != 'deleted'
          AND COALESCE(
                (SELECT t.name FROM nutrition_library_item_translations t
                 WHERE t.item_id = nli.id AND t.locale = ?),
                nli.name
              ) IS NULL
      `, [locale]);
      expect(rows[0].blank).toBe(0);
    }
  });

  it('accepts a locale key in any case', async () => {
    const res = await request
      .put(`/platform/nutrition-library/${itemId}/translations`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ translations: { ES: `Lentejas mayúsculas ${suffix}` } });
    expect(res.status).toBe(200);
    expect(res.body.translations.es).toBe(`Lentejas mayúsculas ${suffix}`);
  });

  it('keeps created_at and stamps modified_at when a translation is edited', async () => {
    await request
      .put(`/platform/nutrition-library/${itemId}/translations`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ translations: { es: `Lentejas v1 ${suffix}` } });
    const { rows: first } = await db.query<{ created_at: string; modified_at: string | null }>(
      "SELECT created_at, modified_at FROM nutrition_library_item_translations WHERE item_id = ? AND locale = 'es'",
      [itemId],
    );

    await request
      .put(`/platform/nutrition-library/${itemId}/translations`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ translations: { es: `Lentejas v2 ${suffix}` } });
    const { rows: second } = await db.query<{ created_at: string; modified_at: string | null }>(
      "SELECT created_at, modified_at FROM nutrition_library_item_translations WHERE item_id = ? AND locale = 'es'",
      [itemId],
    );
    expect(new Date(second[0].created_at).getTime()).toBe(new Date(first[0].created_at).getTime());
    expect(second[0].modified_at).not.toBeNull();
  });
});
