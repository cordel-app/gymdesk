// #2183: Invite hitting Clerk's "already exists" 422 reconciles the stored status.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

const clerk = vi.hoisted(() => ({
  createInvitation: vi.fn(),
  getInvitationList: vi.fn(),
  getUserList: vi.fn(),
  revokeInvitation: vi.fn(),
}));

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: { getUser: vi.fn().mockResolvedValue({ publicMetadata: {}, fullName: 'Test User', firstName: 'Test', lastName: 'User' }), getUserList: clerk.getUserList },
      invitations: { createInvitation: clerk.createInvitation, getInvitationList: clerk.getInvitationList, revokeInvitation: clerk.revokeInvitation },
    })),
  };
});

let gymId: string;
beforeAll(async () => {
  gymId = await createTestGym();
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

let seq = 0;
async function member(): Promise<{ id: number; email: string }> {
  const email = `inv-${Date.now()}-${++seq}@conflict.test`;
  const { insertId } = await db.query(`INSERT INTO members (gym_id, name, email) VALUES (?, 'M', ?)`, [gymId, email]);
  return { id: insertId as number, email };
}
const invite = (id: number) =>
  request.post(`/members/${id}/invite`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const stored = async (id: number) =>
  (await db.query<any>('SELECT invitation_id, invited_at, clerk_user_id FROM members WHERE id = ?', [id])).rows[0];

describe('POST /members/:id/invite conflict reconciliation', () => {
  beforeAll(() => {
    clerk.createInvitation.mockRejectedValue(Object.assign(new Error('exists'), { status: 422 }));
  });

  it('stores the pending Clerk invitation, and a retry is stable', async () => {
    const m = await member();
    clerk.getInvitationList.mockResolvedValue({ data: [{ id: 'inv_real', emailAddress: m.email, status: 'pending' }] });
    clerk.getUserList.mockResolvedValue({ data: [] });
    for (let i = 0; i < 2; i++) {
      const res = await invite(m.id);
      expect(res.status).toBe(409);
      expect(res.body.reconciled).toBe('pending_invitation');
    }
    const row = await stored(m.id);
    expect(row.invitation_id).toBe('inv_real');
    expect(row.invited_at).not.toBeNull();
  });

  it('finds the member\'s invitation beyond the first page of pending invitations', async () => {
    const m = await member();
    const others = Array.from({ length: 500 }, (_, i) => ({ id: `inv_o${i}`, emailAddress: `o${i}@x.test`, status: 'pending' }));
    clerk.getInvitationList.mockImplementation(async (q: any) =>
      ({ data: q.offset ? [{ id: 'inv_late', emailAddress: m.email, status: 'pending' }] : others }));
    clerk.getUserList.mockResolvedValue({ data: [] });
    const res = await invite(m.id);
    expect(res.body.reconciled).toBe('pending_invitation');
    expect((await stored(m.id)).invitation_id).toBe('inv_late');
    clerk.getInvitationList.mockReset();
  });

  it('reports an existing account without linking it', async () => {
    const m = await member();
    clerk.getInvitationList.mockResolvedValue({ data: [] });
    clerk.getUserList.mockResolvedValue({ data: [{ id: 'user_x', emailAddresses: [{ emailAddress: m.email }] }] });
    const res = await invite(m.id);
    expect(res.status).toBe(409);
    expect(res.body.reconciled).toBe('account_exists');
    expect((await stored(m.id)).clerk_user_id).toBeNull();
  });

  it('changes nothing when Clerk reports neither, or the lookup fails', async () => {
    const m = await member();
    clerk.getInvitationList.mockResolvedValue({ data: [] });
    clerk.getUserList.mockResolvedValue({ data: [] });
    expect((await invite(m.id)).body.reconciled).toBeUndefined();
    clerk.getInvitationList.mockRejectedValue(new Error('down'));
    const res = await invite(m.id);
    expect(res.status).toBe(409);
    expect((await stored(m.id)).invitation_id).toBeNull();
  });

  it('leaves unrelated Clerk errors visible and the status untouched', async () => {
    const m = await member();
    clerk.createInvitation.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
    const res = await invite(m.id);
    expect(res.status).toBe(500);
    expect((await stored(m.id)).invitation_id).toBeNull();
  });
});

describe('GET /members/:id/clerk-status with an invitation Clerk holds but the row does not', () => {
  const status = (id: number) =>
    request.get(`/members/${id}/clerk-status`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

  it('reports the pending invitation (even beside an existing account) and stores it', async () => {
    const m = await member();
    clerk.getInvitationList.mockReset();
    clerk.getInvitationList.mockResolvedValue({ data: [{ id: 'inv_status', emailAddress: m.email, status: 'pending' }] });
    clerk.getUserList.mockResolvedValue({ data: [{ id: 'user_x', emailAddresses: [{ emailAddress: m.email }] }] });
    const res = await status(m.id);
    expect(res.status).toBe(200);
    expect(res.body.has_pending_invitation).toBe(true);
    expect(res.body.status).toBe('invited');
    expect(res.body.account_exists).toBe(true);
    expect(res.body.invited_at).not.toBeNull();
    expect((await stored(m.id)).invitation_id).toBe('inv_status');
  });

  it('keeps "none" when Clerk holds no invitation', async () => {
    const m = await member();
    clerk.getInvitationList.mockReset();
    clerk.getInvitationList.mockResolvedValue({ data: [] });
    clerk.getUserList.mockResolvedValue({ data: [] });
    const res = await status(m.id);
    expect(res.body.has_pending_invitation).toBe(false);
    expect(res.body.status).toBe('not_enrolled');
  });
});

// #2680: the reconciled Members App invitation state, and the three actions behind it.
describe('Members App invitation state and actions (#2680)', () => {
  const as = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
  const status = (id: number) => as(request.get(`/members/${id}/clerk-status`));
  const resend = (id: number) => as(request.post(`/members/${id}/reinvite`));
  const cancel = (id: number) => as(request.post(`/members/${id}/revoke-invite`));
  const pendingFor = (email: string, ...ids: string[]) =>
    ({ data: ids.map((id) => ({ id, emailAddress: email, status: 'pending' })) });
  const setStored = (id: number, inv: string | null) =>
    db.query('UPDATE members SET invitation_id = ? WHERE id = ?', [inv, id]);

  beforeEach(() => {
    clerk.getInvitationList.mockReset();
    clerk.getUserList.mockReset().mockResolvedValue({ data: [] });
    clerk.createInvitation.mockReset();
    clerk.revokeInvitation.mockReset().mockResolvedValue({});
  });

  it('clears a stored invitation Clerk no longer holds as pending', async () => {
    const m = await member();
    await setStored(m.id, 'inv_expired');
    clerk.getInvitationList.mockResolvedValue({ data: [] });
    const res = await status(m.id);
    expect(res.body.invitation_state).toBe('not_invited');
    expect(res.body.has_pending_invitation).toBe(false);
    expect((await stored(m.id)).invitation_id).toBeNull();
  });

  it('reports an existing unlinked account apart from a linked one', async () => {
    const m = await member();
    clerk.getInvitationList.mockResolvedValue({ data: [] });
    clerk.getUserList.mockResolvedValue({ data: [{ id: 'user_y', emailAddresses: [{ emailAddress: m.email }] }] });
    const res = await status(m.id);
    expect(res.body.invitation_state).toBe('account_exists');
    expect(res.body.enrolled).toBe(false);
    expect((await stored(m.id)).clerk_user_id).toBeNull();
  });

  it('a failed lookup is unknown, never "not invited", and keeps a stored invitation', async () => {
    const m = await member();
    clerk.getInvitationList.mockRejectedValue(new Error('down'));
    expect((await status(m.id)).body.invitation_state).toBe('unknown');
    await setStored(m.id, 'inv_kept');
    const res = await status(m.id);
    expect(res.body.invitation_state).toBe('invitation_pending');
    expect((await stored(m.id)).invitation_id).toBe('inv_kept');
  });

  it('a linked member is linked', async () => {
    const m = await member();
    await db.query('UPDATE members SET clerk_user_id = ? WHERE id = ?', [`user_${m.id}`, m.id]);
    expect((await status(m.id)).body.invitation_state).toBe('linked');
    expect((await resend(m.id)).status).toBe(400);
    expect((await cancel(m.id)).status).toBe(400);
  });

  it('Resend revokes every pending invitation before creating one, and stores it', async () => {
    const m = await member();
    await setStored(m.id, 'inv_a');
    clerk.getInvitationList.mockResolvedValue(pendingFor(m.email, 'inv_a', 'inv_b'));
    clerk.createInvitation.mockResolvedValue({ id: 'inv_new' });
    const res = await resend(m.id);
    expect(res.status).toBe(200);
    expect(clerk.revokeInvitation.mock.calls.map((c) => c[0])).toEqual(['inv_a', 'inv_b']);
    expect(clerk.createInvitation).toHaveBeenCalledTimes(1);
    expect(clerk.revokeInvitation.mock.invocationCallOrder[1]).toBeLessThan(clerk.createInvitation.mock.invocationCallOrder[0]);
    const row = await stored(m.id);
    expect(row.invitation_id).toBe('inv_new');
    expect(row.invited_at).not.toBeNull();
  });

  it('Resend with nothing pending in Clerk creates nothing and clears the stale reference', async () => {
    const m = await member();
    await setStored(m.id, 'inv_gone');
    clerk.getInvitationList.mockResolvedValue({ data: [] });
    const res = await resend(m.id);
    expect(res.status).toBe(409);
    expect(res.body.invitation_state).toBe('not_invited');
    expect(clerk.createInvitation).not.toHaveBeenCalled();
    expect((await stored(m.id)).invitation_id).toBeNull();
  });

  it('Resend refuses when Clerk cannot be asked, creating nothing', async () => {
    const m = await member();
    await setStored(m.id, 'inv_s');
    clerk.getInvitationList.mockRejectedValue(new Error('down'));
    const res = await resend(m.id);
    expect(res.status).toBe(502);
    expect(clerk.createInvitation).not.toHaveBeenCalled();
    expect(clerk.revokeInvitation).not.toHaveBeenCalled();
    expect((await stored(m.id)).invitation_id).toBe('inv_s');
  });

  it('Cancel revokes the invitation Clerk actually holds, even one the row did not store', async () => {
    const m = await member();
    clerk.getInvitationList.mockResolvedValue(pendingFor(m.email, 'inv_clerk'));
    const res = await cancel(m.id);
    expect(res.status).toBe(204);
    expect(clerk.revokeInvitation).toHaveBeenCalledWith('inv_clerk');
    const row = await stored(m.id);
    expect(row.invitation_id).toBeNull();
    const { rows } = await db.query<any>('SELECT deleted_at FROM members WHERE id = ?', [m.id]);
    expect(rows[0].deleted_at).toBeNull();
  });

  it('Cancel falls back to the stored invitation when Clerk cannot be listed', async () => {
    const m = await member();
    await setStored(m.id, 'inv_stored');
    clerk.getInvitationList.mockRejectedValue(new Error('down'));
    const res = await cancel(m.id);
    expect(res.status).toBe(204);
    expect(clerk.revokeInvitation).toHaveBeenCalledWith('inv_stored');
    expect((await stored(m.id)).invitation_id).toBeNull();
  });

  it('Cancel keeps the reference when Clerk refuses the revoke', async () => {
    const m = await member();
    await setStored(m.id, 'inv_s');
    clerk.getInvitationList.mockResolvedValue(pendingFor(m.email, 'inv_s'));
    clerk.revokeInvitation.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
    expect((await cancel(m.id)).status).toBe(502);
    expect((await stored(m.id)).invitation_id).toBe('inv_s');
  });
});
