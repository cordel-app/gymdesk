// #3311 — `GET /payments/members/:memberId/timeline`, the Member card's
// Payments History and Forecast. Fixtures are inserted directly; the HTTP API
// is used only for the action under test.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request, activateAssignment,
} from './helpers';
import { createDraft } from '../api/product-sets';
import { activateWithEvents, addProductSetService, ensureSchedule } from '../api/product-set-configuration';
import { allocateSchedule, cadenceForFrequency } from '../domain/scheduleAllocation';

let gymId: string;
let otherGymId: string;
let memberId: number;
let setId: number;
let chargeTypeId: number;

let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
function dayOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function asAdmin(path: string, gid = gymId) {
  return request.get(path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gid);
}

async function createPlan(gid: string, price: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans
       (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', NULL, NULL, 0, 0)`,
    [gid, `PTL-Plan-${uniq()}`],
  );
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, ?, ?, 'active')`,
    [gid, insertId, price, dayOffset(-365)],
  );
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`,
    [gid, insertId],
  );
  return insertId;
}

async function insertEvent(opts: {
  type: string; amount: number; billingDate: string | null; productSetId: number | null; isScheduled?: boolean;
  scheduleId?: number | null;
}): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO billing_events
       (gym_id, member_id, product_set_id, event_type, charge_type_id, source, actor_user_id, amount, billing_date, is_scheduled,
        schedule_id, period_start)
     VALUES (?, ?, ?, ?, ?, 'system', NULL, ?, ?, ?, ?, ?)`,
    [gymId, memberId, opts.productSetId, opts.type, chargeTypeId, opts.amount, opts.billingDate, opts.isScheduled ? 1 : 0,
      opts.scheduleId ?? null, opts.scheduleId != null ? opts.billingDate : null],
  );
  return insertId;
}

async function insertCompletedPayment(eventId: number, amount: number, completedAt: string): Promise<void> {
  await db.query(
    `INSERT INTO payment_requests
       (gym_id, member_id, amount, currency, charge_type_id, billing_event_id, status, provider, provider_order,
        source, created_at, completed_at)
     VALUES (?, ?, ?, 'EUR', ?, ?, 'completed', 'monei', UUID(), 'billing_run', ?, ?)`,
    [gymId, memberId, amount, chargeTypeId, eventId, completedAt, completedAt],
  );
}

beforeAll(async () => {
  gymId = await createTestGym('Payments Timeline Gym');
  otherGymId = await createTestGym('Payments Timeline Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
  const { rows } = await db.query<{ id: number }>("SELECT id FROM charge_types WHERE code = 'membership_fee'");
  chargeTypeId = rows[0].id;
  const m = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'Timeline Member', `ptl-${uniq()}@test.com`]);
  memberId = m.insertId;

  const planId = await createPlan(gymId, 70);
  const res = await request.post('/user-memberships')
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)
    .send({ member_id: memberId, membership_plan_id: planId, starts_at: dayOffset(0) });
  expect(res.status).toBe(201);
  await activateAssignment(gymId, res.body.id);
  const s = await db.query<{ id: number }>(
    "SELECT id FROM product_sets WHERE gym_id = ? AND owner_member_id = ? AND status = 'active'", [gymId, memberId]);
  setId = s.rows[0].id;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('auth and tenancy', () => {
  it('returns 401 without auth', async () => {
    const res = await request.get(`/payments/members/${memberId}/timeline`).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 404 for a member of another gym', async () => {
    const res = await asAdmin(`/payments/members/${memberId}/timeline`, otherGymId);
    expect(res.status).toBe(404);
  });
});

describe('GET /payments/members/:memberId/timeline', () => {
  it('combines the payment history, the scheduled events and the forecast, writing nothing', async () => {
    // History: a fee billed 90 days ago, paid three days later.
    const paidEvent = await insertEvent({ type: 'payment_recorded', amount: 70, billingDate: dayOffset(-90), productSetId: setId });
    await insertCompletedPayment(paidEvent, 70, `${dayOffset(-87)} 10:00:00`);
    // A one-off Product, paid 30 days ago.
    const purchase = await insertEvent({ type: 'product_purchase', amount: 15, billingDate: null, productSetId: null });
    await insertCompletedPayment(purchase, 15, `${dayOffset(-30)} 09:00:00`);

    const before = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM billing_events WHERE gym_id = ?', [gymId]);
    const res = await asAdmin(`/payments/members/${memberId}/timeline`);
    expect(res.status).toBe(200);
    const after = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM billing_events WHERE gym_id = ?', [gymId]);
    expect(Number(after.rows[0].n)).toBe(Number(before.rows[0].n));

    const points = res.body.points as any[];
    expect(res.body.today).toBe(dayOffset(0));
    // The earliest point is the earliest payment, at its actual payment date.
    expect(points[0]).toMatchObject({ kind: 'payment', billing_event_id: paidEvent, date: dayOffset(-87), status: 'paid' });
    // The one-off Product is exactly one point.
    expect(points.filter((p) => p.billing_event_id === purchase)).toEqual([
      expect.objectContaining({ kind: 'payment', event_type: 'product_purchase', date: dayOffset(-30), amount: 15 }),
    ]);
    // The future runs from today through at least two monthly cycles: the obligations the
    // activation persisted read as scheduled, and nothing is forecast twice on their dates.
    const future = points.filter((p) => p.kind !== 'payment');
    expect(future.length).toBeGreaterThanOrEqual(2);
    expect(future.every((p) => p.date >= dayOffset(0))).toBe(true);
    expect(future[future.length - 1].date >= dayOffset(28)).toBe(true);
    const dates = future.map((p) => p.date);
    expect(new Set(dates).size).toBe(dates.length);
  });

  it('forecasts what is not persisted yet, and a persisted obligation replaces the forecast on its date', async () => {
    const { rows: persisted } = await db.query<any>(
      `SELECT id, billing_date, amount FROM billing_events
        WHERE gym_id = ? AND member_id = ? AND is_scheduled = 1 ORDER BY billing_date`, [gymId, memberId]);
    expect(persisted.length).toBeGreaterThan(0);
    // Without the persisted obligations, the engine's forecast stands on their dates.
    await db.query('UPDATE billing_events SET is_scheduled = 0, cancelled_at = UTC_TIMESTAMP() WHERE gym_id = ? AND member_id = ? AND is_scheduled = 1', [gymId, memberId]);
    const forecastOnly = (await asAdmin(`/payments/members/${memberId}/timeline`)).body.points
      .filter((p: any) => p.kind === 'forecast');
    expect(forecastOnly.length).toBeGreaterThanOrEqual(2);
    expect(forecastOnly.every((p: any) => p.billing_event_id === null && p.status === 'forecasted' && p.lines.length > 0)).toBe(true);
    expect(forecastOnly[forecastOnly.length - 1].date >= dayOffset(28)).toBe(true);

    // #3446: an event on the same date that is not this obligation (no schedule) hides nothing.
    const first = forecastOnly[0];
    const unrelated = await insertEvent({
      type: 'payment_recorded', amount: 5, billingDate: first.date, productSetId: setId, isScheduled: true,
    });
    const withUnrelated = (await asAdmin(`/payments/members/${memberId}/timeline`)).body.points as any[];
    expect(withUnrelated.filter((p) => p.date === first.date).map((p) => [p.kind, p.billing_event_id])).toEqual([
      ['scheduled', unrelated], ['forecast', null],
    ]);
    await db.query('UPDATE billing_events SET cancelled_at = UTC_TIMESTAMP(), is_scheduled = 0 WHERE id = ?', [unrelated]);

    // The obligation itself — the plan schedule's period — replaces the forecast.
    const { rows: sch } = await db.query<any>(
      "SELECT id FROM product_set_schedules WHERE owner_member_id = ? AND schedule_key = 'plan'", [memberId]);
    // The cancelled obligation still holds the period's unique key; free it for this fixture.
    await db.query('UPDATE billing_events SET period_start = NULL WHERE schedule_id = ? AND period_start = ? AND cancelled_at IS NOT NULL',
      [sch[0].id, first.date]);
    const scheduled = await insertEvent({
      type: 'payment_recorded', amount: first.amount, billingDate: first.date, productSetId: setId, isScheduled: true,
      scheduleId: sch[0].id,
    });
    const res = await asAdmin(`/payments/members/${memberId}/timeline`);
    const onDate = (res.body.points as any[]).filter((p) => p.date === first.date && p.status !== 'cancelled');
    expect(onDate).toEqual([expect.objectContaining({ kind: 'scheduled', billing_event_id: scheduled, status: 'scheduled' })]);
  });
});

async function insertAttempt(eventId: number, status: string): Promise<void> {
  await db.query(
    `INSERT INTO payment_requests
       (gym_id, member_id, amount, currency, charge_type_id, billing_event_id, status, provider, provider_order, source)
     VALUES (?, ?, 10, 'EUR', ?, ?, ?, 'monei', UUID(), 'billing_run')`,
    [gymId, memberId, chargeTypeId, eventId, status],
  );
}

describe('#3435: cancelled attempts are left out, failed and pending are marked', () => {
  let cancelledPending: number;
  let cancelledPaid: number;
  let failed: number;
  let pending: number;
  let expired: number;

  beforeAll(async () => {
    cancelledPending = await insertEvent({ type: 'payment_recorded', amount: 11, billingDate: dayOffset(-20), productSetId: setId });
    await insertAttempt(cancelledPending, 'pending');
    await db.query('UPDATE billing_events SET cancelled_at = UTC_TIMESTAMP() WHERE id = ?', [cancelledPending]);
    cancelledPaid = await insertEvent({ type: 'payment_recorded', amount: 12, billingDate: dayOffset(-19), productSetId: setId });
    await insertCompletedPayment(cancelledPaid, 12, `${dayOffset(-19)} 10:00:00`);
    await db.query('UPDATE billing_events SET cancelled_at = UTC_TIMESTAMP() WHERE id = ?', [cancelledPaid]);
    failed = await insertEvent({ type: 'payment_recorded', amount: 13, billingDate: dayOffset(-18), productSetId: setId });
    await insertAttempt(failed, 'failed');
    pending = await insertEvent({ type: 'payment_recorded', amount: 14, billingDate: dayOffset(-17), productSetId: setId });
    await insertAttempt(pending, 'pending');
    expired = await insertEvent({ type: 'payment_recorded', amount: 15, billingDate: dayOffset(-16), productSetId: setId });
    await insertAttempt(expired, 'expired');
  });

  it('the chart leaves out the cancelled attempt and marks failed and pending points', async () => {
    const res = await asAdmin(`/payments/members/${memberId}/timeline`);
    expect(res.status).toBe(200);
    const byId = new Map((res.body.points as any[]).map((p) => [p.billing_event_id, p]));
    expect(byId.has(cancelledPending)).toBe(false);
    expect(byId.get(cancelledPaid)).toMatchObject({ status: 'cancelled', alert: null });
    expect(byId.get(failed)).toMatchObject({ kind: 'payment', status: 'failed', alert: 'failed' });
    expect(byId.get(pending)).toMatchObject({ kind: 'payment', status: 'pending', alert: 'pending' });
    // #3311 stage 3: an expired attempt that collected nothing is not a point either.
    expect(byId.has(expired)).toBe(false);
  });

  it('the Payments tab table lists every cancelled event as resolved, and the chart rule stays the chart\'s', async () => {
    // #3435 stage 2: the tab's table request is the unfiltered ledger.
    const res = await asAdmin(`/payments/billing-events?member_id=${memberId}&limit=200`);
    expect(res.status).toBe(200);
    const byId = new Map((res.body.items as any[]).map((r) => [r.id, r]));
    expect(byId.get(cancelledPending)).toMatchObject({ status: 'cancelled' });
    expect(byId.get(cancelledPaid)).toMatchObject({ status: 'cancelled' });
    expect(byId.get(failed)).toMatchObject({ status: 'failed' });
    expect(byId.get(pending)).toMatchObject({ status: 'pending' });
  });

  it('a cancelled persisted obligation reads cancelled, never scheduled, in the table and is off the chart', async () => {
    const ev = await insertEvent({ type: 'payment_recorded', amount: 15, billingDate: dayOffset(30), productSetId: setId, isScheduled: true });
    await db.query('UPDATE billing_events SET cancelled_at = UTC_TIMESTAMP() WHERE id = ?', [ev]);
    const list = await asAdmin(`/payments/billing-events?member_id=${memberId}&limit=200`);
    expect((list.body.items as any[]).find((r) => r.id === ev)).toMatchObject({ status: 'cancelled' });
    const chart = await asAdmin(`/payments/members/${memberId}/timeline`);
    expect((chart.body.points as any[]).some((p) => p.billing_event_id === ev)).toBe(false);
  });
});

describe('#3446: a yearly and a four-weekly line over one two-year horizon', () => {
  let owner: number;
  let insuranceName: string;
  let lockerName: string;

  beforeAll(async () => {
    const today = dayOffset(0);
    const product = async (name: string, amount: number, freq: string) => (await db.query(
      `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system)
       VALUES (?, ?, 'fee', ?, 'EUR', ?, 'active', 'available', 0)`, [gymId, name, amount, freq])).insertId;
    insuranceName = `Insurance-${uniq()}`;
    lockerName = `Locker-${uniq()}`;
    const insurance = await product(insuranceName, 30, 'year');
    const locker = await product(lockerName, 12, 'four_weeks');
    owner = (await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
      [gymId, 'Two-year member', `ptl2-${uniq()}@test.com`])).insertId;
    const actor = { name: 'Test', type: 'staff' };
    const set = await db.transaction(async (tx) => {
      const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: null, startsAt: today, actor });
      if (d.kind !== 'created') throw new Error('expected created');
      const existing: any[] = [];
      for (const [productId, freq] of [[insurance, 'year'], [locker, 'four_weeks']] as const) {
        const cadence = cadenceForFrequency(freq)!;
        const allocation: any = allocateSchedule({ cadence, purchaseDate: today, schedules: existing });
        const scheduleId = await ensureSchedule(tx, {
          gymId, productSetId: d.productSet.id, key: allocation.key, anchorDate: today,
          cadenceInterval: cadence.interval, cadenceUnit: cadence.unit,
        });
        existing.push({ id: scheduleId, key: allocation.key, cadence, anchorDate: today });
        await addProductSetService(tx, { gymId, productSetId: d.productSet.id, productId, quantity: 1, startsAt: today, scheduleId });
      }
      return d.productSet;
    });
    const act = await db.transaction((tx) => activateWithEvents(tx, { gymId, productSetId: set.id, today }));
    expect(act.kind).toBe('ok');
  });

  it('plots the persisted cycles as Scheduled and the locker\'s later cycles as Forecasted through two years', async () => {
    const before = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM billing_events WHERE gym_id = ?', [gymId]);
    const res = await asAdmin(`/payments/members/${owner}/timeline`);
    expect(res.status).toBe(200);
    const after = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM billing_events WHERE gym_id = ?', [gymId]);
    expect(Number(after.rows[0].n)).toBe(Number(before.rows[0].n));

    const points = res.body.points as any[];
    const carries = (p: any, name: string) => p.lines.some((l: any) => l.label === name);
    const lockerForecast = points.filter((p) => p.kind === 'forecast' && carries(p, lockerName));
    const insurancePoints = points.filter((p) => p.kind !== 'payment' && carries(p, insuranceName));
    // The locker keeps its four-weekly cycles across the insurance's two-year horizon.
    expect(lockerForecast.length).toBeGreaterThan(15);
    expect(lockerForecast[lockerForecast.length - 1].date >= dayOffset(700)).toBe(true);
    expect(lockerForecast.every((p) => p.status === 'forecasted' && p.billing_event_id === null)).toBe(true);
    // Every persisted obligation reads as Scheduled, and no obligation is plotted twice.
    const scheduled = points.filter((p) => p.kind === 'scheduled');
    expect(scheduled.length).toBeGreaterThanOrEqual(2);
    expect(scheduled.every((p) => p.status === 'scheduled' && p.billing_event_id != null)).toBe(true);
    expect(insurancePoints.length).toBeGreaterThanOrEqual(2);
    const projections = points.filter((p) => p.kind === 'forecast' || p.kind === 'no_charge');
    const keys = projections.map((p) => `${p.date}|${p.lines.map((l: any) => l.label).join(',')}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
