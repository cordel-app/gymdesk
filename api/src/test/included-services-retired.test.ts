// #635 stage 4 (part 2) — Included Services retired (§1, and the issue's answer
// that "the relation should be [the other way] around … So Included services can
// be completely removed").
//
// Integration tests, in the same shape as charge-benefits-retired.test.ts: the
// concept must be gone from the real Express + MySQL stack (the endpoints no
// longer route, no payload carries the field, migration 177 dropped the table),
// and the two behaviours that used to ride on `plan_allowances` must still work —
// booking access, which is the Activity Type's own eligible-plan list now, and
// class packages, which still pay for an activity the member's plan does not
// grant. The center-coverage check that shared the retired hook's file is
// exercised too, since it moved to `plan-center-access.ts`.

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

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

async function createPlan(gymId: string, name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '1')`,
    [gymId, `${name} ${uniq()}`],
  );
  return insertId;
}

async function createMember(gymId: string, centerId?: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'IS Retired Member', ?)`,
    [gymId, `is-retired-${uniq()}@example.com`],
  );
  if (centerId) {
    await db.query(
      `INSERT INTO member_centers (gym_id, member_id, center_id, is_default, assigned_at)
       VALUES (?, ?, ?, 1, UTC_TIMESTAMP())`,
      [gymId, insertId, centerId],
    );
  }
  return insertId;
}

async function createCenter(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO centers (gym_id, name) VALUES (?, ?)`, [gymId, `IS-Center-${uniq()}`],
  );
  return insertId;
}

/** A non-public activity type: `public_event = 0` makes the eligible-plan list decide. */
async function createRestrictedActivityType(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO activity_types (gym_id, name, duration_minutes, max_capacity, status, public_event)
     VALUES (?, ?, 60, 10, 'active', 0)`,
    [gymId, `IS Yoga ${uniq()}`],
  );
  return insertId;
}

async function allowPlanToBook(gymId: string, activityTypeId: number, planId: number) {
  await db.query(
    `INSERT INTO activity_type_eligible_plans (gym_id, activity_type_id, membership_plan_id)
     VALUES (?, ?, ?)`,
    [gymId, activityTypeId, planId],
  );
}

async function assignActivePlan(gymId: string, memberId: number, planId: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at)
     VALUES (?, ?, ?, 'active', CURDATE())`,
    [gymId, memberId, planId],
  );
  return insertId;
}

async function createSession(gymId: string, activityTypeId: number, centerId: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO calendar_events (gym_id, center_id, title, activity_type_id, starts_at, ends_at, status)
     VALUES (?, ?, 'IS Retired Session', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 2 DAY),
             DATE_ADD(UTC_TIMESTAMP(), INTERVAL 49 HOUR), 'scheduled')`,
    [gymId, centerId, activityTypeId],
  );
  return insertId;
}

async function givePackage(gymId: string, memberId: number, sessions: number): Promise<number> {
  const { insertId: packageId } = await db.query(
    `INSERT INTO class_packages (gym_id, name, number_of_sessions, price, validity_days, status)
     VALUES (?, ?, ?, 50, 180, 'active')`,
    [gymId, `IS Package ${uniq()}`, sessions],
  );
  const { insertId } = await db.query(
    `INSERT INTO user_class_packages (gym_id, member_id, class_package_id, purchased_at, expires_at, sessions_remaining, status)
     VALUES (?, ?, ?, UTC_TIMESTAMP(), DATE_ADD(UTC_DATE(), INTERVAL 180 DAY), ?, 'active')`,
    [gymId, memberId, packageId, sessions],
  );
  return insertId;
}

async function book(gymId: string, memberId: number, sessionId: number) {
  return request
    .post('/bookings')
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ member_id: memberId, class_session_id: sessionId });
}

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS n FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [name],
  );
  return Number(rows[0].n) > 0;
}

describe('Included Services are retired (#635 stage 4)', () => {
  let gymId: string;
  let planId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Included Services Retired Gym');
    await createTestMembership(gymId, 'admin');
    planId = await createPlan(gymId, 'IS Retired Plan');
  });

  // ── The schema ──

  it('drops plan_allowances (migration 177)', async () => {
    expect(await tableExists('plan_allowances')).toBe(false);
  });

  it('keeps activity_type_eligible_plans, which is the relation that replaces it', async () => {
    expect(await tableExists('activity_type_eligible_plans')).toBe(true);
  });

  // ── The endpoints ──

  it.each([
    ['get', ''],
    ['post', ''],
    ['put', '/1'],
    ['delete', '/1'],
  ])('no longer routes %s /membership-plans/:id/allowances%s', async (method, suffix) => {
    const res = await (request as any)[method](`/membership-plans/${planId}/allowances${suffix}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({});
    expect(res.status).toBe(404);
  });

  // ── The payloads ──

  it('drops allowances from GET /membership-plans/:id, keeping the Benefit sections', async () => {
    const res = await request
      .get(`/membership-plans/${planId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.allowances).toBeUndefined();
    expect(Array.isArray(res.body.session_benefits)).toBe(true);
    expect(Array.isArray(res.body.oneoff_benefits)).toBe(true);
    expect(Array.isArray(res.body.periodical_benefits)).toBe(true);
  });

  it('drops allowances from GET /membership-plans (list)', async () => {
    const res = await request
      .get('/membership-plans')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    for (const plan of res.body) {
      expect(plan.allowances).toBeUndefined();
    }
  });

  it('drops activity_allowances from GET /user-memberships/:id, keeping the #635 snapshot', async () => {
    const memberId = await createMember(gymId);
    const assign = await request
      .post(`/membership-plans/${planId}/assign`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ member_ids: [memberId], owner_member_id: memberId, starts_at: '2026-01-01' });
    expect(assign.status).toBe(201);

    const detail = await request
      .get(`/user-memberships/${assign.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(detail.status).toBe(200);
    expect(detail.body.activity_allowances).toBeUndefined();
    expect(detail.body.snapshot).toBeDefined();
  });

  it('drops activity_allowances from the Member membership configuration', async () => {
    const memberId = await createMember(gymId);
    await assignActivePlan(gymId, memberId, planId);

    const res = await request
      .get(`/user-memberships/member/${memberId}/configuration`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.plans).toHaveLength(1);
    expect(res.body.plans[0].activity_allowances).toBeUndefined();
  });

  it('duplicates a Plan without allowances to copy', async () => {
    const res = await request
      .post(`/membership-plans/${planId}/duplicate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(201);
    expect(res.body.allowances).toBeUndefined();
  });
});

// ─── Booking access without Included Services ────────────────────────────────
// The rule `plan_allowances` enforced ("the plan must include this activity
// type") is now the Activity Type's own eligible-plan list, and a session_count
// cap no longer exists at all.

describe('Booking access after Included Services (#635 stage 4)', () => {
  let gymId: string;
  let centerId: number;

  beforeAll(async () => {
    gymId = await createTestGym('IS Retired Booking Gym');
    await createTestMembership(gymId, 'admin');
    centerId = await createCenter(gymId);
  });

  it('lets a member on an eligible plan book, with no allowance row to configure', async () => {
    const planId = await createPlan(gymId, 'IS Eligible Plan');
    const atId = await createRestrictedActivityType(gymId);
    await allowPlanToBook(gymId, atId, planId);
    const memberId = await createMember(gymId, centerId);
    await assignActivePlan(gymId, memberId, planId);

    const res = await book(gymId, memberId, await createSession(gymId, atId, centerId));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('booked');
  });

  it('never caps how many sessions of an activity an eligible plan may book', async () => {
    const planId = await createPlan(gymId, 'IS Uncapped Plan');
    const atId = await createRestrictedActivityType(gymId);
    await allowPlanToBook(gymId, atId, planId);
    const memberId = await createMember(gymId, centerId);
    await assignActivePlan(gymId, memberId, planId);

    for (let i = 0; i < 3; i++) {
      const res = await book(gymId, memberId, await createSession(gymId, atId, centerId));
      expect(res.status).toBe(201);
    }
  });

  it('rejects a member whose plan is not on the eligible list', async () => {
    const eligiblePlan = await createPlan(gymId, 'IS Other Plan');
    const atId = await createRestrictedActivityType(gymId);
    await allowPlanToBook(gymId, atId, eligiblePlan);
    const memberId = await createMember(gymId, centerId);
    await assignActivePlan(gymId, memberId, await createPlan(gymId, 'IS Wrong Plan'));

    const res = await book(gymId, memberId, await createSession(gymId, atId, centerId));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('plan_not_eligible');
  });

  it('lets a class package pay for an activity the plan does not grant, debiting one credit', async () => {
    const eligiblePlan = await createPlan(gymId, 'IS Package Other Plan');
    const atId = await createRestrictedActivityType(gymId);
    await allowPlanToBook(gymId, atId, eligiblePlan);
    const memberId = await createMember(gymId, centerId);
    await assignActivePlan(gymId, memberId, await createPlan(gymId, 'IS Package Wrong Plan'));
    const userPackageId = await givePackage(gymId, memberId, 5);

    const res = await book(gymId, memberId, await createSession(gymId, atId, centerId));
    expect(res.status).toBe(201);

    const { rows } = await db.query(
      'SELECT sessions_remaining FROM user_class_packages WHERE id = ?', [userPackageId],
    );
    expect(Number(rows[0].sessions_remaining)).toBe(4);
  });

  it('charges no credit when the plan already grants the activity', async () => {
    const planId = await createPlan(gymId, 'IS No Debit Plan');
    const atId = await createRestrictedActivityType(gymId);
    await allowPlanToBook(gymId, atId, planId);
    const memberId = await createMember(gymId, centerId);
    await assignActivePlan(gymId, memberId, planId);
    const userPackageId = await givePackage(gymId, memberId, 5);

    const res = await book(gymId, memberId, await createSession(gymId, atId, centerId));
    expect(res.status).toBe(201);

    const { rows } = await db.query(
      'SELECT sessions_remaining FROM user_class_packages WHERE id = ?', [userPackageId],
    );
    expect(Number(rows[0].sessions_remaining)).toBe(5);
  });

  // The center check shared `plan-allowances.ts` with the retired allowance gate
  // and moved to `plan-center-access.ts` — it must still reject.
  it('still enforces the plan\'s center coverage', async () => {
    const planId = await createPlan(gymId, 'IS Center Plan');
    const atId = await createRestrictedActivityType(gymId);
    await allowPlanToBook(gymId, atId, planId);
    const coveredCenter = await createCenter(gymId);
    await db.query(
      'INSERT INTO membership_plan_centers (gym_id, membership_plan_id, center_id) VALUES (?, ?, ?)',
      [gymId, planId, coveredCenter],
    );
    const memberId = await createMember(gymId, centerId);
    await assignActivePlan(gymId, memberId, planId);

    // The session runs at a center the plan does not cover.
    const res = await book(gymId, memberId, await createSession(gymId, atId, centerId));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('center_not_covered');
  });
});

// ─── Closing an assignment ───────────────────────────────────────────────────
// #511 stage 3 warned about a session_count allowance with sessions left in its
// window. With the allowance gone, a pending billing event is the only unused
// value an assignment can carry.

describe('POST /user-memberships/:id/close after Included Services (#635 stage 4)', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('IS Retired Close Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('closes without a confirmation prompt when there is no pending billing', async () => {
    const planId = await createPlan(gymId, 'IS Close Plan');
    const atId = await createRestrictedActivityType(gymId);
    await allowPlanToBook(gymId, atId, planId);
    const memberId = await createMember(gymId);
    const umId = await assignActivePlan(gymId, memberId, planId);
    await db.query('UPDATE user_memberships SET next_billing_date = NULL WHERE id = ?', [umId]);

    const res = await request
      .post(`/user-memberships/${umId}/close`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
  });
});
