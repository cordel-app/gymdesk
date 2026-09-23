// #709 part 1: DELETE /members/:id removes the member's Clerk login when that
// was its last link to Gymdesk (as staff revokeAccess() already does) and then
// unlinks the member. A login still linked elsewhere is kept and stays linked.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, TEST_USER_ID, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

const clerk = vi.hoisted(() => ({
  users: new Map<string, any>(),
  getUser: vi.fn(),
  deleteUser: vi.fn(),
  revokeInvitation: vi.fn(),
}));

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: {
        getUser: clerk.getUser,
        getUserList: vi.fn().mockResolvedValue({ data: [], totalCount: 0 }),
        deleteUser: clerk.deleteUser,
      },
      invitations: { createInvitation: vi.fn().mockResolvedValue({ id: 'inv-reinvite' }), revokeInvitation: clerk.revokeInvitation },
    })),
  };
});

const RUN = `mdel-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const uid = (tag: string) => `${RUN}-${tag}`;
const REGULAR = { publicMetadata: {}, fullName: 'Test User', firstName: 'Test', lastName: 'User' };

let gymId: string;
let otherGymId: string;

beforeAll(async () => {
  gymId = await createTestGym('Member Delete Clerk Gym');
  otherGymId = await createTestGym('Member Delete Clerk Other Gym');
  await createTestMembership(gymId, 'admin');
});

beforeEach(() => {
  clerk.users.clear();
  clerk.users.set(TEST_USER_ID, REGULAR);
  clerk.getUser.mockReset().mockImplementation(async (id: string) => {
    const u = clerk.users.get(id);
    if (!u) throw Object.assign(new Error('not found'), { status: 404 });
    return u;
  });
  clerk.deleteUser.mockReset().mockResolvedValue({});
  clerk.revokeInvitation.mockReset().mockResolvedValue({});
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

/** A member of gymId signed in with Clerk account `clerkUserId`, plus its member-role login row. */
async function linkedMember(clerkUserId: string) {
  clerk.users.set(clerkUserId, { ...REGULAR, id: clerkUserId });
  const { insertId } = await db.query(
    'INSERT INTO members (name, email, gym_id, clerk_user_id) VALUES (?, ?, ?, ?)',
    [`Member ${clerkUserId}`, `${clerkUserId}@mdel.test`, gymId, clerkUserId],
  );
  await createTestMembership(gymId, 'member', clerkUserId);
  return insertId as number;
}

const remove = (id: number) =>
  request.delete(`/members/${id}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function memberRow(id: number) {
  const { rows } = await db.query<any>('SELECT clerk_user_id, deleted_at FROM members WHERE id = ?', [id]);
  return rows[0];
}
async function loginRows(userId: string) {
  const { rows } = await db.query<any>('SELECT gym_id, role FROM gym_memberships WHERE user_id = ?', [userId]);
  return rows;
}

describe('DELETE /members/:id — Clerk login (#709)', () => {
  it('last link → deletes the Clerk account, then soft-deletes and unlinks the member', async () => {
    const cid = uid('last');
    const memberId = await linkedMember(cid);

    const res = await remove(memberId);

    expect(res.status).toBe(204);
    expect(clerk.deleteUser).toHaveBeenCalledWith(cid);
    expect(await memberRow(memberId)).toMatchObject({ clerk_user_id: null });
    expect((await memberRow(memberId)).deleted_at).not.toBeNull();
    expect(await loginRows(cid)).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 50));
    const { rows: audit } = await db.query<any>(
      "SELECT new_values FROM audit_logs WHERE gym_id = ? AND entity_type = 'member' AND entity_id = ? AND action = 'soft_delete'",
      [gymId, String(memberId)],
    );
    const next = typeof audit[0].new_values === 'string' ? JSON.parse(audit[0].new_values) : audit[0].new_values;
    expect(next).toMatchObject({ login_unlinked: true, clerk_account_deleted: true });
  });

  it('still staff in another gym → keeps the Clerk account AND the member\'s link, so a Recycle Bin restore reconnects them', async () => {
    const cid = uid('staff-elsewhere');
    const memberId = await linkedMember(cid);
    await createTestMembership(otherGymId, 'front_desk', cid);

    const res = await remove(memberId);

    expect(res.status).toBe(204);
    expect(clerk.deleteUser).not.toHaveBeenCalled();
    expect(await memberRow(memberId)).toMatchObject({ clerk_user_id: cid });
    expect((await memberRow(memberId)).deleted_at).not.toBeNull();
    const rows = await loginRows(cid);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([{ gym_id: gymId, role: 'member' }, { gym_id: otherGymId, role: 'front_desk' }]));
  });

  it('a superadmin member keeps the Clerk account and stays linked', async () => {
    const cid = uid('superadmin');
    const memberId = await linkedMember(cid);
    clerk.users.set(cid, { ...REGULAR, id: cid, publicMetadata: { platform_role: 'superadmin' } });

    expect((await remove(memberId)).status).toBe(204);
    expect(clerk.deleteUser).not.toHaveBeenCalled();
    expect(await memberRow(memberId)).toMatchObject({ clerk_user_id: cid });
  });

  it('after the login was deleted, the member can be invited again (no stale link blocks it)', async () => {
    const cid = uid('reinvite');
    const memberId = await linkedMember(cid);
    await remove(memberId);
    // Simulate a Recycle Bin restore (that route is behind a feature flag).
    await db.query('UPDATE members SET deleted_at = NULL, deleted_by_name = NULL WHERE id = ?', [memberId]);

    const res = await request.post(`/members/${memberId}/invite`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

    expect(res.status).toBeLessThan(300);
  });

  it('Clerk delete fails → 502 and the member, its link and its login stay untouched', async () => {
    const cid = uid('clerk-502');
    const memberId = await linkedMember(cid);
    clerk.deleteUser.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));

    const res = await remove(memberId);

    expect(res.status).toBe(502);
    expect(await memberRow(memberId)).toMatchObject({ clerk_user_id: cid, deleted_at: null });
    expect(await loginRows(cid)).toHaveLength(1);
  });

  it('account already gone in Clerk (404) → no delete call, member still removed and unlinked', async () => {
    const cid = uid('gone');
    const memberId = await linkedMember(cid);
    clerk.users.delete(cid);

    const res = await remove(memberId);

    expect(res.status).toBe(204);
    expect(clerk.deleteUser).not.toHaveBeenCalled();
    expect(await memberRow(memberId)).toMatchObject({ clerk_user_id: null });
    expect(await loginRows(cid)).toHaveLength(0);
  });

  it('never signed in (pending invitation) → unchanged: invitation revoked, no Clerk user touched', async () => {
    const { insertId } = await db.query(
      'INSERT INTO members (name, email, gym_id, invitation_id) VALUES (?, ?, ?, ?)',
      ['Invited Only', `${uid('invited')}@mdel.test`, gymId, 'inv-pending'],
    );

    const res = await remove(insertId as number);

    expect(res.status).toBe(204);
    expect(clerk.revokeInvitation).toHaveBeenCalledWith('inv-pending');
    expect(clerk.deleteUser).not.toHaveBeenCalled();
  });
});
