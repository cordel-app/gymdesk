import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  TEST_USER_ID,
  cleanupTestGyms,
  createTestGym,
  request,
} from './helpers';

// Single shared getUser mock so both tenantContext.ts and impersonation.ts
// (each of which calls createClerkClient() once at module load) use the same function.
const mockGetUser = vi.hoisted(() =>
  vi.fn().mockImplementation(async (userId: string) => {
    if (userId === 'test-user-id') {
      return {
        publicMetadata: { platform_role: 'superadmin' },
        fullName: 'Super Admin',
        firstName: 'Super',
        lastName: 'Admin',
        emailAddresses: [],
        primaryEmailAddressId: null,
      };
    }
    return {
      publicMetadata: {},
      fullName: 'Target User',
      firstName: 'Target',
      lastName: 'User',
      emailAddresses: [],
      primaryEmailAddressId: null,
    };
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

const TARGET_ID = 'impersonation-target-id';
const STAFF_ID = 'impersonation-staff-id';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ─── GET /platform/impersonation/candidates ──────────────────────────────────

describe('GET /platform/impersonation/candidates', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Candidates Test Gym');

    // Staff member with a name
    await db.query(
      `INSERT INTO gym_memberships (user_id, gym_id, role, status, name)
       VALUES (?, ?, 'trainer_performance', 'active', 'Alice Trainer')`,
      [STAFF_ID, gymId],
    );

    // Member via members table with a linked clerk user
    await db.query(
      `INSERT INTO members (gym_id, name, email, clerk_user_id)
       VALUES (?, 'Bob Member', 'bob@test.com', ?)`,
      [gymId, TARGET_ID],
    );
  });

  beforeEach(() => {
    mockGetUser.mockClear();
    // Restore default: TEST_USER_ID → superadmin, everything else → regular user
    mockGetUser.mockImplementation(async (userId: string) => {
      if (userId === TEST_USER_ID) {
        return { publicMetadata: { platform_role: 'superadmin' }, fullName: 'Super Admin', firstName: 'Super', lastName: 'Admin', emailAddresses: [], primaryEmailAddressId: null };
      }
      return { publicMetadata: {}, fullName: 'Target User', firstName: 'Target', lastName: 'User', emailAddresses: [], primaryEmailAddressId: null };
    });
  });

  it('returns 401 when no Authorization header', async () => {
    const res = await request
      .get('/platform/impersonation/candidates')
      .query({ gym_id: gymId });

    expect(res.status).toBe(401);
  });

  it('returns 403 when authenticated but not superadmin', async () => {
    mockGetUser.mockResolvedValue({ publicMetadata: {}, fullName: 'Regular', firstName: 'Regular', lastName: 'User', emailAddresses: [], primaryEmailAddressId: null });

    const res = await request
      .get('/platform/impersonation/candidates')
      .set('Authorization', TEST_AUTH_HEADER)
      .query({ gym_id: gymId });

    expect(res.status).toBe(403);
  });

  it('returns 400 when gym_id query param is missing', async () => {
    const res = await request
      .get('/platform/impersonation/candidates')
      .set('Authorization', TEST_AUTH_HEADER);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/gym_id/);
  });

  it('returns staff and members for the gym', async () => {
    const res = await request
      .get('/platform/impersonation/candidates')
      .set('Authorization', TEST_AUTH_HEADER)
      .query({ gym_id: gymId, q: '' });

    expect(res.status).toBe(200);
    const ids = res.body.map((u: any) => u.userId);
    expect(ids).toContain(STAFF_ID);
    expect(ids).toContain(TARGET_ID);
  });

  it('filters by name search', async () => {
    const res = await request
      .get('/platform/impersonation/candidates')
      .set('Authorization', TEST_AUTH_HEADER)
      .query({ gym_id: gymId, q: 'Alice' });

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].userId).toBe(STAFF_ID);
    expect(res.body[0].type).toBe('staff');
  });

  it('excludes staff users who are superadmins', async () => {
    mockGetUser.mockImplementation(async (userId: string) => {
      // Both the caller and STAFF_ID are superadmins
      if (userId === TEST_USER_ID || userId === STAFF_ID) {
        return { publicMetadata: { platform_role: 'superadmin' }, fullName: 'Super', firstName: 'Super', lastName: 'Admin', emailAddresses: [], primaryEmailAddressId: null };
      }
      return { publicMetadata: {}, fullName: 'Regular', firstName: 'Regular', lastName: 'User', emailAddresses: [], primaryEmailAddressId: null };
    });

    const res = await request
      .get('/platform/impersonation/candidates')
      .set('Authorization', TEST_AUTH_HEADER)
      .query({ gym_id: gymId, q: 'Alice' });

    expect(res.status).toBe(200);
    // STAFF_ID is a superadmin so must be excluded
    const ids = res.body.map((u: any) => u.userId);
    expect(ids).not.toContain(STAFF_ID);
  });
});

// ─── POST /platform/impersonation/stop ───────────────────────────────────────

describe('POST /platform/impersonation/stop', () => {
  beforeEach(() => {
    mockGetUser.mockClear();
    mockGetUser.mockImplementation(async (userId: string) => {
      if (userId === TEST_USER_ID) {
        return { publicMetadata: { platform_role: 'superadmin' }, fullName: 'Super Admin', firstName: 'Super', lastName: 'Admin', emailAddresses: [], primaryEmailAddressId: null };
      }
      return { publicMetadata: {}, fullName: 'Target User', firstName: 'Target', lastName: 'User', emailAddresses: [], primaryEmailAddressId: null };
    });
  });

  it('returns 401 when no Authorization header', async () => {
    const res = await request
      .post('/platform/impersonation/stop')
      .send({ impersonated_user_id: TARGET_ID });

    expect(res.status).toBe(401);
  });

  it('returns 403 when not superadmin', async () => {
    mockGetUser.mockResolvedValue({ publicMetadata: {}, fullName: 'Regular', firstName: 'Regular', lastName: 'User', emailAddresses: [], primaryEmailAddressId: null });

    const res = await request
      .post('/platform/impersonation/stop')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ impersonated_user_id: TARGET_ID });

    expect(res.status).toBe(403);
  });

  it('returns 400 when impersonated_user_id is missing', async () => {
    const res = await request
      .post('/platform/impersonation/stop')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/impersonated_user_id/);
  });

  it('returns 204 on success', async () => {
    const res = await request
      .post('/platform/impersonation/stop')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ impersonated_user_id: TARGET_ID, duration_seconds: 42 });

    expect(res.status).toBe(204);
  });
});

// ─── POST /platform/impersonation/:userId ────────────────────────────────────

describe('POST /platform/impersonation/:userId', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Start Impersonation Test Gym');

    // Insert an active gym_membership for TARGET_ID
    await db.query(
      `INSERT INTO gym_memberships (user_id, gym_id, role, status)
       VALUES (?, ?, 'member', 'active')`,
      [TARGET_ID, gymId],
    );
  });

  beforeEach(() => {
    mockGetUser.mockClear();
    mockGetUser.mockImplementation(async (userId: string) => {
      if (userId === TEST_USER_ID) {
        return { publicMetadata: { platform_role: 'superadmin' }, fullName: 'Super Admin', firstName: 'Super', lastName: 'Admin', emailAddresses: [], primaryEmailAddressId: null };
      }
      return { publicMetadata: {}, fullName: 'Target User', firstName: 'Target', lastName: 'User', emailAddresses: [], primaryEmailAddressId: null };
    });
  });

  it('returns 401 when no Authorization header', async () => {
    const res = await request
      .post(`/platform/impersonation/${TARGET_ID}`)
      .set('x-gym-id', gymId)
      .send();

    expect(res.status).toBe(401);
  });

  it('returns 403 when not superadmin', async () => {
    mockGetUser.mockResolvedValue({ publicMetadata: {}, fullName: 'Regular', firstName: 'Regular', lastName: 'User', emailAddresses: [], primaryEmailAddressId: null });

    const res = await request
      .post(`/platform/impersonation/${TARGET_ID}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send();

    expect(res.status).toBe(403);
  });

  it('returns 400 when x-gym-id header is missing', async () => {
    const res = await request
      .post(`/platform/impersonation/${TARGET_ID}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send();

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/x-gym-id/);
  });

  it('returns 400 when trying to impersonate yourself', async () => {
    const res = await request
      .post(`/platform/impersonation/${TEST_USER_ID}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send();

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/yourself/);
  });

  it('returns 404 when target user does not exist in Clerk', async () => {
    // requireSuperadmin calls getUser(TEST_USER_ID) → superadmin
    // then the route calls getUser(targetId) → throws (simulating Clerk 404)
    mockGetUser.mockImplementationOnce(async () => ({
      publicMetadata: { platform_role: 'superadmin' },
      fullName: 'Super Admin',
      firstName: 'Super',
      lastName: 'Admin',
      emailAddresses: [],
      primaryEmailAddressId: null,
    }));
    mockGetUser.mockImplementationOnce(async () => {
      throw new Error('User not found');
    });

    const res = await request
      .post('/platform/impersonation/nonexistent-clerk-id')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send();

    expect(res.status).toBe(404);
  });

  it('returns 400 when target is another superadmin', async () => {
    const otherSuperadminId = 'other-superadmin-id';

    // requireSuperadmin: getUser(TEST_USER_ID) → superadmin
    // route target check: getUser(otherSuperadminId) → superadmin
    mockGetUser.mockImplementation(async () => ({
      publicMetadata: { platform_role: 'superadmin' },
      fullName: 'Other Super Admin',
      firstName: 'Other',
      lastName: 'Admin',
      emailAddresses: [],
      primaryEmailAddressId: null,
    }));

    const res = await request
      .post(`/platform/impersonation/${otherSuperadminId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send();

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/superadmin/);
  });

  it('returns 400 when target has no active membership in the gym', async () => {
    const noMembershipId = 'no-membership-user-id';

    const res = await request
      .post(`/platform/impersonation/${noMembershipId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send();

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/membership/);
  });

  it('returns the target user data with gymIds on success', async () => {
    const res = await request
      .post(`/platform/impersonation/${TARGET_ID}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: TARGET_ID,
      name: expect.any(String),
      role: 'member',
      gym_id: gymId,
      gymIds: expect.arrayContaining([gymId]),
    });
  });

  it('does not return TARGET_ID memberships from another gym (tenant isolation)', async () => {
    const gymB = await createTestGym('Gym B Isolation');

    const res = await request
      .post(`/platform/impersonation/${TARGET_ID}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB)
      .send();

    // TARGET_ID has no membership in gymB
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/membership/);
  });
});
