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

  // Insert a global (system) library item — gym_id IS NULL — cleaned up manually below
  // since cleanupTestGyms only deletes rows scoped to the created test gyms.
  const { insertId } = await db.query(
    "INSERT INTO nutrition_library_items (gym_id, name, category, status) VALUES (NULL, 'NL Test Chicken', 'main_dish', 'active')",
    [],
  );
  libraryItemId = insertId;
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
// Happy path — list, search, filter, pagination
// ---------------------------------------------------------------------------

describe('GET /nutrition-library — happy path', () => {
  it('returns paginated items including system (gym_id null) items', async () => {
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
    expect(item.category).toBe('main_dish');
    expect(item.gym_id).toBeNull();
  });

  it('filters by ?category=main_dish and returns only main_dish items', async () => {
    const res = await request
      .get('/nutrition-library?category=main_dish')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    for (const item of res.body.items) {
      expect(item.category).toBe('main_dish');
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

  it('returns 400 for an invalid ?category value', async () => {
    const res = await request
      .get('/nutrition-library?category=invalid')
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
    const res = await request.post('/nutrition-library').send({ name: 'X', category: 'main_dish' });
    expect(res.status).toBe(401);
  });

  it('returns 403 for accountant role (no NUTRITION access at all)', async () => {
    const res = await request
      .post('/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', accountantGymId)
      .send({ name: 'Accountant Item', category: 'main_dish' });
    expect(res.status).toBe(403);
  });

  it('creates a gym-owned item as admin and returns 201', async () => {
    const res = await request
      .post('/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `Gym Item ${Date.now()}`, category: 'side' });
    expect(res.status).toBe(201);
    expect(res.body.category).toBe('side');
    expect(res.body.gym_id).toBe(gymId);
    expect(res.body.image_url).toBeNull();
  });

  it('creates a gym-owned item with an image_url and returns it', async () => {
    const res = await request
      .post('/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `Gym Item With Image ${Date.now()}`, category: 'side', image_url: 'https://r2.example/img.png' });
    expect(res.status).toBe(201);
    expect(res.body.image_url).toBe('https://r2.example/img.png');
  });

  it('returns 400 when creating without a name', async () => {
    const res = await request
      .post('/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ category: 'main_dish' });
    expect(res.status).toBe(400);
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
      .send({ name: `Editable Item ${suffix}`, category: 'sauce' });
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
