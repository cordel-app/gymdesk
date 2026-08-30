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

const STAFF_ID = 'impersonation-staff-id';
const LINKED_MEMBER_CLERK_ID = 'impersonation-linked-member-id';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ─── GET /platform/impersonation/targets ─────────────────────────────────────

describe('GET /platform/impersonation/targets', () => {
  let gymId: string;
  let linkedMemberId: number;
  let unlinkedMemberId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Targets Test Gym');

    // Staff member
    await db.query(
      `INSERT INTO gym_memberships (user_id, gym_id, role, status, name)
       VALUES (?, ?, 'trainer_performance', 'active', 'Alice Trainer')`,
      [STAFF_ID, gymId],
    );

    // Linked member (has a Clerk account)
    const { insertId: lId } = await db.query(
      `INSERT INTO members (gym_id, name, email, clerk_user_id)
       VALUES (?, 'Bob Member', 'bob@test.com', ?)`,
      [gymId, LINKED_MEMBER_CLERK_ID],
    );
    linkedMemberId = lId;

    // Unlinked member (no Clerk account — the core new case)
    const { insertId: uId } = await db.query(
      `INSERT INTO members (gym_id, name, email)
       VALUES (?, 'Carol Unlinked', 'carol@test.com')`,
      [gymId],
    );
    unlinkedMemberId = uId;
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
      .get('/platform/impersonation/targets')
      .query({ gym_id: gymId });
    expect(res.status).toBe(401);
  });

  it('returns 403 when authenticated but not superadmin', async () => {
    mockGetUser.mockResolvedValue({ publicMetadata: {}, fullName: 'Regular', firstName: 'Regular', lastName: 'User', emailAddresses: [], primaryEmailAddressId: null });
    const res = await request
      .get('/platform/impersonation/targets')
      .set('Authorization', TEST_AUTH_HEADER)
      .query({ gym_id: gymId });
    expect(res.status).toBe(403);
  });

  it('returns 400 when gym_id query param is missing', async () => {
    const res = await request
      .get('/platform/impersonation/targets')
      .set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/gym_id/);
  });

  it('returns staff and members (including unlinked) for the gym', async () => {
    const res = await request
      .get('/platform/impersonation/targets')
      .set('Authorization', TEST_AUTH_HEADER)
      .query({ gym_id: gymId, q: '' });

    expect(res.status).toBe(200);
    const ids = res.body.map((u: any) => u.id);
    expect(ids).toContain(STAFF_ID);
    expect(ids).toContain(`member:${linkedMemberId}`);
    expect(ids).toContain(`member:${unlinkedMemberId}`);
  });

  it('includes members without a Clerk account (no clerk_user_id)', async () => {
    const res = await request
      .get('/platform/impersonation/targets')
      .set('Authorization', TEST_AUTH_HEADER)
      .query({ gym_id: gymId, q: 'Carol' });

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].id).toBe(`member:${unlinkedMemberId}`);
    expect(res.body[0].type).toBe('member');
    expect(res.body[0].role).toBe('member');
  });

  it('filters by name search', async () => {
    const res = await request
      .get('/platform/impersonation/targets')
      .set('Authorization', TEST_AUTH_HEADER)
      .query({ gym_id: gymId, q: 'Alice' });

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].id).toBe(STAFF_ID);
    expect(res.body[0].type).toBe('staff');
  });

  it('excludes staff users who are superadmins', async () => {
    mockGetUser.mockImplementation(async (userId: string) => {
      if (userId === TEST_USER_ID || userId === STAFF_ID) {
        return { publicMetadata: { platform_role: 'superadmin' }, fullName: 'Super', firstName: 'Super', lastName: 'Admin', emailAddresses: [], primaryEmailAddressId: null };
      }
      return { publicMetadata: {}, fullName: 'Regular', firstName: 'Regular', lastName: 'User', emailAddresses: [], primaryEmailAddressId: null };
    });

    const res = await request
      .get('/platform/impersonation/targets')
      .set('Authorization', TEST_AUTH_HEADER)
      .query({ gym_id: gymId, q: 'Alice' });

    expect(res.status).toBe(200);
    const ids = res.body.map((u: any) => u.id);
    expect(ids).not.toContain(STAFF_ID);
  });

  it('does not include deleted members', async () => {
    const { insertId } = await db.query(
      `INSERT INTO members (gym_id, name, email, deleted_at)
       VALUES (?, 'Dave Deleted', 'dave@test.com', UTC_TIMESTAMP())`,
      [gymId],
    );

    const res = await request
      .get('/platform/impersonation/targets')
      .set('Authorization', TEST_AUTH_HEADER)
      .query({ gym_id: gymId, q: 'Dave' });

    expect(res.status).toBe(200);
    const ids = res.body.map((u: any) => u.id);
    expect(ids).not.toContain(`member:${insertId}`);
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
      .send({ impersonated_user_id: `member:1` });
    expect(res.status).toBe(401);
  });

  it('returns 403 when not superadmin', async () => {
    mockGetUser.mockResolvedValue({ publicMetadata: {}, fullName: 'Regular', firstName: 'Regular', lastName: 'User', emailAddresses: [], primaryEmailAddressId: null });
    const res = await request
      .post('/platform/impersonation/stop')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ impersonated_user_id: `member:1` });
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

  it('returns 204 on success for member id', async () => {
    const res = await request
      .post('/platform/impersonation/stop')
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ impersonated_user_id: `member:42`, duration_seconds: 42 });
    expect(res.status).toBe(204);
  });
});

// ─── POST /platform/impersonation/:targetId ───────────────────────────────────

describe('POST /platform/impersonation/:targetId — member impersonation', () => {
  let gymId: string;
  let memberId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Member Impersonation Test Gym');
    const { insertId } = await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Eve Unlinked', 'eve@test.com')`,
      [gymId],
    );
    memberId = insertId;
  });

  beforeEach(() => {
    mockGetUser.mockClear();
    mockGetUser.mockImplementation(async (userId: string) => {
      if (userId === TEST_USER_ID) {
        return { publicMetadata: { platform_role: 'superadmin' }, fullName: 'Super Admin', firstName: 'Super', lastName: 'Admin', emailAddresses: [], primaryEmailAddressId: null };
      }
      return { publicMetadata: {}, fullName: 'Target', firstName: 'Target', lastName: 'User', emailAddresses: [], primaryEmailAddressId: null };
    });
  });

  it('returns 401 when no Authorization header', async () => {
    const res = await request
      .post(`/platform/impersonation/${memberId}`)
      .set('x-gym-id', gymId)
      .send({ targetType: 'member' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when targetType is missing', async () => {
    const res = await request
      .post(`/platform/impersonation/${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/targetType/);
  });

  it('returns 400 when x-gym-id header is missing', async () => {
    const res = await request
      .post(`/platform/impersonation/${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ targetType: 'member' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/x-gym-id/);
  });

  it('succeeds for unlinked member (no clerk_user_id)', async () => {
    const res = await request
      .post(`/platform/impersonation/${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ targetType: 'member' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: `member:${memberId}`,
      name: 'Eve Unlinked',
      role: 'member',
      gym_id: gymId,
      gymIds: [gymId],
    });
  });

  it('returns 400 for deleted member', async () => {
    const { insertId } = await db.query(
      `INSERT INTO members (gym_id, name, email, deleted_at)
       VALUES (?, 'Frank Deleted', 'frank@test.com', UTC_TIMESTAMP())`,
      [gymId],
    );
    const res = await request
      .post(`/platform/impersonation/${insertId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ targetType: 'member' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for member belonging to a different gym (tenant isolation)', async () => {
    const gymB = await createTestGym('Gym B Isolation Member');
    const res = await request
      .post(`/platform/impersonation/${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB)
      .send({ targetType: 'member' });
    expect(res.status).toBe(400);
  });
});

describe('POST /platform/impersonation/:targetId — staff impersonation', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Staff Impersonation Test Gym');
    await db.query(
      `INSERT INTO gym_memberships (user_id, gym_id, role, status, name)
       VALUES (?, ?, 'member', 'active', 'Grace Staff')`,
      [LINKED_MEMBER_CLERK_ID, gymId],
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

  it('returns 400 when trying to impersonate yourself as staff', async () => {
    const res = await request
      .post(`/platform/impersonation/${TEST_USER_ID}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ targetType: 'staff' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/yourself/);
  });

  it('returns 400 when target is another superadmin', async () => {
    mockGetUser.mockImplementation(async () => ({
      publicMetadata: { platform_role: 'superadmin' },
      fullName: 'Other Super Admin',
      firstName: 'Other',
      lastName: 'Admin',
      emailAddresses: [],
      primaryEmailAddressId: null,
    }));
    const res = await request
      .post(`/platform/impersonation/other-superadmin-id`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ targetType: 'staff' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/superadmin/);
  });

  it('returns 400 when target has no active membership in the gym', async () => {
    const res = await request
      .post(`/platform/impersonation/no-membership-user-id`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ targetType: 'staff' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/membership/);
  });

  it('returns target data with gymIds on success', async () => {
    const res = await request
      .post(`/platform/impersonation/${LINKED_MEMBER_CLERK_ID}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ targetType: 'staff' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: LINKED_MEMBER_CLERK_ID,
      name: expect.any(String),
      role: 'member',
      gym_id: gymId,
      gymIds: expect.arrayContaining([gymId]),
    });
  });

  it('returns 400 for tenant isolation (target in wrong gym)', async () => {
    const gymB = await createTestGym('Gym B Isolation Staff');
    const res = await request
      .post(`/platform/impersonation/${LINKED_MEMBER_CLERK_ID}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB)
      .send({ targetType: 'staff' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/membership/);
  });
});
