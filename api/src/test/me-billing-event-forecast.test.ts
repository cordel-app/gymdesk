// #1123 — `GET /me/billing-event-forecast`, the member-facing half of the
// Billing Event Forecast the Payments card's *Next Payment* and *Forecast
// Billing Events* subcards are built from.
//
// Integration, not unit: what is under test is **which assignment the member's
// forecast is of** and that it is the same projection the staff see, not the
// projection itself — that is unit-tested in
// `assignment-billing-event-simulation.unit.test.ts`, the engine in
// `billing-simulation.test.ts`, and the staff route in
// `assigned-plan-billing-forecast.test.ts`.
//
// Fixtures are inserted directly; the HTTP API is used only for the action under
// test (CLAUDE.md).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
  activateAssignment, ensureTestProductSet } from './helpers';

const ROOT = '/me/billing-event-forecast';

let gymId: string;
let memberId: number;

// `members.clerk_user_id` is globally UNIQUE (migration 003), so this file
// brings its own Clerk ids rather than claiming the shared `TEST_USER_ID` row —
// a plain INSERT of it would fail, and adopting it would move another file's
// member into this gym.
const MEMBER_CLERK = `mbf-member-${Date.now()}`;

let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

function dayOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const TODAY = () => dayOffset(0);

async function createPlan(gid: string, price = 70): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans
       (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', NULL, NULL, 0, 0)`,
    [gid, `MBF-Plan-${uniq()}`],
  );
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, ?, ?, 'active')`,
    [gid, insertId, price, dayOffset(-365)],
  );
  await db.query(
    `INSERT INTO billing_policies
       (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`,
    [gid, insertId],
  );
  return insertId;
}

/** A member row linked to a Clerk id, so `resolveMemberId()` finds it. */
async function createLinkedMember(gid: string, clerkId: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gid, 'Forecast Member', `mbf-${uniq()}@test.com`, clerkId],
  );
  return insertId;
}

/** Assigns a plan through the staff route, so the snapshot is captured as usual. */
async function assignPlan(gid: string, mid: number, planId: number, startsAt = TODAY()): Promise<number> {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: `mbf-admin-${gid}` } as any);
  const res = await request.post('/user-memberships')
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gid)
    .send({ member_id: mid, membership_plan_id: planId, starts_at: startsAt });
  expect(res.status).toBe(201);
  // #1108 stage 1: assignment creates a Draft, and a Draft is deliberately not
  // the member's plan (Q2) — the member-facing reads exclude it — so the plan
  // this file forecasts is committed here.
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: `mbf-admin-${gid}` } as any);
  await activateAssignment(gid, res.body.id);
  return res.body.id as number;
}

/** The member's own call: their token, their gym. */
function asMember(gid: string = gymId, clerkId: string = MEMBER_CLERK) {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerkId } as any);
  return request.get(ROOT).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gid);
}

beforeAll(async () => {
  gymId = await createTestGym('Member Forecast Gym');
  await createTestMembership(gymId, 'member', MEMBER_CLERK);
  // The staff login the fixtures assign plans with — a second user in the same
  // gym, so `POST /user-memberships` is reachable while the member's own calls
  // stay a `member`.
  await createTestMembership(gymId, 'admin', `mbf-admin-${gymId}`);
  memberId = await createLinkedMember(gymId, MEMBER_CLERK);
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('auth and gating', () => {
  it('returns 401 without auth', async () => {
    const res = await request.get(ROOT).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 for a gym role that is not a member', async () => {
    const roleGymId = await createTestGym('Forecast Role Guard Gym');
    await createTestMembership(roleGymId, 'admin', 'mbf-role-admin');
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: 'mbf-role-admin' } as any);
    const res = await request.get(ROOT)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', roleGymId);
    expect(res.status).toBe(403);
  });
});

describe('GET /me/billing-event-forecast', () => {
  it('forecasts the member’s own plan, grouped by billing date', async () => {
    await assignPlan(gymId, memberId, await createPlan(gymId, 70));

    const res = await asMember();
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.currency).toBe('EUR');
    expect(res.body.tax_included).toBe(true);
    // Anchored on today and nothing already behind us: the dates the member has
    // been charged on are the ledger's, not the forecast's (#924 stage 4).
    expect(res.body.anchor_date).toBe(TODAY());
    const dates = res.body.dates.map((g: any) => g.date);
    expect(dates.length).toBeGreaterThan(0);
    expect(dates).toEqual([...dates].sort());
    for (const date of dates) expect(date >= TODAY()).toBe(true);

    const fee = res.body.dates[0].lines.find((l: any) => l.kind === 'membership_fee');
    expect(fee).toMatchObject({ actual_charge: 70, regular_price: 70, product_id: null });

    await db.query('DELETE FROM user_memberships WHERE gym_id = ? AND member_id = ?', [gymId, memberId]);
  });

  // The whole point of reusing `assignedPlanBillingForecast()`: the member and
  // the staff card cannot be shown two different futures for one contract.
  it('answers exactly what the staff route answers for the same assignment', async () => {
    const umId = await assignPlan(gymId, memberId, await createPlan(gymId, 55));

    const mine = await asMember();
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: `mbf-admin-${gymId}` } as any);
    const staff = await request.get(`/user-memberships/${umId}/billing-event-simulation`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

    expect(staff.status).toBe(200);
    expect(mine.body).toEqual(staff.body);

    await db.query('DELETE FROM user_memberships WHERE gym_id = ? AND member_id = ?', [gymId, memberId]);
  });

  it('includes a Period Benefit that falls on the same date as the fee', async () => {
    const planId = await createPlan(gymId, 70);
    const { insertId: lockerId } = await db.query(
      `INSERT INTO products
         (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system)
       VALUES (?, ?, 'fee', 20, 'EUR', 'month', 'active', 'available', 0)`,
      [gymId, `MBF Locker ${uniq()}`],
    );
    await db.query(
      `INSERT INTO membership_plan_periodical (gym_id, membership_plan_id, product_id, quantity)
       VALUES (?, ?, ?, 1)`,
      [gymId, planId, lockerId],
    );
    await assignPlan(gymId, memberId, planId);

    const res = await asMember();
    const today = res.body.dates.find((g: any) => g.date === TODAY());
    expect(today.total).toBe(90);
    expect(today.lines.map((l: any) => l.kind).sort()).toEqual(['membership_fee', 'product']);

    await db.query('DELETE FROM user_memberships WHERE gym_id = ? AND member_id = ?', [gymId, memberId]);
  });

  // A legitimate state, not an error: the Payments card renders its empty text.
  it('answers available: false for a member with no plan', async () => {
    const res = await asMember();
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.dates).toEqual([]);
    expect(typeof res.body.reason).toBe('string');
  });

  it('answers available: false when the only plan is cancelled', async () => {
    const umId = await assignPlan(gymId, memberId, await createPlan(gymId, 70));
    await db.query("UPDATE user_memberships SET status = 'cancelled' WHERE id = ?", [umId]);

    const res = await asMember();
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);

    await db.query('DELETE FROM user_memberships WHERE id = ?', [umId]);
  });

  // Tenant isolation: the caller is resolved from the session and the query is
  // constrained on `(gym_id, member_id)`, so another gym's assignment for the
  // same Clerk user is invisible.
  it('never reads an assignment from another gym', async () => {
    const otherGym = await createTestGym('Forecast Other Gym');
    await createTestMembership(otherGym, 'member', 'mbf-other-member');
    await createTestMembership(otherGym, 'admin', `mbf-admin-${otherGym}`);
    const otherMember = await createLinkedMember(otherGym, 'mbf-other-member');
    await assignPlan(otherGym, otherMember, await createPlan(otherGym, 999));

    // This gym's member holds nothing, so their own forecast is empty …
    const mine = await asMember();
    expect(mine.body.available).toBe(false);

    // … while the other gym's member sees their own.
    const theirs = await asMember(otherGym, 'mbf-other-member');
    expect(theirs.status).toBe(200);
    expect(theirs.body.available).toBe(true);
  });
});

describe('GET /me/billing-events', () => {
  // #1123 §4 — the past subcard reports a status per event, derived by the one
  // implementation the staff ledger reads (#640), never by the page.
  it('reports a derived status on every ledger row', async () => {
    const umId = await assignPlan(gymId, memberId, await createPlan(gymId, 70));
    // `billing_events.source` is NOT NULL with no default (migration 008) and
    // its CHECK admits `admin` · `system` · `employee` · `customer` · `provider`.
    const { insertId: paidId } = await db.query(
      `INSERT INTO billing_events
         (gym_id, member_id, product_set_id, event_type, source, amount)
       VALUES (?, ?, ?, 'payment_recorded', 'admin', 70)`,
      [gymId, memberId, await ensureTestProductSet(gymId, memberId, umId)],
    );
    const { insertId: changedId } = await db.query(
      `INSERT INTO billing_events
         (gym_id, member_id, product_set_id, event_type, source, previous_status, new_status)
       VALUES (?, ?, ?, 'status_changed', 'system', 'active', 'paused')`,
      [gymId, memberId, await ensureTestProductSet(gymId, memberId, umId)],
    );

    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: MEMBER_CLERK } as any);
    const res = await request.get('/me/billing-events?limit=50')
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.items.map((e: any) => [e.id, e]));
    expect(byId[paidId].status).toBe('paid');
    // A row that records no payment is informational, not paid.
    expect(byId[changedId].status).toBe('recorded');

    await db.query('DELETE FROM billing_events WHERE id IN (?, ?)', [paidId, changedId]);
    await db.query('DELETE FROM user_memberships WHERE id = ?', [umId]);
  });
});
