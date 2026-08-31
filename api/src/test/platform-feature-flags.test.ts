// Tests for platform-feature-flags.ts router

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { invalidateFeatureFlagsCache } from '../infra/featureFlags';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

// Override the default @clerk/backend mock: default = superadmin so platform
// routes work without per-test overrides. Non-superadmin tests use
// mockResolvedValueOnce to swap in a regular user for a single call.
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

let gymId: string;

beforeAll(async () => {
  gymId = await createTestGym();
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  // Safety net: re-enable any flags that tests may have left disabled.
  await db.query(
    `UPDATE feature_flags SET enabled = 1 WHERE feature_key IN ('membership.members', 'membership')`,
  );
  invalidateFeatureFlagsCache();
  await cleanupTestGyms();
  await db.end();
});

// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------

describe('auth guard', () => {
  it('returns 401 on GET /feature-flags without auth', async () => {
    const res = await request.get('/feature-flags');
    expect(res.status).toBe(401);
  });

  it('returns 401 on GET /platform/feature-flags without auth', async () => {
    const res = await request.get('/platform/feature-flags');
    expect(res.status).toBe(401);
  });

  it('returns 401 on PUT /platform/feature-flags/:key without auth', async () => {
    const res = await request
      .put('/platform/feature-flags/membership.members')
      .send({ enabled: false });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Superadmin guard
// ---------------------------------------------------------------------------

describe('superadmin guard', () => {
  it('returns 403 on GET /platform/feature-flags when user is not a superadmin', async () => {
    mockGetUser.mockResolvedValueOnce({
      publicMetadata: {},
      fullName: 'Regular User',
      firstName: 'Regular',
      lastName: 'User',
    });
    const res = await request
      .get('/platform/feature-flags')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(403);
  });

  it('returns 403 on PUT /platform/feature-flags/:key when user is not a superadmin', async () => {
    mockGetUser.mockResolvedValueOnce({
      publicMetadata: {},
      fullName: 'Regular User',
      firstName: 'Regular',
      lastName: 'User',
    });
    const res = await request
      .put('/platform/feature-flags/membership.members')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ enabled: false });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Platform CRUD — superadmin
// ---------------------------------------------------------------------------

describe('platform feature flags CRUD', () => {
  it('returns 200 with an array of flag objects', async () => {
    const res = await request
      .get('/platform/feature-flags')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    const flag = res.body.find((f: any) => f.feature_key === 'membership.members');
    expect(flag).toBeDefined();
    expect(typeof flag.feature_key).toBe('string');
    expect(typeof flag.enabled).toBe('boolean');
    expect(flag).toHaveProperty('updated_at');
  });

  it('disables a flag and re-enables it', async () => {
    const disableRes = await request
      .put('/platform/feature-flags/membership.members')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ enabled: false });
    expect(disableRes.status).toBe(200);
    expect(disableRes.body.feature_key).toBe('membership.members');
    expect(disableRes.body.enabled).toBe(false);

    const enableRes = await request
      .put('/platform/feature-flags/membership.members')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ enabled: true });
    expect(enableRes.status).toBe(200);
    expect(enableRes.body.feature_key).toBe('membership.members');
    expect(enableRes.body.enabled).toBe(true);
  });

  it('returns 404 for a non-existent feature key', async () => {
    const res = await request
      .put('/platform/feature-flags/nonexistent.flag.key')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ enabled: false });
    expect(res.status).toBe(404);
  });

  it('returns 400 when enabled field is missing from the body', async () => {
    const res = await request
      .put('/platform/feature-flags/membership.members')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 400 when enabled is not a boolean', async () => {
    const res = await request
      .put('/platform/feature-flags/membership.members')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ enabled: 'yes' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when enabled is a number instead of boolean', async () => {
    const res = await request
      .put('/platform/feature-flags/membership.members')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ enabled: 1 });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Public feature flags endpoint — any authenticated user
// ---------------------------------------------------------------------------

describe('public feature flags', () => {
  it('returns 200 with a Record<string, boolean> for an authenticated user', async () => {
    // GET /feature-flags only uses requireAuth(), no tenantContext — no x-gym-id needed.
    const res = await request
      .get('/feature-flags')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(Array.isArray(res.body)).toBe(false);
    // All values must be booleans.
    for (const [key, value] of Object.entries(res.body)) {
      expect(typeof key).toBe('string');
      expect(typeof value).toBe('boolean');
    }
    // Seeded keys should be present and enabled.
    expect(res.body['membership.members']).toBe(true);
    expect(res.body['membership']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// requireFeatureEnabled enforcement on /members
// ---------------------------------------------------------------------------

describe('requireFeatureEnabled enforcement', () => {
  it('returns 403 on GET /members when membership.members flag is disabled', async () => {
    // Disable the flag via the platform API (default mock = superadmin).
    const disableRes = await request
      .put('/platform/feature-flags/membership.members')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ enabled: false });
    expect(disableRes.status).toBe(200);

    // Access /members as a regular (non-superadmin) user.
    mockGetUser.mockResolvedValueOnce({
      publicMetadata: {},
      fullName: 'Regular User',
      firstName: 'Regular',
      lastName: 'User',
    });
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(403);

    // Re-enable so subsequent tests are not polluted.
    await request
      .put('/platform/feature-flags/membership.members')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ enabled: true });
  });

  it('returns 200 on GET /members once membership.members is re-enabled', async () => {
    // Confirm the flag is on (re-enabled by the previous test).
    mockGetUser.mockResolvedValueOnce({
      publicMetadata: {},
      fullName: 'Regular User',
      firstName: 'Regular',
      lastName: 'User',
    });
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('returns 403 on GET /members when the ancestor membership flag is disabled', async () => {
    // Disabling the parent 'membership' must block child 'membership.members'.
    const disableRes = await request
      .put('/platform/feature-flags/membership')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ enabled: false });
    expect(disableRes.status).toBe(200);

    mockGetUser.mockResolvedValueOnce({
      publicMetadata: {},
      fullName: 'Regular User',
      firstName: 'Regular',
      lastName: 'User',
    });
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(403);

    // Re-enable the ancestor.
    await request
      .put('/platform/feature-flags/membership')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ enabled: true });
  });
});

// ---------------------------------------------------------------------------
// Superadmin bypass
// ---------------------------------------------------------------------------

describe('superadmin bypasses feature flags', () => {
  it('returns 200 on GET /members for a superadmin even when membership.members is disabled', async () => {
    // Disable the flag via the platform API (default mock = superadmin).
    const disableRes = await request
      .put('/platform/feature-flags/membership.members')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ enabled: false });
    expect(disableRes.status).toBe(200);

    // Access /members as superadmin (default mock — no mockResolvedValueOnce override).
    // tenantContext will set isSuperadmin: true, so requireFeatureEnabled skips the check.
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    // Re-enable so subsequent tests and afterAll are clean.
    await request
      .put('/platform/feature-flags/membership.members')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ enabled: true });
  });
});
