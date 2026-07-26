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
let libraryItemId: number;

beforeAll(async () => {
  gymId = await createTestGym('NL Test Gym');
  await createTestMembership(gymId, 'admin');

  accountantGymId = await createTestGym('NL Accountant Gym');
  await createTestMembership(accountantGymId, 'accountant');

  // Insert a global library item — nutrition_library_items has no gym_id so we manage
  // its cleanup manually in afterAll.
  const { insertId } = await db.query(
    "INSERT INTO nutrition_library_items (name, category) VALUES ('NL Test Chicken', 'main_dish')",
    [],
  );
  libraryItemId = insertId;
});

afterAll(async () => {
  await db.query('DELETE FROM nutrition_library_items WHERE id = ?', [libraryItemId]);
  await cleanupTestGyms();
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
// Happy path
// ---------------------------------------------------------------------------

describe('GET /nutrition-library — happy path', () => {
  it('returns an array of library items', async () => {
    const res = await request
      .get('/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const item = res.body.find((i: any) => i.id === libraryItemId);
    expect(item).toBeDefined();
    expect(item.name).toBe('NL Test Chicken');
    expect(item.category).toBe('main_dish');
  });

  it('filters by ?category=main_dish and returns only main_dish items', async () => {
    const res = await request
      .get('/nutrition-library?category=main_dish')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const item of res.body) {
      expect(item.category).toBe('main_dish');
    }
    // Our seeded item must appear
    const item = res.body.find((i: any) => i.id === libraryItemId);
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
