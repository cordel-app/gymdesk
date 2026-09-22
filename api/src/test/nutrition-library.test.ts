// Tests for nutrition-library.ts router

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

let gymId: string;
let accountantGymId: string;
let otherGymId: string;
let libraryItemId: number;
let mainDishId: number;
let sideId: number;
let sauceId: number;

async function getCategoryId(slug: string): Promise<number> {
  const { rows } = await db.query<{ id: number }>('SELECT id FROM nutrition_library_categories WHERE slug = ?', [slug]);
  return rows[0]?.id;
}

beforeAll(async () => {
  gymId = await createTestGym('NL Test Gym');
  await createTestMembership(gymId, 'admin');

  accountantGymId = await createTestGym('NL Accountant Gym');
  await createTestMembership(accountantGymId, 'accountant');

  // Same TEST_USER_ID as an admin of a second gym — lets the tenant-isolation
  // test pass the auth/module-access middleware and reach the router's own
  // gym_id ownership check.
  otherGymId = await createTestGym('NL Other Gym');
  await createTestMembership(otherGymId, 'admin');

  mainDishId = await getCategoryId('main_dish');
  sideId = await getCategoryId('side');
  sauceId = await getCategoryId('sauce');

  // Insert a global (system) library item — gym_id IS NULL — cleaned up manually below
  // since cleanupTestGyms only deletes rows scoped to the created test gyms.
  const { insertId } = await db.query(
    "INSERT INTO nutrition_library_items (gym_id, name, status) VALUES (NULL, 'NL Test Chicken', 'active')",
    [],
  );
  libraryItemId = insertId;
  await db.query('INSERT INTO nutrition_library_item_categories (item_id, category_id) VALUES (?, ?)', [libraryItemId, mainDishId]);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.query('DELETE FROM nutrition_library_items WHERE id = ?', [libraryItemId]);
  await db.end();
});

// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------

describe('GET /nutrition-library — auth guard', () => {
  it('returns 401 without auth', async () => {
    const res = await request.get('/nutrition-library');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Module access guard
// ---------------------------------------------------------------------------

describe('GET /nutrition-library — module access', () => {
  it('returns 403 for accountant role (NONE permission on NUTRITION)', async () => {
    const res = await request
      .get('/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', accountantGymId);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Categories / nutritional qualities catalogues
// ---------------------------------------------------------------------------

describe('GET /nutrition-library/categories', () => {
  it('returns the global category catalogue', async () => {
    const res = await request
      .get('/nutrition-library/categories')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.some((c: any) => c.slug === 'main_dish')).toBe(true);
    expect(res.body.some((c: any) => c.slug === 'side')).toBe(true);
  });
});

describe('GET /nutrition-library/nutritional-qualities', () => {
  it('includes fat and fiber alongside protein and carbohydrate', async () => {
    const res = await request
      .get('/nutrition-library/nutritional-qualities')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const slugs = res.body.map((q: any) => q.slug);
    expect(slugs).toEqual(expect.arrayContaining(['protein', 'carbohydrate', 'fat', 'fiber']));
  });
});

// ---------------------------------------------------------------------------
// Happy path — list, search, filter, pagination
// ---------------------------------------------------------------------------

describe('GET /nutrition-library — happy path', () => {
  it('returns paginated items including system (gym_id null) items, with categories', async () => {
    const res = await request
      .get('/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe('number');
    const item = res.body.items.find((i: any) => i.id === libraryItemId);
    expect(item).toBeDefined();
    expect(item.name).toBe('NL Test Chicken');
    expect(item.categories.map((c: any) => c.slug)).toEqual(['main_dish']);
    expect(item.gym_id).toBeNull();
  });

  it('filters by ?category_id= and returns only items with that category', async () => {
    const res = await request
      .get(`/nutrition-library?category_id=${mainDishId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    for (const item of res.body.items) {
      expect(item.categories.some((c: any) => c.id === mainDishId)).toBe(true);
    }
    const item = res.body.items.find((i: any) => i.id === libraryItemId);
    expect(item).toBeDefined();
  });

  it('filters by ?search= (case-insensitive partial match)', async () => {
    const res = await request
      .get('/nutrition-library?search=test chicken')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const item = res.body.items.find((i: any) => i.id === libraryItemId);
    expect(item).toBeDefined();
  });

  it('returns 400 for an invalid ?category_id value', async () => {
    const res = await request
      .get('/nutrition-library?category_id=not-a-number')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Create / Edit — gym-owned items only
// ---------------------------------------------------------------------------

describe('POST /nutrition-library — gym-owned items', () => {
  it('returns 401 without auth', async () => {
    const res = await request.post('/nutrition-library').send({ name: 'X', category_ids: [mainDishId] });
    expect(res.status).toBe(401);
  });

  it('returns 403 for accountant role (no NUTRITION access at all)', async () => {
    const res = await request
      .post('/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', accountantGymId)
      .send({ name: 'Accountant Item', category_ids: [mainDishId] });
    expect(res.status).toBe(403);
  });

  it('creates a gym-owned item with a single category and returns 201', async () => {
    const res = await request
      .post('/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `Gym Item ${Date.now()}`, category_ids: [sideId] });
    expect(res.status).toBe(201);
    expect(res.body.categories.map((c: any) => c.id)).toEqual([sideId]);
    expect(res.body.gym_id).toBe(gymId);
    expect(res.body.image_url).toBeNull();
  });

  it('creates a gym-owned item with multiple categories (e.g. peas: main dish + side)', async () => {
    const res = await request
      .post('/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `Peas ${Date.now()}`, category_ids: [mainDishId, sideId] });
    expect(res.status).toBe(201);
    const ids = res.body.categories.map((c: any) => c.id).sort();
    expect(ids).toEqual([mainDishId, sideId].sort());
  });

  it('creates a gym-owned item with an image_url and returns it', async () => {
    const res = await request
      .post('/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `Gym Item With Image ${Date.now()}`, category_ids: [sideId], image_url: 'https://r2.example/img.png' });
    expect(res.status).toBe(201);
    expect(res.body.image_url).toBe('https://r2.example/img.png');
  });

  it('creates a gym-owned item with nutritional qualities and returns them', async () => {
    const { rows } = await db.query<{ id: number }>("SELECT id FROM nutritional_qualities WHERE slug IN ('fat', 'fiber')");
    const qualityIds = rows.map((r) => r.id);
    const res = await request
      .post('/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `High Fiber Item ${Date.now()}`, category_ids: [sideId], quality_ids: qualityIds });
    expect(res.status).toBe(201);
    expect(res.body.qualities.map((q: any) => q.id).sort()).toEqual(qualityIds.sort());
  });

  it('returns 400 when creating without a name', async () => {
    const res = await request
      .post('/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ category_ids: [mainDishId] });
    expect(res.status).toBe(400);
  });

  it('returns 400 when creating without any category', async () => {
    const res = await request
      .post('/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `No Category ${Date.now()}`, category_ids: [] });
    expect(res.status).toBe(400);
  });

  it('returns 400 when creating with an invalid category id', async () => {
    const res = await request
      .post('/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `Bad Category ${Date.now()}`, category_ids: [999999] });
    expect(res.status).toBe(400);
  });

  it('returns 409 when creating an item with a name that already exists for this gym', async () => {
    const name = `Duplicate Name ${Date.now()}`;
    const first = await request
      .post('/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name, category_ids: [mainDishId] });
    expect(first.status).toBe(201);

    const second = await request
      .post('/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name, category_ids: [sideId] });
    expect(second.status).toBe(409);
  });
});

describe('PUT /nutrition-library/:id — gym-owned items only', () => {
  let ownItemId: number;
  const suffix = `${Date.now()}-edit`;

  beforeAll(async () => {
    const res = await request
      .post('/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `Editable Item ${suffix}`, category_ids: [sauceId] });
    expect(res.status).toBe(201);
    ownItemId = res.body.id;
  });

  it('returns 403 when trying to edit a system (gym_id null) item', async () => {
    const res = await request
      .put(`/nutrition-library/${libraryItemId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Hacked Name' });
    expect(res.status).toBe(403);
  });

  it('returns 404 when trying to edit another gym\'s item (tenant isolation)', async () => {
    const res = await request
      .put(`/nutrition-library/${ownItemId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId)
      .send({ name: 'Cross Tenant Update' });
    expect(res.status).toBe(404);
  });

  it('edits own gym item and returns 200', async () => {
    const res = await request
      .put(`/nutrition-library/${ownItemId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `Editable Item Updated ${suffix}` });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(`Editable Item Updated ${suffix}`);
  });

  it('replaces categories on own gym item, adding a second category', async () => {
    const res = await request
      .put(`/nutrition-library/${ownItemId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ category_ids: [sauceId, mainDishId] });
    expect(res.status).toBe(200);
    expect(res.body.categories.map((c: any) => c.id).sort()).toEqual([sauceId, mainDishId].sort());
  });

  it('returns 400 when replacing categories with an empty array', async () => {
    const res = await request
      .put(`/nutrition-library/${ownItemId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ category_ids: [] });
    expect(res.status).toBe(400);
  });

  it('sets image_url on own gym item and returns it', async () => {
    const res = await request
      .put(`/nutrition-library/${ownItemId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ image_url: 'https://r2.example/updated.png' });
    expect(res.status).toBe(200);
    expect(res.body.image_url).toBe('https://r2.example/updated.png');
  });

  it('clears image_url when explicitly set to null', async () => {
    const res = await request
      .put(`/nutrition-library/${ownItemId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ image_url: null });
    expect(res.status).toBe(200);
    expect(res.body.image_url).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Translated names for gym staff (#643)
// ---------------------------------------------------------------------------

describe('translated names', () => {
  let gymItemId: number;

  beforeAll(async () => {
    // Cascades away with the system item in afterAll.
    await db.query(
      `INSERT INTO nutrition_library_item_translations (item_id, locale, name)
       VALUES (?, 'es', 'NL Pollo de Prueba'), (?, 'ca', 'NL Pollastre de Prova')
       ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [libraryItemId, libraryItemId],
    );

    const res = await request
      .post('/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `NL Gym Food ${Date.now()}`, category_ids: [sideId] });
    gymItemId = res.body.id;
  });

  it('shows a system item in the staff member’s locale, keeping name as the base value', async () => {
    const res = await request
      .get('/nutrition-library?search=NL Pollo de Prueba')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .set('x-locale', 'es');
    expect(res.status).toBe(200);
    const item = res.body.items.find((i: any) => i.id === libraryItemId);
    expect(item.display_name).toBe('NL Pollo de Prueba');
    expect(item.name).toBe('NL Test Chicken');
    expect(item.translations.ca).toBe('NL Pollastre de Prova');
  });

  it('leaves gym-owned items showing their single entered name in every locale', async () => {
    const res = await request
      .get('/nutrition-library?limit=200')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .set('x-locale', 'ca');
    const item = res.body.items.find((i: any) => i.id === gymItemId);
    expect(item.display_name).toBe(item.name);
    expect(item.translations).toEqual({});
  });

  it('a gym item created while browsing in Catalan stores the name it was given', async () => {
    const name = `NL Catalan Create ${Date.now()}`;
    const res = await request
      .post('/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .set('x-locale', 'ca')
      .send({ name, category_ids: [sideId] });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe(name);
    expect(res.body.display_name).toBe(name);
  });
});
