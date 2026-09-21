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
       VALUES (?, 'Bob Member', ?, ?)`,
      [gymId, `bob+${gymId}@test.com`, LINKED_MEMBER_CLERK_ID],
    );
    linkedMemberId = lId;

    // Unlinked member (no Clerk account — the core new case)
    const { insertId: uId } = await db.query(
      `INSERT INTO members (gym_id, name, email)
       VALUES (?, 'Carol Unlinked', ?)`,
      [gymId, `carol+${gymId}@test.com`],
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

  it('includes staff even when their Clerk user cannot be resolved (staff discovery is DB-only)', async () => {
    mockGetUser.mockClear();
    mockGetUser.mockImplementation(async (userId: string) => {
      if (userId === TEST_USER_ID) {
        return { publicMetadata: { platform_role: 'superadmin' }, fullName: 'Super', firstName: 'Super', lastName: 'Admin', emailAddresses: [], primaryEmailAddressId: null };
      }
      // Any other lookup (e.g. for STAFF_ID) fails, as it would for a user with no Clerk account.
      throw new Error('user not found in Clerk');
    });

    const res = await request
      .get('/platform/impersonation/targets')
      .set('Authorization', TEST_AUTH_HEADER)
      .query({ gym_id: gymId, q: 'Alice' });

    expect(res.status).toBe(200);
    const ids = res.body.map((u: any) => u.id);
    expect(ids).toContain(STAFF_ID);
    // Only requireSuperadmin's own Clerk lookup for the caller should have happened —
    // staff discovery must never call getUser for staff rows.
    expect(mockGetUser).not.toHaveBeenCalledWith(STAFF_ID);
  });

  it('returns status field on staff targets', async () => {
    const res = await request
      .get('/platform/impersonation/targets')
      .set('Authorization', TEST_AUTH_HEADER)
      .query({ gym_id: gymId, q: 'Alice' });

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].status).toBeDefined();
  });

  it('includes invited (non-active) staff in results', async () => {
    const invitedStaffId = 'impersonation-invited-staff-id';
    await db.query(
      `INSERT INTO gym_memberships (user_id, gym_id, role, status, name)
       VALUES (?, ?, 'trainer_performance', 'invited', 'Invited Trainer')`,
      [invitedStaffId, gymId],
    );

    const res = await request
      .get('/platform/impersonation/targets')
      .set('Authorization', TEST_AUTH_HEADER)
      .query({ gym_id: gymId, q: 'Invited' });

    expect(res.status).toBe(200);
    const match = res.body.find((u: any) => u.id === invitedStaffId);
    expect(match).toBeDefined();
    expect(match.status).toBe('invited');

    await db.query('DELETE FROM gym_memberships WHERE user_id = ?', [invitedStaffId]);
  });

  it('includes staff with no name/email (granted via existing Clerk user — regression #364)', async () => {
    // Mirrors a legacy direct grant: only user_id/gym_id/role are set, so both name and
    // email are NULL. A plain `name LIKE ?` filter used to silently drop this row.
    const namelessStaffId = 'impersonation-nameless-staff-id';
    await db.query(
      `INSERT INTO gym_memberships (user_id, gym_id, role) VALUES (?, ?, 'trainer_performance')`,
      [namelessStaffId, gymId],
    );

    const res = await request
      .get('/platform/impersonation/targets')
      .set('Authorization', TEST_AUTH_HEADER)
      .query({ gym_id: gymId, q: '' });

    expect(res.status).toBe(200);
    const match = res.body.find((u: any) => u.id === namelessStaffId);
    expect(match).toBeDefined();
    expect(match.name).toBe(namelessStaffId);

    await db.query('DELETE FROM gym_memberships WHERE user_id = ?', [namelessStaffId]);
  });

  it('shows the linked Staff record\'s name and profile for a login, and skips Staff rows with no login (#592)', async () => {
    const { insertId: gmId } = await db.query(
      `INSERT INTO gym_memberships (user_id, gym_id, role, status, name)
       VALUES ('impersonation-linked-staff-id', ?, 'front_desk', 'active', 'Legacy Name')`,
      [gymId],
    );
    await db.query(
      `INSERT INTO staff (gym_id, gym_membership_id, first_name, last_name, email, profile, hire_date, created_at, updated_at)
       VALUES (?, ?, 'Javier', 'Dominguez', 'javier@impersonation.test', 'Front Desk', '2026-01-01', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [gymId, gmId],
    );
    // HR record with no login — nothing to impersonate.
    await db.query(
      `INSERT INTO staff (gym_id, first_name, last_name, email, profile, hire_date, created_at, updated_at)
       VALUES (?, 'No', 'Login', 'nologin@impersonation.test', 'Accountant', '2026-01-01', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [gymId],
    );

    const res = await request
      .get('/platform/impersonation/targets')
      .set('Authorization', TEST_AUTH_HEADER)
      .query({ gym_id: gymId, q: 'Dominguez', type: 'staff' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: 'impersonation-linked-staff-id', name: 'Javier Dominguez', email: 'javier@impersonation.test',
      role: 'front_desk', profile: 'Front Desk', type: 'staff',
    });

    const all = await request
      .get('/platform/impersonation/targets')
      .set('Authorization', TEST_AUTH_HEADER)
      .query({ gym_id: gymId, q: '', type: 'staff' });
    expect(all.body.find((u: any) => u.name === 'No Login')).toBeUndefined();

    await db.query('DELETE FROM staff WHERE gym_id = ?', [gymId]);
    await db.query('DELETE FROM gym_memberships WHERE id = ?', [gmId]);
  });

  it('excludes members when type=staff is requested (Admin app impersonation dialog — #504)', async () => {
    const res = await request
      .get('/platform/impersonation/targets')
      .set('Authorization', TEST_AUTH_HEADER)
      .query({ gym_id: gymId, q: '', type: 'staff' });

    expect(res.status).toBe(200);
    const types = res.body.map((u: any) => u.type);
    expect(types).not.toContain('member');
    const ids = res.body.map((u: any) => u.id);
    expect(ids).toContain(STAFF_ID);
    expect(ids).not.toContain(`member:${linkedMemberId}`);
    expect(ids).not.toContain(`member:${unlinkedMemberId}`);
  });

  it('excludes staff when type=member is requested (Member app impersonation dialog)', async () => {
    const res = await request
      .get('/platform/impersonation/targets')
      .set('Authorization', TEST_AUTH_HEADER)
      .query({ gym_id: gymId, q: '', type: 'member' });

    expect(res.status).toBe(200);
    const types = res.body.map((u: any) => u.type);
    expect(types).not.toContain('staff');
    const ids = res.body.map((u: any) => u.id);
    expect(ids).not.toContain(STAFF_ID);
    expect(ids).toContain(`member:${linkedMemberId}`);
  });

  it('returns 400 for an invalid type value', async () => {
    const res = await request
      .get('/platform/impersonation/targets')
      .set('Authorization', TEST_AUTH_HEADER)
      .query({ gym_id: gymId, type: 'admin' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/type/);
  });

  it('does not include deleted members', async () => {
    const { insertId } = await db.query(
      `INSERT INTO members (gym_id, name, email, deleted_at)
       VALUES (?, 'Dave Deleted', ?, UTC_TIMESTAMP())`,
      [gymId, `dave+${gymId}@test.com`],
    );

    const res = await request
      .get('/platform/impersonation/targets')
      .set('Authorization', TEST_AUTH_HEADER)
      .query({ gym_id: gymId, q: 'Dave' });

    expect(res.status).toBe(200);
    const ids = res.body.map((u: any) => u.id);
    expect(ids).not.toContain(`member:${insertId}`);
  });

  it('does not include staff from a different gym (tenant isolation — #504)', async () => {
    const gymB = await createTestGym('Targets Test Gym B');
    const otherGymStaffId = 'impersonation-other-gym-staff-id';
    await db.query(
      `INSERT INTO gym_memberships (user_id, gym_id, role, status, name)
       VALUES (?, ?, 'admin', 'active', 'Javier Otro Gimnasio')`,
      [otherGymStaffId, gymB],
    );

    const res = await request
      .get('/platform/impersonation/targets')
      .set('Authorization', TEST_AUTH_HEADER)
      .query({ gym_id: gymId, q: '', type: 'staff' });

    expect(res.status).toBe(200);
    const ids = res.body.map((u: any) => u.id);
    expect(ids).not.toContain(otherGymStaffId);

    await db.query('DELETE FROM gym_memberships WHERE user_id = ?', [otherGymStaffId]);
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
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Eve Unlinked', ?)`,
      [gymId, `eve+${gymId}@test.com`],
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

  // The frontend sends the full "member:<N>" id from /targets — these tests mirror that format.

  it('returns 401 when no Authorization header', async () => {
    const res = await request
      .post(`/platform/impersonation/member:${memberId}`)
      .set('x-gym-id', gymId)
      .send({ targetType: 'member' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when targetType is missing', async () => {
    const res = await request
      .post(`/platform/impersonation/member:${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/targetType/);
  });

  it('returns 400 when x-gym-id header is missing', async () => {
    const res = await request
      .post(`/platform/impersonation/member:${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .send({ targetType: 'member' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/x-gym-id/);
  });

  it('succeeds for unlinked member using "member:<N>" format (frontend wire format)', async () => {
    const res = await request
      .post(`/platform/impersonation/member:${memberId}`)
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

  it('also succeeds with a plain integer id (backward compat)', async () => {
    const res = await request
      .post(`/platform/impersonation/${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ targetType: 'member' });
    expect(res.status).toBe(200);
  });

  it('returns 400 for deleted member', async () => {
    const { insertId } = await db.query(
      `INSERT INTO members (gym_id, name, email, deleted_at)
       VALUES (?, 'Frank Deleted', ?, UTC_TIMESTAMP())`,
      [gymId, `frank+${gymId}@test.com`],
    );
    const res = await request
      .post(`/platform/impersonation/member:${insertId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ targetType: 'member' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for member belonging to a different gym (tenant isolation)', async () => {
    const gymB = await createTestGym('Gym B Isolation Member');
    const res = await request
      .post(`/platform/impersonation/member:${memberId}`)
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
    // Also insert a members row so the linked clerk user has a profile in this gym
    await db.query(
      `INSERT IGNORE INTO members (gym_id, name, email, clerk_user_id)
       VALUES (?, 'Grace Staff', ?, ?)`,
      [gymId, `grace+${gymId}@test.com`, LINKED_MEMBER_CLERK_ID],
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

  it('refuses to start a session on a staff member whose invitation is still pending', async () => {
    const placeholderId = `invited_${Date.now()}`;
    await db.query(
      `INSERT INTO gym_memberships (user_id, gym_id, role, status, email, name)
       VALUES (?, ?, 'front_desk', 'invited', 'pending@impersonation.test', 'Pending Staff')`,
      [placeholderId, gymId],
    );

    const res = await request
      .post(`/platform/impersonation/${placeholderId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ targetType: 'staff' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not accepted their invitation/);
    await db.query('DELETE FROM gym_memberships WHERE user_id = ?', [placeholderId]);
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

  it('returns 400 for a superadmin target — superadmins carry no gym_memberships row', async () => {
    // Superadmin status is Clerk-only and irrelevant here: staff validation never
    // calls Clerk, so a superadmin target is rejected the same way as any other
    // user with no gym_memberships row for this gym.
    const res = await request
      .post(`/platform/impersonation/other-superadmin-id`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ targetType: 'staff' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/membership/);
  });

  it('returns 400 when target has no membership in the gym', async () => {
    const res = await request
      .post(`/platform/impersonation/no-membership-user-id`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ targetType: 'staff' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/membership/);
  });

  it('succeeds for staff even when Clerk lookup fails for the target (staff validation is DB-only)', async () => {
    mockGetUser.mockClear();
    mockGetUser.mockImplementation(async (userId: string) => {
      if (userId === TEST_USER_ID) {
        return { publicMetadata: { platform_role: 'superadmin' }, fullName: 'Super Admin', firstName: 'Super', lastName: 'Admin', emailAddresses: [], primaryEmailAddressId: null };
      }
      throw new Error('user not found in Clerk');
    });

    const res = await request
      .post(`/platform/impersonation/${LINKED_MEMBER_CLERK_ID}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ targetType: 'staff' });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(LINKED_MEMBER_CLERK_ID);
    expect(mockGetUser).not.toHaveBeenCalledWith(LINKED_MEMBER_CLERK_ID);
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

  it('refuses invited (non-active) staff by status, even with a non-placeholder id', async () => {
    // #342/#358 let POST start a session here, but tenantContext resolves the target
    // in Clerk on every request and an invited row has no Clerk user yet — the session
    // died on its first call. Invited staff still appear in GET /targets (see above);
    // only starting a session is refused.
    const invitedId = 'impersonation-invited-post-staff-id';
    await db.query(
      `INSERT INTO gym_memberships (user_id, gym_id, role, status, name)
       VALUES (?, ?, 'trainer_performance', 'invited', 'Invited Post Trainer')`,
      [invitedId, gymId],
    );

    const res = await request
      .post(`/platform/impersonation/${invitedId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ targetType: 'staff' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not accepted their invitation/);

    await db.query('DELETE FROM gym_memberships WHERE user_id = ?', [invitedId]);
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
