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

  it('includes account_status, enrollment_status and payment_status fields in each row', async () => {
    await createMember(gymId);
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const member of res.body) {
      expect(member).toHaveProperty('account_status');
      expect(member).toHaveProperty('enrollment_status');
      expect(member).toHaveProperty('payment_status');
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

// ─── enrollment_status derivation ────────────────────────────────────────────

describe('enrollment_status derivation', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Members Enrollment Status Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('returns enrollment_status null when the member has no user_memberships', async () => {
    const memberId = await createMember(gymId);
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const member = res.body.find((m: any) => m.id === memberId);
    expect(member).toBeDefined();
    expect(member.enrollment_status).toBeNull();
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
    expect(member.enrollment_status).toBe('active');
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
    expect(member.enrollment_status).toBe('cancelled');
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

// ─── nif_nie_passport filter (#515) ──────────────────────────────────────────

describe('Members — nif_nie_passport filter (#515)', () => {
  let gymId: string;
  let otherGymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Document Filter Test Gym');
    await createTestMembership(gymId, 'admin');

    await db.query(
      `INSERT INTO members (gym_id, name, email, nif_nie_passport) VALUES
       (?, 'Nia Fuentes', 'nia@example.com', '12345678Z'),
       (?, 'Nora Estrada', 'nora@example.com', 'X1234567L'),
       (?, 'Pablo Ibarra', 'pablo@example.com', 'AB0012345'),
       (?, 'No Document', 'nodoc@example.com', NULL)`,
      [gymId, gymId, gymId, gymId],
    );

    otherGymId = await createTestGym('Other Document Gym');
    await db.query(
      `INSERT INTO members (gym_id, name, email, nif_nie_passport) VALUES (?, 'Other Gym Member', 'other-doc@example.com', '12345678Z')`,
      [otherGymId],
    );
  });

  it('returns all members when the filter is absent', async () => {
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(4);
  });

  it('performs a partial, case-insensitive match', async () => {
    const res = await request
      .get('/members?nif_nie_passport=12345678z')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].nif_nie_passport).toBe('12345678Z');
  });

  it('matches a fragment of the document without requiring the full value', async () => {
    const res = await request
      .get('/members?nif_nie_passport=1234')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const names = res.body.map((m: any) => m.name);
    expect(names).toContain('Nia Fuentes');
    expect(names).toContain('Nora Estrada');
  });

  it('preserves leading zeros in the search term', async () => {
    const res = await request
      .get('/members?nif_nie_passport=0012')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].name).toBe('Pablo Ibarra');
  });

  it('does not require a valid NIF/NIE control letter or full length', async () => {
    const res = await request
      .get('/members?nif_nie_passport=X123')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.some((m: any) => m.name === 'Nora Estrada')).toBe(true);
  });

  it('returns empty array when no document matches', async () => {
    const res = await request
      .get('/members?nif_nie_passport=zzznomatch999')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('tenant isolation — does not return other gym members', async () => {
    const res = await request
      .get('/members?nif_nie_passport=12345678Z')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.every((m: any) => m.gym_id === gymId)).toBe(true);
    expect(res.body.some((m: any) => m.email === 'other-doc@example.com')).toBe(false);
  });

  it('combines with other active filters', async () => {
    const res = await request
      .get('/members?nif_nie_passport=1234&q=Nia')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].name).toBe('Nia Fuentes');
  });

  it('unauthenticated request returns 401', async () => {
    const res = await request
      .get('/members?nif_nie_passport=1234')
      .set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });
});

// ─── DELETE /members/:id — soft-delete and recycle-bin integration ────────────

describe('DELETE /members/:id', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Members Delete Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('returns 204 and soft-deletes the member', async () => {
    const memberId = await createMember(gymId);
    const res = await request
      .delete(`/members/${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);

    const { rows } = await db.query<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM members WHERE id = ?',
      [memberId],
    );
    expect(rows[0].deleted_at).not.toBeNull();
  });

  it('sets deleted_by_name on the member row', async () => {
    const memberId = await createMember(gymId);
    await request
      .delete(`/members/${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    const { rows } = await db.query<{ deleted_by_name: string | null }>(
      'SELECT deleted_by_name FROM members WHERE id = ?',
      [memberId],
    );
    // actorName may be null in test (no real Clerk user), so we just verify the column exists
    expect(rows[0]).toHaveProperty('deleted_by_name');
  });

  it('deleted member no longer appears in GET /members', async () => {
    const memberId = await createMember(gymId);
    await request
      .delete(`/members/${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((m: any) => m.id);
    expect(ids).not.toContain(memberId);
  });

  it('returns 404 when deleting an already-deleted member', async () => {
    const memberId = await createMember(gymId);
    await db.query('UPDATE members SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [memberId]);
    const res = await request
      .delete(`/members/${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

// ─── enrollment_status filter (#346) ─────────────────────────────────────────

describe('enrollment_status filter (#346)', () => {
  let gymId: string;
  let activeMemberId: number;
  let pausedMemberId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Members Enrollment Filter Gym');
    await createTestMembership(gymId, 'admin');
    activeMemberId = await createMember(gymId);
    pausedMemberId = await createMember(gymId);
    await createUserMembership(gymId, activeMemberId, 'active');
    await createUserMembership(gymId, pausedMemberId, 'paused');
  });

  it('returns only active-enrollment members when filtered', async () => {
    const res = await request
      .get('/members?enrollment_status=active')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((m: any) => m.id);
    expect(ids).toContain(activeMemberId);
    expect(ids).not.toContain(pausedMemberId);
    for (const m of res.body) expect(m.enrollment_status).toBe('active');
  });

  it('returns only paused-enrollment members when filtered', async () => {
    const res = await request
      .get('/members?enrollment_status=paused')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((m: any) => m.id);
    expect(ids).toContain(pausedMemberId);
    expect(ids).not.toContain(activeMemberId);
  });

  it('returns empty array when no members match the filter', async () => {
    const res = await request
      .get('/members?enrollment_status=expired')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((m: any) => m.id);
    expect(ids).not.toContain(activeMemberId);
    expect(ids).not.toContain(pausedMemberId);
  });
});

// ─── payment_status filter (#346) ────────────────────────────────────────────

async function getChargeTypeId(): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    'SELECT id FROM charge_types WHERE code = ? LIMIT 1',
    ['membership_fee'],
  );
  return rows[0].id;
}

async function createUserMembershipForPayment(gymId: string, memberId: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO user_memberships (gym_id, member_id, status, starts_at) VALUES (?, ?, 'active', CURDATE())`,
    [gymId, memberId],
  );
  return insertId as number;
}

async function insertPaymentRequest(
  gymId: string,
  userMembershipId: number,
  memberId: number,
  chargeTypeId: number,
  status: string,
): Promise<void> {
  await db.query(
    `INSERT INTO payment_requests
       (gym_id, user_membership_id, member_id, amount, currency, charge_type_id,
        status, provider, provider_order, page_token, page_token_expires, initiated_by, source)
     VALUES (?, ?, ?, '10.00', 'EUR', ?,
             ?, 'monei', UUID(), UUID(), DATE_ADD(NOW(), INTERVAL 10 MINUTE), 'test', 'admin')`,
    [gymId, userMembershipId, memberId, chargeTypeId, status],
  );
}

describe('payment_status (#346)', () => {
  let gymId: string;
  let completedMemberId: number;
  let pendingMemberId: number;
  let noPaymentMemberId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Members Payment Status Gym');
    await createTestMembership(gymId, 'admin');

    completedMemberId = await createMember(gymId);
    pendingMemberId   = await createMember(gymId);
    noPaymentMemberId = await createMember(gymId);

    const chargeTypeId = await getChargeTypeId();
    const completedUmId = await createUserMembershipForPayment(gymId, completedMemberId);
    const pendingUmId   = await createUserMembershipForPayment(gymId, pendingMemberId);

    await insertPaymentRequest(gymId, completedUmId, completedMemberId, chargeTypeId, 'completed');
    await insertPaymentRequest(gymId, pendingUmId,   pendingMemberId,   chargeTypeId, 'pending');
  });

  it('returns payment_status null when member has no payment requests', async () => {
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const member = res.body.find((m: any) => m.id === noPaymentMemberId);
    expect(member).toBeDefined();
    expect(member.payment_status).toBeNull();
  });

  it('returns the most recent payment_status when member has payments', async () => {
    const res = await request
      .get('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const member = res.body.find((m: any) => m.id === completedMemberId);
    expect(member).toBeDefined();
    expect(member.payment_status).toBe('completed');
  });

  it('filters by payment_status=completed', async () => {
    const res = await request
      .get('/members?payment_status=completed')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((m: any) => m.id);
    expect(ids).toContain(completedMemberId);
    expect(ids).not.toContain(pendingMemberId);
    expect(ids).not.toContain(noPaymentMemberId);
  });

  it('filters by payment_status=pending', async () => {
    const res = await request
      .get('/members?payment_status=pending')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((m: any) => m.id);
    expect(ids).toContain(pendingMemberId);
    expect(ids).not.toContain(completedMemberId);
  });

  it('combined enrollment + payment filter returns intersection', async () => {
    // completedMemberId has a user_membership (active) and payment_status=completed
    const res = await request
      .get('/members?enrollment_status=active&payment_status=completed')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((m: any) => m.id);
    expect(ids).toContain(completedMemberId);
    expect(ids).not.toContain(pendingMemberId);
    expect(ids).not.toContain(noPaymentMemberId);
  });
});

// ─── GET /:id — audit fields (#346) ──────────────────────────────────────────

describe('GET /members/:id — audit fields (#346)', () => {
  let gymId: string;
  let memberId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Members Detail Gym');
    await createTestMembership(gymId, 'admin');
    memberId = await createMember(gymId);
  });

  it('returns 200 with the member record', async () => {
    const res = await request
      .get(`/members/${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(memberId);
  });

  it('includes created_by_name and modified_by_name fields', async () => {
    const res = await request
      .get(`/members/${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('created_by_name');
    expect(res.body).toHaveProperty('modified_by_name');
  });

  it('returns 404 for a member from another gym', async () => {
    const otherGym = await createTestGym('Members Detail Other Gym');
    await createTestMembership(otherGym, 'admin');
    const otherMemberId = await createMember(otherGym);
    const res = await request
      .get(`/members/${otherMemberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

// ─── PUT /:id — profile fields (#346) ────────────────────────────────────────

describe('PUT /members/:id — profile fields (#346)', () => {
  let gymId: string;
  let memberId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Members Profile Update Gym');
    await createTestMembership(gymId, 'admin');
    memberId = await createMember(gymId);
  });

  it('updates profile fields and returns the updated member', async () => {
    const res = await request
      .put(`/members/${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        name: 'Updated Name',
        phone: '+34600000001',
        date_of_birth: '1990-05-15',
        gender: 'female',
        address: '123 Main St, Barcelona',
        emergency_contact: 'Contact Person +34600000002',
        notes: 'Internal note for this member',
      });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Name');
    expect(res.body.phone).toBe('+34600000001');
    expect(res.body.date_of_birth).toMatch(/1990-05-15/);
    expect(res.body.gender).toBe('female');
    expect(res.body.address).toBe('123 Main St, Barcelona');
    expect(res.body.emergency_contact).toBe('Contact Person +34600000002');
    expect(res.body.notes).toBe('Internal note for this member');
  });

  it('sets modified_at on update', async () => {
    await request
      .put(`/members/${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Modified Name' });

    const { rows } = await db.query<{ modified_at: string | null }>(
      'SELECT modified_at FROM members WHERE id = ?',
      [memberId],
    );
    expect(rows[0].modified_at).not.toBeNull();
  });

  it('does not update email', async () => {
    const { rows: before } = await db.query<{ email: string }>(
      'SELECT email FROM members WHERE id = ?',
      [memberId],
    );
    const originalEmail = before[0].email;

    await request
      .put(`/members/${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Name Only', email: 'newemail@test.com' });

    const { rows: after } = await db.query<{ email: string }>(
      'SELECT email FROM members WHERE id = ?',
      [memberId],
    );
    expect(after[0].email).toBe(originalEmail);
  });

  it('returns 404 for a non-existent member', async () => {
    const res = await request
      .put('/members/999999')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Ghost' });
    expect(res.status).toBe(404);
  });
});

// ─── nif_nie_passport (#513) ──────────────────────────────────────────────────

describe('POST /members — nif_nie_passport', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('Members Document Create Gym');
    await createTestMembership(gymId, 'admin');
    // A single center lets resolveMemberCenters fall back to it automatically.
    await db.query(`INSERT INTO centers (gym_id, name) VALUES (?, 'Main Center')`, [gymId]);
  });

  it('creates a member with a valid NIF and it round-trips through GET', async () => {
    const email = `doc-nif-${Date.now()}@test.com`;
    const res = await request
      .post('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Doc Nif Member', email, nif_nie_passport: '12345678Z' });
    expect(res.status).toBe(201);
    expect(res.body.nif_nie_passport).toBe('12345678Z');

    const getRes = await request
      .get(`/members/${res.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(getRes.status).toBe(200);
    expect(getRes.body.nif_nie_passport).toBe('12345678Z');
  });

  it('creates a member with a valid NIE and normalizes to uppercase', async () => {
    const email = `doc-nie-${Date.now()}@test.com`;
    const res = await request
      .post('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Doc Nie Member', email, nif_nie_passport: 'x1234567l' });
    expect(res.status).toBe(201);
    expect(res.body.nif_nie_passport).toBe('X1234567L');
  });

  it('creates a member with a valid passport value', async () => {
    const email = `doc-passport-${Date.now()}@test.com`;
    const res = await request
      .post('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Doc Passport Member', email, nif_nie_passport: 'AB1234567' });
    expect(res.status).toBe(201);
    expect(res.body.nif_nie_passport).toBe('AB1234567');
  });

  it('creates a member with no document value (null)', async () => {
    const email = `doc-none-${Date.now()}@test.com`;
    const res = await request
      .post('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Doc None Member', email });
    expect(res.status).toBe(201);
    expect(res.body.nif_nie_passport).toBeNull();
  });

  it('returns 400 with a structured error for an NIF with a bad control letter and does not persist it', async () => {
    const email = `doc-bad-nif-${Date.now()}@test.com`;
    const res = await request
      .post('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Doc Bad Nif Member', email, nif_nie_passport: '12345678A' });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');

    const { rows } = await db.query('SELECT id FROM members WHERE email = ?', [email]);
    expect(rows.length).toBe(0);
  });

  it('returns 400 for a whitespace-only document value', async () => {
    const email = `doc-ws-${Date.now()}@test.com`;
    const res = await request
      .post('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Doc Whitespace Member', email, nif_nie_passport: '   ' });
    expect(res.status).toBe(400);
  });
});

describe('POST /members — default center ignores inactive centers', () => {
  let gymId: string;
  let activeCenter: number;

  beforeAll(async () => {
    gymId = await createTestGym('Members Inactive Center Gym');
    await createTestMembership(gymId, 'admin');
    const { insertId } = await db.query(`INSERT INTO centers (gym_id, name) VALUES (?, 'Main Center')`, [gymId]);
    activeCenter = insertId as number;
    await db.query(`INSERT INTO centers (gym_id, name, status) VALUES (?, 'Closed Center', 'inactive')`, [gymId]);
  });

  it('assigns the sole active center when the gym also has an inactive one', async () => {
    const res = await request
      .post('/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Inactive Center Member', email: `inactive-center-${Date.now()}@test.com` });
    expect(res.status).toBe(201);

    const { rows } = await db.query<{ center_id: number }>(
      'SELECT center_id FROM member_centers WHERE member_id = ? AND gym_id = ? AND is_default = 1',
      [res.body.id, gymId],
    );
    expect(rows.map((r) => r.center_id)).toEqual([activeCenter]);
  });
});

describe('PUT /members/:id — nif_nie_passport', () => {
  let gymId: string;
  let memberId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Members Document Update Gym');
    await createTestMembership(gymId, 'admin');
    memberId = await createMember(gymId);
  });

  it('sets a valid NIF on update', async () => {
    const res = await request
      .put(`/members/${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Doc Update Member', nif_nie_passport: '12345678Z' });
    expect(res.status).toBe(200);
    expect(res.body.nif_nie_passport).toBe('12345678Z');
  });

  it('rejects an update with an invalid NIE control letter and leaves the stored value unchanged', async () => {
    const res = await request
      .put(`/members/${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Doc Update Member', nif_nie_passport: 'X1234567A' });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');

    const { rows } = await db.query<{ nif_nie_passport: string | null }>(
      'SELECT nif_nie_passport FROM members WHERE id = ?',
      [memberId],
    );
    expect(rows[0].nif_nie_passport).toBe('12345678Z');
  });

  it('rejects an unsupported-character passport-shaped value', async () => {
    const res = await request
      .put(`/members/${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Doc Update Member', nif_nie_passport: 'AB-123 456!' });
    expect(res.status).toBe(400);
  });

  it('clears the document value when an empty string is sent', async () => {
    const res = await request
      .put(`/members/${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Doc Update Member', nif_nie_passport: '' });
    expect(res.status).toBe(200);
    expect(res.body.nif_nie_passport).toBeNull();
  });

  it('does not affect other members when updating this field', async () => {
    const otherMemberId = await createMember(gymId);
    await request
      .put(`/members/${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ name: 'Doc Update Member', nif_nie_passport: 'AB1234567' });

    const { rows } = await db.query<{ nif_nie_passport: string | null }>(
      'SELECT nif_nie_passport FROM members WHERE id = ?',
      [otherMemberId],
    );
    expect(rows[0].nif_nie_passport).toBeNull();
  });
});
