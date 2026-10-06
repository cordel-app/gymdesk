// #924 stage 3 — the Assigned Plan card's **Membership Fee Simulation**.
//
// §7 of the ticket asks for the Membership Plan card's Example Timeline (#818)
// on an Assigned Plan, "using the same simulation logic and presentation as
// Membership Plans" — same dates, frequencies, pricing, benefits, promotions,
// tax and recurrence rules as the actual billing logic — and forbids the one
// shortcut that would make it easy:
//
//   > The simulation should not implement a separate calculation engine.
//
// Integration, not unit: what is under test here is *which row the projection
// reads from* — the assignment's own frozen snapshot, its standing Promotions,
// its Personal Membership Fee Benefit — and that the two entry points
// (`GET /user-memberships/:id`'s embedded `example_timeline` and
// `GET /user-memberships/:id/example-timeline`) answer the same thing. The walk
// itself is unit-tested in `assignment-example-timeline.unit.test.ts` and the
// pricing rule in `membership-fee-resolution.test.ts`.
//
// Fixtures are inserted directly; the HTTP API is only used for the action
// under test (CLAUDE.md).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
  activateAssignment,
} from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

function dayOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const TODAY = () => dayOffset(0);

async function createPlan(gymId: string, opts: {
  price?: number | null;
  free?: number | null;
  paid?: number | null;
  bonus?: number | null;
  prepaid?: number | null;
  /** `null` leaves the Plan with no billing policy at all. */
  cadence?: { interval: number; unit: string } | null;
} = {}): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans
       (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', ?, ?, ?, ?)`,
    [gymId, `AFT-Plan-${uniq()}`, opts.free ?? null, opts.paid ?? null,
      opts.bonus ?? null, opts.prepaid ?? null],
  );
  if (opts.price !== null) {
    await db.query(
      `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
       VALUES (?, ?, ?, ?, 'active')`,
      [gymId, insertId, opts.price ?? 100, dayOffset(-365)],
    );
  }
  const cadence = opts.cadence === undefined ? { interval: 1, unit: 'month' } : opts.cadence;
  if (cadence) {
    await db.query(
      // #1130 stage 1: `auto_renew` is pinned off here rather than left on the
      // column's own DEFAULT, because every case in this file is about what a
      // Billing & Duration *means* and not about the cycle starting again —
      // the same reason `membership-plans.test.ts` and
      // `plan-duration-billing-frequency.test.ts` pin it.
      `INSERT INTO billing_policies
         (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit,
          auto_renew)
       VALUES (?, ?, ?, ?, 0)`,
      [gymId, insertId, cadence.interval, cadence.unit],
    );
  }
  return insertId;
}

async function createMember(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'AFT Member', `aft-${uniq()}@test.com`],
  );
  return insertId;
}

const assign = (gymId: string, planId: number, memberId: number, startsAt = TODAY()) =>
  request
    .post('/user-memberships')
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ member_id: memberId, membership_plan_id: planId, starts_at: startsAt });

async function assignPlan(gymId: string, planId: number): Promise<number> {
  const res = await assign(gymId, planId, await createMember(gymId));
  expect(res.status).toBe(201);
  // #1108 stage 1: assignment creates a Draft; this file is about an active
  // assignment's Membership Fee Simulation.
  await activateAssignment(gymId, res.body.id);
  return res.body.id as number;
}

const getAssignment = (gymId: string, umId: number) =>
  request.get(`/user-memberships/${umId}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

const getTimeline = (gymId: string, umId: number) =>
  request.get(`/user-memberships/${umId}/example-timeline`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function timelineOf(gymId: string, umId: number) {
  const res = await getAssignment(gymId, umId);
  expect(res.status).toBe(200);
  return res.body.example_timeline;
}

describe('Assigned Plan — Membership Fee Simulation (#924 stage 3)', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('AFT Timeline Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('embeds the projection on the assignment, anchored on its own start date', async () => {
    const umId = await assignPlan(gymId, await createPlan(gymId, { price: 70 }));
    const timeline = await timelineOf(gymId, umId);

    expect(timeline.available).toBe(true);
    expect(timeline.anchorDate).toBe(TODAY());
    expect(timeline.currency).toBe('EUR');
    // Nothing is configured, so the table is the two trailing regular periods.
    expect(timeline.periods).toHaveLength(2);
    expect(timeline.periods[0]).toMatchObject({
      period: 1, startsOn: TODAY(), status: 'pay_regular', amount: 70, waived: false,
    });
    // Billing does not stop where the table does.
    expect(timeline.periods[1].endsOn).toBeNull();
  });

  it('serves the same projection on its own route', async () => {
    const umId = await assignPlan(gymId, await createPlan(gymId, { price: 70 }));
    const res = await getTimeline(gymId, umId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(await timelineOf(gymId, umId));
  });

  it('reads the Free Period frozen onto the assignment, not a later Plan edit', async () => {
    const planId = await createPlan(gymId, { price: 70, free: 2, paid: 4 });
    const umId = await assignPlan(gymId, planId);

    const before = await timelineOf(gymId, umId);
    expect(before.periods.filter((p: any) => p.status === 'free_plan')).toHaveLength(2);
    expect(before.periods[0]).toMatchObject({ waived: true, amount: null });

    // §13/§17: the assignment owns the configuration it was agreed with, so
    // widening the Plan's Free Period must not move an existing contract.
    await db.query('UPDATE membership_plans SET free_periods = 5 WHERE id = ?', [planId]);
    const after = await timelineOf(gymId, umId);
    expect(after.periods.filter((p: any) => p.status === 'free_plan')).toHaveLength(2);
  });

  it('collects the whole Pre-paid Duration in its first period (#946)', async () => {
    const umId = await assignPlan(
      gymId, await createPlan(gymId, { price: 70, paid: 6, prepaid: 3 }),
    );
    const timeline = await timelineOf(gymId, umId);
    const prepaid = timeline.periods.filter((p: any) => p.status === 'prepaid_plan');
    expect(prepaid).toHaveLength(3);
    expect(prepaid[0]).toMatchObject({ amount: 210, waived: false, prepaidPeriods: 3 });
    expect(prepaid[1]).toMatchObject({ waived: true, amount: null, prepaidPeriods: null });
  });

  it('counts the durations in the assignment’s own cadence, not in months (#892)', async () => {
    const umId = await assignPlan(
      gymId,
      await createPlan(gymId, { price: 70, free: 2, paid: 4, cadence: { interval: 4, unit: 'week' } }),
    );
    const timeline = await timelineOf(gymId, umId);
    expect(timeline.periods.filter((p: any) => p.status === 'free_plan')).toHaveLength(2);
    // Four weeks per row, so the second period starts 28 days in.
    expect(timeline.periods[1].startsOn).toBe(dayOffset(28));
  });

  it('applies the Personal Membership Fee Benefit to every period (#772)', async () => {
    const umId = await assignPlan(gymId, await createPlan(gymId, { price: 100 }));
    const res = await request
      .put(`/user-memberships/${umId}/fee-benefit`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)
      .send({ action: 'percentage_discount', value: 15 });
    expect(res.status).toBe(200);

    const timeline = await timelineOf(gymId, umId);
    expect(timeline.periods.every((p: any) => p.amount === 85)).toBe(true);
    // It never ends, so it is this contract's regular charge: the projection
    // must not treat it as a window to run past.
    expect(timeline.periods).toHaveLength(2);
  });

  it('quotes the agreed fee, not the Plan’s current price, once it is repriced', async () => {
    const planId = await createPlan(gymId, { price: 70 });
    const umId = await assignPlan(gymId, planId);
    await db.query(
      `UPDATE membership_plan_prices SET price = 120 WHERE membership_plan_id = ?`, [planId],
    );
    const timeline = await timelineOf(gymId, umId);
    expect(timeline.periods[0].amount).toBe(70);
  });

  it('lets an applied Promotion decide the period, and names it in the status', async () => {
    const planId = await createPlan(gymId, { price: 70, free: 1, paid: 6 });
    const umId = await assignPlan(gymId, planId);

    const { insertId: promotionId } = await db.query(
      `INSERT INTO promotions
         (gym_id, name, description, starts_at, ends_at, lifecycle_status, stackable,
          only_applicable_for_new_members, free_months, paid_months, bonus_months)
       VALUES (?, ?, 'AFT promo', ?, '2099-12-31', 'active', 1, 0, 2, 6, 0)`,
      [gymId, `AFT-Promo-${uniq()}`, dayOffset(-1)],
    );
    await db.query(
      'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
      [gymId, promotionId, planId],
    );
    const applied = await request
      .post(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)
      .send({ promotion_id: promotionId });
    expect(applied.status).toBe(201);

    const timeline = await timelineOf(gymId, umId);
    // The Plan's own Free Period would waive period 1 too, but where a
    // Promotion governs the date it decides the fee alone (#635's Q2 answer) —
    // so the status has to name the Promotion's period, not the Plan's.
    expect(timeline.periods[0].status).toBe('free_promotion');
    expect(timeline.periods[0].waived).toBe(true);
    expect(timeline.periods.map((p: any) => p.status)).toContain('pay_promotion');
    // And it runs on past the Promotion to the contract's own regular charge.
    expect(timeline.periods[timeline.periods.length - 1]).toMatchObject({
      status: 'pay_regular', amount: 70,
    });
  });

  it('says why there is no timeline when the assignment has no billing frequency', async () => {
    const umId = await assignPlan(gymId, await createPlan(gymId, { price: 70, cadence: null }));
    const timeline = await timelineOf(gymId, umId);
    expect(timeline.available).toBe(false);
    expect(typeof timeline.reason).toBe('string');
    expect(timeline.periods).toEqual([]);
  });
});

describe('GET /user-memberships/:id/example-timeline — auth and tenancy', () => {
  let gymA: string;
  let gymB: string;
  let umA: number;

  beforeAll(async () => {
    gymA = await createTestGym('AFT Gym A');
    gymB = await createTestGym('AFT Gym B');
    await createTestMembership(gymA, 'admin');
    await createTestMembership(gymB, 'admin');
    umA = await assignPlan(gymA, await createPlan(gymA, { price: 70 }));
  });

  it('returns 401 without authentication', async () => {
    const res = await request.get(`/user-memberships/${umA}/example-timeline`).set('x-gym-id', gymA);
    expect(res.status).toBe(401);
  });

  it('returns 404 for another gym’s assignment', async () => {
    const res = await getTimeline(gymB, umA);
    expect(res.status).toBe(404);
  });

  it('returns 404 for an assignment that does not exist', async () => {
    const res = await getTimeline(gymA, 99999999);
    expect(res.status).toBe(404);
  });
});
