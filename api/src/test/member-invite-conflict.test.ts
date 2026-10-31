// #2183: Invite hitting Clerk's "already exists" 422 reconciles the stored status.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

const clerk = vi.hoisted(() => ({
  createInvitation: vi.fn(),
  getInvitationList: vi.fn(),
  getUserList: vi.fn(),
}));

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: { getUser: vi.fn(), getUserList: clerk.getUserList },
      invitations: { createInvitation: clerk.createInvitation, getInvitationList: clerk.getInvitationList, revokeInvitation: vi.fn() },
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
  beforeAll(() => clerk.createInvitation.mockRejectedValue(Object.assign(new Error('exists'), { status: 422 })));

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
