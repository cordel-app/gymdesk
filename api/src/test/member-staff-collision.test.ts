// #594: one email is never both member and staff of the same gym. Both sides
// refuse with 409 instead of silently flipping the single gym_memberships role.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  TEST_USER_ID,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

const clerk = vi.hoisted(() => ({
  getUserList: vi.fn().mockResolvedValue({ data: [], totalCount: 0 }),
  getUser: vi.fn(),
  createInvitation: vi.fn().mockResolvedValue({ id: 'inv-test-id' }),
}));

const REGULAR_USER = { publicMetadata: {}, fullName: 'Test User', firstName: 'Test', lastName: 'User', emailAddresses: [] as any[], primaryEmailAddressId: null };

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: {
        getUser: clerk.getUser,
        getUserList: clerk.getUserList,
        deleteUser: vi.fn().mockResolvedValue({}),
        updateUserMetadata: vi.fn().mockResolvedValue({}),
      },
      invitations: {
        createInvitation: clerk.createInvitation,
        revokeInvitation: vi.fn().mockResolvedValue({}),
      },
    })),
  };
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

let seq = 0;
const uniqueEmail = (tag: string) => `${tag}-${Date.now()}-${++seq}@collision.test`;

const STAFF_BASE = { first_name: 'Work', last_name: 'Account', profile: 'Front Desk', hire_date: '2026-01-15' };

async function insertMember(gymId: string, email: string, clerkUserId: string | null = null): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, 'Personal Account', ?, ?)`,
    [gymId, email, clerkUserId],
  );
  return insertId as number;
}

async function insertStaff(gymId: string, email: string, membershipId: number | null = null): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO staff (gym_id, gym_membership_id, first_name, last_name, email, profile, hire_date, created_at, updated_at)
     VALUES (?, ?, 'Work', 'Account', ?, 'Front Desk', '2026-01-01', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [gymId, membershipId, email],
  );
  return insertId as number;
}

async function insertStaffMembership(gymId: string, userId: string, email: string | null = null, status = 'active'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO gym_memberships (user_id, gym_id, role, status, email) VALUES (?, ?, 'front_desk', ?, ?)`,
    [userId, gymId, status, email],
  );
  return insertId as number;
}

const auth = (r: any, gymId: string) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

describe('member/staff email collision (#594)', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Collision Gym');
    await createTestMembership(gymId, 'admin');
    // POST /members requires the gym to have at least one center.
    await db.query(`INSERT INTO centers (gym_id, name) VALUES (?, 'Main Center')`, [gymId]);
  });

  beforeEach(() => {
    clerk.getUserList.mockReset().mockResolvedValue({ data: [], totalCount: 0 });
    clerk.getUser.mockReset().mockResolvedValue(REGULAR_USER);
    clerk.createInvitation.mockClear();
  });

  describe('staff side', () => {
    it('POST /staff refuses a member\'s email and saves nothing', async () => {
      const email = uniqueEmail('member');
      await insertMember(gymId, email);

      const res = await auth(request.post('/staff'), gymId).send({ ...STAFF_BASE, email });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/registered as a member/);
      const { rows } = await db.query('SELECT id FROM staff WHERE gym_id = ? AND email = ?', [gymId, email]);
      expect(rows).toHaveLength(0);
      expect(clerk.createInvitation).not.toHaveBeenCalled();
    });

    it('POST /staff matches the member email case-insensitively', async () => {
      const email = uniqueEmail('Mixed.Case');
      await insertMember(gymId, email.toLowerCase());

      const res = await auth(request.post('/staff'), gymId).send({ ...STAFF_BASE, email: email.toUpperCase() });
      expect(res.status).toBe(409);
    });

    it('POST /staff refuses when the Clerk account already holds a member row in the gym', async () => {
      // No `members` row on this email (e.g. it was soft-deleted), but the account
      // is still a member of the gym — grantAccess must not flip that row.
      const email = uniqueEmail('linked');
      const clerkId = `clerk-${email}`;
      clerk.getUserList.mockResolvedValue({ data: [{ id: clerkId, emailAddresses: [{ id: 'e1', emailAddress: email }], primaryEmailAddressId: 'e1' }], totalCount: 1 });
      await db.query(`INSERT INTO gym_memberships (user_id, gym_id, role) VALUES (?, ?, 'member')`, [clerkId, gymId]);

      const res = await auth(request.post('/staff'), gymId).send({ ...STAFF_BASE, email });

      expect(res.status).toBe(409);
      const { rows } = await db.query<{ role: string }>('SELECT role FROM gym_memberships WHERE user_id = ?', [clerkId]);
      expect(rows[0].role).toBe('member');
      await db.query('DELETE FROM gym_memberships WHERE user_id = ?', [clerkId]);
    });

    it('POST /staff/:id/access refuses for an existing staff row whose email is a member\'s', async () => {
      const email = uniqueEmail('retry');
      const staffId = await insertStaff(gymId, email);
      await insertMember(gymId, email);

      const res = await auth(request.post(`/staff/${staffId}/access`), gymId);

      expect(res.status).toBe(409);
      const { rows } = await db.query<{ gym_membership_id: number | null }>('SELECT gym_membership_id FROM staff WHERE id = ?', [staffId]);
      expect(rows[0].gym_membership_id).toBeNull();
    });

    it('PUT /staff/:id refuses changing the email to a member\'s', async () => {
      const original = uniqueEmail('orig');
      const memberEmail = uniqueEmail('taken');
      const staffId = await insertStaff(gymId, original);
      await insertMember(gymId, memberEmail);

      const res = await auth(request.put(`/staff/${staffId}`), gymId).send({ ...STAFF_BASE, email: memberEmail });

      expect(res.status).toBe(409);
      const { rows } = await db.query<{ email: string }>('SELECT email FROM staff WHERE id = ?', [staffId]);
      expect(rows[0].email).toBe(original);
    });

    it('still grants access when the email is not a member of the gym', async () => {
      const res = await auth(request.post('/staff'), gymId).send({ ...STAFF_BASE, email: uniqueEmail('clean') });
      expect(res.status).toBe(201);
      expect(res.body.access).toEqual({ status: 'invited' });
    });
  });

  describe('member side', () => {
    it('POST /members refuses an email that is a linked staff login', async () => {
      const email = uniqueEmail('staff');
      const gmId = await insertStaffMembership(gymId, `clerk-${email}`);
      await insertStaff(gymId, email, gmId);

      const res = await auth(request.post('/members'), gymId).send({ name: 'Personal', email });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/staff login/);
      const { rows } = await db.query('SELECT id FROM members WHERE gym_id = ? AND email = ?', [gymId, email]);
      expect(rows).toHaveLength(0);
    });

    it('POST /members refuses an email with a pending staff invitation', async () => {
      const email = uniqueEmail('pending');
      await insertStaffMembership(gymId, `invited_${Date.now()}`, email, 'invited');

      const res = await auth(request.post('/members'), gymId).send({ name: 'Personal', email });
      expect(res.status).toBe(409);
    });

    it('POST /members/:id/invite refuses when the member\'s email became a staff login', async () => {
      const email = uniqueEmail('late');
      const memberId = await insertMember(gymId, email);
      const gmId = await insertStaffMembership(gymId, `clerk-${email}`);
      await insertStaff(gymId, email, gmId);

      const res = await auth(request.post(`/members/${memberId}/invite`), gymId);

      expect(res.status).toBe(409);
      expect(clerk.createInvitation).not.toHaveBeenCalled();
    });

    it('POST /me/link refuses when the signing-in account is already staff in the gym', async () => {
      const gymBId = await createTestGym('Collision Gym B');
      const email = uniqueEmail('owner');
      // The caller is front_desk in gym B and tries to link a member row on their own email.
      await createTestMembership(gymBId, 'front_desk');
      await insertMember(gymBId, email);
      clerk.getUser.mockResolvedValue({ ...REGULAR_USER, emailAddresses: [{ id: 'e1', emailAddress: email }] });

      const res = await request.post('/me/link').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymBId);

      expect(res.status).toBe(409);
      const { rows } = await db.query<{ clerk_user_id: string | null }>('SELECT clerk_user_id FROM members WHERE gym_id = ? AND email = ?', [gymBId, email]);
      expect(rows[0].clerk_user_id).toBeNull();
      const { rows: gm } = await db.query<{ role: string }>('SELECT role FROM gym_memberships WHERE user_id = ? AND gym_id = ?', [TEST_USER_ID, gymBId]);
      expect(gm[0].role).toBe('front_desk');
    });
  });
});
