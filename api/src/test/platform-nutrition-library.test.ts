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

beforeAll(async () => {
  // No gym required for superadmin-only routes.
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
      .send({ name: 'X', category: 'main_dish' });
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
      .send({ name: `PNL Chicken ${uniqueSuffix}`, category: 'main_dish' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe(`PNL Chicken ${uniqueSuffix}`);
    expect(res.body.category).toBe('main_dish');
    expect(res.body.status).toBe('active');
    itemId = res.body.id;
    createdItemIds.push(itemId);
  });

  it('lists library items and excludes deleted ones by default', async () => {
    const res = await request
      .get('/platform/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const found = res.body.find((i: any) => i.id === itemId);
    expect(found).toBeDefined();
    for (const item of res.body) {
      expect(item.status).not.toBe('deleted');
    }
  });

  it('updates the item name and returns 200', async () => {
    const res = await request
      .put(`/platform/nutrition-library/${itemId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `PNL Chicken Updated ${uniqueSuffix}` });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(`PNL Chicken Updated ${uniqueSuffix}`);
    expect(res.body.category).toBe('main_dish');
  });

  it('updates the category and returns 200', async () => {
    const res = await request
      .put(`/platform/nutrition-library/${itemId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ category: 'side' });
    expect(res.status).toBe(200);
    expect(res.body.category).toBe('side');
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
    const found = listRes.body.find((i: any) => i.id === itemId);
    expect(found).toBeUndefined();
  });

  it('shows deleted item when ?status=deleted', async () => {
    const res = await request
      .get('/platform/nutrition-library?status=deleted')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const found = res.body.find((i: any) => i.id === itemId);
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
      .send({ category: 'main_dish' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when creating without a category', async () => {
    const res = await request
      .post('/platform/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `PNL No Category ${Date.now()}` });
    expect(res.status).toBe(400);
  });

  it('returns 400 when creating with an invalid category', async () => {
    const res = await request
      .post('/platform/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `PNL Bad Category ${Date.now()}`, category: 'vegetable' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when listing with an invalid ?category value', async () => {
    const res = await request
      .get('/platform/nutrition-library?category=invalid')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(400);
  });

  it('returns 400 when updating with an invalid category', async () => {
    // Create a valid item first
    const createRes = await request
      .post('/platform/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: `PNL Valid For BadUpdate ${Date.now()}`, category: 'drink' });
    expect(createRes.status).toBe(201);
    createdItemIds.push(createRes.body.id);

    const res = await request
      .put(`/platform/nutrition-library/${createRes.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ category: 'veggie' });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Duplicate
// ---------------------------------------------------------------------------

describe('platform nutrition library duplicate', () => {
  it('returns 409 when creating an item with the same name and category', async () => {
    const uniqueName = `PNL Dup Item ${Date.now()}`;

    const first = await request
      .post('/platform/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: uniqueName, category: 'drink' });
    expect(first.status).toBe(201);
    createdItemIds.push(first.body.id);

    const second = await request
      .post('/platform/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: uniqueName, category: 'drink' });
    expect(second.status).toBe(409);
  });

  it('allows same name under a different category', async () => {
    const uniqueName = `PNL Same Name DiffCat ${Date.now()}`;

    const first = await request
      .post('/platform/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: uniqueName, category: 'sauce' });
    expect(first.status).toBe(201);
    createdItemIds.push(first.body.id);

    const second = await request
      .post('/platform/nutrition-library')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: uniqueName, category: 'dessert' });
    expect(second.status).toBe(201);
    createdItemIds.push(second.body.id);
  });
});
