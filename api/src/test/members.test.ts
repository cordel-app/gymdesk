// Tests for members.ts router

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

// ─── Shared setup helpers ─────────────────────────────────────────────────────

async function createMember(
  gymId: string,
  overrides: {
    clerk_user_id?: string | null;
    invitation_id?: string | null;
  } = {},
): Promise<number> {
  const email = `member-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`;
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

async function createUserMembership(
  gymId: string,
  memberId: number,
  status: string,
): Promise<void> {
  await db.query(
    `INSERT INTO user_memberships (gym_id, member_id, status, starts_at)
     VALUES (?, ?, ?, CURDATE())`,
    [gymId, memberId, status],
  );
}

// ─── Auth and access guards ───────────────────────────────────────────────────

describe('Auth and access guards', () => {
  let gymId: string;
  let gymNoAccess: string;

  beforeAll(async () => {
    gymId = await createTestGym('Members Auth Gym');
    await createTestMembership(gymId, 'admin');

    gymNoAccess = await createTestGym('Members No Access Gym');
    // TEST_USER_ID has no membership in gymNoAccess
  });

  it('returns 401 without an Authorization header', async () => {
    const res = await request.get('/members').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no membership in the requested gym', async () => {
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymNoAccess);
    expect(res.status).toBe(403);
  });
});

// ─── Tenant isolation ─────────────────────────────────────────────────────────

describe('Tenant isolation', () => {
  let gymA: string;
  let gymB: string;
  let memberBId: number;

  beforeAll(async () => {
    gymA = await createTestGym('Members Tenant Gym A');
    await createTestMembership(gymA, 'admin');
    gymB = await createTestGym('Members Tenant Gym B');
    memberBId = await createMember(gymB);
  });

  it('returns 403 when the user has no membership in the requested gym', async () => {
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(403);
  });

  it('returns 404 when accessing a gym B member with gym A credentials', async () => {
    const res = await request
      .get(`/members/${memberBId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA);
    expect(res.status).toBe(404);
  });

  it('does not include gym B members in the gym A list', async () => {
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA);
    expect(res.status).toBe(200);
    const ids = res.body.map((m: any) => m.id);
    expect(ids).not.toContain(memberBId);
  });
});

// ─── GET /members — happy path and computed fields ────────────────────────────

describe('GET /members', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Members List Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('returns 200 with an array', async () => {
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('includes account_status and membership_status fields in each row', async () => {
    await createMember(gymId);
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const member of res.body) {
      expect(member).toHaveProperty('account_status');
      expect(member).toHaveProperty('membership_status');
    }
  });

  it('does not include soft-deleted members', async () => {
    const memberId = await createMember(gymId);
    await db.query('UPDATE members SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [memberId]);
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((m: any) => m.id);
    expect(ids).not.toContain(memberId);
  });
});

// ─── account_status derivation ────────────────────────────────────────────────

describe('account_status derivation', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Members Account Status Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('returns account_status "active" when clerk_user_id is set', async () => {
    const memberId = await createMember(gymId, { clerk_user_id: 'user_test_active_123' });
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const member = res.body.find((m: any) => m.id === memberId);
    expect(member).toBeDefined();
    expect(member.account_status).toBe('active');
  });

  it('returns account_status "invited" when invitation_id is set and clerk_user_id is null', async () => {
    const memberId = await createMember(gymId, {
      clerk_user_id: null,
      invitation_id: 'inv_test_invited_456',
    });
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const member = res.body.find((m: any) => m.id === memberId);
    expect(member).toBeDefined();
    expect(member.account_status).toBe('invited');
  });

  it('returns account_status "not_enrolled" when both clerk_user_id and invitation_id are null', async () => {
    const memberId = await createMember(gymId, {
      clerk_user_id: null,
      invitation_id: null,
    });
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const member = res.body.find((m: any) => m.id === memberId);
    expect(member).toBeDefined();
    expect(member.account_status).toBe('not_enrolled');
  });
});

// ─── membership_status derivation ────────────────────────────────────────────

describe('membership_status derivation', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Members Membership Status Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('returns membership_status null when the member has no user_memberships', async () => {
    const memberId = await createMember(gymId);
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const member = res.body.find((m: any) => m.id === memberId);
    expect(member).toBeDefined();
    expect(member.membership_status).toBeNull();
  });

  it('returns the most recent user_membership status for a member who has one', async () => {
    const memberId = await createMember(gymId);
    await createUserMembership(gymId, memberId, 'active');
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const member = res.body.find((m: any) => m.id === memberId);
    expect(member).toBeDefined();
    expect(member.membership_status).toBe('active');
  });

  it('returns the most recent user_membership status when the member has multiple memberships', async () => {
    const memberId = await createMember(gymId);
    // Insert an older membership first
    await createUserMembership(gymId, memberId, 'expired');
    // Small delay to ensure different created_at ordering
    await new Promise((r) => setTimeout(r, 10));
    // Insert a more recent membership
    await createUserMembership(gymId, memberId, 'cancelled');
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const member = res.body.find((m: any) => m.id === memberId);
    expect(member).toBeDefined();
    expect(member.membership_status).toBe('cancelled');
  });
});

describe('Members — search (#326)', () => {
  let gymId: string;
  let otherGymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Search Test Gym');
    await createTestMembership(gymId, 'admin');

    // Insert members with distinct names/emails for search
    await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES
       (?, 'Alice Wonderland', 'alice@example.com'),
       (?, 'Bob Builder', 'bob@example.com'),
       (?, 'Charlie Brown', 'charlie@example.com')`,
      [gymId, gymId, gymId],
    );

    // A second gym for tenant isolation check
    otherGymId = await createTestGym('Other Gym');
    await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES (?, 'Alice Other', 'alice-other@example.com')`,
      [otherGymId],
    );
  });

  it('returns all members when q is absent', async () => {
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(3);
  });

  it('filters by name with q param (case-insensitive)', async () => {
    const res = await request
      .get('/members?q=alice')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].name).toBe('Alice Wonderland');
  });

  it('filters by email with q param', async () => {
    const res = await request
      .get('/members?q=bob%40example')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.every((m: any) => m.name === 'Bob Builder')).toBe(true);
  });

  it('returns max 20 results when q is present', async () => {
    // Insert 25 members named "Searchable X"
    const values = Array.from({ length: 25 }, (_, i) =>
      `(?, 'Searchable ${i}', 'searchable${i}-${Date.now()}@example.com')`,
    ).join(',');
    await db.query(
      `INSERT INTO members (gym_id, name, email) VALUES ${values}`,
      Array.from({ length: 25 }, () => gymId),
    );
    const res = await request
      .get('/members?q=Searchable')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(20);
  });

  it('tenant isolation — q search does not return other gym members', async () => {
    const res = await request
      .get('/members?q=alice')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.every((m: any) => m.gym_id === gymId)).toBe(true);
    expect(res.body.some((m: any) => m.email === 'alice-other@example.com')).toBe(false);
  });

  it('returns empty array when no match', async () => {
    const res = await request
      .get('/members?q=zzznomatch999')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('unauthenticated request returns 401', async () => {
    const res = await request
      .get('/members?q=alice')
      .set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });
});
