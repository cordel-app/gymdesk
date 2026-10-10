import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym } from './helpers';
import { createDraft } from '../api/product-sets';
import {
  activateWithEvents, addProductSetService, ensureSchedule, loadProductSetSimulationAssignment,
  materialiseScheduledEvents, snapshotProductSetFromPlan,
} from '../api/product-set-configuration';
import { allocateSchedule, cadenceForFrequency } from '../domain/scheduleAllocation';
import { linesMatchTotal } from '../domain/billingEventLines';

let gymId: string;
const actor = { name: 'Test', type: 'staff' };
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const day = (offset: number) => {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10);
};
const TODAY = day(0);

async function member(): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'M', `pse-${uniq()}@example.com`]);
  return insertId;
}
async function product(name: string, amount: number, billingFrequency: string, type = 'fee'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system)
     VALUES (?, ?, ?, ?, 'EUR', ?, 'active', 'available', 0)`,
    [gymId, `${name}-${uniq()}`, type, amount, billingFrequency]);
  return insertId;
}
async function plan(opts: { price: number; free?: number | null; periodical?: Array<{ productId: number }> }): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', ?, NULL, 0, 0)`,
    [gymId, `PSE-Plan-${uniq()}`, opts.free ?? null]);
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, ?, ?, 'active')`, [gymId, insertId, opts.price, day(-365)]);
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  for (const p of opts.periodical ?? []) {
    await db.query(
      `INSERT INTO membership_plan_periodical (gym_id, membership_plan_id, product_id, quantity) VALUES (?, ?, ?, 1)`,
      [gymId, insertId, p.productId]);
  }
  return insertId;
}

async function newVersion(owner: number, planId: number | null, startsAt = TODAY, fee: number | null = null) {
  return db.transaction(async (tx) => {
    const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: planId, startsAt, actor });
    if (d.kind !== 'created') throw new Error(`expected created, got ${d.kind}`);
    if (planId != null) {
      await snapshotProductSetFromPlan(tx, { gymId, productSetId: d.productSet.id, membershipPlanId: planId, membershipFeePrice: fee, startsAt });
    }
    return d.productSet;
  });
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

async function scheduledEvents(setId: number) {
  const { rows } = await db.query<any>(
    `SELECT id, schedule_id, period_start, billing_date, amount FROM billing_events
      WHERE product_set_id = ? AND is_scheduled = 1 ORDER BY billing_date, id`, [setId]);
  return rows.map((r: any) => ({ ...r, period_start: iso(r.period_start), billing_date: iso(r.billing_date) }));
}

beforeAll(async () => { gymId = await createTestGym('PS events gym'); });
afterAll(async () => {
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('a ProductSet version feeds the existing engine (#1325 PR 2b)', () => {
  it('reads back what was frozen, from the version\'s own rows', async () => {
    const locker = await product('Locker', 10, 'month');
    const planId = await plan({ price: 50, periodical: [{ productId: locker }] });
    const set = await newVersion(await member(), planId, TODAY, 50);
    const a = await loadProductSetSimulationAssignment(gymId, set.id);
    expect(a).not.toBeNull();
    expect(a!.membershipFeePrice).toBe(50);
    expect(a!.recurringInterval).toBe(1);
    expect(a!.recurringUnit).toBe('month');
    expect(a!.planBenefits.map((b) => b.productId)).toEqual([locker]);
  });

  it('a catalogue price change after the snapshot moves nothing already frozen', async () => {
    const locker = await product('Locker2', 10, 'month');
    const planId = await plan({ price: 50, periodical: [{ productId: locker }] });
    const set = await newVersion(await member(), planId, TODAY, 50);
    await db.query('UPDATE products SET amount = 999 WHERE id = ?', [locker]);
    const a = await loadProductSetSimulationAssignment(gymId, set.id);
    expect(a!.planBenefits[0].unitPrice).toBe(10);
  });
});

describe('persisted Scheduled Billing Events (#1325 PR 2b)', () => {
  it('generates the next cycles with lines that sum to the event, idempotently', async () => {
    const locker = await product('Locker3', 10, 'month');
    const planId = await plan({ price: 50, periodical: [{ productId: locker }] });
    const set = await newVersion(await member(), planId, TODAY, 50);

    const first = await db.transaction((tx) => materialiseScheduledEvents(tx, { gymId, productSetId: set.id, today: TODAY }));
    expect(first.created).toBeGreaterThan(0);
    const events = await scheduledEvents(set.id);
    expect(events.length).toBeLessThanOrEqual(2 + 1); // two cycles of the plan schedule (+ a one-off group if any)
    for (const e of events) {
      const { rows: lines } = await db.query<any>(
        'SELECT amount, kind FROM billing_event_lines WHERE billing_event_id = ?', [e.id]);
      expect(lines.length).toBeGreaterThan(0);
      expect(linesMatchTotal(lines.map((l: any) => ({ amount: Number(l.amount) })), Number(e.amount))).toBe(true);
    }
    const again = await db.transaction((tx) => materialiseScheduledEvents(tx, { gymId, productSetId: set.id, today: TODAY }));
    expect(again.created).toBe(0);
    expect((await scheduledEvents(set.id)).length).toBe(events.length);
  });

  it('a plan-less set with a recurring service has its own independent schedule', async () => {
    const owner = await member();
    const locker = await product('LockerOnly', 15, 'month');
    const set = await db.transaction(async (tx) => {
      const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: null, startsAt: TODAY, actor });
      if (d.kind !== 'created') throw new Error('expected created');
      const allocation = allocateSchedule({ cadence: cadenceForFrequency('month')!, purchaseDate: TODAY, schedules: [] });
      expect(allocation.kind).toBe('new');
      const scheduleId = await ensureSchedule(tx, {
        gymId, rootProductSetId: d.productSet.id, key: allocation.key, anchorDate: TODAY,
        cadenceInterval: 1, cadenceUnit: 'month',
      });
      await addProductSetService(tx, { gymId, productSetId: d.productSet.id, productId: locker, quantity: 1, startsAt: TODAY, scheduleId });
      return d.productSet;
    });
    const out = await db.transaction((tx) => materialiseScheduledEvents(tx, { gymId, productSetId: set.id, today: TODAY }));
    expect(out.created).toBeGreaterThan(0);
    const events = await scheduledEvents(set.id);
    expect(events.every((e: any) => e.schedule_id != null)).toBe(true);
  });
});

describe('activation replaces only obsolete future Scheduled events (#1325 PR 2b)', () => {
  it('supersedes v1, deletes its future events and generates v2\'s without duplicates', async () => {
    const owner = await member();
    const planId = await plan({ price: 40 });
    const v1 = await newVersion(owner, planId, TODAY, 40);
    const act1 = await db.transaction((tx) => activateWithEvents(tx, { gymId, productSetId: v1.id, today: TODAY }));
    expect(act1.kind).toBe('ok');
    const before = await scheduledEvents(v1.id);
    expect(before.length).toBeGreaterThan(0);

    // A past, already-paid obligation of v1 must survive the replacement.
    const paid = await db.query(
      `INSERT INTO billing_events (gym_id, member_id, event_type, source, amount, product_set_id, billing_date, is_scheduled)
       VALUES (?, ?, 'recurring_payment', 'system', 40, ?, ?, 0)`, [gymId, owner, v1.id, day(-30)]);

    const v2 = await newVersion(owner, planId, TODAY, 45);
    const act2 = await db.transaction((tx) => activateWithEvents(tx, { gymId, productSetId: v2.id, today: TODAY }));
    expect(act2.kind).toBe('ok');

    const { rows: st } = await db.query<{ status: string }>('SELECT status FROM product_sets WHERE id = ?', [v1.id]);
    expect(st[0].status).toBe('superseded');
    // v1 kept no future scheduled event; v2 owns them, one per schedule period.
    // An event due today is not a *future* obligation, so v1 keeps it; every
    // strictly later one is v1's no longer.
    const futureV1 = (await scheduledEvents(v1.id)).filter((e: any) => e.billing_date > TODAY);
    expect(futureV1.length).toBe(0);
    const v2Events = await scheduledEvents(v2.id);
    expect(v2Events.length).toBeGreaterThan(0);
    const periods = v2Events.map((e: any) => `${e.schedule_id}|${e.period_start}`);
    expect(new Set(periods).size).toBe(periods.length);
    // The protected, already-issued obligation is intact.
    const { rows: kept } = await db.query('SELECT id FROM billing_events WHERE id = ?', [paid.insertId]);
    expect(kept.length).toBe(1);
  });

  it('never deletes a scheduled event that already has a payment attempt', async () => {
    const owner = await member();
    const planId = await plan({ price: 30 });
    const v1 = await newVersion(owner, planId, TODAY, 30);
    await db.transaction((tx) => activateWithEvents(tx, { gymId, productSetId: v1.id, today: TODAY }));
    const events = await scheduledEvents(v1.id);
    const future = events.find((e: any) => e.billing_date > TODAY);
    expect(future).toBeDefined();
    await db.query(
      `INSERT INTO payment_requests (gym_id, member_id, amount, status, source, billing_event_id, attempt, provider_status)
       VALUES (?, ?, 30, 'pending', 'billing_run', ?, 1, 'PENDING')`, [gymId, owner, future.id]);

    const v2 = await newVersion(owner, planId, TODAY, 30);
    await db.transaction((tx) => activateWithEvents(tx, { gymId, productSetId: v2.id, today: TODAY }));
    const { rows } = await db.query('SELECT id FROM billing_events WHERE id = ?', [future.id]);
    expect(rows.length).toBe(1);
  });
});
