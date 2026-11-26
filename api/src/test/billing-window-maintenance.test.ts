// #3445 — the rolling window of future Scheduled Billing Events: each recurring schedule keeps its
// next two *positive* obligations persisted, at activation and through `POST /billing/maintain-window`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym, request } from './helpers';
import { createDraft } from '../api/product-sets';
import {
  activateWithEvents, addProductSetService, ensureSchedule, materialiseScheduledEvents, snapshotProductSetFromPlan,
} from '../api/product-set-configuration';
import { allocateSchedule, cadenceForFrequency } from '../domain/scheduleAllocation';

const SECRET = 'window-maintenance-secret';
let gymId: string;
const actor = { name: 'Test', type: 'staff' };
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

async function member(): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'M', `win-${uniq()}@example.com`]);
  return insertId;
}
async function product(name: string, amount: number, billingFrequency: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system)
     VALUES (?, ?, 'fee', ?, 'EUR', ?, 'active', 'available', 0)`,
    [gymId, `${name}-${uniq()}`, amount, billingFrequency]);
  return insertId;
}
async function plan(price: number, free: number | null): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', ?, ?, 0, 0)`,
    [gymId, `Win-Plan-${uniq()}`, free, free ? 12 : null]);
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, ?, '2020-01-01', 'active')`, [gymId, insertId, price]);
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return insertId;
}
async function planVersion(planId: number, price: number) {
  return db.transaction(async (tx) => {
    const d = await createDraft(tx, { gymId, ownerMemberId: await member(), membershipPlanId: planId, startsAt: TODAY, actor });
    if (d.kind !== 'created') throw new Error(`expected created, got ${d.kind}`);
    await snapshotProductSetFromPlan(tx, { gymId, productSetId: d.productSet.id, membershipPlanId: planId, membershipFeePrice: price, startsAt: TODAY });
    return d.productSet;
  });
}
/** A plan-less set holding one recurring line per given product, each on a schedule of its own cadence. */
async function servicesVersion(lines: Array<{ productId: number; frequency: string }>) {
  return db.transaction(async (tx) => {
    const d = await createDraft(tx, { gymId, ownerMemberId: await member(), membershipPlanId: null, startsAt: TODAY, actor });
    if (d.kind !== 'created') throw new Error('expected created');
    const existing: Array<{ id: number | null; key: string; cadence: any; anchorDate: string }> = [];
    for (const l of lines) {
      const cadence = cadenceForFrequency(l.frequency)!;
      const allocation = allocateSchedule({ cadence, purchaseDate: TODAY, schedules: existing as any });
      const key = allocation.kind === 'new' ? allocation.key : (allocation as any).key;
      const scheduleId = await ensureSchedule(tx, {
        gymId, productSetId: d.productSet.id, key, anchorDate: TODAY,
        cadenceInterval: cadence.interval, cadenceUnit: cadence.unit,
      });
      existing.push({ id: scheduleId, key, cadence, anchorDate: TODAY });
      await addProductSetService(tx, { gymId, productSetId: d.productSet.id, productId: l.productId, quantity: 1, startsAt: TODAY, scheduleId });
    }
    return d.productSet;
  });
}
/**
 * The set's Scheduled events. A schedule's prorated first stretch (a line joining between two grid
 * dates) is a stub, not a cycle, and holds no slot of the window (#2125 stage 9): `regular` leaves it out.
 */
async function scheduledEvents(setId: number, opts: { regular?: boolean } = {}) {
  const { rows } = await db.query<any>(
    `SELECT id, schedule_id, period_start, billing_date, amount FROM billing_events be
      WHERE product_set_id = ? AND is_scheduled = 1
        ${opts.regular ? 'AND NOT EXISTS (SELECT 1 FROM billing_event_lines l WHERE l.billing_event_id = be.id AND l.prorated_days IS NOT NULL)' : ''}
      ORDER BY billing_date, id`, [setId]);
  return rows.map((r: any) => ({ ...r, amount: Number(r.amount), period_start: iso(r.period_start), billing_date: iso(r.billing_date) }));
}
const maintain = () => request.post('/billing/maintain-window').set('x-internal-secret', SECRET);

beforeAll(async () => {
  process.env.BILLING_INTERNAL_SECRET = SECRET;
  gymId = await createTestGym('Billing window gym');
});
afterAll(async () => {
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('the rolling window counts only positive cycles (#3445)', () => {
  it('scans past free periods to persist two positive obligations on activation', async () => {
    const set = await planVersion(await plan(50, 3), 50);
    const act = await db.transaction((tx) => activateWithEvents(tx, { gymId, productSetId: set.id, today: TODAY }));
    expect(act.kind).toBe('ok');
    const events = await scheduledEvents(set.id, { regular: true });
    expect(events.map((e) => e.amount)).toEqual([50, 50]);
    // The three free months are skipped: the first positive charge is three months out.
    expect(events[0].billing_date > TODAY).toBe(true);
    const { rows: zero } = await db.query('SELECT id FROM billing_events WHERE product_set_id = ? AND amount <= 0', [set.id]);
    expect(zero.length).toBe(0);
  });

  it('the window is the set\'s: two distinct positive dates across a yearly and a four-weekly line (stage 2)', async () => {
    const insurance = await product('Insurance', 30, 'year');
    const locker = await product('Locker', 12, 'four_weeks');
    const set = await servicesVersion([{ productId: insurance, frequency: 'year' }, { productId: locker, frequency: 'four_weeks' }]);
    await db.transaction((tx) => activateWithEvents(tx, { gymId, productSetId: set.id, today: TODAY }));
    const events = await scheduledEvents(set.id);
    // Two dates in total, not two per schedule: the yearly line's first year (today, with the
    // locker's prorated first stretch consolidated into it) and the locker's next grid date; the
    // locker's later cycles and the second year wait until the window advances.
    const dates = [...new Set(events.map((e) => e.billing_date))];
    expect(dates.length).toBe(2);
    expect(events.length).toBe(2);
    const { rows: yearly } = await db.query<any>(
      `SELECT bl.billing_event_id FROM billing_event_lines bl JOIN billing_events be ON be.id = bl.billing_event_id
        WHERE be.product_set_id = ? AND bl.product_id = ?`, [set.id, insurance]);
    expect(yearly.length).toBe(1);
    const periods = events.map((e) => `${e.schedule_id}|${e.period_start}`);
    expect(new Set(periods).size).toBe(periods.length);
  });

  it('consolidates two schedules owing on one date into ONE event, each line keeping its schedule (stage 2)', async () => {
    const towel = await product('Towel', 9, 'month');
    const parking = await product('Parking', 15, 'month');
    // Two monthly lines on two schedules of their own: both bill on the 1st.
    const set = await db.transaction(async (tx) => {
      const d = await createDraft(tx, { gymId, ownerMemberId: await member(), membershipPlanId: null, startsAt: TODAY, actor });
      if (d.kind !== 'created') throw new Error('expected created');
      for (const [key, productId] of [['towel', towel], ['parking', parking]] as const) {
        const scheduleId = await ensureSchedule(tx, {
          gymId, productSetId: d.productSet.id, key, anchorDate: TODAY, cadenceInterval: 1, cadenceUnit: 'month',
        });
        await addProductSetService(tx, { gymId, productSetId: d.productSet.id, productId, quantity: 1, startsAt: TODAY, scheduleId });
      }
      return d.productSet;
    });
    await db.transaction((tx) => activateWithEvents(tx, { gymId, productSetId: set.id, today: TODAY }));
    const events = await scheduledEvents(set.id, { regular: true });
    expect(events.length).toBe(2);
    expect(new Set(events.map((e) => e.billing_date)).size).toBe(2);
    for (const e of events) {
      expect(e.amount).toBe(24);
      const { rows: lines } = await db.query<any>(
        'SELECT schedule_id, period_start, amount FROM billing_event_lines WHERE billing_event_id = ? ORDER BY id', [e.id]);
      expect(lines.length).toBe(2);
      expect(new Set(lines.map((l: any) => Number(l.schedule_id))).size).toBe(2);
      for (const l of lines) expect(iso(l.period_start)).toBe(e.billing_date);
    }
    // Repeated maintenance creates neither a second event nor a separate one for the other schedule.
    const again = await db.transaction((tx) => materialiseScheduledEvents(tx, { gymId, productSetId: set.id, today: TODAY }));
    expect(again.created).toBe(0);
    expect((await scheduledEvents(set.id, { regular: true })).length).toBe(2);
  });

  it('a repeated activation or materialisation creates nothing twice', async () => {
    const set = await planVersion(await plan(40, 1), 40);
    await db.transaction((tx) => activateWithEvents(tx, { gymId, productSetId: set.id, today: TODAY }));
    const before = await scheduledEvents(set.id);
    const again = await db.transaction((tx) => materialiseScheduledEvents(tx, { gymId, productSetId: set.id, today: TODAY }));
    expect(again.created).toBe(0);
    expect(await scheduledEvents(set.id)).toEqual(before);
  });
});

describe('POST /billing/maintain-window (#3445)', () => {
  it('answers 401 without the internal secret', async () => {
    expect((await request.post('/billing/maintain-window')).status).toBe(401);
    expect((await request.post('/billing/maintain-window').set('x-internal-secret', 'nope')).status).toBe(401);
  });

  it('replenishes a window that ran short, keeps attempted events, and is idempotent under concurrency', async () => {
    const set = await planVersion(await plan(60, 0), 60);
    await db.transaction((tx) => activateWithEvents(tx, { gymId, productSetId: set.id, today: TODAY }));
    const full = await scheduledEvents(set.id, { regular: true });
    expect(full.length).toBe(2);
    // The first obligation has an attempt (it was charged); the second disappeared (a window that ran short).
    await db.query(
      `INSERT INTO payment_requests (gym_id, member_id, amount, status, source, billing_event_id, method)
       SELECT gym_id, member_id, amount, 'completed', 'billing_run', id, 'provider' FROM billing_events WHERE id = ?`,
      [full[0].id]);
    await db.query('DELETE FROM billing_events WHERE id = ?', [full[1].id]);

    const [a, b] = await Promise.all([maintain(), maintain()]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.events_created + b.body.events_created).toBeGreaterThanOrEqual(1);
    expect(a.body.failures).toBe(0);

    const after = await scheduledEvents(set.id, { regular: true });
    expect(after.map((e) => e.amount)).toEqual([60, 60]);
    expect(after[0].id).toBe(full[0].id); // the attempted event is untouched
    const periods = after.map((e) => `${e.schedule_id}|${e.period_start}`);
    expect(new Set(periods).size).toBe(periods.length);

    const res = await maintain();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ run_date: TODAY, failures: 0 });
    expect((await scheduledEvents(set.id, { regular: true })).length).toBe(2);
    // It never charges: no new payment request was written for the set.
    const { rows: reqs } = await db.query(
      'SELECT id FROM payment_requests WHERE billing_event_id IN (SELECT id FROM billing_events WHERE product_set_id = ?)', [set.id]);
    expect(reqs.length).toBe(1);
  });

  it('reports each set\'s target status: replenished, then at target on the next run (#3444)', async () => {
    const set = await planVersion(await plan(35, 0), 35);
    await db.transaction((tx) => activateWithEvents(tx, { gymId, productSetId: set.id, today: TODAY }));
    const full = await scheduledEvents(set.id, { regular: true });
    await db.query('DELETE FROM billing_events WHERE id = ?', [full[1].id]);

    const first = await maintain();
    expect(first.status).toBe(200);
    expect(first.body.target_events).toBe(2);
    const mine = first.body.product_sets.find((p: any) => p.product_set_id === set.id);
    expect(mine).toMatchObject({ status: 'replenished', events_created: 1 });
    expect(mine.future_events).toBeGreaterThanOrEqual(2);

    const second = await maintain();
    expect(second.status).toBe(200);
    expect(second.body.product_sets.find((p: any) => p.product_set_id === set.id))
      .toMatchObject({ status: 'at_target', events_created: 0 });
    expect(second.body.product_sets_at_target).toBeGreaterThanOrEqual(1);
  });

  it('reports a contract owing fewer than two future obligations as a legitimate shortfall (#3444)', async () => {
    const locker = await product('ShortLocker', 18, 'month');
    const set = await servicesVersion([{ productId: locker, frequency: 'month' }]);
    // The line ends ten days from now: one obligation is left within its contract.
    const ends = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    await db.query(
      `UPDATE product_periodical_snapshots SET ends_at = ?
        WHERE id IN (SELECT product_periodical_snapshot_id FROM product_set_periodical_snapshots WHERE product_set_id = ?)`,
      [ends, set.id]);
    await db.transaction((tx) => activateWithEvents(tx, { gymId, productSetId: set.id, today: TODAY }));

    const res = await maintain();
    expect(res.status).toBe(200);
    const mine = res.body.product_sets.find((p: any) => p.product_set_id === set.id);
    expect(mine.status).toBe('shortfall');
    expect(mine.reason).toBe('fewer_future_obligations');
    expect(mine.future_events).toBe(mine.planned_events);
    expect(mine.future_events).toBeLessThan(2);
    expect(res.body.product_sets_shortfall).toBeGreaterThanOrEqual(1);
  });

  it('leaves a superseded set alone', async () => {
    const set = await planVersion(await plan(25, 0), 25);
    await db.transaction((tx) => activateWithEvents(tx, { gymId, productSetId: set.id, today: TODAY }));
    await db.query("UPDATE product_sets SET status = 'superseded' WHERE id = ?", [set.id]);
    await db.query('DELETE FROM billing_events WHERE product_set_id = ?', [set.id]);
    expect((await maintain()).status).toBe(200);
    expect((await scheduledEvents(set.id)).length).toBe(0);
  });
});
