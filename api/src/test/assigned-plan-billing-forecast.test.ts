// #924 stage 4 — the Assigned Plan card's **Billing Event Forecast**.
//
// §8 asks the Assigned Plan for the Billing Event Simulation the Membership
// Plan card already has, showing "the billing events that will actually be
// created for the assigned membership": grouped by billing date, chronological,
// calculated from the actual configuration, tax included. §9 keeps the
// frequencies independent, §10 fixes the length at two complete cycles of every
// recurring event present, and §12 forbids the shortcut — no second billing or
// pricing logic.
//
// Integration, not unit: what is under test here is *which rows the projection
// reads* — the assignment's own frozen snapshot, its standing Promotions'
// grants, its Additional Periodic Services — and how the amounts are grossed
// up (the one thing this loader does beyond reading). The grouping, the horizon
// and the from-today rule are unit-tested in
// `assignment-billing-event-simulation.unit.test.ts`, and the engine itself in
// `billing-simulation.test.ts`.
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

describe('Assigned Plan — Billing Event Forecast (#924 stage 4)', () => {
  let gymId: string;
  let taxRateId: number;

  async function createItem(opts: {
    name: string;
    type?: 'sessions' | 'service' | 'fee' | 'other';
    frequency: string | null;
    amount: number;
    taxRateId?: number | null;
    taxBehavior?: 'inclusive' | 'exclusive';
  }): Promise<number> {
    const { insertId } = await db.query(
      `INSERT INTO gym_charges
         (gym_id, name, type, billing_frequency, status, is_system, currency,
          amount, tax_rate_id, tax_behavior)
       VALUES (?, ?, ?, ?, 'active', 0, 'EUR', ?, ?, ?)`,
      [gymId, opts.name, opts.type ?? 'service', opts.frequency, opts.amount,
        opts.taxRateId ?? null, opts.taxBehavior ?? 'inclusive'],
    );
    return insertId;
  }

  async function createPlan(opts: {
    price?: number;
    taxRateId?: number | null;
    taxBehavior?: 'inclusive' | 'exclusive';
    cadence?: { interval: number; unit: string } | null;
    free?: number | null;
    paid?: number | null;
    /**
     * When the Plan's price window opens. It has to cover the start date the
     * assignment is created with: `POST /user-memberships` freezes
     * `membership_fee_price` from `effectivePrice(plan, starts_at)` and leaves
     * it NULL when no window matches, which is an assignment with no fee to
     * project at all. A back-dated contract therefore needs a back-dated price.
     */
    priceFrom?: string;
  } = {}): Promise<number> {
    const { insertId } = await db.query(
      `INSERT INTO membership_plans
         (gym_id, name, lifecycle_status, enrollment_status, member_limit,
          free_periods, paid_periods, bonus_periods, tax_rate_id, tax_behavior)
       VALUES (?, ?, 'active', 'public', '1', ?, ?, 0, ?, ?)`,
      [gymId, `BEF-Plan-${uniq()}`, opts.free ?? 0, opts.paid ?? 12,
        opts.taxRateId ?? null, opts.taxBehavior ?? 'inclusive'],
    );
    await db.query(
      `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
       VALUES (?, ?, ?, ?, 'active')`,
      [gymId, insertId, opts.price ?? 70, opts.priceFrom ?? dayOffset(-365)],
    );
    const cadence = opts.cadence === undefined ? { interval: 1, unit: 'month' } : opts.cadence;
    if (cadence) {
      await db.query(
        `INSERT INTO billing_policies
           (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
         VALUES (?, ?, ?, ?)`,
        [gymId, insertId, cadence.interval, cadence.unit],
      );
    }
    return insertId;
  }

  async function addPlanBenefit(table: string, planId: number, chargeId: number, opts: {
    quantity?: number; action?: string; value?: number | null;
  } = {}): Promise<void> {
    await db.query(
      `INSERT INTO ${table} (gym_id, membership_plan_id, gym_charge_id, quantity, \`action\`, \`value\`)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [gymId, planId, chargeId, opts.quantity ?? 1, opts.action ?? 'no_benefit', opts.value ?? null],
    );
  }

  async function assignPlan(planId: number, startsAt = TODAY()): Promise<number> {
    const { insertId: memberId } = await db.query(
      'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
      [gymId, 'BEF Member', `bef-${uniq()}@test.com`],
    );
    const res = await request
      .post('/user-memberships')
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)
      .send({ member_id: memberId, membership_plan_id: planId, starts_at: startsAt });
    expect(res.status).toBe(201);
    return res.body.id as number;
  }

  const getAssignment = (umId: number) => request
    .get(`/user-memberships/${umId}`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

  async function forecastOf(umId: number) {
    const res = await getAssignment(umId);
    expect(res.status).toBe(200);
    return res.body.billing_event_simulation;
  }

  const lineOn = (forecast: any, date: string, label: string) =>
    (forecast.dates.find((d: any) => d.date === date)?.lines ?? [])
      .find((l: any) => l.label === label);

  beforeAll(async () => {
    gymId = await createTestGym('BEF Forecast Gym');
    await createTestMembership(gymId, 'admin');
    const { insertId } = await db.query(
      `INSERT INTO tax_rates (gym_id, name, rate_percent, is_system, status)
       VALUES (?, 'VAT 10%', 10, 0, 'active')`,
      [gymId],
    );
    taxRateId = insertId;
  });

  it('embeds the forecast on the assignment, grouped by date from today', async () => {
    const planId = await createPlan({ price: 70 });
    const registration = await createItem({ name: 'Registration Fee', type: 'fee', frequency: 'once', amount: 100 });
    await addPlanBenefit('membership_plan_oneoff', planId, registration);
    const umId = await assignPlan(planId);

    const forecast = await forecastOf(umId);
    expect(forecast.available).toBe(true);
    expect(forecast.currency).toBe('EUR');
    expect(forecast.tax_included).toBe(true);
    expect(forecast.anchor_date).toBe(TODAY());
    // Chronological, and the one-off heads the first group (§8's example).
    const dates = forecast.dates.map((d: any) => d.date);
    expect(dates).toEqual([...dates].sort());
    expect(forecast.dates[0].date).toBe(TODAY());
    expect(forecast.dates[0].lines.map((l: any) => l.label))
      .toEqual(expect.arrayContaining(['Registration Fee']));
    expect(forecast.dates[0].total).toBe(170);
    // §10 — `Once` appears once.
    const onceLines = forecast.dates.flatMap((d: any) => d.lines)
      .filter((l: any) => l.label === 'Registration Fee');
    expect(onceLines).toHaveLength(1);
  });

  it('serves the same forecast on its own route', async () => {
    const umId = await assignPlan(await createPlan({ price: 70 }));
    const res = await request.get(`/user-memberships/${umId}/billing-event-simulation`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(await forecastOf(umId));
  });

  it('quotes every amount tax-included, at each item’s own rate', async () => {
    // Exclusive VAT on both sides: a €70 fee reads €77.00 and a €100 item €110.00.
    const planId = await createPlan({ price: 70, taxRateId, taxBehavior: 'exclusive' });
    const locker = await createItem({
      name: 'Locker', frequency: 'month', amount: 100, taxRateId, taxBehavior: 'exclusive',
    });
    await addPlanBenefit('membership_plan_periodical', planId, locker);
    const umId = await assignPlan(planId);

    const forecast = await forecastOf(umId);
    expect(lineOn(forecast, TODAY(), 'Locker').actual_charge).toBe(110);
    const fee = forecast.dates[0].lines.find((l: any) => l.kind === 'membership_fee');
    expect(fee.actual_charge).toBe(77);
    expect(forecast.dates[0].total).toBe(187);
  });

  it('keeps the frozen price when the Sellable Item or the Plan is repriced afterwards', async () => {
    const planId = await createPlan({ price: 70 });
    const locker = await createItem({ name: 'Frozen Locker', frequency: 'month', amount: 20 });
    await addPlanBenefit('membership_plan_periodical', planId, locker);
    const umId = await assignPlan(planId);

    // §13/§17 — the assignment owns what it was agreed with.
    await db.query('UPDATE gym_charges SET amount = 99 WHERE id = ?', [locker]);
    await db.query('UPDATE membership_plan_prices SET price = 200 WHERE membership_plan_id = ?', [planId]);

    const forecast = await forecastOf(umId);
    expect(lineOn(forecast, TODAY(), 'Frozen Locker').actual_charge).toBe(20);
    expect(forecast.dates[0].lines.find((l: any) => l.kind === 'membership_fee').actual_charge).toBe(70);
  });

  it('carries the assignment’s Additional Periodic Services (§11)', async () => {
    const umId = await assignPlan(await createPlan({ price: 70 }));
    const towels = await createItem({ name: 'Towel service', frequency: 'month', amount: 15 });
    const added = await request
      .post(`/user-memberships/${umId}/services`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)
      .send({ gym_charge_id: towels, quantity: 1, starts_at: TODAY() });
    expect(added.status).toBe(201);

    const forecast = await forecastOf(umId);
    expect(lineOn(forecast, TODAY(), 'Towel service').actual_charge).toBe(15);
  });

  it('prices a standing Promotion’s grant from that application’s own snapshot', async () => {
    const planId = await createPlan({ price: 70 });
    const umId = await assignPlan(planId);
    const sauna = await createItem({ name: 'Sauna access', frequency: 'month', amount: 30 });

    const { insertId: promotionId } = await db.query(
      `INSERT INTO promotions
         (gym_id, name, description, starts_at, ends_at, lifecycle_status, stackable,
          only_applicable_for_new_members, free_months, paid_months, bonus_months)
       VALUES (?, ?, 'BEF promo', ?, '2099-12-31', 'active', 1, 0, 0, 6, 0)`,
      [gymId, `BEF-Promo-${uniq()}`, dayOffset(-1)],
    );
    await db.query(
      'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
      [gymId, promotionId, planId],
    );
    await db.query(
      `INSERT INTO promotion_periodical (gym_id, promotion_id, gym_charge_id, quantity, \`action\`, \`value\`)
       VALUES (?, ?, ?, 3, 'waive', NULL)`,
      [gymId, promotionId, sauna],
    );
    const applied = await request
      .post(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)
      .send({ promotion_id: promotionId });
    expect(applied.status).toBe(201);

    const forecast = await forecastOf(umId);
    const granted = lineOn(forecast, TODAY(), 'Sauna access');
    // A waived line is still a billing event, shown at €0 beside what it would
    // otherwise have cost.
    expect(granted.actual_charge).toBe(0);
    expect(granted.regular_price).toBe(30);
    expect(granted.benefits.map((b: any) => b.action)).toContain('waive');

    // §16 — editing the Promotion afterwards cannot reprice an application that
    // already carries a snapshot of it.
    await db.query('UPDATE promotion_periodical SET `action` = ? WHERE promotion_id = ?',
      ['no_benefit', promotionId]);
    const after = await forecastOf(umId);
    expect(lineOn(after, TODAY(), 'Sauna access').actual_charge).toBe(0);
  });

  it('waives the Membership Fee of a Free Period the assignment froze', async () => {
    const umId = await assignPlan(await createPlan({ price: 70, free: 2, paid: 6 }));
    const forecast = await forecastOf(umId);
    const fee = forecast.dates[0].lines.find((l: any) => l.kind === 'membership_fee');
    expect(fee.actual_charge).toBe(0);
    expect(fee.regular_price).toBe(70);
    // It runs on to the contract's first regular charge rather than stopping
    // inside the free window (#629 §6).
    const charged = forecast.dates.flatMap((d: any) => d.lines)
      .filter((l: any) => l.kind === 'membership_fee' && l.actual_charge === 70);
    expect(charged.length).toBeGreaterThan(0);
  });

  it('forecasts from today for a contract that started long ago', async () => {
    const umId = await assignPlan(
      await createPlan({ price: 70, priceFrom: dayOffset(-900) }),
      dayOffset(-800),
    );
    const forecast = await forecastOf(umId);
    expect(forecast.available).toBe(true);
    expect(forecast.anchor_date).toBe(TODAY());
    expect(forecast.dates.every((d: any) => d.date >= TODAY())).toBe(true);
    expect(forecast.dates.length).toBeGreaterThan(0);
  });

  it('says there is nothing to forecast when the assignment has no billing frequency', async () => {
    const umId = await assignPlan(await createPlan({ price: 70, cadence: null }));
    const forecast = await forecastOf(umId);
    expect(forecast.available).toBe(false);
    expect(typeof forecast.reason).toBe('string');
    expect(forecast.dates).toEqual([]);
  });

  it('says there is nothing to forecast for an assignment that bills nothing further', async () => {
    const umId = await assignPlan(await createPlan({ price: 70 }));
    expect((await forecastOf(umId)).available).toBe(true);

    // `cancelled`/`expired` are outside the simulated statuses: the contract is
    // over, so there is nothing ahead of it to project.
    await db.query('UPDATE user_memberships SET status = ? WHERE id = ?', ['cancelled', umId]);
    const forecast = await forecastOf(umId);
    expect(forecast.available).toBe(false);
    expect(typeof forecast.reason).toBe('string');
    expect(forecast.dates).toEqual([]);
  });
});

describe('GET /user-memberships/:id/billing-event-simulation — auth and tenancy', () => {
  let gymA: string;
  let gymB: string;
  let umA: number;

  async function planWithPrice(gymId: string): Promise<number> {
    const { insertId } = await db.query(
      `INSERT INTO membership_plans
         (gym_id, name, lifecycle_status, enrollment_status, member_limit,
          free_periods, paid_periods, bonus_periods)
       VALUES (?, ?, 'active', 'public', '1', 0, 12, 0)`,
      [gymId, `BEF-Auth-Plan-${uniq()}`],
    );
    await db.query(
      `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
       VALUES (?, ?, 70, ?, 'active')`,
      [gymId, insertId, dayOffset(-365)],
    );
    await db.query(
      `INSERT INTO billing_policies
         (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
       VALUES (?, ?, 1, 'month')`,
      [gymId, insertId],
    );
    return insertId;
  }

  beforeAll(async () => {
    gymA = await createTestGym('BEF Gym A');
    gymB = await createTestGym('BEF Gym B');
    await createTestMembership(gymA, 'admin');
    await createTestMembership(gymB, 'admin');
    const { insertId: memberId } = await db.query(
      'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
      [gymA, 'BEF A', `bef-a-${uniq()}@test.com`],
    );
    const res = await request
      .post('/user-memberships')
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymA)
      .send({ member_id: memberId, membership_plan_id: await planWithPrice(gymA), starts_at: TODAY() });
    expect(res.status).toBe(201);
    umA = res.body.id;
  });

  const get = (gymId: string, umId: number) =>
    request.get(`/user-memberships/${umId}/billing-event-simulation`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

  it('returns 401 without authentication', async () => {
    const res = await request.get(`/user-memberships/${umA}/billing-event-simulation`).set('x-gym-id', gymA);
    expect(res.status).toBe(401);
  });

  it('returns 404 for another gym’s assignment', async () => {
    expect((await get(gymB, umA)).status).toBe(404);
  });

  it('returns 404 for an assignment that does not exist', async () => {
    expect((await get(gymA, 99999999)).status).toBe(404);
  });
});
