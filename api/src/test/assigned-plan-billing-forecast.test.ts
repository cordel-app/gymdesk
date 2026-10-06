// #924 stage 4 — the Assigned Plan card's **Billing Event Forecast**.
//
// §8 asks for the Membership Plan card's Billing Event Simulation (#915) on an
// Assigned Plan, over "the same billing and pricing logic as the actual
// system", and §9/§10 for one group per billing date with every line that falls
// on it.
//
// Integration, not unit: what is under test here is *which rows the projection
// reads* — the assignment's own frozen snapshot, its standing Promotions, its
// Additional Periodic Services — and that the two entry points
// (`GET /user-memberships/:id`'s embedded `billing_event_simulation` and
// `GET /user-memberships/:id/billing-event-simulation`) answer the same thing.
// The projection itself is unit-tested in
// `assignment-billing-event-simulation.unit.test.ts` and the engine in
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
  cadence?: { interval: number; unit: string } | null;
} = {}): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans
       (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', ?, ?, 0, 0)`,
    [gymId, `ABF-Plan-${uniq()}`, opts.free ?? null, opts.paid ?? null],
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
      `INSERT INTO billing_policies
         (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
       VALUES (?, ?, ?, ?)`,
      [gymId, insertId, cadence.interval, cadence.unit],
    );
  }
  return insertId;
}

async function createCharge(gymId: string, opts: {
  name: string; type: string; amount: number; billingFrequency: string;
}): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products
       (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system)
     VALUES (?, ?, ?, ?, 'EUR', ?, 'active', 'available', 0)`,
    [gymId, opts.name, opts.type, opts.amount, opts.billingFrequency],
  );
  return insertId;
}

async function addPlanBenefit(
  gymId: string, table: string, planId: number, chargeId: number, quantity = 1,
): Promise<void> {
  await db.query(
    `INSERT INTO ${table} (gym_id, membership_plan_id, product_id, quantity) VALUES (?, ?, ?, ?)`,
    [gymId, planId, chargeId, quantity],
  );
}

async function createMember(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'ABF Member', `abf-${uniq()}@test.com`],
  );
  return insertId;
}

async function assignPlan(gymId: string, planId: number, startsAt = TODAY()): Promise<number> {
  const res = await request.post('/user-memberships')
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)
    .send({ member_id: await createMember(gymId), membership_plan_id: planId, starts_at: startsAt });
  expect(res.status).toBe(201);
  // #1108 stage 1: assignment creates a Draft, and this file is about an active
  // assignment's forecast. (A Draft is projected too — that is Q3's answer —
  // which is `draft-membership-assignment.test.ts`'s own case.)
  await activateAssignment(gymId, res.body.id);
  return res.body.id as number;
}

const getAssignment = (gymId: string, umId: number) =>
  request.get(`/user-memberships/${umId}`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

const getForecast = (gymId: string, umId: number) =>
  request.get(`/user-memberships/${umId}/billing-event-simulation`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function forecastOf(gymId: string, umId: number) {
  const res = await getAssignment(gymId, umId);
  expect(res.status).toBe(200);
  return res.body.billing_event_simulation;
}

/** Every line of one group, keyed by label. */
function linesOn(forecast: any, date: string): Record<string, any> {
  const group = forecast.dates.find((g: any) => g.date === date);
  expect(group, `no billing event on ${date}`).toBeTruthy();
  return Object.fromEntries(group.lines.map((l: any) => [l.label, l]));
}

describe('Assigned Plan — Billing Event Forecast (#924 stage 4)', () => {
  let gymId: string;

  beforeAll(async () => {
    gymId = await createTestGym('ABF Forecast Gym');
    await createTestMembership(gymId, 'admin');
  });

  it('embeds the forecast on the assignment, grouped by billing date', async () => {
    const umId = await assignPlan(gymId, await createPlan(gymId, { price: 70 }));
    const forecast = await forecastOf(gymId, umId);

    expect(forecast.available).toBe(true);
    expect(forecast.currency).toBe('EUR');
    expect(forecast.tax_included).toBe(true);
    // The forecast starts today, not at a hypothetical enrollment date.
    expect(forecast.anchor_date).toBe(TODAY());
    expect(forecast.dates.length).toBeGreaterThan(0);
    // Chronological, and nothing already behind us.
    const dates = forecast.dates.map((g: any) => g.date);
    expect(dates).toEqual([...dates].sort());
    for (const date of dates) expect(date >= TODAY()).toBe(true);
    // The first group is today's Membership Fee, at the agreed price.
    const fee = forecast.dates[0].lines.find((l: any) => l.kind === 'membership_fee');
    expect(fee).toMatchObject({ actual_charge: 70, regular_price: 70, product_id: null });
  });

  it('serves the same forecast on its own route', async () => {
    const umId = await assignPlan(gymId, await createPlan(gymId, { price: 70 }));
    const res = await getForecast(gymId, umId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(await forecastOf(gymId, umId));
  });

  it('lists the Membership Fee and a Period Benefit that fall on the same date', async () => {
    const planId = await createPlan(gymId, { price: 70 });
    const lockerId = await createCharge(gymId, {
      name: `ABF Locker ${uniq()}`, type: 'fee', amount: 20, billingFrequency: 'month',
    });
    await addPlanBenefit(gymId, 'membership_plan_periodical', planId, lockerId, 1);
    const umId = await assignPlan(gymId, planId);

    const forecast = await forecastOf(gymId, umId);
    const today = forecast.dates.find((g: any) => g.date === TODAY());
    expect(today.lines).toHaveLength(2);
    expect(today.total).toBe(90);
    expect(today.lines.map((l: any) => l.kind).sort()).toEqual(['membership_fee', 'product']);
  });

  it('bills the assignment’s frozen benefit line, not a later Product reprice (§17)', async () => {
    const planId = await createPlan(gymId, { price: 70 });
    const lockerId = await createCharge(gymId, {
      name: `ABF Locker ${uniq()}`, type: 'fee', amount: 20, billingFrequency: 'month',
    });
    await addPlanBenefit(gymId, 'membership_plan_periodical', planId, lockerId, 1);
    const umId = await assignPlan(gymId, planId);

    const before = await forecastOf(gymId, umId);
    await db.query('UPDATE products SET amount = 99 WHERE id = ?', [lockerId]);
    const after = await forecastOf(gymId, umId);
    expect(after).toEqual(before);
  });

  it('does not forecast a one-off charge the assignment was already billed', async () => {
    const planId = await createPlan(gymId, { price: 70 });
    const feeName = `ABF Registration ${uniq()}`;
    const feeId = await createCharge(gymId, {
      name: feeName, type: 'fee', amount: 50, billingFrequency: 'once',
    });
    await addPlanBenefit(gymId, 'membership_plan_oneoff', planId, feeId, 1);
    // Enrolled a year ago: the Registration Fee was charged then, and the card's
    // Billing Events ledger is what shows it.
    const umId = await assignPlan(gymId, planId, dayOffset(-365));

    const forecast = await forecastOf(gymId, umId);
    expect(forecast.available).toBe(true);
    const labels = forecast.dates.flatMap((g: any) => g.lines.map((l: any) => l.label));
    expect(labels).not.toContain(feeName);
    // And the fee cycles it still has ahead of it are forecast.
    expect(labels.length).toBeGreaterThan(0);
  });

  it('waives a line an applied Promotion grants, and still shows its regular price', async () => {
    const planId = await createPlan(gymId, { price: 70 });
    const lockerName = `ABF Locker ${uniq()}`;
    const lockerId = await createCharge(gymId, {
      name: lockerName, type: 'fee', amount: 20, billingFrequency: 'month',
    });
    await addPlanBenefit(gymId, 'membership_plan_periodical', planId, lockerId, 1);
    const umId = await assignPlan(gymId, planId);

    const { insertId: promotionId } = await db.query(
      `INSERT INTO promotions
         (gym_id, name, description, starts_at, ends_at, lifecycle_status, stackable,
          only_applicable_for_new_members, free_months, paid_months, bonus_months)
       VALUES (?, ?, 'ABF promo', ?, '2099-12-31', 'active', 1, 0, 0, 6, 0)`,
      [gymId, `ABF-Promo-${uniq()}`, dayOffset(-1)],
    );
    await db.query(
      'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
      [gymId, promotionId, planId],
    );
    await db.query(
      `INSERT INTO promotion_periodical (gym_id, promotion_id, product_id, quantity, \`action\`, \`value\`)
       VALUES (?, ?, ?, 3, 'waive', NULL)`,
      [gymId, promotionId, lockerId],
    );
    const applied = await request.post(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)
      .send({ promotion_id: promotionId });
    expect(applied.status).toBe(201);

    const forecast = await forecastOf(gymId, umId);
    const locker = linesOn(forecast, TODAY())[lockerName];
    // A waived line is a billing event, shown at €0 beside what it would
    // otherwise have cost (#915) — never dropped because it costs nothing.
    expect(locker).toMatchObject({ actual_charge: 0, regular_price: 20 });
    expect(locker.benefits.map((b: any) => b.action)).toContain('waive');
  });

  it('waives the Membership Fee of a free period, from the assignment’s own duration', async () => {
    const umId = await assignPlan(gymId, await createPlan(gymId, { price: 70, free: 2, paid: 6 }));
    const forecast = await forecastOf(gymId, umId);
    const fee = forecast.dates[0].lines.find((l: any) => l.kind === 'membership_fee');
    expect(fee).toMatchObject({ actual_charge: 0, regular_price: 70 });
    expect(fee.benefits.map((b: any) => b.source)).toContain('membership_plan');
  });

  it('includes an Additional Periodic Service of the assignment (§11)', async () => {
    const planId = await createPlan(gymId, { price: 70 });
    const umId = await assignPlan(gymId, planId);
    const serviceName = `ABF Trainer ${uniq()}`;
    const serviceCharge = await createCharge(gymId, {
      name: serviceName, type: 'fee', amount: 40, billingFrequency: 'month',
    });
    const added = await request.post(`/user-memberships/${umId}/services`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)
      .send({ product_id: serviceCharge, quantity: 1, starts_at: TODAY() });
    expect(added.status).toBe(201);

    const forecast = await forecastOf(gymId, umId);
    const labels = forecast.dates.flatMap((g: any) => g.lines.map((l: any) => l.label));
    expect(labels).toContain(serviceName);
  });

  it('says why there is nothing to forecast when the assignment has no billing frequency', async () => {
    const umId = await assignPlan(gymId, await createPlan(gymId, { price: 70, cadence: null }));
    const forecast = await forecastOf(gymId, umId);
    expect(forecast.available).toBe(false);
    expect(typeof forecast.reason).toBe('string');
    expect(forecast.dates).toEqual([]);
  });

  it('forecasts nothing for an assignment that is no longer billing', async () => {
    const umId = await assignPlan(gymId, await createPlan(gymId, { price: 70 }));
    await db.query("UPDATE user_memberships SET status = 'cancelled' WHERE id = ?", [umId]);
    const forecast = await forecastOf(gymId, umId);
    expect(forecast.available).toBe(false);
    expect(forecast.dates).toEqual([]);
  });
});

describe('GET /user-memberships/:id/billing-event-simulation — auth and tenancy', () => {
  let gymA: string;
  let gymB: string;
  let umA: number;

  beforeAll(async () => {
    gymA = await createTestGym('ABF Gym A');
    gymB = await createTestGym('ABF Gym B');
    await createTestMembership(gymA, 'admin');
    await createTestMembership(gymB, 'admin');
    umA = await assignPlan(gymA, await createPlan(gymA, { price: 70 }));
  });

  it('returns 401 without authentication', async () => {
    const res = await request
      .get(`/user-memberships/${umA}/billing-event-simulation`).set('x-gym-id', gymA);
    expect(res.status).toBe(401);
  });

  it('returns 404 for another gym’s assignment', async () => {
    const res = await getForecast(gymB, umA);
    expect(res.status).toBe(404);
  });

  it('returns 404 for an assignment that does not exist', async () => {
    const res = await getForecast(gymA, 99999999);
    expect(res.status).toBe(404);
  });
});
