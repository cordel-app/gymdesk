// Tests for GET /members/:id/clerk-status (members.ts router)

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

async function createMember(
  gymId: string,
  overrides: {
    clerk_user_id?: string | null;
    invitation_id?: string | null;
  } = {},
): Promise<number> {
  const email = `clerk-status-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`;
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email, clerk_user_id, invitation_id)
     VALUES (?, 'Test Member', ?, ?, ?)`,
    [
      gymId,
      email,
      overrides.clerk_user_id ?? null,
      overrides.invitation_id ?? null,
    ],
  );
  return insertId as number;
}

describe('GET /members/:id/clerk-status', () => {
  let gymId: string;
  let gymBId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Member Clerk Status Gym A');
    gymBId = await createTestGym('Member Clerk Status Gym B');
    await createTestMembership(gymId, 'admin');
  });

  it('returns 401 without auth', async () => {
    const memberId = await createMember(gymId);
    const res = await request
      .get(`/members/${memberId}/clerk-status`)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no membership in the requested gym', async () => {
    const memberId = await createMember(gymBId);
    const res = await request
      .get(`/members/${memberId}/clerk-status`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymBId);
    expect(res.status).toBe(403);
  });

  it('returns 404 when accessing a gym B member with gym A credentials (tenant isolation)', async () => {
    const memberBId = await createMember(gymBId);
    const res = await request
      .get(`/members/${memberBId}/clerk-status`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-existent member id', async () => {
    const res = await request
      .get('/members/9999999/clerk-status')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns { status: "not_enrolled", userId: null } when clerk_user_id and invitation_id are both null', async () => {
    const memberId = await createMember(gymId, {
      clerk_user_id: null,
      invitation_id: null,
    });
    const res = await request
      .get(`/members/${memberId}/clerk-status`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'not_enrolled', userId: null });
  });

  it('returns { status: "invited", userId: null } when invitation_id is set but clerk_user_id is null', async () => {
    const memberId = await createMember(gymId, {
      clerk_user_id: null,
      invitation_id: 'inv_test_12345',
    });
    const res = await request
      .get(`/members/${memberId}/clerk-status`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'invited', userId: null });
  });

  it('returns 404 for a soft-deleted member', async () => {
    const memberId = await createMember(gymId);
    await db.query(
      'UPDATE members SET deleted_at = UTC_TIMESTAMP() WHERE id = ?',
      [memberId],
    );
    const res = await request
      .get(`/members/${memberId}/clerk-status`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});
