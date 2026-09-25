// Tests for payments-dashboard.ts router (#674)
//
// GET /payments/dashboard/summary returns the four cards of the Payments
// Dashboard in one round trip: Scheduled this month (projected from
// `user_memberships.next_billing_date`) plus Total / Failed / Successful last
// month (counted off the `billing_events` ledger, with each event's status
// derived from its latest linked `payment_requests` row).
//
// Every scenario gets its own gym so the counts asserted are exact — the cards
// are gym-wide totals, not a filtered list.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { invalidateFeatureFlagsCache } from '../infra/featureFlags';
import { countScheduledInWindow, monthWindows } from '../api/payments-dashboard';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

const PATH = '/payments/dashboard/summary';

interface Summary {
  current_month_start: string;
  current_month_end: string;
  previous_month_start: string;
  previous_month_end: string;
  scheduled_this_month: number;
  total_last_month: number;
  failed_last_month: number;
  successful_last_month: number;
}

// The month boundaries are computed the same way the router computes them
// rather than hardcoded, so the file keeps passing in every calendar month.
const W = monthWindows(new Date().toISOString().slice(0, 10));

/** A DATETIME comfortably inside the previous calendar month. */
const lastMonthAt = (time = '12:00:00') => `${W.previousMonthStart.slice(0, 8)}15 ${time}`;
/** The first instant of the current month — always in the past, never "last month". */
const thisMonthAt = () => `${W.currentMonthStart} 00:00:00`;

let gymId: string;

// ── Local setup helpers ──────────────────────────────────────────────────────

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

async function createMember(gym: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'PD Test Member', ?)`,
    [gym, `pd-${uniq()}@test.com`],
  );
  return insertId;
}

async function getChargeTypeId(code = 'membership_fee'): Promise<number> {
  const { rows } = await db.query<{ id: number }>('SELECT id FROM charge_types WHERE code = ?', [code]);
  return rows[0].id;
}

async function createPlan(gym: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'staff_only')`,
    [gym, `PD-Plan-${uniq()}`],
  );
  return insertId;
}

/** A plan plus the billing policy the scheduled-dates projection joins on. */
async function createPlanWithPolicy(
  gym: string,
  interval = 1,
  unit: 'day' | 'week' | 'month' | 'year' = 'month',
): Promise<number> {
  const planId = await createPlan(gym);
  await db.query(
    `INSERT INTO billing_policies
       (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, ?, ?)`,
    [gym, planId, interval, unit],
  );
  return planId;
}

async function createUserMembership(
  gym: string,
  memberId: number,
  planId: number,
  nextBillingDate: string | null = null,
  status: 'draft' | 'awaiting_payment' | 'active' | 'paused' | 'cancelled' | 'expired' = 'active',
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO user_memberships
       (gym_id, member_id, membership_plan_id, status, starts_at, final_price, next_billing_date)
     VALUES (?, ?, ?, ?, '2000-01-01', '49.00', ?)`,
    [gym, memberId, planId, status, nextBillingDate],
  );
  return insertId;
}

/** One `billing_events` ledger row, with its creation time pinned. */
async function insertEvent(
  gym: string,
  eventType:
    | 'charge_created'
    | 'payment_recorded'
    | 'status_changed'
    | 'adjustment'
    | 'recurring_payment'
    | 'failed_billing',
  createdAt: string,
  memberId: number | null = null,
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO billing_events (gym_id, member_id, event_type, charge_type_id, source, actor_user_id, amount, created_at)
     VALUES (?, ?, ?, ?, 'system', NULL, '49.00', ?)`,
    [gym, memberId, eventType, await getChargeTypeId(), createdAt],
  );
  return insertId;
}

/** A Payment Transaction linked to a Billing Event — what the status derives from. */
async function insertTransaction(
  gym: string,
  billingEventId: number,
  memberId: number,
  userMembershipId: number,
  status: 'pending' | 'completed' | 'failed' | 'expired',
  createdAt: string,
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO payment_requests
       (gym_id, user_membership_id, member_id, amount, currency, charge_type_id,
        status, provider, provider_order, page_token, page_token_expires,
        source, billing_event_id, created_at)
     VALUES (?, ?, ?, '49.00', 'EUR', ?, ?, 'monei', UUID(), UUID(),
             DATE_ADD(NOW(), INTERVAL 10 MINUTE), 'billing_run', ?, ?)`,
    [gym, userMembershipId, memberId, await getChargeTypeId(), status, billingEventId, createdAt],
  );
  return insertId;
}

/** A member + plan + active membership, the parents every transaction row needs. */
async function createBillableMember(gym: string): Promise<{ memberId: number; userMembershipId: number }> {
  const memberId = await createMember(gym);
  const planId = await createPlan(gym);
  const userMembershipId = await createUserMembership(gym, memberId, planId);
  return { memberId, userMembershipId };
}

const get = (gym: string) =>
  request.get(PATH).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);

async function summary(gym: string): Promise<Summary> {
  const res = await get(gym);
  expect(res.status).toBe(200);
  return res.body as Summary;
}

/** A fresh gym the test user administers, so each scenario's totals stand alone. */
async function freshGym(name: string): Promise<string> {
  const gym = await createTestGym(name);
  await createTestMembership(gym, 'admin');
  return gym;
}

beforeAll(async () => {
  gymId = await freshGym('Payments Dashboard Gym');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ── Auth ─────────────────────────────────────────────────────────────────────

describe('GET /payments/dashboard/summary — auth', () => {
  it('returns 401 without auth', async () => {
    const res = await request.get(PATH).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 when the user has no membership in the requested gym', async () => {
    const otherGym = await createTestGym('PD No Membership Gym');
    const res = await get(otherGym);
    expect(res.status).toBe(403);
  });

  it('returns 403 for a role with no PAYMENTS access', async () => {
    const gym = await createTestGym('PD Nutritionist Gym');
    await createTestMembership(gym, 'nutritionist');
    const res = await get(gym);
    expect(res.status).toBe(403);
  });

  it('returns 200 for a read-only PAYMENTS role', async () => {
    const gym = await createTestGym('PD Accountant Gym');
    await createTestMembership(gym, 'accountant');
    const res = await get(gym);
    expect(res.status).toBe(200);
    expect(typeof res.body.total_last_month).toBe('number');
  });
});

// ── Feature flag ─────────────────────────────────────────────────────────────

// The Dashboard has its own `payments.dashboard` key (migration 171) so it can
// be switched off on its own. Superadmins bypass flags entirely, so the caller
// here is a plain gym admin.
describe('GET /payments/dashboard/summary — feature flag', () => {
  const KEY = 'payments.dashboard';
  let original: number | undefined;

  beforeAll(async () => {
    const { rows } = await db.query<{ enabled: number }>(
      'SELECT enabled FROM feature_flags WHERE feature_key = ?',
      [KEY],
    );
    original = rows[0]?.enabled;
  });

  afterEach(async () => {
    if (original !== undefined) {
      await db.query('UPDATE feature_flags SET enabled = ? WHERE feature_key = ?', [original, KEY]);
    }
    invalidateFeatureFlagsCache();
  });

  // Without this, a renamed or unseeded key would make the case below pass
  // vacuously — an absent flag row counts as enabled.
  it('seeds the payments.dashboard flag', () => {
    expect(original).toBe(1);
  });

  it('returns 403 when payments.dashboard is switched off', async () => {
    await db.query('UPDATE feature_flags SET enabled = 0 WHERE feature_key = ?', [KEY]);
    invalidateFeatureFlagsCache();
    expect((await get(gymId)).status).toBe(403);
  });

  it('serves the Dashboard again once the flag is back on', async () => {
    expect((await get(gymId)).status).toBe(200);
  });
});

// ── Happy path ───────────────────────────────────────────────────────────────

describe('GET /payments/dashboard/summary — last month cards', () => {
  let gym: string;

  // Five ledger rows dated in the previous calendar month, one dated in the
  // current one:
  //   recurring_payment, no transaction              → paid
  //   charge_created + latest transaction 'failed'   → failed
  //   failed_billing, no transaction                 → failed
  //   charge_created + latest transaction 'completed'→ paid
  //   status_changed, no transaction                 → recorded (neither card)
  //   recurring_payment dated THIS month             → out of every card
  beforeAll(async () => {
    gym = await freshGym('PD Last Month Gym');
    const { memberId, userMembershipId } = await createBillableMember(gym);

    await insertEvent(gym, 'recurring_payment', lastMonthAt(), memberId);

    const failedTx = await insertEvent(gym, 'charge_created', lastMonthAt(), memberId);
    await insertTransaction(gym, failedTx, memberId, userMembershipId, 'failed', lastMonthAt('12:05:00'));

    await insertEvent(gym, 'failed_billing', lastMonthAt(), memberId);

    const paidTx = await insertEvent(gym, 'charge_created', lastMonthAt(), memberId);
    await insertTransaction(gym, paidTx, memberId, userMembershipId, 'completed', lastMonthAt('12:05:00'));

    await insertEvent(gym, 'status_changed', lastMonthAt(), memberId);

    await insertEvent(gym, 'recurring_payment', thisMonthAt(), memberId);
  });

  it('reports the calendar windows the cards are counted over', async () => {
    const body = await summary(gym);
    expect(body.current_month_start).toBe(W.currentMonthStart);
    expect(body.current_month_end).toBe(W.currentMonthEnd);
    expect(body.previous_month_start).toBe(W.previousMonthStart);
    expect(body.previous_month_end).toBe(W.previousMonthEnd);
    // The windows are whole calendar months that touch without overlapping.
    expect(body.previous_month_start < body.previous_month_end).toBe(true);
    expect(body.previous_month_end < body.current_month_start).toBe(true);
    expect(body.current_month_start.endsWith('-01')).toBe(true);
    expect(body.previous_month_start.endsWith('-01')).toBe(true);
  });

  it('counts failed and successful events by their derived status', async () => {
    const body = await summary(gym);
    // failed: the 'failed' transaction + the failed_billing row with no transaction
    expect(body.failed_last_month).toBe(2);
    // paid: the recurring_payment row + the 'completed' transaction
    expect(body.successful_last_month).toBe(2);
  });

  it('counts every ledger row in the total, not just failed + successful', async () => {
    const body = await summary(gym);
    expect(body.total_last_month).toBe(5);
    expect(body.total_last_month).toBeGreaterThan(
      body.failed_last_month + body.successful_last_month,
    );
  });

  it('excludes a ledger row created this month from every last-month card', async () => {
    const body = await summary(gym);
    // Six rows exist in this gym; the sixth is dated this month.
    const { rows } = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM billing_events WHERE gym_id = ?',
      [gym],
    );
    expect(Number(rows[0].n)).toBe(6);
    expect(body.total_last_month).toBe(5);
  });
});

// ── Key invariants ───────────────────────────────────────────────────────────

describe('GET /payments/dashboard/summary — status derivation invariants', () => {
  it('lets the latest transaction win: a retried failed_billing counts as successful', async () => {
    const gym = await freshGym('PD Retry Gym');
    const { memberId, userMembershipId } = await createBillableMember(gym);
    const eventId = await insertEvent(gym, 'failed_billing', lastMonthAt(), memberId);
    await insertTransaction(gym, eventId, memberId, userMembershipId, 'failed', lastMonthAt('09:00:00'));
    await insertTransaction(gym, eventId, memberId, userMembershipId, 'completed', lastMonthAt('18:00:00'));

    const body = await summary(gym);
    expect(body.total_last_month).toBe(1);
    expect(body.failed_last_month).toBe(0);
    expect(body.successful_last_month).toBe(1);
  });

  it('counts an expired transaction as failed, like a rejected one', async () => {
    const gym = await freshGym('PD Expired Gym');
    const { memberId, userMembershipId } = await createBillableMember(gym);
    const eventId = await insertEvent(gym, 'charge_created', lastMonthAt(), memberId);
    await insertTransaction(gym, eventId, memberId, userMembershipId, 'expired', lastMonthAt('13:00:00'));

    const body = await summary(gym);
    expect(body.failed_last_month).toBe(1);
    expect(body.successful_last_month).toBe(0);
  });

  it('puts status_changed and adjustment rows in the total but in neither bucket', async () => {
    const gym = await freshGym('PD Recorded Gym');
    const memberId = await createMember(gym);
    await insertEvent(gym, 'status_changed', lastMonthAt(), memberId);
    await insertEvent(gym, 'adjustment', lastMonthAt(), memberId);

    const body = await summary(gym);
    expect(body.total_last_month).toBe(2);
    expect(body.failed_last_month).toBe(0);
    expect(body.successful_last_month).toBe(0);
  });

  it('counts an event whose only transaction is still pending in neither bucket', async () => {
    const gym = await freshGym('PD Pending Gym');
    const { memberId, userMembershipId } = await createBillableMember(gym);
    const eventId = await insertEvent(gym, 'recurring_payment', lastMonthAt(), memberId);
    await insertTransaction(gym, eventId, memberId, userMembershipId, 'pending', lastMonthAt('13:00:00'));

    const body = await summary(gym);
    expect(body.total_last_month).toBe(1);
    expect(body.failed_last_month).toBe(0);
    // The pending transaction overrides the event type's own "paid" fallback.
    expect(body.successful_last_month).toBe(0);
  });
});

// ── Scheduled this month ─────────────────────────────────────────────────────

describe('GET /payments/dashboard/summary — scheduled this month', () => {
  it('counts an active membership whose next billing date still falls this month', async () => {
    const gym = await freshGym('PD Scheduled Gym');
    const memberId = await createMember(gym);
    const planId = await createPlanWithPolicy(gym, 1, 'month');
    // The last day of this month is always today or later, so this case does
    // not depend on which day of the month the suite happens to run.
    await createUserMembership(gym, memberId, planId, W.currentMonthEnd);

    const body = await summary(gym);
    expect(body.scheduled_this_month).toBe(1);
  });

  it('contributes 0 for a membership whose next billing date has already passed', async () => {
    const gym = await freshGym('PD Overdue Gym');
    const memberId = await createMember(gym);
    // A yearly interval, so the overdue date does not project forward into the
    // current month and accidentally count.
    const planId = await createPlanWithPolicy(gym, 1, 'year');
    await createUserMembership(gym, memberId, planId, `${W.previousMonthStart.slice(0, 8)}10`);

    const body = await summary(gym);
    expect(body.scheduled_this_month).toBe(0);
  });

  it('ignores a membership that is not active, and one with no billing date', async () => {
    const gym = await freshGym('PD Inactive Gym');
    const planId = await createPlanWithPolicy(gym, 1, 'month');
    await createUserMembership(gym, await createMember(gym), planId, W.currentMonthEnd, 'cancelled');
    await createUserMembership(gym, await createMember(gym), planId, W.currentMonthEnd, 'paused');
    await createUserMembership(gym, await createMember(gym), planId, null, 'active');

    const body = await summary(gym);
    expect(body.scheduled_this_month).toBe(0);
  });

  it('counts each active membership separately', async () => {
    const gym = await freshGym('PD Multi Scheduled Gym');
    const planId = await createPlanWithPolicy(gym, 1, 'month');
    await createUserMembership(gym, await createMember(gym), planId, W.currentMonthEnd);
    await createUserMembership(gym, await createMember(gym), planId, W.currentMonthEnd);

    const body = await summary(gym);
    expect(body.scheduled_this_month).toBe(2);
  });
});

// ── Tenant isolation ─────────────────────────────────────────────────────────

describe('GET /payments/dashboard/summary — tenant isolation', () => {
  it("never counts another gym's ledger rows or scheduled memberships", async () => {
    const gymA = await freshGym('PD Tenant A');
    const gymB = await freshGym('PD Tenant B');

    const { memberId, userMembershipId } = await createBillableMember(gymA);
    const eventId = await insertEvent(gymA, 'charge_created', lastMonthAt(), memberId);
    await insertTransaction(gymA, eventId, memberId, userMembershipId, 'failed', lastMonthAt('13:00:00'));
    await insertEvent(gymA, 'recurring_payment', lastMonthAt(), memberId);

    const planA = await createPlanWithPolicy(gymA, 1, 'month');
    await createUserMembership(gymA, await createMember(gymA), planA, W.currentMonthEnd);

    const fromA = await summary(gymA);
    expect(fromA.total_last_month).toBe(2);
    expect(fromA.failed_last_month).toBe(1);
    expect(fromA.successful_last_month).toBe(1);
    expect(fromA.scheduled_this_month).toBe(1);

    // Gym B has none of it, even though the rows exist in the same tables.
    const fromB = await summary(gymB);
    expect(fromB.total_last_month).toBe(0);
    expect(fromB.failed_last_month).toBe(0);
    expect(fromB.successful_last_month).toBe(0);
    expect(fromB.scheduled_this_month).toBe(0);
  });
});

// ── Pure helpers (no DB, no HTTP) ────────────────────────────────────────────

// `monthWindows` and `countScheduledInWindow` take the clock as an argument
// precisely so the boundary cases can be pinned to a date instead of waiting
// for a month to turn over.
describe('monthWindows()', () => {
  it('bounds the current and previous calendar months', () => {
    expect(monthWindows('2026-03-15')).toEqual({
      today: '2026-03-15',
      currentMonthStart: '2026-03-01',
      currentMonthEnd: '2026-03-31',
      previousMonthStart: '2026-02-01',
      previousMonthEnd: '2026-02-28',
      nextMonthStart: '2026-04-01',
    });
  });

  it('rolls back across the year boundary in January', () => {
    const w = monthWindows('2026-01-05');
    expect(w.previousMonthStart).toBe('2025-12-01');
    expect(w.previousMonthEnd).toBe('2025-12-31');
    expect(w.currentMonthStart).toBe('2026-01-01');
    expect(w.nextMonthStart).toBe('2026-02-01');
  });

  it('rolls forward across the year boundary in December', () => {
    const w = monthWindows('2026-12-31');
    expect(w.currentMonthEnd).toBe('2026-12-31');
    expect(w.nextMonthStart).toBe('2027-01-01');
    expect(w.previousMonthStart).toBe('2026-11-01');
    expect(w.previousMonthEnd).toBe('2026-11-30');
  });

  it('gives February 29 days in a leap year', () => {
    expect(monthWindows('2024-03-10').previousMonthEnd).toBe('2024-02-29');
    expect(monthWindows('2024-02-10').currentMonthEnd).toBe('2024-02-29');
  });

  it('is stable on the first and last day of the month', () => {
    expect(monthWindows('2026-03-01').currentMonthStart).toBe('2026-03-01');
    expect(monthWindows('2026-03-31').currentMonthEnd).toBe('2026-03-31');
  });
});

describe('countScheduledInWindow()', () => {
  // Mid-month, so both "still to come" and "already passed" are expressible.
  const w = monthWindows('2026-03-15');

  it('counts a billing date still to come this month', () => {
    expect(countScheduledInWindow('2026-03-20', 1, 'month', w)).toBe(1);
  });

  it('counts a billing date falling exactly today', () => {
    expect(countScheduledInWindow('2026-03-15', 1, 'month', w)).toBe(1);
  });

  it('does not count a billing date that has already passed', () => {
    expect(countScheduledInWindow('2026-03-10', 1, 'month', w)).toBe(0);
  });

  it('projects an overdue date forward and counts only what is still ahead', () => {
    // Jan 5 → Feb 5 → Mar 5 (already gone) → Apr 5 (out of the window).
    expect(countScheduledInWindow('2026-01-05', 1, 'month', w)).toBe(0);
    // Jan 20 → Feb 20 → Mar 20, which is still ahead of today.
    expect(countScheduledInWindow('2026-01-20', 1, 'month', w)).toBe(1);
  });

  it('counts every occurrence of a short interval left in the month', () => {
    // Mar 1, 8, 15, 22, 29 — the last three are today or later.
    expect(countScheduledInWindow('2026-03-01', 7, 'day', w)).toBe(3);
    // Mar 15 … Mar 31 inclusive.
    expect(countScheduledInWindow('2026-03-01', 1, 'day', w)).toBe(17);
  });

  it('does not count a date beyond the end of this month', () => {
    expect(countScheduledInWindow('2026-04-02', 1, 'month', w)).toBe(0);
    expect(countScheduledInWindow('2026-03-20', 1, 'year', w)).toBe(1);
    expect(countScheduledInWindow('2027-03-20', 1, 'year', w)).toBe(0);
  });

  it('returns 0 rather than looping on a missing or non-positive interval', () => {
    expect(countScheduledInWindow('', 1, 'month', w)).toBe(0);
    expect(countScheduledInWindow('2026-03-20', 0, 'month', w)).toBe(0);
    expect(countScheduledInWindow('2026-03-20', -1, 'month', w)).toBe(0);
  });
});
