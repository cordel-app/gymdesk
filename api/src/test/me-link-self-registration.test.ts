// Tests for me.ts router — POST /me/link, website self-registration extension (#599)
// When no unlinked members row matches the Clerk user's email and the user carries
// server-set `publicMetadata.gym_signup` for THIS gym (copied by Clerk from the
// invitation issued by POST /public/gyms/:slug/registrations), /me/link creates the
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
const uniqueEmail = (tag: string) =>
  `${tag}-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 7)}@me-link-selfreg.test`;

async function insertCenter(gymId: string, name = 'Main Center'): Promise<number> {
  const { insertId } = await db.query(`INSERT INTO centers (gym_id, name, status) VALUES (?, ?, 'active')`, [gymId, name]);
  return insertId as number;
}

/** What Clerk returns for the signed-in user; `signup` is the invitation metadata. */
function clerkUser(email: string, signup?: Record<string, unknown> | null, extra: Record<string, unknown> = {}) {
  return {
    id: TEST_USER_ID,
    emailAddresses: [{ id: 'e1', emailAddress: email }],
    publicMetadata: signup ? { gym_signup: signup } : {},
    firstName: 'Clerk',
    lastName: 'Name',
    fullName: 'Clerk Name',
    ...extra,
  };
}

const link = (gymId: string) => request.post('/me/link').set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function membersOf(gymId: string) {
  const { rows } = await db.query<any>('SELECT * FROM members WHERE gym_id = ? ORDER BY id', [gymId]);
  return rows;
}

async function membershipOf(gymId: string, userId = TEST_USER_ID) {
  const { rows } = await db.query<any>('SELECT * FROM gym_memberships WHERE gym_id = ? AND user_id = ?', [gymId, userId]);
  return rows[0] ?? null;
}

// members.clerk_user_id is UNIQUE platform-wide and TEST_USER_ID is fixed: a row linked
// by one test would make every later INSERT a duplicate. Track the gyms this file
// creates and clear their member rows (member_centers cascades) after every test.
const gymIds: string[] = [];
async function newGym(name: string) {
  const id = await createTestGym(name);
  gymIds.push(id);
  return id;
}

let gymId: string;
let centerId: number;

beforeAll(async () => {
  // Residue from an aborted earlier run (test files run sequentially, so nothing live
  // holds it) would otherwise turn every create into a 409. Unlink rather than delete.
  await db.query('UPDATE members SET clerk_user_id = NULL WHERE clerk_user_id = ?', [TEST_USER_ID]);
  // A fresh gym the admin owns, per CLAUDE.md; self-registration itself runs in gyms
  // where TEST_USER_ID holds no staff row (a staff login can never self-register — see the 409 test).
  const adminGym = await newGym('Self Reg Admin Gym');
  await createTestMembership(adminGym, 'admin');
});

beforeEach(async () => {
  clerk.getUser.mockReset();
  clerk.updateUserMetadata.mockReset().mockResolvedValue({});
  gymId = await newGym('Self Reg Gym');
  centerId = await insertCenter(gymId);
});

afterEach(async () => {
  if (gymIds.length === 0) return;
  const marks = gymIds.map(() => '?').join(',');
  await db.query(`DELETE FROM members WHERE gym_id IN (${marks})`, gymIds);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end(); // must be last
});

describe('POST /me/link — guards', () => {
  it('returns 401 without auth', async () => {
    const res = await request.post('/me/link').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 400 without x-gym-id', async () => {
    const res = await request.post('/me/link').set('Authorization', TEST_AUTH_HEADER);
    expect(res.status).toBe(400);
  });
});

describe('POST /me/link — website self-registration (#599)', () => {
  it('creates the member, its default center and a member gym_membership → 201, then clears the metadata', async () => {
    const email = uniqueEmail('happy');
    clerk.getUser.mockResolvedValue(clerkUser(email, { gym_id: gymId, name: 'Web Person', center_id: centerId }));

    const res = await link(gymId);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Web Person', email, gym_id: gymId, clerk_user_id: TEST_USER_ID });

    const members = await membersOf(gymId);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ id: res.body.id, name: 'Web Person', email, clerk_user_id: TEST_USER_ID });
    expect(members[0].deleted_at).toBeNull();
    expect(members[0].invitation_id).toBeNull();

    const { rows: mc } = await db.query<any>('SELECT * FROM member_centers WHERE member_id = ?', [res.body.id]);
    expect(mc).toHaveLength(1);
    expect(mc[0]).toMatchObject({ gym_id: gymId, center_id: centerId, is_default: 1 });

    const gm = await membershipOf(gymId);
    expect(gm).toMatchObject({ role: 'member', status: 'active' });

    expect(clerk.updateUserMetadata).toHaveBeenCalledTimes(1);
    expect(clerk.updateUserMetadata).toHaveBeenCalledWith(TEST_USER_ID, { publicMetadata: { gym_signup: null } });
  });

  it("falls back to the Clerk name when the metadata carries no name", async () => {
    const email = uniqueEmail('noname');
    clerk.getUser.mockResolvedValue(clerkUser(email, { gym_id: gymId, center_id: centerId }));

    const res = await link(gymId);

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Clerk Name');
  });

  it('still returns 201 when clearing the metadata fails (best-effort)', async () => {
    const email = uniqueEmail('clearfail');
    clerk.getUser.mockResolvedValue(clerkUser(email, { gym_id: gymId, name: 'Web Person', center_id: centerId }));
    clerk.updateUserMetadata.mockRejectedValueOnce(new Error('clerk down'));

    const res = await link(gymId);

    expect(res.status).toBe(201);
    expect(await membersOf(gymId)).toHaveLength(1);
  });

  it('metadata for a DIFFERENT gym → 404 and no row in either gym (tenant isolation)', async () => {
    const invitedGym = await newGym('Self Reg Invited Gym');
    const invitedCenter = await insertCenter(invitedGym);
    const email = uniqueEmail('othergym');
    clerk.getUser.mockResolvedValue(clerkUser(email, { gym_id: invitedGym, name: 'Web Person', center_id: invitedCenter }));

    const res = await link(gymId); // x-gym-id is NOT the gym that issued the invitation

    expect(res.status).toBe(404);
    expect(await membersOf(gymId)).toHaveLength(0);
    expect(await membersOf(invitedGym)).toHaveLength(0);
    expect(await membershipOf(gymId)).toBeNull();
    expect(clerk.updateUserMetadata).not.toHaveBeenCalled();
  });

  it('no metadata and no member row → 404 (existing behaviour)', async () => {
    clerk.getUser.mockResolvedValue(clerkUser(uniqueEmail('nometa')));

    const res = await link(gymId);

    expect(res.status).toBe(404);
    expect(await membersOf(gymId)).toHaveLength(0);
    expect(await membershipOf(gymId)).toBeNull();
    expect(clerk.updateUserMetadata).not.toHaveBeenCalled();
  });

  it('caller already holds a non-member gym_memberships row in the gym → 409, nothing created', async () => {
    const email = uniqueEmail('staffcaller');
    await createTestMembership(gymId, 'front_desk');
    clerk.getUser.mockResolvedValue(clerkUser(email, { gym_id: gymId, name: 'Web Person', center_id: centerId }));

    const res = await link(gymId);

    expect(res.status).toBe(409);
    expect(await membersOf(gymId)).toHaveLength(0);
    expect((await membershipOf(gymId)).role).toBe('front_desk');
    expect(clerk.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("the email is another account's staff login in the gym → 409, nothing created", async () => {
    const email = uniqueEmail('staffemail');
    await db.query(
      `INSERT INTO gym_memberships (user_id, gym_id, role, status, email) VALUES (?, ?, 'front_desk', 'invited', ?)`,
      [`invited_${Date.now()}`, gymId, email],
    );
    clerk.getUser.mockResolvedValue(clerkUser(email, { gym_id: gymId, name: 'Web Person', center_id: centerId }));

    const res = await link(gymId);

    expect(res.status).toBe(409);
    expect(await membersOf(gymId)).toHaveLength(0);
    expect(await membershipOf(gymId)).toBeNull();
  });

  it('a second identical call after success → 200 with the same member, no duplicate rows', async () => {
    const email = uniqueEmail('retry');
    // Clearing the metadata is best-effort, so a retry may still carry it.
    clerk.getUser.mockResolvedValue(clerkUser(email, { gym_id: gymId, name: 'Web Person', center_id: centerId }));

    const first = await link(gymId);
    expect(first.status).toBe(201);
    const second = await link(gymId);

    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body).toMatchObject({ email, clerk_user_id: TEST_USER_ID, name: 'Web Person' });
    expect(await membersOf(gymId)).toHaveLength(1);
    const { rows: mc } = await db.query('SELECT center_id FROM member_centers WHERE member_id = ?', [first.body.id]);
    expect(mc).toHaveLength(1);
    const { rows: gm } = await db.query('SELECT id FROM gym_memberships WHERE gym_id = ? AND user_id = ?', [gymId, TEST_USER_ID]);
    expect(gm).toHaveLength(1);
  });

  it("the email already sits on another gym's member record → 409 and no row here", async () => {
    const otherGym = await newGym('Self Reg Email Elsewhere');
    const email = uniqueEmail('elsewhere');
    await db.query('INSERT INTO members (name, email, gym_id) VALUES (?, ?, ?)', ['Elsewhere', email, otherGym]);
    clerk.getUser.mockResolvedValue(clerkUser(email, { gym_id: gymId, name: 'Web Person', center_id: centerId }));

    const res = await link(gymId);

    expect(res.status).toBe(409);
    expect(await membersOf(gymId)).toHaveLength(0);
    // The failed transaction must not leave a member login behind.
    expect(await membershipOf(gymId)).toBeNull();
    expect(clerk.updateUserMetadata).not.toHaveBeenCalled();
  });

  it('a deleted center_id in the metadata falls back to the gym\'s remaining center', async () => {
    const goneCenter = await insertCenter(gymId, 'Closed Center');
    await db.query('UPDATE centers SET deleted_at = UTC_TIMESTAMP() WHERE id = ? AND gym_id = ?', [goneCenter, gymId]);
    const email = uniqueEmail('deletedcenter');
    clerk.getUser.mockResolvedValue(clerkUser(email, { gym_id: gymId, name: 'Web Person', center_id: goneCenter }));

    const res = await link(gymId);

    expect(res.status).toBe(201);
    const { rows: mc } = await db.query<any>('SELECT center_id, is_default FROM member_centers WHERE member_id = ?', [res.body.id]);
    expect(mc).toHaveLength(1);
    expect(mc[0]).toMatchObject({ center_id: centerId, is_default: 1 });
  });

  it("another gym's center_id in the metadata is never used", async () => {
    const otherGym = await newGym('Self Reg Foreign Center');
    const foreignCenter = await insertCenter(otherGym);
    const email = uniqueEmail('foreigncenter');
    clerk.getUser.mockResolvedValue(clerkUser(email, { gym_id: gymId, name: 'Web Person', center_id: foreignCenter }));

    const res = await link(gymId);

    expect(res.status).toBe(201);
    const { rows: mc } = await db.query<any>('SELECT center_id FROM member_centers WHERE member_id = ?', [res.body.id]);
    expect(mc.map((r: any) => r.center_id)).toEqual([centerId]);
  });

  it('an existing unlinked member row wins over the metadata: linked (200), not duplicated', async () => {
    const email = uniqueEmail('rowwins');
    const { insertId } = await db.query('INSERT INTO members (name, email, gym_id, invitation_id) VALUES (?, ?, ?, ?)', ['Added By Staff', email, gymId, 'inv-x']);
    clerk.getUser.mockResolvedValue(clerkUser(email, { gym_id: gymId, name: 'Web Person', center_id: centerId }));

    const res = await link(gymId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: insertId, name: 'Added By Staff', clerk_user_id: TEST_USER_ID });
    const members = await membersOf(gymId);
    expect(members).toHaveLength(1);
    expect(members[0].invitation_id).toBeNull();
    expect((await membershipOf(gymId)).role).toBe('member');
  });
});
