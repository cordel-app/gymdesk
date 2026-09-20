// #592: Staff records own their login (gym_memberships) via staff.gym_membership_id.
// Covers the grant-on-create / sync-on-update / revoke-on-deactivate-delete flow and
// the explicit POST/DELETE /staff/:id/access endpoints that replaced the Team page.

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

// Each test decides whether the staff email resolves to an existing Clerk user
// (direct grant) or to nobody (invitation path). Spies on the invitation / user
// mutations let tests assert which Clerk side effects fired.
const clerk = vi.hoisted(() => ({
  getUserList: vi.fn().mockResolvedValue({ data: [], totalCount: 0 }),
  getUser: vi.fn(),
  deleteUser: vi.fn().mockResolvedValue({}),
  createInvitation: vi.fn().mockResolvedValue({ id: 'inv-test-id' }),
  revokeInvitation: vi.fn().mockResolvedValue({}),
}));

const REGULAR_USER = { publicMetadata: {}, fullName: 'Test User', firstName: 'Test', lastName: 'User', emailAddresses: [], primaryEmailAddressId: null };
const SUPERADMIN = { ...REGULAR_USER, publicMetadata: { platform_role: 'superadmin' } };

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: {
        getUser: clerk.getUser,
        getUserList: clerk.getUserList,
        deleteUser: clerk.deleteUser,
        updateUserMetadata: vi.fn().mockResolvedValue({}),
      },
      invitations: {
        createInvitation: clerk.createInvitation,
        revokeInvitation: clerk.revokeInvitation,
      },
    })),
  };
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

const BASE = {
  first_name: 'Javier',
  last_name: 'Dominguez',
  profile: 'Front Desk',
  hire_date: '2026-01-15',
};

let seq = 0;
const uniqueEmail = (tag: string) => `${tag}-${Date.now()}-${++seq}@staff-access.test`;

async function postStaff(gymId: string, body: Record<string, unknown>) {
  return request
    .post('/staff')
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ ...BASE, ...body });
}

async function membershipFor(staffId: number) {
  const { rows } = await db.query<any>(
    `SELECT gm.* FROM staff s JOIN gym_memberships gm ON gm.id = s.gym_membership_id WHERE s.id = ?`,
    [staffId],
  );
  return rows[0] ?? null;
}

function knownClerkUser(id: string, email: string) {
  clerk.getUserList.mockResolvedValue({
    data: [{ id, emailAddresses: [{ id: 'e1', emailAddress: email }], primaryEmailAddressId: 'e1' }],
    totalCount: 1,
  });
}

describe('staff access (#592)', () => {
  let gymId: string;
  let gymBId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Staff Access Gym A');
    gymBId = await createTestGym('Staff Access Gym B');
    await createTestMembership(gymId, 'admin');
    // Non-admin membership in gym B for the same caller — used for the 403 check.
    await createTestMembership(gymBId, 'front_desk');
  });

  beforeEach(() => {
    clerk.getUserList.mockReset().mockResolvedValue({ data: [], totalCount: 0 });
    clerk.getUser.mockReset().mockResolvedValue(REGULAR_USER);
    clerk.deleteUser.mockClear();
    clerk.createInvitation.mockReset().mockResolvedValue({ id: 'inv-test-id' });
    clerk.revokeInvitation.mockClear();
  });

  describe('auth + tenant isolation', () => {
    it('returns 401 without auth', async () => {
      const res = await request.post('/staff/1/access').set('x-gym-id', gymId);
      expect(res.status).toBe(401);
    });

    it('returns 403 when the caller is not an admin in the gym', async () => {
      const res = await request
        .post('/staff/1/access')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymBId);
      expect(res.status).toBe(403);
    });

    it('returns 404 when granting access to a gym B staff row with gym A credentials', async () => {
      const { insertId } = await db.query(
        `INSERT INTO staff (gym_id, first_name, last_name, email, profile, hire_date, created_at, updated_at)
         VALUES (?, 'Other', 'Gym', ?, 'Front Desk', '2026-01-01', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        [gymBId, uniqueEmail('other-gym')],
      );
      const res = await request
        .post(`/staff/${insertId}/access`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /staff — grant on create', () => {
    it('links an existing Clerk user with the role mapped from the profile and the full name', async () => {
      const email = uniqueEmail('existing');
      const clerkId = `clerk-${email}`;
      knownClerkUser(clerkId, email);

      const res = await postStaff(gymId, { email, profile: 'Nutritionist' });

      expect(res.status).toBe(201);
      expect(res.body.access).toEqual({ status: 'granted' });
      expect(res.body.gym_membership_id).toBeTruthy();

      const gm = await membershipFor(res.body.id);
      expect(gm.user_id).toBe(clerkId);
      expect(gm.role).toBe('nutritionist');
      expect(gm.status).toBe('active');
      expect(gm.name).toBe('Javier Dominguez');
      expect(clerk.createInvitation).not.toHaveBeenCalled();
    });

    it('invites an email Clerk does not know and links the invited placeholder row', async () => {
      const email = uniqueEmail('Brand.New');

      const res = await postStaff(gymId, { email, profile: 'Personal Trainer' });

      expect(res.status).toBe(201);
      expect(res.body.access).toEqual({ status: 'invited' });

      const gm = await membershipFor(res.body.id);
      expect(gm.status).toBe('invited');
      expect(gm.user_id).toMatch(/^invited_/);
      expect(gm.role).toBe('trainer_performance');
      expect(gm.email).toBe(email.toLowerCase());
      expect(gm.name).toBe('Javier Dominguez');
      expect(gm.invitation_id).toBe('inv-test-id');
      expect(clerk.createInvitation).toHaveBeenCalledWith(expect.objectContaining({
        emailAddress: email.toLowerCase(),
        publicMetadata: { gym_invite: { gym_id: gymId, role: 'trainer_performance' } },
      }));
    });

    it('rejects a profile outside the fixed profile → role map', async () => {
      const res = await postStaff(gymId, { email: uniqueEmail('bad-profile'), profile: 'Trainer' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/profile must be one of/);
    });

    it('does not grant access to an employee created as inactive', async () => {
      const res = await postStaff(gymId, { email: uniqueEmail('inactive'), employment_status: 'inactive' });
      expect(res.status).toBe(201);
      expect(res.body.access).toEqual({ status: 'not_enrolled' });
      expect(res.body.gym_membership_id).toBeNull();
      expect(clerk.createInvitation).not.toHaveBeenCalled();
    });

    it('keeps the staff row and reports the failure when Clerk rejects the invitation', async () => {
      clerk.createInvitation.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));

      const res = await postStaff(gymId, { email: uniqueEmail('clerk-down') });

      expect(res.status).toBe(201);
      expect(res.body.access.status).toBe('error');
      expect(res.body.gym_membership_id).toBeNull();
      const { rows } = await db.query('SELECT id FROM staff WHERE id = ?', [res.body.id]);
      expect(rows).toHaveLength(1);
    });
  });

  describe('POST /staff/:id/access — retry / resend', () => {
    it('grants access to a not-enrolled staff member', async () => {
      const created = await postStaff(gymId, { email: uniqueEmail('later'), employment_status: 'inactive' });
      expect(created.body.gym_membership_id).toBeNull();

      const res = await request
        .post(`/staff/${created.body.id}/access`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('invited');
      expect(await membershipFor(created.body.id)).not.toBeNull();
    });

    it('re-sends a pending invitation and overwrites the stored invitation_id', async () => {
      const created = await postStaff(gymId, { email: uniqueEmail('resend') });
      clerk.createInvitation.mockResolvedValue({ id: 'inv-second-id' });

      const res = await request
        .post(`/staff/${created.body.id}/access`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('reinvited');
      expect((await membershipFor(created.body.id)).invitation_id).toBe('inv-second-id');
    });

    it('is a no-op for an already active login', async () => {
      const email = uniqueEmail('active');
      knownClerkUser(`clerk-${email}`, email);
      const created = await postStaff(gymId, { email });

      const res = await request
        .post(`/staff/${created.body.id}/access`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('already_granted');
    });
  });

  describe('PUT /staff/:id — login follows the HR record', () => {
    it('syncs role and name onto the linked membership', async () => {
      const email = uniqueEmail('sync');
      knownClerkUser(`clerk-${email}`, email);
      const created = await postStaff(gymId, { email, profile: 'Front Desk' });

      const res = await request
        .put(`/staff/${created.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ ...BASE, email, first_name: 'Xavi', profile: 'Accountant' });

      expect(res.status).toBe(200);
      const gm = await membershipFor(created.body.id);
      expect(gm.role).toBe('accountant');
      expect(gm.name).toBe('Xavi Dominguez');
    });

    it('refuses to demote the gym\'s last admin', async () => {
      // Caller acts as a superadmin (no membership row) so the Gym Manager below is the only admin.
      clerk.getUser.mockResolvedValue(SUPERADMIN);
      const gymCId = await createTestGym('Staff Access Gym C');
      const email = uniqueEmail('manager');
      knownClerkUser(`clerk-${email}`, email);
      const created = await postStaff(gymCId, { email, profile: 'Gym Manager' });
      expect((await membershipFor(created.body.id)).role).toBe('admin');

      const res = await request
        .put(`/staff/${created.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymCId)
        .send({ ...BASE, email, profile: 'Front Desk' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/last admin/);
      expect((await membershipFor(created.body.id)).role).toBe('admin');
    });

    it('refuses to change the caller\'s own role', async () => {
      const email = uniqueEmail('self');
      knownClerkUser(TEST_USER_ID, email);
      const created = await postStaff(gymId, { email, profile: 'Gym Manager' });
      // The caller already has the admin membership in gym A; the grant re-used it.
      expect((await membershipFor(created.body.id)).user_id).toBe(TEST_USER_ID);

      const res = await request
        .put(`/staff/${created.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ ...BASE, email, profile: 'Front Desk' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/your own role/);

      // Unlink so the shared caller membership survives later revoke tests.
      await db.query('UPDATE staff SET gym_membership_id = NULL WHERE id = ?', [created.body.id]);
    });
  });

  describe('revoking', () => {
    it('PATCH /deactivate revokes a pending invitation and unlinks, keeping the HR record', async () => {
      const created = await postStaff(gymId, { email: uniqueEmail('deactivate') });
      const gmId = created.body.gym_membership_id;

      const res = await request
        .patch(`/staff/${created.body.id}/deactivate`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);

      expect(res.status).toBe(200);
      expect(res.body.employment_status).toBe('inactive');
      expect(res.body.gym_membership_id).toBeNull();
      expect(clerk.revokeInvitation).toHaveBeenCalledWith('inv-test-id');
      const { rows } = await db.query('SELECT id FROM gym_memberships WHERE id = ?', [gmId]);
      expect(rows).toHaveLength(0);
    });

    it('PATCH /deactivate removes an active login but keeps the Clerk account', async () => {
      const email = uniqueEmail('deactivate-active');
      knownClerkUser(`clerk-${email}`, email);
      const created = await postStaff(gymId, { email });

      const res = await request
        .patch(`/staff/${created.body.id}/deactivate`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);

      expect(res.status).toBe(200);
      expect(clerk.deleteUser).not.toHaveBeenCalled();
      expect(await membershipFor(created.body.id)).toBeNull();
    });

    it('DELETE /staff/:id also deletes the Clerk account when this was their last gym', async () => {
      const email = uniqueEmail('delete');
      const clerkId = `clerk-${email}`;
      knownClerkUser(clerkId, email);
      const created = await postStaff(gymId, { email });

      const res = await request
        .delete(`/staff/${created.body.id}`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);

      expect(res.status).toBe(204);
      expect(clerk.deleteUser).toHaveBeenCalledWith(clerkId);
      const { rows } = await db.query('SELECT id FROM gym_memberships WHERE user_id = ?', [clerkId]);
      expect(rows).toHaveLength(0);
    });

    it('DELETE /staff/:id/access revokes the login and leaves the staff row active', async () => {
      const email = uniqueEmail('revoke-only');
      knownClerkUser(`clerk-${email}`, email);
      const created = await postStaff(gymId, { email });

      const res = await request
        .delete(`/staff/${created.body.id}/access`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);

      expect(res.status).toBe(204);
      expect(clerk.deleteUser).not.toHaveBeenCalled();
      const { rows } = await db.query<any>('SELECT employment_status, gym_membership_id FROM staff WHERE id = ?', [created.body.id]);
      expect(rows[0].employment_status).toBe('active');
      expect(rows[0].gym_membership_id).toBeNull();
    });

    it('refuses to revoke the caller\'s own access', async () => {
      const email = uniqueEmail('self-revoke');
      knownClerkUser(TEST_USER_ID, email);
      const created = await postStaff(gymId, { email, profile: 'Gym Manager' });

      const res = await request
        .delete(`/staff/${created.body.id}/access`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/your own access/);
      await db.query('UPDATE staff SET gym_membership_id = NULL WHERE id = ?', [created.body.id]);
    });
  });
});
