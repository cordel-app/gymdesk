// Tests for meals-catalog.ts router (dishesRouter, sidesRouter, saucesRouter)

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

beforeAll(async () => {
  gymId = await createTestGym('Meals Catalog Test Gym');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ---------------------------------------------------------------------------
// Auth guard — unauthenticated requests return 401 before any tenant check
// ---------------------------------------------------------------------------

describe('auth guard', () => {
  it.each(['/dishes', '/sides', '/sauces'])(
    'returns 401 without auth on GET %s',
    async (path) => {
      const res = await request.get(path);
      expect(res.status).toBe(401);
    },
  );

  it.each(['/dishes', '/sides', '/sauces'])(
    'returns 401 without auth on POST %s',
    async (path) => {
      const res = await request.post(path).send({ name: 'X' });
      expect(res.status).toBe(401);
    },
  );
});

// ---------------------------------------------------------------------------
// Tenant isolation — no membership in target gym → 403 from tenantContext
// ---------------------------------------------------------------------------

describe('tenant isolation — no membership', () => {
  it('returns 403 on GET /dishes when user has no membership in this gym', async () => {
    const otherId = await createTestGym('No Membership Gym Meals');
    const res = await request
      .get('/dishes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherId);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Module access guard — accountant has NONE for NUTRITION → 403
// ---------------------------------------------------------------------------

describe('module access guard', () => {
  let accountantGymId: string;

  beforeAll(async () => {
    accountantGymId = await createTestGym('Accountant Gym Meals');
    await createTestMembership(accountantGymId, 'accountant');
  });

  it.each(['/dishes', '/sides', '/sauces'])(
    'returns 403 on GET %s for accountant role (NONE permission for NUTRITION)',
    async (path) => {
      const res = await request
        .get(path)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', accountantGymId);
      expect(res.status).toBe(403);
    },
  );
});

// ---------------------------------------------------------------------------
// Write guard — front_desk has R for NUTRITION → read is OK, writes return 403
// ---------------------------------------------------------------------------

describe('write guard', () => {
  let frontDeskGymId: string;

  beforeAll(async () => {
    frontDeskGymId = await createTestGym('Front Desk Gym Meals');
    await createTestMembership(frontDeskGymId, 'front_desk');
  });

  it('returns 200 on GET /dishes for front_desk (read access is allowed)', async () => {
    const res = await request
      .get('/dishes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', frontDeskGymId);
    expect(res.status).toBe(200);
  });

  it.each(['/dishes', '/sides', '/sauces'])(
    'returns 403 on POST %s for front_desk (R permission, no write)',
    async (path) => {
      const res = await request
        .post(path)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', frontDeskGymId)
        .send({ name: 'Unauthorized Item' });
      expect(res.status).toBe(403);
    },
  );

  it('returns 403 on DELETE /dishes/:id for front_desk', async () => {
    // Create a dish in the admin gym so we have a real id to reference
    const createRes = await request
      .post('/dishes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'FrontDesk Delete Guard Dish' });
    expect(createRes.status).toBe(201);

    const res = await request
      .delete(`/dishes/${createRes.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', frontDeskGymId);
    // front_desk cannot write NUTRITION — 403 before reaching the resource check
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Cross-gym tenant isolation — resource from gym A returns 404 with gym B id
// ---------------------------------------------------------------------------

describe('cross-gym tenant isolation', () => {
  it('returns 404 when fetching a dish that belongs to another gym', async () => {
    const gymA = await createTestGym('Gym A Catalog');
    await createTestMembership(gymA, 'admin');
    const gymB = await createTestGym('Gym B Catalog');
    await createTestMembership(gymB, 'admin');

    const createRes = await request
      .post('/dishes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA)
      .send({ name: 'Gym A Exclusive Dish' });
    expect(createRes.status).toBe(201);

    const res = await request
      .get(`/dishes/${createRes.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(404);
  });

  it('returns 404 when updating a dish that belongs to another gym', async () => {
    const gymA = await createTestGym('Gym A Catalog Update');
    await createTestMembership(gymA, 'admin');
    const gymB = await createTestGym('Gym B Catalog Update');
    await createTestMembership(gymB, 'admin');

    const createRes = await request
      .post('/dishes')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA)
      .send({ name: 'Gym A Exclusive Dish Update' });
    expect(createRes.status).toBe(201);

    const res = await request
      .put(`/dishes/${createRes.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB)
      .send({ name: 'Stolen Update' });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Parametrized suite — dishes, sides, and sauces share the same CRUD behaviour
// ---------------------------------------------------------------------------

describe.each([
  { path: '/dishes', label: 'dishes' },
  { path: '/sides', label: 'sides' },
  { path: '/sauces', label: 'sauces' },
])('$label — CRUD happy path', ({ path, label }) => {
  // -- POST ------------------------------------------------------------------

  it('returns 201 with status=active on POST', async () => {
    const res = await request
      .post(path)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        name: `${label} Happy Path`,
        calories: 150,
        protein: 20,
        carbohydrates: 10,
        fat: 5,
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');
    expect(res.body.name).toBe(`${label} Happy Path`);
    // MySQL DECIMAL columns are serialised as strings
    expect(parseFloat(res.body.calories)).toBe(150);
    expect(parseFloat(res.body.protein)).toBe(20);
  });

  it('returns 400 on POST without a name', async () => {
    const res = await request
      .post(path)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ calories: 100 });
    expect(res.status).toBe(400);
  });

  it('returns 409 on POST when name already exists in this gym', async () => {
    const name = `Unique ${label} ${Date.now()}`;

    const first = await request
      .post(path)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name });
    expect(first.status).toBe(201);

    const second = await request
      .post(path)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name });
    expect(second.status).toBe(409);
  });

  // -- GET list --------------------------------------------------------------

  it('returns 200 with an array on GET list', async () => {
    const res = await request
      .get(path)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('excludes soft-deleted items from GET list', async () => {
    const createRes = await request
      .post(path)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `${label} List Exclude Deleted` });
    expect(createRes.status).toBe(201);
    const id = createRes.body.id;

    await request
      .delete(`${path}/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    const listRes = await request
      .get(path)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(listRes.status).toBe(200);
    expect(listRes.body.find((row: any) => row.id === id)).toBeUndefined();
  });

  // -- GET /:id --------------------------------------------------------------

  it('returns 200 with the row on GET /:id', async () => {
    const createRes = await request
      .post(path)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `${label} Get By ID` });
    expect(createRes.status).toBe(201);
    const id = createRes.body.id;

    const res = await request
      .get(`${path}/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.name).toBe(`${label} Get By ID`);
  });

  it('returns 404 on GET /:id for a non-existent item', async () => {
    const res = await request
      .get(`${path}/99999999`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns the row with status=deleted on GET /:id after soft-delete', async () => {
    const createRes = await request
      .post(path)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `${label} Get Deleted By ID` });
    expect(createRes.status).toBe(201);
    const id = createRes.body.id;

    const delRes = await request
      .delete(`${path}/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(delRes.status).toBe(204);

    // GET /:id has no status filter — deleted row is still visible
    const getRes = await request
      .get(`${path}/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(getRes.status).toBe(200);
    expect(getRes.body.status).toBe('deleted');
    expect(getRes.body.deleted_at).not.toBeNull();
  });

  // -- PUT -------------------------------------------------------------------

  it('returns 200 with updated fields on PUT', async () => {
    const createRes = await request
      .post(path)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `${label} Before Update`, calories: 100 });
    expect(createRes.status).toBe(201);
    const id = createRes.body.id;

    const res = await request
      .put(`${path}/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `${label} After Update`, calories: 250 });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(`${label} After Update`);
    expect(parseFloat(res.body.calories)).toBe(250);
  });

  it('returns 400 on PUT with no updatable fields', async () => {
    const createRes = await request
      .post(path)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `${label} No Fields PUT` });
    expect(createRes.status).toBe(201);

    const res = await request
      .put(`${path}/${createRes.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 on PUT for a soft-deleted item', async () => {
    const createRes = await request
      .post(path)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `${label} Deleted PUT` });
    expect(createRes.status).toBe(201);
    const id = createRes.body.id;

    await request
      .delete(`${path}/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    const res = await request
      .put(`${path}/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `${label} Should Not Update` });
    expect(res.status).toBe(404);
  });

  // -- DELETE (soft-delete) --------------------------------------------------

  it('returns 204 on DELETE and soft-deletes the row', async () => {
    const createRes = await request
      .post(path)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `${label} To Delete` });
    expect(createRes.status).toBe(201);

    const res = await request
      .delete(`${path}/${createRes.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);
  });

  it('returns 404 on a second DELETE of the same item', async () => {
    const createRes = await request
      .post(path)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `${label} Double Delete` });
    expect(createRes.status).toBe(201);
    const id = createRes.body.id;

    await request
      .delete(`${path}/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    const res = await request
      .delete(`${path}/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  // -- Duplicate -------------------------------------------------------------

  it('returns 201 with name suffixed " (copy)" on POST /:id/duplicate', async () => {
    const createRes = await request
      .post(path)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `${label} Original`, calories: 200, protein: 15 });
    expect(createRes.status).toBe(201);
    const id = createRes.body.id;

    const dupRes = await request
      .post(`${path}/${id}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(dupRes.status).toBe(201);
    expect(dupRes.body.name).toBe(`${label} Original (copy)`);
    expect(dupRes.body.status).toBe('active');
    expect(dupRes.body.id).not.toBe(id);
    // Nutrition fields should be copied from the source
    expect(parseFloat(dupRes.body.calories)).toBe(200);
    expect(parseFloat(dupRes.body.protein)).toBe(15);
  });

  it('returns 404 on POST /:id/duplicate when source is soft-deleted', async () => {
    const createRes = await request
      .post(path)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: `${label} Delete Then Dup` });
    expect(createRes.status).toBe(201);
    const id = createRes.body.id;

    await request
      .delete(`${path}/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    const res = await request
      .post(`${path}/${id}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 404 on POST /:id/duplicate for a non-existent item', async () => {
    const res = await request
      .post(`${path}/99999999/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});
