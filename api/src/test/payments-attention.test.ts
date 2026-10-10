// Tests for #779 — failed payments awaiting action.
//
// GET /payments/billing-events/attention answers `{ count, oldest_created_at }`
// for the sidebar badge; the Payments Dashboard summary carries the same pair.
// "Awaiting action" is the Billing Events list's own `status=failed`, so every
// scenario also checks the badge agrees with that list.
//
// Every scenario gets its own gym so the counts asserted are exact.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request, ensureTestProductSet } from './helpers';

const PATH = '/payments/billing-events/attention';

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

async function getChargeTypeId(): Promise<number> {
  const { rows } = await db.query<{ id: number }>("SELECT id FROM charge_types WHERE code = 'membership_fee'");
  return rows[0].id;
}

/** A member with an active assignment — what Retry / Manual payment need. */
async function createBillableMember(gym: string): Promise<{ memberId: number; userMembershipId: number }> {
  const { insertId: memberId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Attention Member', ?)`,
    [gym, `att-${uniq()}@test.com`],
  );
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'staff_only')`,
    [gym, `ATT-Plan-${uniq()}`],
  );
  const { insertId: userMembershipId } = await db.query(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, base_price)
     VALUES (?, ?, ?, 'active', '2000-01-01', '49.00')`,
    [gym, memberId, planId],
  );
  return { memberId, userMembershipId };
}

async function insertEvent(
  gym: string,
  eventType: 'failed_billing' | 'recurring_payment' | 'charge_created' | 'status_changed',
  m: { memberId: number; userMembershipId: number },
  createdAt: string,
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO billing_events
       (gym_id, member_id, product_set_id, event_type, charge_type_id, source, amount, created_at)
     VALUES (?, ?, ?, ?, ?, 'system', '49.00', ?)`,
    [gym, m.memberId, await ensureTestProductSet(gym, m.memberId, m.userMembershipId), eventType, await getChargeTypeId(), createdAt],
  );
  return insertId;
}

async function insertTransaction(
  gym: string,
  billingEventId: number,
  m: { memberId: number; userMembershipId: number },
  status: 'pending' | 'completed' | 'failed' | 'expired',
  createdAt: string,
): Promise<void> {
  await db.query(
    `INSERT INTO payment_requests
       (gym_id, user_membership_id, member_id, amount, currency, charge_type_id,
        status, provider, provider_order, page_token, page_token_expires,
        source, billing_event_id, created_at)
     VALUES (?, ?, ?, '49.00', 'EUR', ?, ?, 'monei', UUID(), UUID(),
             DATE_ADD(NOW(), INTERVAL 10 MINUTE), 'billing_run', ?, ?)`,
    [gym, m.userMembershipId, m.memberId, await getChargeTypeId(), status, billingEventId, createdAt],
  );
}

const get = (gym: string, path = PATH) =>
  request.get(path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);

async function attention(gym: string): Promise<{ count: number; oldest_created_at: string | null }> {
  const res = await get(gym);
  expect(res.status).toBe(200);
  return res.body;
}

/** The Billing Events list's own failed filter — what the badge links to. */
async function failedListTotal(gym: string): Promise<number> {
  const res = await get(gym, '/payments/billing-events?status=failed');
  expect(res.status).toBe(200);
  return res.body.total;
}

async function freshGym(name: string, role: 'admin' | 'accountant' = 'admin'): Promise<string> {
  const gym = await createTestGym(name);
  await createTestMembership(gym, role);
  return gym;
}

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ── Auth ─────────────────────────────────────────────────────────────────────

describe('GET /payments/billing-events/attention — auth', () => {
  let gym: string;
  beforeAll(async () => { gym = await freshGym('ATT Auth Gym'); });

  it('returns 401 without auth', async () => {
    const res = await request.get(PATH).set('x-gym-id', gym);
    expect(res.status).toBe(401);
  });

  it('returns 403 for a role with no PAYMENTS access', async () => {
    const other = await createTestGym('ATT Nutritionist Gym');
    await createTestMembership(other, 'nutritionist');
    expect((await get(other)).status).toBe(403);
  });

  it('returns 200 for a read-only PAYMENTS role', async () => {
    const other = await freshGym('ATT Accountant Gym', 'accountant');
    expect(await attention(other)).toEqual({ count: 0, oldest_created_at: null });
  });
});

// ── Tenant isolation ─────────────────────────────────────────────────────────

describe('GET /payments/billing-events/attention — tenant isolation', () => {
  it("does not count another gym's failures", async () => {
    const gymA = await freshGym('ATT Gym A');
    const gymB = await freshGym('ATT Gym B');
    const m = await createBillableMember(gymA);
    await insertEvent(gymA, 'failed_billing', m, '2026-09-01 03:00:00');

    expect((await attention(gymA)).count).toBe(1);
    expect(await attention(gymB)).toEqual({ count: 0, oldest_created_at: null });
  });
});

// ── What counts ──────────────────────────────────────────────────────────────

describe('GET /payments/billing-events/attention — awaiting action', () => {
  let gym: string;
  let m: { memberId: number; userMembershipId: number };

  //   failed_billing, no transaction                    → counts (oldest)
  //   recurring_payment + latest transaction 'failed'   → counts
  //   charge_created + latest transaction 'expired'     → counts
  //   failed_billing + failed, then completed (retry)   → settled, not counted
  //   recurring_payment, completed                      → paid, not counted
  //   failed_billing + latest transaction 'pending'     → in flight, not counted
  //   status_changed                                    → not counted
  beforeAll(async () => {
    gym = await freshGym('ATT Counts Gym');
    m = await createBillableMember(gym);

    await insertEvent(gym, 'failed_billing', m, '2026-08-02 03:00:00');

    const rejected = await insertEvent(gym, 'recurring_payment', m, '2026-08-10 03:00:00');
    await insertTransaction(gym, rejected, m, 'failed', '2026-08-10 03:00:01');

    const expired = await insertEvent(gym, 'charge_created', m, '2026-08-12 10:00:00');
    await insertTransaction(gym, expired, m, 'expired', '2026-08-12 10:00:01');

    const retried = await insertEvent(gym, 'failed_billing', m, '2026-07-01 03:00:00');
    await insertTransaction(gym, retried, m, 'failed', '2026-07-01 03:00:01');
    await insertTransaction(gym, retried, m, 'completed', '2026-07-02 09:00:00');

    const paid = await insertEvent(gym, 'recurring_payment', m, '2026-08-15 03:00:00');
    await insertTransaction(gym, paid, m, 'completed', '2026-08-15 03:00:01');

    const inFlight = await insertEvent(gym, 'failed_billing', m, '2026-08-20 03:00:00');
    await insertTransaction(gym, inFlight, m, 'pending', '2026-08-20 09:00:00');

    await insertEvent(gym, 'status_changed', m, '2026-06-01 00:00:00');
  });

  it('counts events whose derived status is failed, with the oldest creation instant', async () => {
    expect(await attention(gym)).toEqual({ count: 3, oldest_created_at: '2026-08-02T03:00:00.000Z' });
  });

  it('agrees with the Billing Events list filtered by failed', async () => {
    expect(await failedListTotal(gym)).toBe((await attention(gym)).count);
  });

  it('is carried on the Payments Dashboard summary too', async () => {
    const res = await get(gym, '/payments/dashboard/summary');
    expect(res.status).toBe(200);
    expect(res.body.awaiting_action_count).toBe(3);
    expect(res.body.awaiting_action_oldest_at).toBe('2026-08-02T03:00:00.000Z');
  });
});

describe('GET /payments/billing-events/attention — resolutions clear it', () => {
  it('drops an event once a Manual payment is recorded against it', async () => {
    const gym = await freshGym('ATT Manual Gym');
    const m = await createBillableMember(gym);
    const eventId = await insertEvent(gym, 'failed_billing', m, '2026-09-01 03:00:00');
    expect((await attention(gym)).count).toBe(1);

    const res = await request
      .post(`/payments/billing-events/${eventId}/manual-payment`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gym)
      .send({});
    expect(res.status).toBe(201);

    expect(await attention(gym)).toEqual({ count: 0, oldest_created_at: null });
    expect(await failedListTotal(gym)).toBe(0);
  });

  it('counts events, not memberships: two rejected cycles of one member are two', async () => {
    const gym = await freshGym('ATT Events Gym');
    const m = await createBillableMember(gym);
    await insertEvent(gym, 'failed_billing', m, '2026-09-01 03:00:00');
    await insertEvent(gym, 'failed_billing', m, '2026-09-02 03:00:00');
    expect((await attention(gym)).count).toBe(2);
  });
});

// ── Billing Events list — order=asc (the badge's work queue) ─────────────────

describe('GET /payments/billing-events?order=asc', () => {
  it('lists the failed queue oldest first', async () => {
    const gym = await freshGym('ATT Order Gym');
    const m = await createBillableMember(gym);
    const newer = await insertEvent(gym, 'failed_billing', m, '2026-09-03 03:00:00');
    const older = await insertEvent(gym, 'failed_billing', m, '2026-09-01 03:00:00');

    const asc = await get(gym, '/payments/billing-events?status=failed&order=asc');
    expect(asc.status).toBe(200);
    expect(asc.body.items.map((r: any) => r.id)).toEqual([older, newer]);

    const desc = await get(gym, '/payments/billing-events?status=failed');
    expect(desc.body.items.map((r: any) => r.id)).toEqual([newer, older]);
  });

  it('rejects an unknown order', async () => {
    const gym = await freshGym('ATT Bad Order Gym');
    expect((await get(gym, '/payments/billing-events?order=sideways')).status).toBe(400);
  });
});
