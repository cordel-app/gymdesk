// #892 — a Membership Plan's durations are counts of its **Billing Frequency
// periods**, not of calendar months.
//
// The arithmetic itself is unit-tested (`plan-duration.test.ts`,
// `plan-example-timeline.test.ts`). What this file covers is the journey the
// ticket is actually about: the same four numbers, on a Plan billed every
// 4 Weeks, must shorten the *dates* everywhere at once — in the Plan editor's
// own payload, in the Example timeline the card renders, in what the Assigned
// Plan snapshot freezes, and in what the nightly run charges on a given cycle.
//
// The money case is the one that matters. A 4-weekly Plan with Free Period = 2
// used to bill:
//
//     cycle 2000-02-26 (period 3)  →  waived, because 26 Feb is still inside
//                                     two calendar months from 1 Jan
//
// and now bills it in full, because period 3 is not one of the two free
// periods. That is the reversal of #818's Q1 answer the ticket asks for, and it
// is asserted below against a real `POST /billing/run`.
//
// Promotions are deliberately untouched (the ticket's closing note), so nothing
// here configures one.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

const SECRET = 'test-billing-secret';

// No payment provider is configured in tests, so the charge branch is otherwise
// unreachable — the same stub `billing-run-membership-fee.test.ts` uses.
const executeRecurring = vi.hoisted(() => vi.fn(async () => ({ success: true, providerRef: 'test-provider-ref' })));
vi.mock('../payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../payments')>()),
  getPaymentProvider: () => ({ executeRecurring }),
}));

let gymId: string;

beforeAll(async () => {
  process.env.BILLING_INTERNAL_SECRET = SECRET;
  gymId = await createTestGym('Billing Frequency Duration Gym');
  await createTestMembership(gymId);
});

beforeEach(async () => {
  // #780: one completed run per UTC date, and the log is global.
  await db.query('DELETE FROM billing_run_log');
  executeRecurring.mockClear();
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

const auth = (req: any) => req.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function createMember(): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Frequency Member', `bfd-${uniq()}@test.com`],
  );
  await db.query(
    `INSERT INTO payment_methods (gym_id, member_id, provider, payment_token, sequence_id)
     VALUES (?, ?, 'monei', ?, ?)`,
    [gymId, insertId, `tok_${insertId}`, `seq_${insertId}`],
  );
  return insertId;
}

/** A Plan with a €50 price, the given cadence and the given period counts. */
async function createPlan(
  cadence: { interval: number; unit: string },
  durations: { free?: number | null; paid?: number | null; bonus?: number | null; prepaid?: number | null } = {},
): Promise<number> {
  const { free = null, paid = null, bonus = null, prepaid = null } = durations;
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans
       (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', ?, ?, ?, ?)`,
    [gymId, `BFD-Plan-${uniq()}`, free, paid, bonus, prepaid],
  );
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, 50, '2000-01-01', 'active')`,
    [gymId, planId],
  );
  await db.query(
    `INSERT INTO billing_policies
       (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, ?, ?)`,
    [gymId, planId, cadence.interval, cadence.unit],
  );
  return planId;
}

/**
 * An assignment carrying its own snapshot of that Plan — the cadence included,
 * which is what `ASSIGNMENT_CADENCE` reads the durations' unit from.
 */
async function createAssignment(params: {
  memberId: number; planId: number; startsAt: string; nextBillingDate: string;
  cadence: { interval: number; unit: string };
  durations: { free?: number | null; paid?: number | null; bonus?: number | null; prepaid?: number | null };
}): Promise<number> {
  const { free = null, paid = null, bonus = null, prepaid = null } = params.durations;
  const { insertId } = await db.query(
    `INSERT INTO user_memberships
       (gym_id, member_id, membership_plan_id, status, starts_at, base_price,
        next_billing_date, membership_fee_price,
        recurring_billing_interval, recurring_billing_unit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, ?, 'active', ?, 0, ?, 50, ?, ?, ?, ?, ?, ?)`,
    [
      gymId, params.memberId, params.planId, params.startsAt, params.nextBillingDate,
      params.cadence.interval, params.cadence.unit, free, paid, bonus, prepaid,
    ],
  );
  return insertId;
}

const runBilling = () => request.post('/billing/run').set('x-internal-secret', SECRET);

async function chargeFor(umId: number) {
  const { rows } = await db.query(
    'SELECT event_type, amount, notes FROM billing_events WHERE user_membership_id = ? ORDER BY id ASC',
    [umId],
  );
  return rows;
}

/* ── what the nightly run charges ────────────────────────────────────────── */

describe('POST /billing/run — durations are counted in Billing Frequency periods (#892)', () => {
  const FOUR_WEEKS = { interval: 4, unit: 'week' };
  const MONTH = { interval: 1, unit: 'month' };

  it('waives the second 4-week cycle of a Free Period of 2', async () => {
    const memberId = await createMember();
    const planId = await createPlan(FOUR_WEEKS, { free: 2, paid: 12 });
    // 1 Jan + 28 days — the second of the two free periods.
    const umId = await createAssignment({
      memberId, planId, startsAt: '2000-01-01', nextBillingDate: '2000-01-29',
      cadence: FOUR_WEEKS, durations: { free: 2, paid: 12 },
    });

    expect((await runBilling()).status).toBe(200);

    expect(await chargeFor(umId)).toEqual([
      { event_type: 'waived_billing', amount: '0.00', notes: 'free_plan' },
    ]);
  });

  // The reversal, and the reason this file exists: 26 Feb is inside two
  // calendar months of 1 Jan, so the old rule waived it. It is the *third*
  // 4-week period, and a Free Period of 2 covers two.
  it('charges the third 4-week cycle in full, where calendar months would have waived it', async () => {
    const memberId = await createMember();
    const planId = await createPlan(FOUR_WEEKS, { free: 2, paid: 12 });
    const umId = await createAssignment({
      memberId, planId, startsAt: '2000-01-01', nextBillingDate: '2000-02-26',
      cadence: FOUR_WEEKS, durations: { free: 2, paid: 12 },
    });

    expect((await runBilling()).status).toBe(200);

    expect(await chargeFor(umId)).toEqual([
      { event_type: 'recurring_payment', amount: '50.00', notes: null },
    ]);
    expect(executeRecurring).toHaveBeenCalled();
  });

  it('leaves a monthly Plan billing exactly as it did — 1 × month is a month', async () => {
    const memberId = await createMember();
    const planId = await createPlan(MONTH, { free: 2, paid: 12 });
    const umId = await createAssignment({
      memberId, planId, startsAt: '2000-01-01', nextBillingDate: '2000-02-01',
      cadence: MONTH, durations: { free: 2, paid: 12 },
    });

    expect((await runBilling()).status).toBe(200);

    expect(await chargeFor(umId)).toEqual([
      { event_type: 'waived_billing', amount: '0.00', notes: 'free_plan' },
    ]);
  });

  // The cadence the durations are counted in is `ASSIGNMENT_CADENCE`: the
  // assignment's frozen pair, and only then its Plan's live one. An assignment
  // that captured no snapshot at all reads both from the Plan.
  it('falls back to the Plan\'s cadence for an assignment that captured no snapshot', async () => {
    const memberId = await createMember();
    const planId = await createPlan(FOUR_WEEKS, { free: 2, paid: 12 });
    const { insertId: umId } = await db.query(
      `INSERT INTO user_memberships
         (gym_id, member_id, membership_plan_id, status, starts_at, base_price, next_billing_date)
       VALUES (?, ?, ?, 'active', '2000-01-01', 0, '2000-02-26')`,
      [gymId, memberId, planId],
    );

    expect((await runBilling()).status).toBe(200);

    // The Plan's own 4-weekly cadence, so the third period is charged.
    expect(await chargeFor(umId)).toEqual([
      { event_type: 'recurring_payment', amount: '50.00', notes: null },
    ]);
  });

  it('counts a Pre-paid Duration in the same periods', async () => {
    const memberId = await createMember();
    const planId = await createPlan(FOUR_WEEKS, { free: 0, paid: 6, prepaid: 2 });
    const umId = await createAssignment({
      memberId, planId, startsAt: '2000-01-01', nextBillingDate: '2000-01-29',
      cadence: FOUR_WEEKS, durations: { free: 0, paid: 6, prepaid: 2 },
    });

    expect((await runBilling()).status).toBe(200);

    expect(await chargeFor(umId)).toEqual([
      { event_type: 'waived_billing', amount: '0.00', notes: 'prepaid_plan' },
    ]);
  });
});

/* ── what the Plan card shows ────────────────────────────────────────────── */

describe('GET /membership-plans/:id — the Example timeline counts the same periods (#892)', () => {
  // The timeline anchors on today (it is an illustration of a hypothetical
  // enrollment), so the cases assert the statuses and the *gaps* between rows
  // rather than fixed dates.
  const timelineFor = async (planId: number) => {
    const res = await auth(request.get(`/membership-plans/${planId}/example-timeline`));
    expect(res.status).toBe(200);
    return res.body;
  };

  const daysBetween = (a: string, b: string) =>
    Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

  it('gives a 4-weekly Plan with Free Period = 2 exactly two free rows, 28 days apart', async () => {
    const planId = await createPlan({ interval: 4, unit: 'week' }, { free: 2, paid: 1 });
    const body = await timelineFor(planId);
    expect(body.available).toBe(true);
    expect(body.periods.map((p: any) => p.status)).toEqual([
      'free_plan', 'free_plan', 'pay_plan', 'pay_regular', 'pay_regular',
    ]);
    const starts = body.periods.map((p: any) => p.startsOn);
    expect(starts[0]).toBe(body.anchorDate);
    expect(daysBetween(starts[0], starts[1])).toBe(28);
    expect(daysBetween(starts[1], starts[2])).toBe(28);
  });

  it('gives a monthly Plan with the same numbers the same statuses, on month boundaries', async () => {
    const planId = await createPlan({ interval: 1, unit: 'month' }, { free: 2, paid: 1 });
    const body = await timelineFor(planId);
    expect(body.periods.map((p: any) => p.status)).toEqual([
      'free_plan', 'free_plan', 'pay_plan', 'pay_regular', 'pay_regular',
    ]);
    // A calendar month, not 28 days — the same four numbers, a different unit.
    expect(daysBetween(body.periods[0].startsOn, body.periods[1].startsOn)).toBeGreaterThanOrEqual(28);
    expect(daysBetween(body.periods[0].startsOn, body.periods[1].startsOn)).toBeLessThanOrEqual(31);
  });

  it('embeds the same timeline in the plan payload, with the renamed columns', async () => {
    const planId = await createPlan({ interval: 4, unit: 'week' }, { free: 2, paid: 1 });
    const res = await auth(request.get(`/membership-plans/${planId}`));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ free_periods: 2, paid_periods: 1 });
    expect(res.body).not.toHaveProperty('free_months');
    expect(res.body.example_timeline.periods.filter((p: any) => p.status === 'free_plan')).toHaveLength(2);
  });
});

/* ── what the editor writes ──────────────────────────────────────────────── */

describe('PUT /membership-plans/:id — the durations are named for what they count (#892)', () => {
  it('writes the four `*_periods` fields and reads them back', async () => {
    const planId = await createPlan({ interval: 4, unit: 'week' });
    const res = await auth(request.put(`/membership-plans/${planId}`))
      .send({ free_periods: 1, paid_periods: 4, pay_beforehand_periods: 2, bonus_periods: 3 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      free_periods: 1, paid_periods: 4, pay_beforehand_periods: 2, bonus_periods: 3,
    });
  });

  it('still bounds the Pre-paid Duration by the Paid one', async () => {
    const planId = await createPlan({ interval: 4, unit: 'week' }, { paid: 2 });
    const res = await auth(request.put(`/membership-plans/${planId}`))
      .send({ pay_beforehand_periods: 3 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('pay_beforehand_periods');
  });

  // §6 — changing the Billing Frequency changes the unit, never the values.
  it('does not touch the stored numbers when the Billing Frequency changes', async () => {
    const planId = await createPlan({ interval: 1, unit: 'month' }, { free: 2, paid: 3, bonus: 1 });
    const res = await auth(request.put(`/membership-plans/${planId}/billing-policy`))
      .send({ recurring_billing_interval: 4, recurring_billing_unit: 'week', auto_renew: true });
    expect(res.status).toBe(200);

    const { rows } = await db.query(
      'SELECT free_periods, paid_periods, bonus_periods FROM membership_plans WHERE id = ?', [planId],
    );
    expect(rows[0]).toMatchObject({ free_periods: 2, paid_periods: 3, bonus_periods: 1 });
  });
});

/* ── Promotions are out of scope ─────────────────────────────────────────── */

describe('#892 leaves Promotions on calendar months', () => {
  it('keeps the Promotion columns named and counted in months', async () => {
    const { insertId: promotionId } = await db.query(
      `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status,
                               free_months, paid_months, bonus_months)
       VALUES (?, ?, '2026-01-01', '2099-12-31', 'active', 1, 3, 0)`,
      [gymId, `BFD-Promo-${uniq()}`],
    );
    const res = await auth(request.get(`/promotions/${promotionId}`));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ free_months: 1, paid_months: 3 });
    expect(res.body).not.toHaveProperty('free_periods');
  });
});
