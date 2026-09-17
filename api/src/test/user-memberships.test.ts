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
// #511 stage 1: 'draft' and 'awaiting_payment' added to the status union so
// fixtures can seed a membership at any point in the new pre-activation
// lifecycle, without touching any of this function's existing call sites.
async function createUserMembershipDirect(
  gymId: string,
  memberId: number,
  planId: number,
  status: 'draft' | 'awaiting_payment' | 'active' | 'paused' | 'cancelled' | 'expired' = 'active',
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

// recordAudit() is fire-and-forget (not awaited by the router), so poll briefly
// rather than assuming the row exists the instant the HTTP response returns
// (mirrors the identical helper in centers.test.ts).
async function waitForAuditLog(
  gymId: string,
  entityType: string,
  entityId: number,
  action: string,
  timeoutMs = 2000,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await db.query(
      `SELECT * FROM audit_logs WHERE gym_id = ? AND entity_type = ? AND entity_id = ? AND action = ?
       ORDER BY id DESC LIMIT 1`,
      [gymId, entityType, String(entityId), action],
    );
    if (rows.length > 0) return rows[0] as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

// Latest billing_events 'status_changed' row for a membership — recordStatusChange
// runs inside the same transaction as the status flip, so (unlike audit_logs) this
// is available synchronously once the HTTP response has been returned.
async function latestStatusChangeEvent(gymId: string, userMembershipId: number): Promise<any | null> {
  const { rows } = await db.query(
    `SELECT * FROM billing_events
     WHERE gym_id = ? AND user_membership_id = ? AND event_type = 'status_changed'
     ORDER BY id DESC LIMIT 1`,
    [gymId, userMembershipId],
  );
  return rows[0] ?? null;
}

// ─── Helpers for expanded detail + Billing Events (#511 stage 3) ──────────────

async function setBillingPolicy(gymId: string, planId: number, interval: number, unit: string): Promise<void> {
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, ?, ?)`,
    [gymId, planId, interval, unit],
  );
}

async function getChargeTypeId(code: string): Promise<number> {
  const { rows } = await db.query('SELECT id FROM charge_types WHERE code = ?', [code]);
  return rows[0].id;
}

async function createPromotion(gymId: string, planId: number, name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable)
     VALUES (?, ?, '2026-01-01', '2099-12-31', 'active', 0)`,
    [gymId, name],
  );
  await db.query(
    'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
    [gymId, insertId, planId],
  );
  return insertId;
}

async function setPromotionPeriodBenefit(
  gymId: string,
  promoId: number,
  chargeTypeId: number,
  action: string,
  value: number | null,
  durationMonths: number | null,
): Promise<void> {
  await db.query(
    `INSERT INTO promotion_period_benefits
       (gym_id, promotion_id, charge_type_id, quantity, frequency_interval, frequency_unit, duration_months, enabled, action, value)
     VALUES (?, ?, ?, 1, 1, 'month', ?, 1, ?, ?)`,
    [gymId, promoId, chargeTypeId, durationMonths, action, value],
  );
}

async function applyPromotionViaApi(gymId: string, umId: number, promotionId: number) {
  return request
    .post(`/user-memberships/${umId}/promotions`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ promotion_id: promotionId });
}

async function createActivityType(gymId: string, name = 'UM Yoga'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO activity_types (gym_id, name) VALUES (?, ?)`,
    [gymId, name],
  );
  return insertId;
}

async function addPlanAllowance(
  gymId: string,
  planId: number,
  activityTypeId: number,
  sessionCount: number,
): Promise<void> {
  await db.query(
    `INSERT INTO plan_allowances (gym_id, membership_plan_id, activity_type_id, allowance_type, session_count, recurrence_interval, recurrence_unit)
     VALUES (?, ?, ?, 'session_count', ?, 1, 'month')`,
    [gymId, planId, activityTypeId, sessionCount],
  );
}

async function createCenter(gymId: string): Promise<number> {
  const { insertId } = await db.query(`INSERT INTO centers (gym_id, name) VALUES (?, ?)`, [gymId, `UM-Center-${Date.now()}`]);
  return insertId;
}

async function createCalendarEvent(gymId: string, centerId: number, activityTypeId: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO calendar_events (gym_id, center_id, kind, title, activity_type_id, starts_at, ends_at, status)
     VALUES (?, ?, 'session', 'UM Test Session', ?, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 23 HOUR), 'scheduled')`,
    [gymId, centerId, activityTypeId],
  );
  return insertId;
}

async function createUsageBooking(gymId: string, centerId: number, memberId: number, eventId: number): Promise<void> {
  await db.query(
    `INSERT INTO calendar_event_bookings (gym_id, center_id, member_id, calendar_event_id, status, booked_at)
     VALUES (?, ?, ?, ?, 'booked', UTC_TIMESTAMP())`,
    [gymId, centerId, memberId, eventId],
  );
}

// Direct-insert fixture carrying an explicit base_price/starts_at/ends_at —
// createUserMembershipDirect above always uses CURDATE()/29.99, which isn't
// controllable enough for deterministic Billing Events range assertions.
async function createUserMembershipWithPrice(
  gymId: string, memberId: number, planId: number,
  status: 'draft' | 'awaiting_payment' | 'active' | 'paused' | 'cancelled' | 'expired',
  basePrice: number, startsAt: string, endsAt: string | null = null,
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, ends_at, base_price, final_price)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [gymId, memberId, planId, status, startsAt, endsAt, basePrice, basePrice],
  );
  await db.query(
    'INSERT INTO user_membership_members (gym_id, user_membership_id, member_id, is_owner) VALUES (?, ?, ?, 1)',
    [gymId, insertId, memberId],
  );
  return insertId;
}

async function insertBillingEvent(
  gymId: string, umId: number, memberId: number, eventType: string, amount: number, createdAt: string,
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO billing_events (gym_id, user_membership_id, member_id, event_type, source, amount, created_at)
     VALUES (?, ?, ?, ?, 'system', ?, ?)`,
    [gymId, umId, memberId, eventType, amount, createdAt],
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

// ─── GET /user-memberships — nif_nie_passport filter (#516) ────────────────────

describe('GET /user-memberships — nif_nie_passport filter', () => {
  let gymId: string;
  let nifId: number;
  let nifMemberId: number;
  let nieId: number;
  let noDocumentId: number;

  beforeAll(async () => {
    gymId = await createTestGym('UM NIF Filter Gym');
    await createTestMembership(gymId, 'admin');

    const planId = await createPlan(gymId);

    nifMemberId = await createMember(gymId, 'UM Filter NIF');
    await db.query('UPDATE members SET nif_nie_passport = ? WHERE id = ?', ['12345678Z', nifMemberId]);
    nifId = await createUserMembershipDirect(gymId, nifMemberId, planId, 'active');

    const nieMemberId = await createMember(gymId, 'UM Filter NIE');
    await db.query('UPDATE members SET nif_nie_passport = ? WHERE id = ?', ['X1234567L', nieMemberId]);
    nieId = await createUserMembershipDirect(gymId, nieMemberId, planId, 'active');

    const noDocumentMemberId = await createMember(gymId, 'UM Filter No Document');
    noDocumentId = await createUserMembershipDirect(gymId, noDocumentMemberId, planId, 'active');
  });

  it('performs a partial, case-insensitive match against the related member document', async () => {
    const res = await request
      .get('/user-memberships?nif_nie_passport=12345678z')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((r: any) => r.id);
    expect(ids).toContain(nifId);
    expect(ids).not.toContain(nieId);
    expect(ids).not.toContain(noDocumentId);
  });

  it('matches a fragment without requiring the full document value', async () => {
    const res = await request
      .get('/user-memberships?nif_nie_passport=X123')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((r: any) => r.id);
    expect(ids).toContain(nieId);
    expect(ids).not.toContain(nifId);
  });

  it('returns all rows when the filter is absent', async () => {
    const res = await request
      .get('/user-memberships')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const ids = res.body.map((r: any) => r.id);
    expect(ids).toContain(nifId);
    expect(ids).toContain(nieId);
    expect(ids).toContain(noDocumentId);
  });

  it('returns no rows when nothing matches', async () => {
    const res = await request
      .get('/user-memberships?nif_nie_passport=nomatch999')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('combines with other active filters', async () => {
    const matching = await request
      .get(`/user-memberships?nif_nie_passport=12345678Z&member_id=${nifMemberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(matching.status).toBe(200);
    expect(matching.body.map((r: any) => r.id)).toEqual([nifId]);

    const nonMatching = await request
      .get(`/user-memberships?nif_nie_passport=12345678Z&member_id=${nifId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(nonMatching.status).toBe(200);
    expect(nonMatching.body.length).toBe(0);
  });

  it('includes the related member document in the response', async () => {
    const res = await request
      .get(`/user-memberships?nif_nie_passport=12345678Z`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body[0].member_nif_nie_passport).toBe('12345678Z');
  });
});

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

// ─── POST /user-memberships/:id/assign-new-plan (#412) ────────────────────────

describe('POST /user-memberships/:id/assign-new-plan', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('UM Assign New Plan Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('returns 401 without an Authorization header', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const umId = await createUserMembershipDirect(gymId, memberId, planId);
    const newPlanId = await createPlan(gymId);
    const res = await request
      .post(`/user-memberships/${umId}/assign-new-plan`)
      .set('x-gym-id', gymId)
      .send({ membership_plan_id: newPlanId, starts_at: isoDate(1) });
    expect(res.status).toBe(401);
  });

  it('returns 403 when a non-admin role (front_desk) attempts to assign a new plan', async () => {
    const gymFD = await createTestGym('UM Assign New Plan FrontDesk Gym');
    await createTestMembership(gymFD, 'front_desk');
    const memberId = await createMember(gymFD);
    const planId = await createPlan(gymFD);
    const umId = await createUserMembershipDirect(gymFD, memberId, planId);
    const newPlanId = await createPlan(gymFD);
    const res = await request
      .post(`/user-memberships/${umId}/assign-new-plan`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymFD)
      .send({ membership_plan_id: newPlanId, starts_at: isoDate(1) });
    expect(res.status).toBe(403);
  });

  it('returns 404 when superseding a gym B membership with gym A credentials', async () => {
    const gymOther = await createTestGym('UM Assign New Plan Other Gym');
    // A different Clerk user is admin in the other gym -- TEST_USER_ID has no
    // membership row there, mirroring the "Tenant isolation" describe above.
    await createTestMembership(gymOther, 'admin', 'other-clerk-user-id');
    const otherMemberId = await createMember(gymOther);
    const otherPlanId = await createPlan(gymOther);
    const otherUmId = await createUserMembershipDirect(gymOther, otherMemberId, otherPlanId);

    // The target plan is valid in the *requesting* gym so the plan lookup
    // itself succeeds -- this isolates the 404 to the cross-gym membership id.
    const newPlanId = await createPlan(gymId);
    const res = await request
      .post(`/user-memberships/${otherUmId}/assign-new-plan`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ membership_plan_id: newPlanId, starts_at: isoDate(1) });
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-existent membership id', async () => {
    const newPlanId = await createPlan(gymId);
    const res = await request
      .post('/user-memberships/9999999/assign-new-plan')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ membership_plan_id: newPlanId, starts_at: isoDate(1) });
    expect(res.status).toBe(404);
  });

  it('returns 400 when membership_plan_id is missing', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const umId = await createUserMembershipDirect(gymId, memberId, planId);
    const res = await request
      .post(`/user-memberships/${umId}/assign-new-plan`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ starts_at: isoDate(1) });
    expect(res.status).toBe(400);
  });

  it('returns 400 when starts_at is missing', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const umId = await createUserMembershipDirect(gymId, memberId, planId);
    const newPlanId = await createPlan(gymId);
    const res = await request
      .post(`/user-memberships/${umId}/assign-new-plan`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ membership_plan_id: newPlanId });
    expect(res.status).toBe(400);
  });

  it('returns 400 when final_price overrides the effective price without a discount_reason', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const umId = await createUserMembershipDirect(gymId, memberId, planId);
    const newPlanId = await createPlan(gymId);
    const res = await request
      .post(`/user-memberships/${umId}/assign-new-plan`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ membership_plan_id: newPlanId, starts_at: isoDate(1), final_price: 10 });
    expect(res.status).toBe(400);
  });

  it('supersedes an active membership: old row expires, new row is active, and both appear newest-first', async () => {
    const memberId = await createMember(gymId, 'UM Assign Active Member');
    const oldPlanId = await createPlan(gymId);
    const newPlanId = await createPlan(gymId);
    const oldUmId = await createUserMembershipDirect(gymId, memberId, oldPlanId, 'active');

    const res = await request
      .post(`/user-memberships/${oldUmId}/assign-new-plan`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ membership_plan_id: newPlanId, starts_at: isoDate(1) });
    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe(oldUmId);
    expect(res.body.member_id).toBe(memberId);
    expect(res.body.status).toBe('active');
    expect(res.body.membership_plan_id).toBe(newPlanId);

    const { rows: oldRows } = await db.query('SELECT status FROM user_memberships WHERE id = ?', [oldUmId]);
    expect(oldRows[0].status).toBe('expired');

    // The new membership gets its own owner row in user_membership_members,
    // just like POST / does.
    const { rows: newOwnerRows } = await db.query(
      'SELECT member_id, is_owner FROM user_membership_members WHERE user_membership_id = ?',
      [res.body.id],
    );
    expect(newOwnerRows).toHaveLength(1);
    expect(newOwnerRows[0].member_id).toBe(memberId);
    expect(Boolean(newOwnerRows[0].is_owner)).toBe(true);

    const list = await request
      .get(`/user-memberships?member_id=${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);
    // ORDER BY starts_at DESC -- the newly-assigned (later starts_at) row comes first.
    expect(list.body[0].id).toBe(res.body.id);
    expect(list.body[0].status).toBe('active');
    expect(list.body[1].id).toBe(oldUmId);
    expect(list.body[1].status).toBe('expired');
  });

  it('supersedes a paused membership the same way (old row -> expired)', async () => {
    const memberId = await createMember(gymId, 'UM Assign Paused Member');
    const oldPlanId = await createPlan(gymId);
    const newPlanId = await createPlan(gymId);
    const oldUmId = await createUserMembershipDirect(gymId, memberId, oldPlanId, 'paused');

    const res = await request
      .post(`/user-memberships/${oldUmId}/assign-new-plan`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ membership_plan_id: newPlanId, starts_at: isoDate(1) });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');

    const { rows: oldRows } = await db.query('SELECT status FROM user_memberships WHERE id = ?', [oldUmId]);
    expect(oldRows[0].status).toBe('expired');
  });

  it('leaves an already-terminal (cancelled) membership untouched while still creating a new active row', async () => {
    const memberId = await createMember(gymId, 'UM Assign Cancelled Member');
    const oldPlanId = await createPlan(gymId);
    const newPlanId = await createPlan(gymId);
    const oldUmId = await createUserMembershipDirect(gymId, memberId, oldPlanId, 'cancelled');

    const res = await request
      .post(`/user-memberships/${oldUmId}/assign-new-plan`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ membership_plan_id: newPlanId, starts_at: isoDate(1) });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');
    expect(res.body.membership_plan_id).toBe(newPlanId);

    // The terminal old row is left exactly as it was -- never flipped to 'expired'.
    const { rows: oldRows } = await db.query('SELECT status FROM user_memberships WHERE id = ?', [oldUmId]);
    expect(oldRows[0].status).toBe('cancelled');
  });

  it('accepts a final_price override together with a discount_reason', async () => {
    const memberId = await createMember(gymId, 'UM Assign Discount Member');
    const oldPlanId = await createPlan(gymId);
    const newPlanId = await createPlan(gymId);
    const oldUmId = await createUserMembershipDirect(gymId, memberId, oldPlanId, 'active');

    const res = await request
      .post(`/user-memberships/${oldUmId}/assign-new-plan`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        membership_plan_id: newPlanId,
        starts_at: isoDate(1),
        final_price: 5,
        discount_reason: 'Loyalty discount',
      });
    expect(res.status).toBe(201);
    expect(Number(res.body.final_price)).toBe(5);
    expect(res.body.discount_reason).toBe('Loyalty discount');
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

// ─── PUT /user-memberships/:id — status transitions (#511 §10) ───────────────
// ALLOWED_TRANSITIONS: draft -> awaiting_payment|cancelled; awaiting_payment ->
// active|cancelled; active -> paused|cancelled; paused -> active|cancelled;
// cancelled/expired -> (none). Validated for any direct `status` set via PUT.

describe('PUT /user-memberships/:id — status transitions (#511 §10)', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('UM Transitions Gym');
    await createTestMembership(gymId, 'admin');
  });

  async function seedAndPut(fromStatus: Parameters<typeof createUserMembershipDirect>[3], toStatus: string) {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const umId = await createUserMembershipDirect(gymId, memberId, planId, fromStatus);
    const res = await request
      .put(`/user-memberships/${umId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ status: toStatus });
    return { res, umId };
  }

  it('allows draft -> awaiting_payment', async () => {
    const { res } = await seedAndPut('draft', 'awaiting_payment');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('awaiting_payment');
  });

  it('allows awaiting_payment -> active', async () => {
    const { res } = await seedAndPut('awaiting_payment', 'active');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
  });

  it('allows paused -> active', async () => {
    const { res } = await seedAndPut('paused', 'active');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
  });

  it('rejects awaiting_payment -> paused with a 400 and an explanatory message', async () => {
    const { res } = await seedAndPut('awaiting_payment', 'paused');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/awaiting_payment/);
    expect(res.body.error).toMatch(/paused/);
  });

  it('rejects draft -> active (must go through awaiting_payment)', async () => {
    const { res } = await seedAndPut('draft', 'active');
    expect(res.status).toBe(400);
  });

  it('rejects any transition out of cancelled', async () => {
    const { res } = await seedAndPut('cancelled', 'active');
    expect(res.status).toBe(400);
  });

  it('rejects any transition out of expired', async () => {
    const { res } = await seedAndPut('expired', 'active');
    expect(res.status).toBe(400);
  });

  it('leaves the stored status unchanged after a rejected transition', async () => {
    const { res, umId } = await seedAndPut('awaiting_payment', 'paused');
    expect(res.status).toBe(400);
    const { rows } = await db.query('SELECT status FROM user_memberships WHERE id = ?', [umId]);
    expect(rows[0].status).toBe('awaiting_payment');
  });
});

// ─── POST /user-memberships/:id/submit (#511) ─────────────────────────────────

describe('POST /user-memberships/:id/submit', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('UM Submit Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('returns 401 without an Authorization header', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const umId = await createUserMembershipDirect(gymId, memberId, planId, 'draft');
    const res = await request.post(`/user-memberships/${umId}/submit`).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 when a read-only role (accountant) attempts to submit', async () => {
    const gymRO = await createTestGym('UM Submit RO Gym');
    await createTestMembership(gymRO, 'accountant');
    const memberId = await createMember(gymRO);
    const planId = await createPlan(gymRO);
    const umId = await createUserMembershipDirect(gymRO, memberId, planId, 'draft');
    const res = await request
      .post(`/user-memberships/${umId}/submit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymRO);
    expect(res.status).toBe(403);
  });

  it('returns 404 when submitting a gym B membership with gym A credentials', async () => {
    const gymOther = await createTestGym('UM Submit Other Gym');
    await createTestMembership(gymOther, 'admin', 'other-clerk-user-id');
    const memberId = await createMember(gymOther);
    const planId = await createPlan(gymOther);
    const otherUmId = await createUserMembershipDirect(gymOther, memberId, planId, 'draft');
    const res = await request
      .post(`/user-memberships/${otherUmId}/submit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-existent membership', async () => {
    const res = await request
      .post('/user-memberships/9999999/submit')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 400 when submitting from any status other than draft', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const umId = await createUserMembershipDirect(gymId, memberId, planId, 'active');
    const res = await request
      .post(`/user-memberships/${umId}/submit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/active/);
  });

  it('transitions draft -> awaiting_payment, recording a billing_events row and an audit log', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const umId = await createUserMembershipDirect(gymId, memberId, planId, 'draft');
    const res = await request
      .post(`/user-memberships/${umId}/submit`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('awaiting_payment');

    const event = await latestStatusChangeEvent(gymId, umId);
    expect(event).not.toBeNull();
    expect(event.previous_status).toBe('draft');
    expect(event.new_status).toBe('awaiting_payment');

    const auditRow = await waitForAuditLog(gymId, 'user_membership', umId, 'submit');
    expect(auditRow).not.toBeNull();
  });
});

// ─── POST /user-memberships/:id/pause (#511) ──────────────────────────────────

describe('POST /user-memberships/:id/pause', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('UM Pause Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('returns 401 without an Authorization header', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const umId = await createUserMembershipDirect(gymId, memberId, planId, 'active');
    const res = await request.post(`/user-memberships/${umId}/pause`).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 when a read-only role (accountant) attempts to pause', async () => {
    const gymRO = await createTestGym('UM Pause RO Gym');
    await createTestMembership(gymRO, 'accountant');
    const memberId = await createMember(gymRO);
    const planId = await createPlan(gymRO);
    const umId = await createUserMembershipDirect(gymRO, memberId, planId, 'active');
    const res = await request
      .post(`/user-memberships/${umId}/pause`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymRO);
    expect(res.status).toBe(403);
  });

  it('returns 404 when pausing a gym B membership with gym A credentials', async () => {
    const gymOther = await createTestGym('UM Pause Other Gym');
    await createTestMembership(gymOther, 'admin', 'other-clerk-user-id');
    const memberId = await createMember(gymOther);
    const planId = await createPlan(gymOther);
    const otherUmId = await createUserMembershipDirect(gymOther, memberId, planId, 'active');
    const res = await request
      .post(`/user-memberships/${otherUmId}/pause`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-existent membership', async () => {
    const res = await request
      .post('/user-memberships/9999999/pause')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 400 when pausing from any status other than active', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const umId = await createUserMembershipDirect(gymId, memberId, planId, 'draft');
    const res = await request
      .post(`/user-memberships/${umId}/pause`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/draft/);
  });

  it('transitions active -> paused, recording a billing_events row and an audit log', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const umId = await createUserMembershipDirect(gymId, memberId, planId, 'active');
    const res = await request
      .post(`/user-memberships/${umId}/pause`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paused');

    const event = await latestStatusChangeEvent(gymId, umId);
    expect(event).not.toBeNull();
    expect(event.previous_status).toBe('active');
    expect(event.new_status).toBe('paused');

    const auditRow = await waitForAuditLog(gymId, 'user_membership', umId, 'pause');
    expect(auditRow).not.toBeNull();
  });
});

// ─── POST /user-memberships/:id/reactivate (#511) ─────────────────────────────

describe('POST /user-memberships/:id/reactivate', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('UM Reactivate Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('returns 401 without an Authorization header', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const umId = await createUserMembershipDirect(gymId, memberId, planId, 'paused');
    const res = await request.post(`/user-memberships/${umId}/reactivate`).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 when a read-only role (accountant) attempts to reactivate', async () => {
    const gymRO = await createTestGym('UM Reactivate RO Gym');
    await createTestMembership(gymRO, 'accountant');
    const memberId = await createMember(gymRO);
    const planId = await createPlan(gymRO);
    const umId = await createUserMembershipDirect(gymRO, memberId, planId, 'paused');
    const res = await request
      .post(`/user-memberships/${umId}/reactivate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymRO);
    expect(res.status).toBe(403);
  });

  it('returns 404 when reactivating a gym B membership with gym A credentials', async () => {
    const gymOther = await createTestGym('UM Reactivate Other Gym');
    await createTestMembership(gymOther, 'admin', 'other-clerk-user-id');
    const memberId = await createMember(gymOther);
    const planId = await createPlan(gymOther);
    const otherUmId = await createUserMembershipDirect(gymOther, memberId, planId, 'paused');
    const res = await request
      .post(`/user-memberships/${otherUmId}/reactivate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-existent membership', async () => {
    const res = await request
      .post('/user-memberships/9999999/reactivate')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 400 when reactivating from any status other than paused', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const umId = await createUserMembershipDirect(gymId, memberId, planId, 'active');
    const res = await request
      .post(`/user-memberships/${umId}/reactivate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/active/);
  });

  it('transitions paused -> active, recording a billing_events row and an audit log', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const umId = await createUserMembershipDirect(gymId, memberId, planId, 'paused');
    const res = await request
      .post(`/user-memberships/${umId}/reactivate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');

    const event = await latestStatusChangeEvent(gymId, umId);
    expect(event).not.toBeNull();
    expect(event.previous_status).toBe('paused');
    expect(event.new_status).toBe('active');

    const auditRow = await waitForAuditLog(gymId, 'user_membership', umId, 'reactivate');
    expect(auditRow).not.toBeNull();
  });
});

// ─── POST /user-memberships/:id/close (#511 §7) ───────────────────────────────
// Admin-only, mirroring DELETE's cancel restriction. Closeable from
// awaiting_payment/active/paused; warns (409) + requires `confirm: true` when
// next_billing_date is today or in the future; closes immediately otherwise.

describe('POST /user-memberships/:id/close', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('UM Close Gym');
    await createTestMembership(gymId, 'admin');
  });

  async function setNextBillingDate(umId: number, dateExpr: string | null) {
    if (dateExpr === null) {
      await db.query('UPDATE user_memberships SET next_billing_date = NULL WHERE id = ?', [umId]);
    } else {
      await db.query(`UPDATE user_memberships SET next_billing_date = ${dateExpr} WHERE id = ?`, [umId]);
    }
  }

  it('returns 401 without an Authorization header', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const umId = await createUserMembershipDirect(gymId, memberId, planId, 'active');
    const res = await request.post(`/user-memberships/${umId}/close`).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 when a non-admin role (front_desk) attempts to close', async () => {
    const gymFD = await createTestGym('UM Close FrontDesk Gym');
    await createTestMembership(gymFD, 'front_desk');
    const memberId = await createMember(gymFD);
    const planId = await createPlan(gymFD);
    const umId = await createUserMembershipDirect(gymFD, memberId, planId, 'active');
    const res = await request
      .post(`/user-memberships/${umId}/close`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymFD);
    expect(res.status).toBe(403);
  });

  it('returns 404 when closing a gym B membership with gym A credentials', async () => {
    const gymOther = await createTestGym('UM Close Other Gym');
    await createTestMembership(gymOther, 'admin', 'other-clerk-user-id');
    const memberId = await createMember(gymOther);
    const planId = await createPlan(gymOther);
    const otherUmId = await createUserMembershipDirect(gymOther, memberId, planId, 'active');
    const res = await request
      .post(`/user-memberships/${otherUmId}/close`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-existent membership', async () => {
    const res = await request
      .post('/user-memberships/9999999/close')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it.each(['draft', 'cancelled', 'expired'] as const)(
    'returns 400 when closing from status %s',
    async (status) => {
      const memberId = await createMember(gymId);
      const planId = await createPlan(gymId);
      const umId = await createUserMembershipDirect(gymId, memberId, planId, status);
      const res = await request
        .post(`/user-memberships/${umId}/close`)
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', gymId);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(new RegExp(status));
    },
  );

  it('closes immediately (no confirm needed) when there is no pending next_billing_date', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const umId = await createUserMembershipDirect(gymId, memberId, planId, 'active');
    await setNextBillingDate(umId, null);

    const res = await request
      .post(`/user-memberships/${umId}/close`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');

    const { rows } = await db.query('SELECT status, closed_at FROM user_memberships WHERE id = ?', [umId]);
    expect(rows[0].status).toBe('cancelled');
    expect(rows[0].closed_at).not.toBeNull();

    const event = await latestStatusChangeEvent(gymId, umId);
    expect(event).not.toBeNull();
    expect(event.previous_status).toBe('active');
    expect(event.new_status).toBe('cancelled');

    const auditRow = await waitForAuditLog(gymId, 'user_membership', umId, 'close');
    expect(auditRow).not.toBeNull();
  });

  it('closes immediately when next_billing_date is in the past', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const umId = await createUserMembershipDirect(gymId, memberId, planId, 'active');
    await setNextBillingDate(umId, 'DATE_SUB(CURDATE(), INTERVAL 1 DAY)');

    const res = await request
      .post(`/user-memberships/${umId}/close`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
  });

  it('returns 409 with unused_value_impacted + warnings when next_billing_date is today, and does not close', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const umId = await createUserMembershipDirect(gymId, memberId, planId, 'active');
    await setNextBillingDate(umId, 'CURDATE()');

    const res = await request
      .post(`/user-memberships/${umId}/close`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('unused_value_impacted');
    expect(Array.isArray(res.body.warnings)).toBe(true);
    expect(res.body.warnings.length).toBeGreaterThan(0);
    expect(res.body.message).toEqual(expect.any(String));

    const { rows } = await db.query('SELECT status, closed_at FROM user_memberships WHERE id = ?', [umId]);
    expect(rows[0].status).toBe('active');
    expect(rows[0].closed_at).toBeNull();
  });

  it('returns 409 when next_billing_date is in the future, and does not close', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const umId = await createUserMembershipDirect(gymId, memberId, planId, 'paused');
    await setNextBillingDate(umId, 'DATE_ADD(CURDATE(), INTERVAL 7 DAY)');

    const res = await request
      .post(`/user-memberships/${umId}/close`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('unused_value_impacted');

    const { rows } = await db.query('SELECT status FROM user_memberships WHERE id = ?', [umId]);
    expect(rows[0].status).toBe('paused');
  });

  it('closes when confirm: true is sent despite a pending next_billing_date', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const umId = await createUserMembershipDirect(gymId, memberId, planId, 'active');
    await setNextBillingDate(umId, 'DATE_ADD(CURDATE(), INTERVAL 7 DAY)');

    const warned = await request
      .post(`/user-memberships/${umId}/close`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(warned.status).toBe(409);

    const res = await request
      .post(`/user-memberships/${umId}/close`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');

    const { rows } = await db.query('SELECT status, closed_at FROM user_memberships WHERE id = ?', [umId]);
    expect(rows[0].status).toBe('cancelled');
    expect(rows[0].closed_at).not.toBeNull();
  });

  // #511 (stage 3): the unused-value check now also reuses the same
  // loadActivityAllowancesUsage helper GET /:id's `activity_allowances`
  // section calls, so a session_count allowance with sessions still
  // remaining in its current recurrence window warns too, on top of the
  // pre-existing pending-billing check above.
  it('returns 409 with a warning when a session_count allowance still has sessions remaining', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const activityTypeId = await createActivityType(gymId);
    await addPlanAllowance(gymId, planId, activityTypeId, 4);
    const umId = await createUserMembershipDirect(gymId, memberId, planId, 'active');
    await setNextBillingDate(umId, null);

    const centerId = await createCenter(gymId);
    const eventId = await createCalendarEvent(gymId, centerId, activityTypeId);
    await createUsageBooking(gymId, centerId, memberId, eventId);

    const res = await request
      .post(`/user-memberships/${umId}/close`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('unused_value_impacted');
    expect(res.body.warnings.some((w: string) => w.includes('3 unused'))).toBe(true);

    const confirmed = await request
      .post(`/user-memberships/${umId}/close`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ confirm: true });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('cancelled');
  });
});

// ─── GET /user-memberships/:id — audit metadata (#511 stage 2) ───────────────
// created_by_name/modified_by_name/modified_at are derived from audit_logs
// (loadAuditMetadata) and only ever added on this single-resource GET, not on
// the list endpoint. The mocked Clerk user resolves to actorName 'Test User'
// (see setup.ts), which is what recordAudit stamps onto every audit_logs row
// written by TEST_USER_ID.

describe('GET /user-memberships/:id — audit metadata (#511 stage 2)', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('UM Audit Metadata Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('sets created_by_name and leaves modified_by_name/modified_at null right after creation', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const createRes = await request
      .post('/user-memberships')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, membership_plan_id: planId, starts_at: '2026-01-01' });
    expect(createRes.status).toBe(201);
    const umId = createRes.body.id;

    // recordAudit is fire-and-forget -- wait for the 'create' row to land
    // before asserting on the audit-derived fields.
    const auditRow = await waitForAuditLog(gymId, 'user_membership', umId, 'create');
    expect(auditRow).not.toBeNull();

    const res = await request
      .get(`/user-memberships/${umId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.created_by_name).toBe('Test User');
    expect(res.body.modified_by_name).toBeNull();
    expect(res.body.modified_at).toBeNull();
  });

  it('sets modified_by_name/modified_at after a mutation (pause), while created_by_name still reflects creation', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const createRes = await request
      .post('/user-memberships')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: memberId, membership_plan_id: planId, starts_at: '2026-01-01' });
    expect(createRes.status).toBe(201);
    const umId = createRes.body.id;
    await waitForAuditLog(gymId, 'user_membership', umId, 'create');

    const pauseRes = await request
      .post(`/user-memberships/${umId}/pause`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(pauseRes.status).toBe(200);
    const pauseAuditRow = await waitForAuditLog(gymId, 'user_membership', umId, 'pause');
    expect(pauseAuditRow).not.toBeNull();

    const res = await request
      .get(`/user-memberships/${umId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.created_by_name).toBe('Test User');
    expect(res.body.modified_by_name).toBe('Test User');
    expect(res.body.modified_at).not.toBeNull();
  });

  it('sets modified_by_name/modified_at after a PUT edit as well', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const umId = await createUserMembershipDirect(gymId, memberId, planId, 'active');

    const putRes = await request
      .put(`/user-memberships/${umId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ status: 'paused' });
    expect(putRes.status).toBe(200);
    const putAuditRow = await waitForAuditLog(gymId, 'user_membership', umId, 'update');
    expect(putAuditRow).not.toBeNull();

    const res = await request
      .get(`/user-memberships/${umId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    // createUserMembershipDirect is a raw DB insert (no 'create' audit row),
    // so created_by_name has no audit history to report -- only the
    // modified_* fields from the PUT are exercised here.
    expect(res.body.created_by_name).toBeNull();
    expect(res.body.modified_by_name).toBe('Test User');
    expect(res.body.modified_at).not.toBeNull();
  });

  it('does not include audit metadata fields on the list endpoint', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const umId = await createUserMembershipDirect(gymId, memberId, planId, 'active');

    const res = await request
      .get('/user-memberships')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const row = res.body.find((r: any) => r.id === umId);
    expect(row).toBeDefined();
    expect(row.created_by_name).toBeUndefined();
    expect(row.modified_by_name).toBeUndefined();
    expect(row.modified_at).toBeUndefined();
  });
});

// ─── GET /user-memberships/:id — expanded detail (#511 stage 3) ──────────────

describe('GET /user-memberships/:id — expanded detail (#511 stage 3)', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('UM Expanded Detail Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('includes members, billing_policy, charge_benefits, activity_allowances and promotions', async () => {
    const owner = await createMember(gymId, 'UM Expanded Owner');
    const partner = await createMember(gymId, 'UM Expanded Partner');
    const planId = await createPlan(gymId, '2');
    await setBillingPolicy(gymId, planId, 1, 'month');
    const activityTypeId = await createActivityType(gymId);
    await addPlanAllowance(gymId, planId, activityTypeId, 4);
    const umId = await createUserMembershipDirect(gymId, owner, planId, 'active');
    await request
      .post(`/user-memberships/${umId}/members`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_id: partner });

    const centerId = await createCenter(gymId);
    const eventId = await createCalendarEvent(gymId, centerId, activityTypeId);
    await createUsageBooking(gymId, centerId, owner, eventId);

    const res = await request
      .get(`/user-memberships/${umId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);

    expect(res.body.members).toHaveLength(2);
    expect(res.body.members.map((m: any) => m.member_id).sort()).toEqual([owner, partner].sort());

    expect(res.body.billing_policy).toMatchObject({ recurring_billing_interval: 1, recurring_billing_unit: 'month' });

    expect(Array.isArray(res.body.charge_benefits)).toBe(true);

    const allowance = res.body.activity_allowances.find((a: any) => a.activity_type_id === activityTypeId);
    expect(allowance).toBeDefined();
    expect(allowance.allocated).toBe(4);
    expect(allowance.used).toBe(1);
    expect(allowance.remaining).toBe(3);

    expect(Array.isArray(res.body.promotions)).toBe(true);

    expect(res.body.billing_events).toBeDefined();
    expect(res.body.billing_events.projected).toBe(false);
  });

  it('reports a draft plan Billing Events view as a projection (projected: true)', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    await setBillingPolicy(gymId, planId, 1, 'month');
    const umId = await createUserMembershipWithPrice(gymId, memberId, planId, 'draft', 40, '2026-01-01');

    const res = await request
      .get(`/user-memberships/${umId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.billing_events.available).toBe(true);
    expect(res.body.billing_events.projected).toBe(true);
    expect(res.body.billing_events.events.length).toBeGreaterThan(0);
    expect(res.body.billing_events.events.every((e: any) => e.projected === true)).toBe(true);
  });

  it('returns 404 for a non-existent membership', async () => {
    const res = await request
      .get('/user-memberships/9999999')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});

// ─── GET /user-memberships/:id/billing-events (#511 stage 3, issue thread Q2) ─
// Range rule: all events affected by an applied promotion, plus the events
// covering the following two calendar months after the last one; with no
// applicable promotion, the next two calendar months from the billing start
// date. Drafts (never persisted to billing_events) get a computed
// projection instead of a query.

describe('GET /user-memberships/:id/billing-events (#511 stage 3)', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('UM Billing Events Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('returns 401 without an Authorization header', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const umId = await createUserMembershipDirect(gymId, memberId, planId, 'active');
    const res = await request.get(`/user-memberships/${umId}/billing-events`).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 404 for a non-existent membership', async () => {
    const res = await request
      .get('/user-memberships/9999999/billing-events')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('returns 404 accessing a gym B membership with gym A credentials', async () => {
    const gymOther = await createTestGym('UM Billing Events Other Gym');
    await createTestMembership(gymOther, 'admin', 'other-clerk-user-id');
    const otherMemberId = await createMember(gymOther);
    const otherPlanId = await createPlan(gymOther);
    const otherUmId = await createUserMembershipDirect(gymOther, otherMemberId, otherPlanId, 'active');
    const res = await request
      .get(`/user-memberships/${otherUmId}/billing-events`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });

  it('reports unavailable for a draft plan with no billing policy configured', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    const umId = await createUserMembershipWithPrice(gymId, memberId, planId, 'draft', 40, '2026-01-01');
    const res = await request
      .get(`/user-memberships/${umId}/billing-events`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.events).toEqual([]);
  });

  it('projects the next 2 calendar months for a draft plan with no applicable promotions', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    await setBillingPolicy(gymId, planId, 1, 'month');
    const umId = await createUserMembershipWithPrice(gymId, memberId, planId, 'draft', 40, '2026-01-01');

    const res = await request
      .get(`/user-memberships/${umId}/billing-events`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.projected).toBe(true);
    expect(res.body.range_start).toBe('2026-01-01');
    expect(res.body.range_end).toBe('2026-03-01');
    expect(res.body.events.map((e: any) => e.date)).toEqual(['2026-02-01', '2026-03-01']);
    expect(res.body.events.every((e: any) => Number(e.amount) === 40 && !e.promotion_affected)).toBe(true);
  });

  it('extends a draft plan projection 2 months past the last event affected by an applied promotion', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    await setBillingPolicy(gymId, planId, 1, 'month');
    const membershipFeeTypeId = await getChargeTypeId('membership_fee');
    const promoId = await createPromotion(gymId, planId, `Draft-Promo-${Date.now()}`);
    await setPromotionPeriodBenefit(gymId, promoId, membershipFeeTypeId, 'fixed_discount', 10, 2);
    const umId = await createUserMembershipWithPrice(gymId, memberId, planId, 'draft', 40, '2026-01-01');
    const applyRes = await applyPromotionViaApi(gymId, umId, promoId);
    expect(applyRes.status).toBe(201);
    // The promotion's duration_months window is counted from its applied_at —
    // pin it to the plan's billing start so the projected cycle dates line
    // up deterministically with the assertions below.
    await db.query(
      'UPDATE user_membership_promotions SET applied_at = ? WHERE user_membership_id = ? AND promotion_id = ?',
      ['2026-01-01', umId, promoId],
    );

    const res = await request
      .get(`/user-memberships/${umId}/billing-events`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.projected).toBe(true);
    // Promotion covers 2026-02-01 (< 2026-01-01 + 2 months expiry) only.
    expect(res.body.range_end).toBe('2026-04-01');
    expect(res.body.events.map((e: any) => e.date)).toEqual(['2026-02-01', '2026-03-01', '2026-04-01']);
    const first = res.body.events[0];
    expect(first.promotion_affected).toBe(true);
    expect(Number(first.amount)).toBe(30);
    expect(res.body.events[1].promotion_affected).toBe(false);
    expect(res.body.events[2].promotion_affected).toBe(false);
  });

  it('queries the persisted ledger for a submitted plan and covers the next 2 calendar months with no promotions', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    await setBillingPolicy(gymId, planId, 1, 'month');
    const umId = await createUserMembershipWithPrice(gymId, memberId, planId, 'active', 40, '2026-01-01');
    await insertBillingEvent(gymId, umId, memberId, 'status_changed', 0, '2026-01-01 10:00:00');
    await insertBillingEvent(gymId, umId, memberId, 'recurring_payment', 40, '2026-02-01 10:00:00');
    // Outside the [2026-01-01, 2026-03-01] range with no promotions applied.
    await insertBillingEvent(gymId, umId, memberId, 'recurring_payment', 40, '2026-05-01 10:00:00');

    const res = await request
      .get(`/user-memberships/${umId}/billing-events`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.projected).toBe(false);
    expect(res.body.range_start).toBe('2026-01-01');
    expect(res.body.range_end).toBe('2026-03-01');
    expect(res.body.events.map((e: any) => e.event_type)).toEqual(['status_changed', 'recurring_payment']);
    expect(res.body.events.every((e: any) => !e.promotion_affected)).toBe(true);
  });

  it('tags persisted events within an applied promotion window and extends the range past the last one', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    await setBillingPolicy(gymId, planId, 1, 'month');
    const membershipFeeTypeId = await getChargeTypeId('membership_fee');
    const promoId = await createPromotion(gymId, planId, `Submitted-Promo-${Date.now()}`);
    await setPromotionPeriodBenefit(gymId, promoId, membershipFeeTypeId, 'fixed_discount', 10, null);
    const umId = await createUserMembershipWithPrice(gymId, memberId, planId, 'active', 40, '2026-01-01');
    const applyRes = await applyPromotionViaApi(gymId, umId, promoId);
    expect(applyRes.status).toBe(201);
    // Still-applied (no revoked_at) -> an open-ended window from applied_at.
    await db.query(
      'UPDATE user_membership_promotions SET applied_at = ? WHERE user_membership_id = ? AND promotion_id = ?',
      ['2026-02-01', umId, promoId],
    );
    // Applying the promotion for real also recorded its own 'adjustment'
    // billing_events row at the (real, present-day) moment it was applied —
    // clear it so this test's assertions only reflect the explicit fixture
    // events below, at their controlled dates.
    await db.query("DELETE FROM billing_events WHERE user_membership_id = ? AND event_type = 'adjustment'", [umId]);

    await insertBillingEvent(gymId, umId, memberId, 'recurring_payment', 40, '2026-01-01 10:00:00');
    await insertBillingEvent(gymId, umId, memberId, 'recurring_payment', 30, '2026-02-01 10:00:00');
    await insertBillingEvent(gymId, umId, memberId, 'recurring_payment', 30, '2026-05-01 10:00:00');

    const res = await request
      .get(`/user-memberships/${umId}/billing-events`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    // Last promotion-affected event is 2026-05-01 (still open-ended) -> range_end = 2026-07-01.
    expect(res.body.range_end).toBe('2026-07-01');
    expect(res.body.events.map((e: any) => e.created_at ? String(e.created_at).slice(0, 10) : null))
      .toEqual(['2026-01-01', '2026-02-01', '2026-05-01']);
    expect(res.body.events[0].promotion_affected).toBe(false);
    expect(res.body.events[1].promotion_affected).toBe(true);
    expect(res.body.events[2].promotion_affected).toBe(true);
  });

  it('excludes events after a promotion is revoked from the tagged/last-affected calculation', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    await setBillingPolicy(gymId, planId, 1, 'month');
    const membershipFeeTypeId = await getChargeTypeId('membership_fee');
    const promoId = await createPromotion(gymId, planId, `Revoked-Promo-${Date.now()}`);
    await setPromotionPeriodBenefit(gymId, promoId, membershipFeeTypeId, 'fixed_discount', 10, null);
    const umId = await createUserMembershipWithPrice(gymId, memberId, planId, 'active', 40, '2026-01-01');
    const applyRes = await applyPromotionViaApi(gymId, umId, promoId);
    expect(applyRes.status).toBe(201);
    const revokeRes = await request
      .delete(`/user-memberships/${umId}/promotions/${promoId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(revokeRes.status).toBe(200);
    await db.query(
      'UPDATE user_membership_promotions SET applied_at = ?, revoked_at = ? WHERE user_membership_id = ? AND promotion_id = ?',
      ['2026-01-01', '2026-02-01', umId, promoId],
    );
    // Applying/revoking for real also recorded their own 'adjustment'
    // billing_events rows at the (real, present-day) moment they happened —
    // clear them so this test's assertions only reflect the explicit
    // fixture events below, at their controlled dates.
    await db.query("DELETE FROM billing_events WHERE user_membership_id = ? AND event_type = 'adjustment'", [umId]);

    await insertBillingEvent(gymId, umId, memberId, 'recurring_payment', 30, '2026-01-15 10:00:00');
    // After revoked_at -> not promotion-affected, and (being the only
    // promotion-affected event) the range stops 2 months after 2026-01-15.
    await insertBillingEvent(gymId, umId, memberId, 'recurring_payment', 40, '2026-06-01 10:00:00');

    const res = await request
      .get(`/user-memberships/${umId}/billing-events`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.range_end).toBe('2026-03-15');
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].promotion_affected).toBe(true);
  });

  it('returns fewer events when the plan ends before the full range', async () => {
    const memberId = await createMember(gymId);
    const planId = await createPlan(gymId);
    await setBillingPolicy(gymId, planId, 1, 'month');
    const umId = await createUserMembershipWithPrice(gymId, memberId, planId, 'active', 40, '2026-01-01', '2026-01-20');
    await insertBillingEvent(gymId, umId, memberId, 'status_changed', 0, '2026-01-01 10:00:00');

    const res = await request
      .get(`/user-memberships/${umId}/billing-events`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.range_end).toBe('2026-01-20');
    expect(res.body.events).toHaveLength(1);
  });
});
