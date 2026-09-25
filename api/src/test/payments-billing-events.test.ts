// Tests for payments.ts billing-events routes

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

// ── Local setup helpers ───────────────────────────────────────────────────────

async function createMember(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'BE Test Member', ?)`,
    [gymId, `be-member-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`],
  );
  return insertId;
}

async function getChargeTypeId(code = 'membership_fee'): Promise<number> {
  const { rows } = await db.query<{ id: number }>('SELECT id FROM charge_types WHERE code = ?', [code]);
  return rows[0].id;
}

async function insertBillingEvent(gymId: string, memberId: number): Promise<number> {
  return insertBillingEventOfType(gymId, memberId, 'payment_recorded');
}

async function insertBillingEventOfType(gymId: string, memberId: number, eventType: string): Promise<number> {
  const chargeTypeId = await getChargeTypeId();
  const { insertId } = await db.query(
    `INSERT INTO billing_events (gym_id, member_id, event_type, charge_type_id, source, actor_user_id, amount)
     VALUES (?, ?, ?, ?, 'employee', 'test-user', 99.00)`,
    [gymId, memberId, eventType, chargeTypeId],
  );
  return insertId;
}

async function insertBillingEventForMembership(
  gymId: string,
  memberId: number,
  userMembershipId: number,
): Promise<number> {
  const chargeTypeId = await getChargeTypeId();
  const { insertId } = await db.query(
    `INSERT INTO billing_events
       (gym_id, member_id, user_membership_id, event_type, charge_type_id, source, actor_user_id, amount)
     VALUES (?, ?, ?, 'payment_recorded', ?, 'employee', 'test-user', 99.00)`,
    [gymId, memberId, userMembershipId, chargeTypeId],
  );
  return insertId;
}

async function createMembershipPlan(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'staff_only')`,
    [gymId, `BE-Plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`],
  );
  return insertId;
}

async function createPlanWithPolicy(gymId: string): Promise<number> {
  const planId = await createMembershipPlan(gymId);
  await db.query(
    `INSERT INTO billing_policies
       (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`,
    [gymId, planId],
  );
  return planId;
}

async function createUserMembership(
  gymId: string,
  memberId: number,
  planId: number,
  nextBillingDate: string | null = null,
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO user_memberships
       (gym_id, member_id, membership_plan_id, status, starts_at, final_price, next_billing_date)
     VALUES (?, ?, ?, 'active', '2000-01-01', '29.99', ?)`,
    [gymId, memberId, planId, nextBillingDate],
  );
  return insertId;
}

async function insertPaymentRequest(
  gymId: string,
  billingEventId: number,
  memberId: number,
  userMembershipId: number,
): Promise<number> {
  const chargeTypeId = await getChargeTypeId();
  const { insertId } = await db.query(
    `INSERT INTO payment_requests
       (gym_id, user_membership_id, member_id, amount, currency, charge_type_id,
        status, provider, provider_order, page_token, page_token_expires, source, billing_event_id)
     VALUES (?, ?, ?, '99.00', 'EUR', ?, 'completed', 'monei',
             UUID(), UUID(), DATE_ADD(NOW(), INTERVAL 10 MINUTE), 'admin', ?)`,
    [gymId, userMembershipId, memberId, chargeTypeId, billingEventId],
  );
  return insertId;
}

// ── GET /payments/billing-events ─────────────────────────────────────────────

describe('GET /payments/billing-events', () => {
  let gymId: string;
  let otherGymId: string;
  let memberId: number;
  let billingEventId: number;

  beforeAll(async () => {
    gymId = await createTestGym('BE List Gym');
    otherGymId = await createTestGym('BE Other Gym');
    await createTestMembership(gymId, 'admin');
    await createTestMembership(otherGymId, 'admin');

    memberId = await createMember(gymId);
    billingEventId = await insertBillingEvent(gymId, memberId);
  });

  it('returns 401 without auth', async () => {
    const res = await request.get('/payments/billing-events').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns empty list for a gym with no billing events (tenant isolation)', async () => {
    // otherGymId has no billing events; the endpoint filters by gym_id so it
    // returns an empty list rather than 403/404.
    const res = await request
      .get('/payments/billing-events')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('items');
    const realItems = res.body.items.filter((i: any) => i.type === 'real');
    expect(realItems).toHaveLength(0);
  });

  it('returns 200 with paginated result and correct row shape', async () => {
    const res = await request
      .get('/payments/billing-events')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('items');
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('limit');
    expect(res.body).toHaveProperty('offset');
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);

    const item = res.body.items.find((i: any) => i.type === 'real' && i.id === billingEventId);
    expect(item).toBeDefined();
    expect(item).toHaveProperty('id', billingEventId);
    expect(item).toHaveProperty('type', 'real');
    expect(item).toHaveProperty('member_id', memberId);
    expect(item).toHaveProperty('billing_date');
    expect(item).toHaveProperty('amount');
    expect(item).toHaveProperty('event_type');
    expect(item).toHaveProperty('status');
  });

  it('filters by member_id', async () => {
    const secondMemberId = await createMember(gymId);
    await insertBillingEvent(gymId, secondMemberId);

    const res = await request
      .get(`/payments/billing-events?member_id=${memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const realItems = res.body.items.filter((i: any) => i.type === 'real');
    expect(realItems.length).toBeGreaterThan(0);
    expect(realItems.every((i: any) => i.member_id === memberId)).toBe(true);
  });

  it('filters by from/to date range', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await request
      .get(`/payments/billing-events?from=${today}&to=${today}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    // All real rows that came back must have billing_date within the range.
    const realItems = res.body.items.filter((i: any) => i.type === 'real');
    expect(realItems.length).toBeGreaterThan(0);
    realItems.forEach((i: any) => {
      expect(i.billing_date >= today && i.billing_date <= today).toBe(true);
    });
  });

  it('includes virtual rows when an active membership has a future next_billing_date', async () => {
    const planId = await createPlanWithPolicy(gymId);
    const futureMemberId = await createMember(gymId);
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 30);
    const futureDateStr = futureDate.toISOString().slice(0, 10);
    await createUserMembership(gymId, futureMemberId, planId, futureDateStr);

    const res = await request
      .get('/payments/billing-events')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const virtualItems = res.body.items.filter((i: any) => i.type === 'virtual');
    expect(virtualItems.length).toBeGreaterThan(0);
    const v = virtualItems[0];
    expect(v.id).toBeNull();
    expect(v.status).toBe('scheduled');
    expect(v.event_type).toBe('upcoming');
  });

  // ── #416: multi-select status filtering ──
  describe('status filter (#416)', () => {
    let statusGymId: string;
    let statusMemberId: number;
    let paidId: number;
    let failedId: number;

    beforeAll(async () => {
      statusGymId = await createTestGym('BE Status Gym');
      await createTestMembership(statusGymId, 'admin');
      statusMemberId = await createMember(statusGymId);
      paidId = await insertBillingEventOfType(statusGymId, statusMemberId, 'payment_recorded');
      failedId = await insertBillingEventOfType(statusGymId, statusMemberId, 'failed_billing');
      await insertBillingEventOfType(statusGymId, statusMemberId, 'adjustment'); // -> 'recorded'

      // Also give this gym a scheduled/virtual billing event so 'scheduled' filtering has something to match.
      const planId = await createPlanWithPolicy(statusGymId);
      const futureMemberId = await createMember(statusGymId);
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 30);
      await createUserMembership(statusGymId, futureMemberId, planId, futureDate.toISOString().slice(0, 10));
    });

    it('filters by a single status', async () => {
      const res = await request
        .get('/payments/billing-events?status=paid')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', statusGymId);
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      expect(res.body.items.every((i: any) => i.status === 'paid')).toBe(true);
      expect(res.body.items.some((i: any) => i.id === paidId)).toBe(true);
    });

    it('filters by multiple statuses passed as a comma-separated value', async () => {
      const res = await request
        .get('/payments/billing-events?status=paid,failed')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', statusGymId);
      expect(res.status).toBe(200);
      const statuses = new Set(res.body.items.map((i: any) => i.status));
      expect([...statuses].every((s) => s === 'paid' || s === 'failed')).toBe(true);
      expect(res.body.items.some((i: any) => i.id === paidId)).toBe(true);
      expect(res.body.items.some((i: any) => i.id === failedId)).toBe(true);
    });

    it('filters by multiple statuses passed as repeated params', async () => {
      const res = await request
        .get('/payments/billing-events?status=paid&status=failed')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', statusGymId);
      expect(res.status).toBe(200);
      const statuses = new Set(res.body.items.map((i: any) => i.status));
      expect([...statuses].every((s) => s === 'paid' || s === 'failed')).toBe(true);
    });

    it('filtering by "scheduled" returns only virtual rows', async () => {
      const res = await request
        .get('/payments/billing-events?status=scheduled')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', statusGymId);
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      expect(res.body.items.every((i: any) => i.status === 'scheduled' && i.type === 'virtual')).toBe(true);
    });

    it('rejects an invalid status value with 400', async () => {
      const res = await request
        .get('/payments/billing-events?status=bogus')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', statusGymId);
      expect(res.status).toBe(400);
    });

    it('still scopes by gym_id when a status filter is applied (tenant isolation)', async () => {
      const otherStatusGymId = await createTestGym('BE Status Other Gym');
      await createTestMembership(otherStatusGymId, 'admin');
      const res = await request
        .get('/payments/billing-events?status=paid')
        .set('Authorization', TEST_AUTH_HEADER)
        .set('x-gym-id', otherStatusGymId);
      expect(res.status).toBe(200);
      expect(res.body.items.filter((i: any) => i.type === 'real')).toHaveLength(0);
    });
  });
});

// ── #639: Created / Next Payment timestamps ──────────────────────────────────

describe('GET /payments/billing-events — created_at / next_payment_date (#639)', () => {
  let gymId: string;
  let memberId: number;
  let planId: number;
  let linkedEventId: number;
  let orphanEventId: number;
  let expiredEventId: number;
  let nextBillingDateStr: string;

  const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

  beforeAll(async () => {
    gymId = await createTestGym('BE Timestamps Gym');
    await createTestMembership(gymId, 'admin');

    memberId = await createMember(gymId);
    planId = await createPlanWithPolicy(gymId);

    const future = new Date();
    future.setDate(future.getDate() + 30);
    nextBillingDateStr = future.toISOString().slice(0, 10);

    // Real event on a membership that is still active and has a scheduled payment.
    const userMembershipId = await createUserMembership(gymId, memberId, planId, nextBillingDateStr);
    linkedEventId = await insertBillingEventForMembership(gymId, memberId, userMembershipId);

    // Real event with no membership at all — nothing is scheduled.
    orphanEventId = await insertBillingEvent(gymId, await createMember(gymId));

    // Real event whose membership is no longer active — its next_billing_date
    // must not be reported as an upcoming payment.
    const expiredMemberId = await createMember(gymId);
    const expiredMembershipId = await createUserMembership(gymId, expiredMemberId, planId, nextBillingDateStr);
    await db.query(`UPDATE user_memberships SET status = 'expired' WHERE id = ?`, [expiredMembershipId]);
    expiredEventId = await insertBillingEventForMembership(gymId, expiredMemberId, expiredMembershipId);
  });

  async function fetchItems() {
    const res = await request
      .get('/payments/billing-events')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    return res.body.items as any[];
  }

  it('reports created_at as a full ISO datetime on real rows', async () => {
    const item = (await fetchItems()).find((i) => i.id === linkedEventId);
    expect(item).toBeDefined();
    expect(item.created_at).toMatch(ISO_DATETIME);
    // Same instant the ledger row carries, not just the date already in billing_date.
    expect(item.created_at.slice(0, 10)).toBe(item.billing_date);
  });

  it('reports the membership next_billing_date as next_payment_date', async () => {
    const item = (await fetchItems()).find((i) => i.id === linkedEventId);
    expect(item.next_payment_date).toBe(nextBillingDateStr);
  });

  it('returns next_payment_date null when the event has no membership', async () => {
    const item = (await fetchItems()).find((i) => i.id === orphanEventId);
    expect(item).toBeDefined();
    expect(item.next_payment_date).toBeNull();
    expect(item.created_at).toMatch(ISO_DATETIME);
  });

  it('returns next_payment_date null when the membership is no longer active', async () => {
    const item = (await fetchItems()).find((i) => i.id === expiredEventId);
    expect(item).toBeDefined();
    expect(item.next_payment_date).toBeNull();
  });

  it('gives projected rows a null created_at and a YYYY-MM-DD next_payment_date', async () => {
    const virtualItems = (await fetchItems()).filter((i) => i.type === 'virtual');
    expect(virtualItems.length).toBeGreaterThan(0);
    for (const v of virtualItems) {
      expect(v.created_at).toBeNull();
      expect(v.next_payment_date).toMatch(ISO_DATE);
    }
    expect(virtualItems.some((v) => v.next_payment_date === nextBillingDateStr)).toBe(true);
  });

  it('projects virtual billing_date as a real ISO date', async () => {
    // Regression: next_billing_date arrives from mysql2 as a Date object, so a
    // plain String(...).slice(0, 10) produced "Wed Oct 21" instead of an ISO date.
    const virtualItems = (await fetchItems()).filter((i) => i.type === 'virtual');
    expect(virtualItems.length).toBeGreaterThan(0);
    for (const v of virtualItems) {
      expect(v.billing_date).toMatch(ISO_DATE);
    }
    expect(virtualItems.some((v) => v.billing_date === nextBillingDateStr)).toBe(true);
  });
});

// ── GET /payments/billing-events/:id/transactions ────────────────────────────

describe('GET /payments/billing-events/:id/transactions', () => {
  let gymId: string;
  let otherGymId: string;
  let memberId: number;
  let billingEventId: number;

  beforeAll(async () => {
    gymId = await createTestGym('BE Trans Gym');
    otherGymId = await createTestGym('BE Trans Other Gym');
    await createTestMembership(gymId, 'admin');
    await createTestMembership(otherGymId, 'admin');

    memberId = await createMember(gymId);
    billingEventId = await insertBillingEvent(gymId, memberId);

    // Create a plan + user_membership so the payment_request has a valid FK target.
    const planId = await createMembershipPlan(gymId);
    const userMembershipId = await createUserMembership(gymId, memberId, planId);
    await insertPaymentRequest(gymId, billingEventId, memberId, userMembershipId);
  });

  it('returns 200 with linked payment_requests', async () => {
    const res = await request
      .get(`/payments/billing-events/${billingEventId}/transactions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('items');
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);

    const item = res.body.items[0];
    expect(item).toHaveProperty('id');
    expect(item).toHaveProperty('status');
    expect(item).toHaveProperty('amount');
    expect(item).toHaveProperty('currency');
    expect(item).toHaveProperty('provider');
    expect(item).toHaveProperty('created_at');
  });

  it('returns 404 when the billing event belongs to a different gym', async () => {
    // billingEventId lives under gymId; querying it with otherGymId header must yield 404.
    const res = await request
      .get(`/payments/billing-events/${billingEventId}/transactions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId);
    expect(res.status).toBe(404);
  });
});
