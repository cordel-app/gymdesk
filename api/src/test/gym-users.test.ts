import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

// gym-users.ts looks up the invited email in Clerk via getUserList — each test
// controls whether that email resolves to an "existing Clerk user" (the path
// that historically dropped the admin-entered name, #504) or to nobody (the
// new-invitation path).
const mockGetUserList = vi.hoisted(() => vi.fn().mockResolvedValue({ data: [], totalCount: 0 }));

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: {
        getUser: vi.fn().mockResolvedValue({
          publicMetadata: {}, fullName: 'Test User', firstName: 'Test', lastName: 'User', emailAddresses: [], primaryEmailAddressId: null,
        }),
        getUserList: mockGetUserList,
        deleteUser: vi.fn().mockResolvedValue({}),
      },
      invitations: {
        createInvitation: vi.fn().mockResolvedValue({ id: 'inv-test-id' }),
        revokeInvitation: vi.fn().mockResolvedValue({}),
      },
    })),
  };
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('gym-users', () => {
  let gymId: string;
  let gymBId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Gym Users Test Gym A');
    gymBId = await createTestGym('Gym Users Test Gym B');
    await createTestMembership(gymId, 'admin');
    // A non-admin membership in gym B for the same caller — used for the 403 check.
    await createTestMembership(gymBId, 'front_desk');
  });

  beforeEach(() => {
    mockGetUserList.mockReset();
    mockGetUserList.mockResolvedValue({ data: [], totalCount: 0 });
  });

  describe('POST /gym-users', () => {
    it('returns 401 when no Authorization header', async () => {
      const res = await request
        .post('/gym-users')
        .set('x-gym-id', gymId)
        .send({ email: 'nobody@test.com', role: 'front_desk' });
      expect(res.status).toBe(401);
    });

    it('returns 403 when caller is not an admin in the target gym', async () => {
      const res = await request
        .post('/gym-users')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymBId)
        .send({ email: 'nobody@test.com', role: 'front_desk' });
      expect(res.status).toBe(403);
    });

    it('persists the admin-entered name when granting an existing Clerk user (regression #504)', async () => {
      const clerkId = 'gym-users-existing-clerk-id';
      mockGetUserList.mockResolvedValue({
        data: [{ id: clerkId, emailAddresses: [{ id: 'e1', emailAddress: 'javier@test.com' }], primaryEmailAddressId: 'e1' }],
        totalCount: 1,
      });

      const res = await request
        .post('/gym-users')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ email: 'javier@test.com', name: 'Javier Dominguez', role: 'front_desk' });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('granted');
      expect(res.body.membership.name).toBe('Javier Dominguez');

      // The bug (#504 reopened): this INSERT previously omitted `name` entirely,
      // so the row was only ever findable/displayable by its raw Clerk user_id —
      // including in the Admin app's impersonation search.
      const { rows } = await db.query<{ name: string | null }>(
        'SELECT name FROM gym_memberships WHERE user_id = ? AND gym_id = ?',
        [clerkId, gymId],
      );
      expect(rows[0].name).toBe('Javier Dominguez');

      await db.query('DELETE FROM gym_memberships WHERE user_id = ?', [clerkId]);
    });

    it('re-granting a different role without a name preserves the previously saved name', async () => {
      const clerkId = 'gym-users-regrant-clerk-id';
      mockGetUserList.mockResolvedValue({
        data: [{ id: clerkId, emailAddresses: [{ id: 'e1', emailAddress: 'regrant@test.com' }], primaryEmailAddressId: 'e1' }],
        totalCount: 1,
      });

      await db.query(
        `INSERT INTO gym_memberships (user_id, gym_id, role, name) VALUES (?, ?, 'front_desk', 'Original Name')`,
        [clerkId, gymId],
      );

      const res = await request
        .post('/gym-users')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ email: 'regrant@test.com', role: 'accountant' });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('granted');
      expect(res.body.membership.role).toBe('accountant');
      expect(res.body.membership.name).toBe('Original Name');

      await db.query('DELETE FROM gym_memberships WHERE user_id = ?', [clerkId]);
    });

    it('sends a Clerk invitation and stores the name for an email Clerk does not know', async () => {
      const res = await request
        .post('/gym-users')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ email: 'brandnew@test.com', name: 'Brand New', role: 'front_desk' });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('invited');

      const { rows } = await db.query<{ name: string | null; status: string }>(
        'SELECT name, status FROM gym_memberships WHERE email = ? AND gym_id = ?',
        ['brandnew@test.com', gymId],
      );
      expect(rows[0].name).toBe('Brand New');
      expect(rows[0].status).toBe('invited');

      await db.query('DELETE FROM gym_memberships WHERE email = ?', ['brandnew@test.com']);
    });
  });

  describe('GET /gym-users — tenant isolation', () => {
    it('does not return members from a different gym', async () => {
      const otherGymUserId = 'gym-users-other-gym-id';
      await db.query(
        `INSERT INTO gym_memberships (user_id, gym_id, role, name) VALUES (?, ?, 'front_desk', 'Other Gym Person')`,
        [otherGymUserId, gymBId],
      );

      const res = await request
        .get('/gym-users')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);

      expect(res.status).toBe(200);
      const ids = res.body.map((r: any) => r.user_id);
      expect(ids).not.toContain(otherGymUserId);

      await db.query('DELETE FROM gym_memberships WHERE user_id = ?', [otherGymUserId]);
    });
  });
});
