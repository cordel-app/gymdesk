// #709 part 3: GET/DELETE /platform/orphaned-accounts — superadmin list and
// delete of Clerk accounts linked to nothing in Gymdesk. Clerk is mocked;
// Gymdesk links are real rows.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { SIGNUP_GRACE_MS } from '../infra/clerk-account-links';
import { TEST_AUTH_HEADER, TEST_USER_ID, cleanupTestGyms, createTestGym, createTestMembership, eventually, request } from './helpers';

const clerk = vi.hoisted(() => ({
  users: new Map<string, any>(),
  getUserList: vi.fn(),
  getUser: vi.fn(),
  deleteUser: vi.fn(),
}));

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: { getUser: clerk.getUser, getUserList: clerk.getUserList, deleteUser: clerk.deleteUser },
      invitations: { createInvitation: vi.fn(), revokeInvitation: vi.fn() },
    })),
  };
});

const RUN = `orph-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const uid = (tag: string) => `${RUN}-${tag}`;
const OLD = Date.now() - SIGNUP_GRACE_MS - 60_000;

function clerkUser(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    firstName: null, lastName: null,
    emailAddresses: [{ id: `em-${id}`, emailAddress: `${id}@orphan.test` }],
    primaryEmailAddressId: `em-${id}`,
    publicMetadata: {},
    createdAt: OLD,
    lastSignInAt: OLD,
    ...over,
  };
}

let gymId: string;
let gymName: string;

beforeAll(async () => {
  gymName = `Orphan Gym ${RUN}`;
  gymId = await createTestGym(gymName);
});

beforeEach(() => {
  clerk.users.clear();
  clerk.users.set(TEST_USER_ID, clerkUser(TEST_USER_ID, { publicMetadata: { platform_role: 'superadmin' } }));
  clerk.getUser.mockReset().mockImplementation(async (id: string) => {
    const u = clerk.users.get(id);
    if (!u) throw Object.assign(new Error('not found'), { status: 404 });
    return u;
  });
  clerk.getUserList.mockReset().mockImplementation(async ({ limit, offset }: { limit: number; offset: number }) => {
    const all = [...clerk.users.values()];
    return { data: all.slice(offset, offset + limit), totalCount: all.length };
  });
  clerk.deleteUser.mockReset().mockResolvedValue({});
});

afterAll(async () => {
  await db.query("DELETE FROM audit_logs WHERE entity_type = 'clerk_account' AND entity_id LIKE ?", [`${RUN}%`]);
  await cleanupTestGyms();
  await db.end();
});

async function addMember(clerkUserId: string, deleted = false) {
  const { insertId } = await db.query(
    `INSERT INTO members (name, email, gym_id, clerk_user_id, deleted_at) VALUES (?, ?, ?, ?, ${deleted ? 'UTC_TIMESTAMP()' : 'NULL'})`,
    [`Member ${clerkUserId}`, `${clerkUserId}@orphan.test`, gymId, clerkUserId],
  );
  return insertId as number;
}

const list = () => request.get('/platform/orphaned-accounts').set('Authorization', TEST_AUTH_HEADER);
const del = (id: string) => request.delete(`/platform/orphaned-accounts/${id}`).set('Authorization', TEST_AUTH_HEADER);

describe('auth', () => {
  it('401 without a token', async () => {
    expect((await request.get('/platform/orphaned-accounts')).status).toBe(401);
    expect((await request.delete('/platform/orphaned-accounts/x')).status).toBe(401);
  });

  it('403 for a signed-in user who is not a superadmin', async () => {
    clerk.users.set(TEST_USER_ID, clerkUser(TEST_USER_ID));
    expect((await list()).status).toBe(403);
    expect((await del(uid('any'))).status).toBe(403);
    expect(clerk.deleteUser).not.toHaveBeenCalled();
  });
});

describe('GET /platform/orphaned-accounts', () => {
  it('lists only unlinked accounts, each with its reason, gyms and deletable flag', async () => {
    const ids = {
      staff: uid('staff'), active: uid('active'), deleted: uid('deleted'), roleOnly: uid('roleonly'),
      incomplete: uid('incomplete'), inProgress: uid('inprogress'), bare: uid('bare'),
    };
    for (const id of Object.values(ids)) clerk.users.set(id, clerkUser(id));
    clerk.users.set(ids.incomplete, clerkUser(ids.incomplete, { publicMetadata: { gym_signup: { gym_id: gymId } } }));
    clerk.users.set(ids.inProgress, clerkUser(ids.inProgress, { publicMetadata: { gym_signup: { gym_id: gymId } }, createdAt: Date.now() - 60_000 }));

    await createTestMembership(gymId, 'front_desk', ids.staff);
    await addMember(ids.active);
    await addMember(ids.deleted, true);
    await createTestMembership(gymId, 'member', ids.deleted); // the row a member delete used to leave behind
    await createTestMembership(gymId, 'member', ids.roleOnly);

    const res = await list();

    expect(res.status).toBe(200);
    const byId = new Map(res.body.map((r: any) => [r.id, r]));
    expect(byId.has(TEST_USER_ID)).toBe(false); // superadmin
    expect(byId.has(ids.staff)).toBe(false);
    expect(byId.has(ids.active)).toBe(false);
    expect(byId.get(ids.deleted)).toMatchObject({
      email: `${ids.deleted}@orphan.test`, reason: 'member_deleted', deletable: true,
      gyms: [{ gym_id: gymId, gym_name: gymName }],
    });
    expect(byId.get(ids.roleOnly)).toMatchObject({ reason: 'no_links', deletable: true });
    expect(byId.get(ids.incomplete)).toMatchObject({ reason: 'signup_incomplete', deletable: true });
    expect(byId.get(ids.inProgress)).toMatchObject({ reason: 'signup_in_progress', deletable: false });
    expect(byId.get(ids.bare)).toMatchObject({ reason: 'no_links', deletable: true, created_at: new Date(OLD).toISOString() });
  });

  it('pages through every Clerk user, past the 500-per-call limit', async () => {
    for (let i = 0; i < 501; i++) clerk.users.set(uid(`bulk-${i}`), clerkUser(uid(`bulk-${i}`)));

    const res = await list();

    expect(res.status).toBe(200);
    expect(clerk.getUserList).toHaveBeenCalledWith(expect.objectContaining({ limit: 500, offset: 0 }));
    expect(clerk.getUserList).toHaveBeenCalledWith(expect.objectContaining({ limit: 500, offset: 500 }));
    expect(res.body.filter((r: any) => r.id.startsWith(uid('bulk-')))).toHaveLength(501);
  });
});

describe('DELETE /platform/orphaned-accounts/:userId', () => {
  it('deletes the Clerk account first, then removes its Gymdesk leftovers and audits it', async () => {
    const id = uid('del-ok');
    clerk.users.set(id, clerkUser(id));
    const memberId = await addMember(id, true);
    await createTestMembership(gymId, 'member', id);

    const res = await del(id);

    expect(res.status).toBe(204);
    expect(clerk.deleteUser).toHaveBeenCalledWith(id);
    const { rows: gm } = await db.query('SELECT id FROM gym_memberships WHERE user_id = ?', [id]);
    expect(gm).toHaveLength(0);
    const { rows: m } = await db.query<any>('SELECT clerk_user_id, deleted_at FROM members WHERE id = ?', [memberId]);
    expect(m[0].clerk_user_id).toBeNull();
    expect(m[0].deleted_at).not.toBeNull();
    const audit = await eventually(async () => (await db.query<any>( // audit is fire-and-forget
      "SELECT gym_id, action, entity_name FROM audit_logs WHERE entity_type = 'clerk_account' AND entity_id = ?", [id],
    )).rows, (r) => r.length > 0);
    expect(audit[0]).toMatchObject({ gym_id: null, action: 'delete', entity_name: `${id}@orphan.test` });
  });

  it('409 when the account is linked (active member) — nothing deleted', async () => {
    const id = uid('del-linked');
    clerk.users.set(id, clerkUser(id));
    await addMember(id);

    const res = await del(id);

    expect(res.status).toBe(409);
    expect(clerk.deleteUser).not.toHaveBeenCalled();
  });

  it('409 for a sign-up still in progress', async () => {
    const id = uid('del-inprogress');
    clerk.users.set(id, clerkUser(id, { publicMetadata: { gym_signup: {} }, createdAt: Date.now() - 60_000 }));

    expect((await del(id)).status).toBe(409);
    expect(clerk.deleteUser).not.toHaveBeenCalled();
  });

  it('502 when Clerk fails — Gymdesk rows untouched', async () => {
    const id = uid('del-502');
    clerk.users.set(id, clerkUser(id));
    await createTestMembership(gymId, 'member', id);
    clerk.deleteUser.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));

    const res = await del(id);

    expect(res.status).toBe(502);
    const { rows: gm } = await db.query('SELECT id FROM gym_memberships WHERE user_id = ?', [id]);
    expect(gm).toHaveLength(1);
  });

  it('404 for an account Clerk does not know', async () => {
    expect((await del(uid('del-missing'))).status).toBe(404);
    expect(clerk.deleteUser).not.toHaveBeenCalled();
  });
});
