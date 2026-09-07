// Tests for user-memberships.ts router

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

async function createPlan(
  gymId: string,
  memberLimit: '1' | '2' | 'family' = '1',
): Promise<number> {
  const name = `UM-Plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'staff_only', ?)`,
    [gymId, name, memberLimit],
  );
  return insertId;
}

async function createMember(gymId: string, name = 'UM Test Member'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)`,
    [gymId, name, `um-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`],
  );
  return insertId;
}

// Direct-insert fixture: creates a user_memberships row plus its owner row in
// user_membership_members, mirroring what POST /user-memberships does — used
// whenever a test needs an existing Membership without exercising POST itself.
async function createUserMembershipDirect(
  gymId: string,
  memberId: number,
  planId: number,
  status: 'active' | 'paused' | 'cancelled' | 'expired' = 'active',
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, final_price)
     VALUES (?, ?, ?, ?, CURDATE(), 29.99)`,
    [gymId, memberId, planId, status],
  );
  await db.query(
    'INSERT INTO user_membership_members (gym_id, user_membership_id, member_id, is_owner) VALUES (?, ?, ?, 1)',
    [gymId, insertId, memberId],
  );
  return insertId;
}

// ─── Auth and access guards ───────────────────────────────────────────────────

describe('Auth and access guards', () => {
  let gymId: string;
  let gymNoAccess: string;
  let gymReadOnly: string;

  beforeAll(async () => {
    gymId = await createTestGym('UM Auth Gym');
    await createTestMembership(gymId, 'admin');

    // trainer_performance has NONE on PAYMENTS -> the app.ts-level
    // requireModuleAccess('PAYMENTS') guard returns 403 for every route.
    gymNoAccess = await createTestGym('UM No Access Gym');
    await createTestMembership(gymNoAccess, 'trainer_performance');

    // accountant has R on PAYMENTS -> can GET, but requireModuleWrite('PAYMENTS')
    // blocks POST/PUT/members-write routes.
    gymReadOnly = await createTestGym('UM Read Only Gym');
    await createTestMembership(gymReadOnly, 'accountant');
  });

  it('returns 401 without an Authorization header', async () => {
    const res = await request.get('/user-memberships').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 when role has NONE access to PAYMENTS (trainer_performance)', async () => {
    const res = await request
      .get('/user-memberships')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymNoAccess);
    expect(res.status).toBe(403);
  });

  it('allows a read-only role (accountant) to GET the list', async () => {
    const res = await request
      .get('/user-memberships')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymReadOnly);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('returns 403 when a read-only role (accountant) attempts POST', async () => {
    const memberId = await createMember(gymReadOnly);
    const planId = await createPlan(gymReadOnly);
    const res = await request
      .post('/user-memberships')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymReadOnly)
      .send({ member_id: memberId, membership_plan_id: planId, starts_at: '2026-01-01' });
    expect(res.status).toBe(403);
  });

  it('returns 403 when a non-admin role (front_desk) attempts DELETE (cancel)', async () => {
    const gymFD = await createTestGym('UM FrontDesk Delete Gym');
    await createTestMembership(gymFD, 'front_desk');
    const memberId = await createMember(gymFD);
    const planId = await createPlan(gymFD);
    const umId = await createUserMembershipDirect(gymFD, memberId, planId);
    const res = await request
      .delete(`/user-memberships/${umId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymFD);
    expect(res.status).toBe(403);
  });
});

// ─── Tenant isolation ─────────────────────────────────────────────────────────

describe('Tenant isolation', () => {
  let gymA: string;
  let gymB: string;
  let memberB: number;
  let umB: number;

  beforeAll(async () => {
    gymA = await createTestGym('UM Tenant Gym A');
    await createTestMembership(gymA, 'admin');

    gymB = await createTestGym('UM Tenant Gym B');
    // A different Clerk user is admin in gym B — TEST_USER_ID has no
    // membership row here, which is what the 403 case below exercises.
    await createTestMembership(gymB, 'admin', 'other-clerk-user-id');
    memberB = await createMember(gymB);
    const planB = await createPlan(gymB, '2');
    umB = await createUserMembershipDirect(gymB, memberB, planB);
  });

  it('returns 403 when the user has no membership in the requested gym', async () => {
    const res = await request
      .get('/user-memberships')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymB);
    expect(res.status).toBe(403);
  });

  it('returns 404 accessing a gym B membership with gym A credentials', async () => {
    const res = await request
      .get(`/user-memberships/${umB}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA);
    expect(res.status).toBe(404);
  });

  it('returns 404 listing the members of a gym B membership with gym A credentials', async () => {
    const res = await request
      .get(`/user-memberships/${umB}/members`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA);
    expect(res.status).toBe(404);
  });

  it('returns 404 adding a member to a gym B membership with gym A credentials', async () => {
    const gymAMember = await createMember(gymA);
    const res = await request
      .post(`/user-memberships/${umB}/members`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA)
      .send({ member_id: gymAMember });
    expect(res.status).toBe(404);
  });

  it('returns 404 removing a member from a gym B membership with gym A credentials', async () => {
    const res = await request
      .delete(`/user-memberships/${umB}/members/${memberB}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymA);
    expect(res.status).toBe(404);
  });
});

// ─── POST /user-memberships ───────────────────────────────────────────────────

describe('POST /user-memberships', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('UM Create Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('creates a membership, inserts the owner as a covered member, and returns 201', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const res = await request
      .post('/user-memberships')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, membership_plan_id: planId, starts_at: '2026-01-01' });
    expect(res.status).toBe(201);
    expect(res.body.member_id).toBe(memberId);
    expect(res.body.status).toBe('active');
    expect(res.body.plan_member_limit).toBe('1');

    const { rows } = await db.query(
      'SELECT member_id, is_owner FROM user_membership_members WHERE user_membership_id = ?',
      [res.body.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].member_id).toBe(memberId);
    expect(Boolean(rows[0].is_owner)).toBe(true);
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request
      .post('/user-memberships')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ starts_at: '2026-01-01' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when member_id does not exist', async () => {
    const planId = await createPlan(gymId);
    const res = await request
      .post('/user-memberships')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: 9999999, membership_plan_id: planId, starts_at: '2026-01-01' });
    expect(res.status).toBe(404);
  });

  it('returns 404 when membership_plan_id does not exist', async () => {
    const memberId = await createMember(gymId);
    const res = await request
      .post('/user-memberships')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, membership_plan_id: 9999999, starts_at: '2026-01-01' });
    expect(res.status).toBe(404);
  });

  it('returns 409 when the member already has an active membership', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    await request
      .post('/user-memberships')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, membership_plan_id: planId, starts_at: '2026-01-01' });
    const res = await request
      .post('/user-memberships')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, membership_plan_id: planId, starts_at: '2026-01-02' });
    expect(res.status).toBe(409);
  });
});

// ─── GET /user-memberships ────────────────────────────────────────────────────

describe('GET /user-memberships', () => {
  let gymId: string;
  let umId: number;
  let memberId: number;

  beforeAll(async () => {
    gymId = await createTestGym('UM List Gym');
    await createTestMembership(gymId, 'admin');
    memberId = await createMember(gymId);
    const planId = await createPlan(gymId, '2');
    umId = await createUserMembershipDirect(gymId, memberId, planId);
  });

  it('returns 200 with an array including plan_member_limit', async () => {
    const res = await request
      .get('/user-memberships')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const row = res.body.find((r: any) => r.id === umId);
    expect(row).toBeDefined();
    expect(row.plan_member_limit).toBe('2');
  });

  it('filters by member_id', async () => {
    const res = await request
      .get(`/user-memberships?member_id=${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.every((r: any) => r.member_id === memberId)).toBe(true);
  });
});

// ─── GET /user-memberships — lifecycle_status (#410) ──────────────────────────

describe('GET /user-memberships — lifecycle_status', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('UM Lifecycle Status Gym');
    await createTestMembership(gymId, 'admin');
  });

  async function listLifecycleStatus(umId: number): Promise<string> {
    const res = await request
      .get('/user-memberships')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const row = res.body.find((r: any) => r.id === umId);
    expect(row).toBeDefined();
    return row.lifecycle_status;
  }

  it("reports 'pending' for a row whose starts_at is in the future", async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const { insertId: umId } = await db.query(
      `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, final_price)
       VALUES (?, ?, ?, 'active', DATE_ADD(CURDATE(), INTERVAL 7 DAY), 29.99)`,
      [gymId, memberId, planId],
    );
    expect(await listLifecycleStatus(umId)).toBe('pending');
  });

  it("reports 'active' for an ongoing, open-ended row", async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const umId = await createUserMembershipDirect(gymId, memberId, planId, 'active');
    expect(await listLifecycleStatus(umId)).toBe('active');
  });

  it("reports 'expired' for an active row whose ends_at has passed", async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const { insertId: umId } = await db.query(
      `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, ends_at, final_price)
       VALUES (?, ?, ?, 'active', DATE_SUB(CURDATE(), INTERVAL 60 DAY), DATE_SUB(CURDATE(), INTERVAL 1 DAY), 29.99)`,
      [gymId, memberId, planId],
    );
    expect(await listLifecycleStatus(umId)).toBe('expired');
  });

  it("passes through the stored status for 'paused', 'cancelled' and 'expired' rows", async () => {
    for (const status of ['paused', 'cancelled', 'expired'] as const) {
      const memberId = await createMember(gymId);
      const planId = await createPlan(gymId);
      const umId = await createUserMembershipDirect(gymId, memberId, planId, status);
      expect(await listLifecycleStatus(umId)).toBe(status);
    }
  });
});

// ─── GET /user-memberships — advanced filtering (#411) ─────────────────────────

describe('GET /user-memberships — advanced filtering', () => {
  let gymId: string;
  let pendingId: number;
  let activeId: number;
  let expiredId: number;
  let pausedId: number;
  let memberIdForActive: number;

  beforeAll(async () => {
    gymId = await createTestGym('UM Advanced Filters Gym');
    await createTestMembership(gymId, 'admin');

    const planId = await createPlan(gymId);

    const pendingMemberId = await createMember(gymId, 'UM Filter Pending');
    ({ insertId: pendingId } = await db.query(
      `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, final_price)
       VALUES (?, ?, ?, 'active', DATE_ADD(CURDATE(), INTERVAL 7 DAY), 29.99)`,
      [gymId, pendingMemberId, planId],
    ));

    memberIdForActive = await createMember(gymId, 'UM Filter Active');
    activeId = await createUserMembershipDirect(gymId, memberIdForActive, planId, 'active');

    const expiredMemberId = await createMember(gymId, 'UM Filter Expired');
    ({ insertId: expiredId } = await db.query(
      `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, ends_at, final_price)
       VALUES (?, ?, ?, 'active', DATE_SUB(CURDATE(), INTERVAL 60 DAY), DATE_SUB(CURDATE(), INTERVAL 1 DAY), 29.99)`,
      [gymId, expiredMemberId, planId],
    ));

    const pausedMemberId = await createMember(gymId, 'UM Filter Paused');
    pausedId = await createUserMembershipDirect(gymId, pausedMemberId, planId, 'paused');
  });

  it('filters by a single lifecycle_status value', async () => {
    const res = await request
      .get('/user-memberships?lifecycle_status=pending')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((r: any) => r.id);
    expect(ids).toContain(pendingId);
    expect(ids).not.toContain(activeId);
    expect(ids).not.toContain(expiredId);
    expect(ids).not.toContain(pausedId);
  });

  it('filters by multiple lifecycle_status values (repeated query param)', async () => {
    const res = await request
      .get('/user-memberships?lifecycle_status=pending&lifecycle_status=paused')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((r: any) => r.id);
    expect(ids).toContain(pendingId);
    expect(ids).toContain(pausedId);
    expect(ids).not.toContain(activeId);
    expect(ids).not.toContain(expiredId);
  });

  it('filters by multiple lifecycle_status values (comma-separated)', async () => {
    const res = await request
      .get('/user-memberships?lifecycle_status=expired,paused')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((r: any) => r.id);
    expect(ids).toContain(expiredId);
    expect(ids).toContain(pausedId);
    expect(ids).not.toContain(pendingId);
    expect(ids).not.toContain(activeId);
  });

  it('returns 400 for an invalid lifecycle_status value', async () => {
    const res = await request
      .get('/user-memberships?lifecycle_status=bogus')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });

  it('filters by member_id together with lifecycle_status', async () => {
    const res = await request
      .get(`/user-memberships?member_id=${memberIdForActive}&lifecycle_status=active`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].id).toBe(activeId);
  });

  it('filters by a start_date/end_date range overlapping starts_at/ends_at', async () => {
    // The expired row's window is [-60d, -1d]; a range entirely before it should exclude it.
    const before = await request
      .get('/user-memberships?end_date=' + isoDate(-90))
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(before.status).toBe(200);
    expect(before.body.map((r: any) => r.id)).not.toContain(expiredId);

    // A range overlapping [-60d, -1d] should include it.
    const overlapping = await request
      .get(`/user-memberships?start_date=${isoDate(-30)}&end_date=${isoDate(-10)}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(overlapping.status).toBe(200);
    expect(overlapping.body.map((r: any) => r.id)).toContain(expiredId);
  });

  it('returns 400 for a malformed date filter', async () => {
    const res = await request
      .get('/user-memberships?start_date=not-a-date')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });
});

function isoDate(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// ─── GET /user-memberships/:id ────────────────────────────────────────────────

describe('GET /user-memberships/:id', () => {
  let gymId: string;
  let umId: number;

  beforeAll(async () => {
    gymId = await createTestGym('UM GetById Gym');
    await createTestMembership(gymId, 'admin');
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    umId = await createUserMembershipDirect(gymId, memberId, planId);
  });

  it('returns the membership by id', async () => {
    const res = await request
      .get(`/user-memberships/${umId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(umId);
  });

  it('returns 404 for a non-existent membership', async () => {
    const res = await request
      .get('/user-memberships/9999999')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

// ─── PUT /user-memberships/:id ────────────────────────────────────────────────

describe('PUT /user-memberships/:id', () => {
  let gymId: string;
  let umId: number;

  beforeAll(async () => {
    gymId = await createTestGym('UM Update Gym');
    await createTestMembership(gymId, 'admin');
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    umId = await createUserMembershipDirect(gymId, memberId, planId);
  });

  it('updates status to paused and returns 200', async () => {
    const res = await request
      .put(`/user-memberships/${umId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ status: 'paused' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paused');
  });

  it('returns 400 for an invalid status', async () => {
    const res = await request
      .put(`/user-memberships/${umId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ status: 'bogus' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for a non-existent membership', async () => {
    const res = await request
      .put('/user-memberships/9999999')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ status: 'paused' });
    expect(res.status).toBe(404);
  });

  it('returns 403 when a non-admin role attempts to cancel via PUT', async () => {
    const gymFD = await createTestGym('UM PUT Cancel Guard Gym');
    await createTestMembership(gymFD, 'front_desk');
    const memberId = await createMember(gymFD);
    const planId = await createPlan(gymFD);
    const fdUmId = await createUserMembershipDirect(gymFD, memberId, planId);
    const res = await request
      .put(`/user-memberships/${fdUmId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymFD)
      .send({ status: 'cancelled' });
    expect(res.status).toBe(403);
  });
});

// ─── DELETE /user-memberships/:id (cancel) ────────────────────────────────────

describe('DELETE /user-memberships/:id', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('UM Delete Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('cancels a membership and returns 204', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const umId = await createUserMembershipDirect(gymId, memberId, planId);
    const res = await request
      .delete(`/user-memberships/${umId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);
    const { rows } = await db.query('SELECT status FROM user_memberships WHERE id = ?', [umId]);
    expect(rows[0].status).toBe('cancelled');
  });

  it('returns 404 when cancelling an already-cancelled membership', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const umId = await createUserMembershipDirect(gymId, memberId, planId);
    await request
      .delete(`/user-memberships/${umId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    const res = await request
      .delete(`/user-memberships/${umId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-existent membership', async () => {
    const res = await request
      .delete('/user-memberships/9999999')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

// ─── GET /user-memberships/:id/members (#374) ─────────────────────────────────

describe('GET /user-memberships/:id/members', () => {
  let gymId: string;
  let owner: number;
  let umId: number;

  beforeAll(async () => {
    gymId = await createTestGym('UM Members Get Gym');
    await createTestMembership(gymId, 'admin');
    owner = await createMember(gymId, 'Owner Member');
    const planId = await createPlan(gymId, '2');
    umId = await createUserMembershipDirect(gymId, owner, planId);
  });

  it('returns the member_limit and an owner-first members list', async () => {
    const res = await request
      .get(`/user-memberships/${umId}/members`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.member_limit).toBe('2');
    expect(res.body.members).toHaveLength(1);
    expect(res.body.members[0].member_id).toBe(owner);
    expect(Boolean(res.body.members[0].is_owner)).toBe(true);
  });

  it('returns 404 for a non-existent membership', async () => {
    const res = await request
      .get('/user-memberships/9999999/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

// ─── POST /user-memberships/:id/members (#374) ────────────────────────────────

describe('POST /user-memberships/:id/members', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('UM Members Add Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('returns 400 when member_id is missing', async () => {
    const owner = await createMember(gymId);
    const planId = await createPlan(gymId, '2');
    const umId = await createUserMembershipDirect(gymId, owner, planId);
    const res = await request
      .post(`/user-memberships/${umId}/members`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 when the membership does not exist', async () => {
    const other = await createMember(gymId);
    const res = await request
      .post('/user-memberships/9999999/members')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: other });
    expect(res.status).toBe(404);
  });

  it('returns 404 when member_id does not exist in this gym', async () => {
    const owner = await createMember(gymId);
    const planId = await createPlan(gymId, '2');
    const umId = await createUserMembershipDirect(gymId, owner, planId);
    const res = await request
      .post(`/user-memberships/${umId}/members`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: 9999999 });
    expect(res.status).toBe(404);
  });

  it('returns 404 when member_id is soft-deleted', async () => {
    const owner = await createMember(gymId);
    const planId = await createPlan(gymId, '2');
    const umId = await createUserMembershipDirect(gymId, owner, planId);
    const deleted = await createMember(gymId);
    await db.query('UPDATE members SET deleted_at = NOW() WHERE id = ?', [deleted]);
    const res = await request
      .post(`/user-memberships/${umId}/members`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: deleted });
    expect(res.status).toBe(404);
  });

  it('adds a covered member on a "2" plan and returns 201 with both members', async () => {
    const owner = await createMember(gymId);
    const partner = await createMember(gymId);
    const planId = await createPlan(gymId, '2');
    const umId = await createUserMembershipDirect(gymId, owner, planId);
    const res = await request
      .post(`/user-memberships/${umId}/members`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: partner });
    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(2);
    const ids = res.body.map((m: any) => m.member_id);
    expect(ids).toContain(owner);
    expect(ids).toContain(partner);
  });

  it("returns 400 with a member-limit message on a '1' plan when adding a second member", async () => {
    const owner = await createMember(gymId);
    const other = await createMember(gymId);
    const planId = await createPlan(gymId, '1');
    const umId = await createUserMembershipDirect(gymId, owner, planId);
    const res = await request
      .post(`/user-memberships/${umId}/members`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: other });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/member limit/i);
  });

  it("returns 400 with a member-limit message on a '2' plan when adding a third member", async () => {
    const owner = await createMember(gymId);
    const second = await createMember(gymId);
    const third = await createMember(gymId);
    const planId = await createPlan(gymId, '2');
    const umId = await createUserMembershipDirect(gymId, owner, planId);
    await request
      .post(`/user-memberships/${umId}/members`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: second });
    const res = await request
      .post(`/user-memberships/${umId}/members`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: third });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/member limit/i);
  });

  it("allows adding several covered members on a 'family' plan (unlimited)", async () => {
    const owner = await createMember(gymId);
    const planId = await createPlan(gymId, 'family');
    const umId = await createUserMembershipDirect(gymId, owner, planId);
    for (let i = 0; i < 4; i++) {
      const extra = await createMember(gymId);
      const res = await request
        .post(`/user-memberships/${umId}/members`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId)
        .send({ member_id: extra });
      expect(res.status).toBe(201);
    }
    const { rows } = await db.query(
      'SELECT COUNT(*) AS n FROM user_membership_members WHERE user_membership_id = ?',
      [umId],
    );
    expect(Number(rows[0].n)).toBe(5); // owner + 4 added
  });

  it('returns 409 when the same member is added twice to the same membership', async () => {
    // Uses a 'family' (unlimited) plan so the duplicate hits the unique-constraint
    // check rather than being pre-empted by the member-limit check (limit is
    // checked before the insert, so a capped plan would return 400 first).
    const owner = await createMember(gymId);
    const partner = await createMember(gymId);
    const planId = await createPlan(gymId, 'family');
    const umId = await createUserMembershipDirect(gymId, owner, planId);
    await request
      .post(`/user-memberships/${umId}/members`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: partner });
    const res = await request
      .post(`/user-memberships/${umId}/members`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: partner });
    expect(res.status).toBe(409);
  });

  it('returns 403 when a read-only role (accountant) attempts to add a member', async () => {
    const gymRO = await createTestGym('UM Members Add RO Gym');
    await createTestMembership(gymRO, 'accountant');
    const owner = await createMember(gymRO);
    const partner = await createMember(gymRO);
    const planId = await createPlan(gymRO, '2');
    const umId = await createUserMembershipDirect(gymRO, owner, planId);
    const res = await request
      .post(`/user-memberships/${umId}/members`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymRO)
      .send({ member_id: partner });
    expect(res.status).toBe(403);
  });
});

// ─── DELETE /user-memberships/:id/members/:memberId (#374) ───────────────────

describe('DELETE /user-memberships/:id/members/:memberId', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('UM Members Remove Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('returns 404 when the member is not covered by this membership', async () => {
    const owner = await createMember(gymId);
    const planId = await createPlan(gymId, '2');
    const umId = await createUserMembershipDirect(gymId, owner, planId);
    const notCovered = await createMember(gymId);
    const res = await request
      .delete(`/user-memberships/${umId}/members/${notCovered}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 400 when attempting to remove the owner', async () => {
    const owner = await createMember(gymId);
    const planId = await createPlan(gymId, '2');
    const umId = await createUserMembershipDirect(gymId, owner, planId);
    const res = await request
      .delete(`/user-memberships/${umId}/members/${owner}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/owner/i);
  });

  it('removes a non-owner covered member and returns 204', async () => {
    const owner = await createMember(gymId);
    const partner = await createMember(gymId);
    const planId = await createPlan(gymId, '2');
    const umId = await createUserMembershipDirect(gymId, owner, planId);
    await request
      .post(`/user-memberships/${umId}/members`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: partner });

    const res = await request
      .delete(`/user-memberships/${umId}/members/${partner}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(204);

    const { rows } = await db.query(
      'SELECT * FROM user_membership_members WHERE user_membership_id = ? AND member_id = ?',
      [umId, partner],
    );
    expect(rows).toHaveLength(0);
  });

  it('returns 403 when a read-only role (accountant) attempts to remove a member', async () => {
    const gymRO = await createTestGym('UM Members Remove RO Gym');
    await createTestMembership(gymRO, 'accountant');
    const owner = await createMember(gymRO);
    const partner = await createMember(gymRO);
    const planId = await createPlan(gymRO, '2');
    const umId = await createUserMembershipDirect(gymRO, owner, planId);
    await db.query(
      'INSERT INTO user_membership_members (gym_id, user_membership_id, member_id, is_owner) VALUES (?, ?, ?, 0)',
      [gymRO, umId, partner],
    );
    const res = await request
      .delete(`/user-memberships/${umId}/members/${partner}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymRO);
    expect(res.status).toBe(403);
  });
});
