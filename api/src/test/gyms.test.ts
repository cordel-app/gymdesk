// Tests for gyms.ts router (platform superadmin endpoints)

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

// Gyms created via the platform API (not via createTestGym) are tracked here
// and hard-deleted in afterAll. centers/gym_charges cascade from gyms, so
// deleting the gym row is sufficient.
const extraGymIds: string[] = [];

// Default: TEST_USER_ID is a superadmin. Individual tests that need a
// non-superadmin user override this via mockResolvedValueOnce / mockResolvedValue.
const mockGetUser = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    publicMetadata: { platform_role: 'superadmin' },
    fullName: 'Super Admin',
    firstName: 'Super',
    lastName: 'Admin',
    emailAddresses: [],
    primaryEmailAddressId: null,
  }),
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

let gymId: string;

beforeAll(async () => {
  gymId = await createTestGym('Platform Gyms Test Gym');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  if (extraGymIds.length > 0) {
    const marks = extraGymIds.map(() => '?').join(',');
    // gym_charges and centers have ON DELETE CASCADE from gyms, so deleting
    // the gym row cascades to them automatically. Explicit deletes here are
    // belt-and-suspenders in case of any non-cascading dependents.
    await db.query(`DELETE FROM gym_charges WHERE gym_id IN (${marks})`, extraGymIds);
    await db.query(`DELETE FROM gyms WHERE id IN (${marks})`, extraGymIds);
  }
  await cleanupTestGyms();
  await db.end();
});

beforeEach(() => {
  mockGetUser.mockClear();
  mockGetUser.mockResolvedValue({
    publicMetadata: { platform_role: 'superadmin' },
    fullName: 'Super Admin',
    firstName: 'Super',
    lastName: 'Admin',
    emailAddresses: [],
    primaryEmailAddressId: null,
  });
});

/** POST /platform/gyms with superadmin auth; tracks the created gym for cleanup. */
async function platformCreateGym(body: Record<string, unknown>) {
  const res = await request
    .post('/platform/gyms')
    .set('Authorization', TEST_AUTH_HEADER)
    .send(body);
  if (res.status === 201 && res.body?.id) {
    extraGymIds.push(res.body.id);
  }
  return res;
}

// ─── Auth guard ───────────────────────────────────────────────────────────────

describe('Auth guard', () => {
  it('returns 401 when no Authorization header is provided', async () => {
    const res = await request.get('/platform/gyms');
    expect(res.status).toBe(401);
  });

  it('returns 403 when the authenticated user is not a superadmin', async () => {
    // Override the default superadmin mock to simulate a regular gym admin.
    mockGetUser.mockResolvedValue({
      publicMetadata: {},
      fullName: 'Regular User',
      firstName: 'Regular',
      lastName: 'User',
      emailAddresses: [],
      primaryEmailAddressId: null,
    });
    const res = await request
      .get('/platform/gyms')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(403);
  });
});

// ─── POST /platform/gyms ──────────────────────────────────────────────────────

describe('POST /platform/gyms', () => {
  it('creates a gym with an auto-generated slug and returns 201 with id/name/slug', async () => {
    const res = await platformCreateGym({ name: 'Auto Slug Test Gym' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: expect.any(String),
      name: 'Auto Slug Test Gym',
      slug: expect.stringMatching(/auto-slug-test-gym/),
    });
    // UUID format
    expect(res.body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('accepts an explicit slug and uses it verbatim', async () => {
    const slug = `explicit-slug-${Date.now()}`;
    const res = await platformCreateGym({ name: 'Explicit Slug Gym', slug });
    expect(res.status).toBe(201);
    expect(res.body.slug).toBe(slug);
  });

  it('returns 400 when name is missing', async () => {
    const res = await request
      .post('/platform/gyms')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ description: 'a gym without a name' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/);
  });

  it('returns 409 when the slug is already taken', async () => {
    const slug = `dup-slug-${Date.now()}`;
    const first = await platformCreateGym({ name: 'First Dup Gym', slug });
    expect(first.status).toBe(201);

    const second = await request
      .post('/platform/gyms')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: 'Second Dup Gym', slug });
    expect(second.status).toBe(409);
  });
});

// ─── GET /platform/gyms ───────────────────────────────────────────────────────

describe('GET /platform/gyms', () => {
  it('returns an array of non-deleted gyms and excludes soft-deleted ones', async () => {
    const activeRes = await platformCreateGym({ name: 'Active List Test Gym' });
    expect(activeRes.status).toBe(201);
    const activeId = activeRes.body.id as string;

    const toDeleteRes = await platformCreateGym({ name: 'Deleted List Test Gym' });
    expect(toDeleteRes.status).toBe(201);
    const deletedId = toDeleteRes.body.id as string;
    // Soft-delete it
    await request
      .delete(`/platform/gyms/${deletedId}`)
      .set('Authorization', TEST_AUTH_HEADER);

    const res = await request
      .get('/platform/gyms')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const ids = res.body.map((g: any) => g.id);
    expect(ids).toContain(activeId);
    expect(ids).not.toContain(deletedId);
  });

  it('filters by ?status=inactive and excludes active gyms', async () => {
    const createRes = await platformCreateGym({ name: 'Inactive Filter Test Gym' });
    expect(createRes.status).toBe(201);
    const inactiveId = createRes.body.id as string;

    // Set it to inactive via PUT
    await request
      .put(`/platform/gyms/${inactiveId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ status: 'inactive' });

    const res = await request
      .get('/platform/gyms')
      .set('Authorization', TEST_AUTH_HEADER)
      .query({ status: 'inactive' });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const ids = res.body.map((g: any) => g.id);
    expect(ids).toContain(inactiveId);
    // The main gymId is active — it must not appear under the inactive filter
    expect(ids).not.toContain(gymId);
    // All returned gyms must have status 'inactive'
    for (const gym of res.body) {
      expect(gym.status).toBe('inactive');
    }
  });
});

// ─── GET /platform/gyms/:id ───────────────────────────────────────────────────

describe('GET /platform/gyms/:id', () => {
  it('returns the gym by ID', async () => {
    const res = await request
      .get(`/platform/gyms/${gymId}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: gymId, name: 'Platform Gyms Test Gym' });
  });

  it('returns a soft-deleted gym by ID with deleted_at populated', async () => {
    const createRes = await platformCreateGym({ name: 'Will Be Soft Deleted' });
    const id = createRes.body.id as string;
    await request
      .delete(`/platform/gyms/${id}`)
      .set('Authorization', TEST_AUTH_HEADER);

    const res = await request
      .get(`/platform/gyms/${id}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.deleted_at).not.toBeNull();
    expect(res.body.status).toBe('deleted');
  });

  it('returns 404 for an unknown gym ID', async () => {
    const res = await request
      .get('/platform/gyms/00000000-0000-0000-0000-000000000000')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(404);
  });
});

// ─── PUT /platform/gyms/:id ───────────────────────────────────────────────────

describe('PUT /platform/gyms/:id', () => {
  it('updates name and status; response has modified_at set', async () => {
    const createRes = await platformCreateGym({ name: 'Gym Before PUT Update' });
    expect(createRes.status).toBe(201);
    const id = createRes.body.id as string;

    const res = await request
      .put(`/platform/gyms/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: 'Gym After PUT Update', status: 'inactive' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Gym After PUT Update');
    expect(res.body.status).toBe('inactive');
    expect(res.body.modified_at).not.toBeNull();
  });

  it('returns 400 when the request body has no updatable fields', async () => {
    const res = await request
      .put(`/platform/gyms/${gymId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 400 when status is not active or inactive', async () => {
    const res = await request
      .put(`/platform/gyms/${gymId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ status: 'deleted' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the target gym has been soft-deleted', async () => {
    const createRes = await platformCreateGym({ name: 'Gym Deleted Before PUT' });
    const id = createRes.body.id as string;
    await request
      .delete(`/platform/gyms/${id}`)
      .set('Authorization', TEST_AUTH_HEADER);

    const res = await request
      .put(`/platform/gyms/${id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ name: 'Should Not Update' });
    expect(res.status).toBe(404);
  });
});

// ─── DELETE /platform/gyms/:id ────────────────────────────────────────────────

describe('DELETE /platform/gyms/:id', () => {
  it('soft-deletes a gym: returns 204, removes it from the list, keeps it accessible by ID', async () => {
    const createRes = await platformCreateGym({ name: 'Gym To Soft Delete' });
    expect(createRes.status).toBe(201);
    const id = createRes.body.id as string;

    const deleteRes = await request
      .delete(`/platform/gyms/${id}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(deleteRes.status).toBe(204);

    // Must not appear in the non-deleted list
    const listRes = await request
      .get('/platform/gyms')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(listRes.status).toBe(200);
    const listedIds = listRes.body.map((g: any) => g.id);
    expect(listedIds).not.toContain(id);

    // Still accessible by ID, with deleted_at and status='deleted'
    const getRes = await request
      .get(`/platform/gyms/${id}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(getRes.status).toBe(200);
    expect(getRes.body.deleted_at).not.toBeNull();
    expect(getRes.body.status).toBe('deleted');
  });

  it('returns 404 when the gym is already deleted', async () => {
    const createRes = await platformCreateGym({ name: 'Double Delete Test Gym' });
    const id = createRes.body.id as string;
    await request
      .delete(`/platform/gyms/${id}`)
      .set('Authorization', TEST_AUTH_HEADER);

    const second = await request
      .delete(`/platform/gyms/${id}`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(second.status).toBe(404);
  });
});

// ─── POST /platform/gyms/:id/duplicate ───────────────────────────────────────

describe('POST /platform/gyms/:id/duplicate', () => {
  it('creates a copy with "Copy of" prefix and a different slug; returns 201', async () => {
    const sourceRes = await platformCreateGym({ name: 'Source For Duplication' });
    expect(sourceRes.status).toBe(201);
    const sourceId = sourceRes.body.id as string;
    const sourceSlug = sourceRes.body.slug as string;

    const res = await request
      .post(`/platform/gyms/${sourceId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(201);

    // Track the duplicate for cleanup
    if (res.body?.id) extraGymIds.push(res.body.id);

    expect(res.body).toMatchObject({
      id: expect.any(String),
      name: 'Copy of Source For Duplication',
    });
    expect(res.body.id).not.toBe(sourceId);
    expect(res.body.slug).not.toBe(sourceSlug);
    // UUID format
    expect(res.body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('returns 404 when the source gym has been soft-deleted', async () => {
    const createRes = await platformCreateGym({ name: 'Deleted Source For Dup' });
    const id = createRes.body.id as string;
    await request
      .delete(`/platform/gyms/${id}`)
      .set('Authorization', TEST_AUTH_HEADER);

    const res = await request
      .post(`/platform/gyms/${id}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(404);
  });
});
