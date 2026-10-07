// Tests for POST /me/link — linking by the invitation's member id (#1075, Hide My Email)
// When no unlinked members row matches the Clerk user's email and the user carries
// server-set `publicMetadata.gym_signup` for THIS gym (copied by Clerk from the
// invitation issued by POST /public/gyms/:gymRef/registrations), /me/link creates the
// member on first sign-in instead of returning 404.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  getUser: vi.fn(),
  updateUserMetadata: vi.fn(),
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
        updateUserMetadata: clerk.updateUserMetadata,
      },
      invitations: {
        createInvitation: vi.fn().mockResolvedValue({ id: 'inv-test-id' }),
        revokeInvitation: vi.fn().mockResolvedValue({}),
      },
    })),
  };
});

let seq = 0;
const uniqueEmail = (tag: string) => `${tag}-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 7)}@me-link-invite.test`;

function clerkUser(email: string, metadata: Record<string, unknown> = {}) {
  return {
    id: TEST_USER_ID,
    emailAddresses: [{ id: 'e1', emailAddress: email }],
    publicMetadata: metadata,
    firstName: 'Clerk',
    lastName: 'Name',
  };
}
const link = (gymId: string) => request.post('/me/link').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const gymIds: string[] = [];
async function newGym(name: string) { const id = await createTestGym(name); gymIds.push(id); return id; }
async function insertMember(gymId: string, email: string): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (name, email, gym_id) VALUES (?, ?, ?)', ['Invited', email, gymId]);
  return insertId as number;
}

let gymId: string;
beforeAll(async () => {
  await db.query('UPDATE members SET clerk_user_id = NULL WHERE clerk_user_id = ?', [TEST_USER_ID]);
  await createTestMembership(await newGym('Invite Admin Gym'), 'admin');
});
beforeEach(async () => {
  clerk.getUser.mockReset();
  clerk.updateUserMetadata.mockReset().mockResolvedValue({});
  gymId = await newGym('Invite Gym');
});
afterEach(async () => {
  const marks = gymIds.map(() => '?').join(',');
  await db.query(`DELETE FROM members WHERE gym_id IN (${marks})`, gymIds);
});
afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('POST /me/link — invitation member id (#1075)', () => {
  it('links a relay-address sign-in to the invited member and clears the metadata', async () => {
    const memberId = await insertMember(gymId, uniqueEmail('real'));
    clerk.getUser.mockResolvedValue(
      clerkUser('abc123@privaterelay.appleid.com', { member_invite: { gym_id: gymId, member_id: memberId } }),
    );
    const res = await link(gymId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: memberId, clerk_user_id: TEST_USER_ID });
    expect(clerk.updateUserMetadata).toHaveBeenCalledWith(TEST_USER_ID, { publicMetadata: { member_invite: null } });
  });

  it('ignores an invitation naming another gym → 404', async () => {
    const memberId = await insertMember(gymId, uniqueEmail('real'));
    const other = await newGym('Other Invite Gym');
    clerk.getUser.mockResolvedValue(
      clerkUser('x@privaterelay.appleid.com', { member_invite: { gym_id: other, member_id: memberId } }),
    );
    expect((await link(gymId)).status).toBe(404);
  });

  it('falls back to the email when the invitation names a member that is already linked', async () => {
    const email = uniqueEmail('fallback');
    const memberId = await insertMember(gymId, email);
    clerk.getUser.mockResolvedValue(clerkUser(email, { member_invite: { gym_id: gymId, member_id: memberId + 9999 } }));
    const res = await link(gymId);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(memberId);
  });

  it('still links by email with no metadata (pre-#1075 invitations)', async () => {
    const email = uniqueEmail('legacy');
    const memberId = await insertMember(gymId, email);
    clerk.getUser.mockResolvedValue(clerkUser(email));
    const res = await link(gymId);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(memberId);
    expect(clerk.updateUserMetadata).not.toHaveBeenCalled();
  });
});
