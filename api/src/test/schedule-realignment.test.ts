// #2125 M5c (Oscar, 2026-11-11, Option B) — existing schedules move onto the
// billing calendar (monthly on the 1st). The not-yet-attempted future events are
// regenerated on the new dates; an attempted one, past events and payment
// history are kept as they are; nothing is prorated or duplicated; a second run
// changes nothing. #2125 M5c-2: a chain's schedules of one cadence are
// consolidated into one — events moved, colliding untouched obligations
// regenerated once, past or attempted collisions kept and reported — and a plan
// joining a chain adopts a schedule of its own cadence rather than opening one.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym } from './helpers';
import { createDraft } from '../api/product-sets';
import { activateWithEvents, snapshotProductSetFromPlan } from '../api/product-set-configuration';
import { realignChainSchedules } from '../api/schedule-realignment';

let gymId: string;
const actor = { name: 'Test', type: 'staff' };
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const day = (offset: number) => {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10);
};
const TODAY = day(0);
// A start well in the past and never on the 1st, so its legacy anchor is off the grid.
const START = day(-40).endsWith('-01') ? day(-41) : day(-40);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

async function legacyChain() {
  const { insertId: memberId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'M', `realign-${uniq()}@example.com`]);
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', NULL, NULL, 0, 0)`, [gymId, `Realign-${uniq()}`]);
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, 31, ?, 'active')`, [gymId, planId, day(-365)]);
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`, [gymId, planId]);

  const setId = await db.transaction(async (tx) => {
    const d = await createDraft(tx, { gymId, ownerMemberId: memberId, membershipPlanId: planId, startsAt: START, actor });
    if (d.kind !== 'created') throw new Error(d.kind);
    await snapshotProductSetFromPlan(tx, { gymId, productSetId: d.productSet.id, membershipPlanId: planId, membershipFeePrice: 31, startsAt: START });
    return d.productSet.id;
  });
  // What a schedule created before M5c looks like: anchored on the plan's own start date.
  await db.query('UPDATE product_set_schedules SET anchor_date = ? WHERE root_product_set_id = ?', [START, setId]);
  const act = await db.transaction((tx) => activateWithEvents(tx, { gymId, productSetId: setId, today: TODAY }));
  expect(act.kind).toBe('ok');
  return { setId, memberId };
}

async function events(setId: number) {
  const { rows } = await db.query<any>(
    `SELECT be.id, be.schedule_id, be.billing_date, be.amount,
            (SELECT COUNT(*) FROM payment_requests pr WHERE pr.billing_event_id = be.id) AS attempts
       FROM billing_events be WHERE be.product_set_id = ? AND be.is_scheduled = 1 ORDER BY be.billing_date, be.id`, [setId]);
  return rows.map((r: any) => ({ ...r, billing_date: iso(r.billing_date), attempts: Number(r.attempts) }));
}

async function attempt(eventId: number, memberId: number) {
  await db.query(
    `INSERT INTO payment_requests
       (gym_id, member_id, amount, currency, charge_type_id, billing_event_id, status, provider, provider_order,
        source, created_at, failure_code, failure_message)
     VALUES (?, ?, '31.00', 'EUR', NULL, ?, 'failed', 'monei', UUID(), 'billing_run', UTC_TIMESTAMP(), 'E999', 'declined')`,
    [gymId, memberId, eventId]);
}

const realign = (rootProductSetId: number) =>
  db.transaction((tx) => realignChainSchedules(tx, { gymId, rootProductSetId, today: TODAY }));

beforeAll(async () => { gymId = await createTestGym('Schedule realignment gym'); });
afterAll(async () => {
  await db.query('DELETE FROM payment_requests WHERE gym_id = ?', [gymId]);
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('realigning an existing monthly schedule onto the 1st (#2125 M5c)', () => {
  it('regenerates untouched future events on the 1st and keeps an attempted one', async () => {
    const { setId, memberId } = await legacyChain();
    const before = await events(setId);
    const future = before.filter((e) => e.billing_date > TODAY);
    expect(future.length).toBeGreaterThan(0);
    expect(future.every((e) => !e.billing_date.endsWith('-01'))).toBe(true);
    const attempted = future[0];
    await attempt(attempted.id, memberId);
    const pastOrToday = before.filter((e) => e.billing_date <= TODAY);

    const result = await realign(setId);
    expect(result.schedules).toHaveLength(1);
    expect(result.schedules[0]).toMatchObject({ from: START, to: `${START.slice(0, 8)}01`, keptAttempted: [attempted.id] });
    expect(result.schedules[0].deletedEvents).toBe(future.length - 1);
    expect(result.createdEvents).toBeGreaterThan(0);

    const { rows: sch } = await db.query<any>('SELECT anchor_date FROM product_set_schedules WHERE root_product_set_id = ?', [setId]);
    expect(iso(sch[0].anchor_date)).toBe(`${START.slice(0, 8)}01`);

    const after = await events(setId);
    // The attempted event and everything up to today are exactly as they were.
    expect(after.find((e) => e.id === attempted.id)).toMatchObject({ billing_date: attempted.billing_date, attempts: 1 });
    for (const e of pastOrToday) expect(after.find((a) => a.id === e.id)).toMatchObject({ billing_date: e.billing_date });
    // Every regenerated obligation is on the 1st, at the full fee (no transition proration), with no duplicate date.
    const regenerated = after.filter((e) => e.billing_date > TODAY && e.id !== attempted.id);
    expect(regenerated.length).toBeGreaterThan(0);
    for (const e of regenerated) {
      expect(e.billing_date.endsWith('-01')).toBe(true);
      expect(Number(e.amount)).toBe(31);
    }
    expect(new Set(regenerated.map((e) => e.billing_date)).size).toBe(regenerated.length);
    const { rows: pr } = await db.query<any>(
      'SELECT COUNT(*) AS n FROM payment_requests WHERE billing_event_id IN (SELECT id FROM billing_events WHERE product_set_id = ?)', [setId]);
    expect(Number(pr[0].n)).toBe(1);

    // Idempotent: a second run finds the anchor on its grid and changes nothing.
    const again = await realign(setId);
    expect(again.schedules).toHaveLength(0);
    expect(await events(setId)).toEqual(after);
  });

  it('moves two monthly schedules of one chain and consolidates them into one (#2125 M5c-2)', async () => {
    const { setId, memberId } = await legacyChain();
    const otherAnchor = day(-20).endsWith('-01') ? day(-21) : day(-20);
    const { insertId: s1 } = await db.query(
      `INSERT INTO product_set_schedules (gym_id, root_product_set_id, owner_member_id, schedule_key, anchor_date, cadence_interval, cadence_unit)
       SELECT ?, ?, owner_member_id, 's1', ?, 1, 'month' FROM product_sets WHERE id = ?`, [gymId, setId, otherAnchor, setId]);
    const { insertId: orphan } = await db.query(
      `INSERT INTO billing_events (gym_id, member_id, event_type, source, amount, product_set_id, schedule_id,
          period_start, billing_date, is_scheduled, created_by)
       VALUES (?, ?, 'charge_created', 'system', 10, ?, ?, ?, ?, 1, 'System')`,
      [gymId, memberId, setId, s1, day(10), day(10)]);

    const result = await realign(setId);
    expect(result.schedules.map((s) => s.to).sort()).toEqual([`${otherAnchor.slice(0, 8)}01`, `${START.slice(0, 8)}01`].sort());
    const { rows } = await db.query('SELECT id FROM billing_events WHERE id = ?', [orphan]);
    expect(rows).toHaveLength(0);
    expect(result.consolidations).toEqual([expect.objectContaining({ mergedScheduleId: s1, removed: true, keptEvents: [] })]);
    const { rows: left } = await db.query<any>('SELECT schedule_key FROM product_set_schedules WHERE root_product_set_id = ?', [setId]);
    expect(left.map((r: any) => r.schedule_key)).toEqual(['plan']);
  });
});

describe('consolidating schedules of one cadence (#2125 M5c-2)', () => {
  async function insertEvent(setId: number, memberId: number, scheduleId: number, date: string, amount = 10) {
    const { insertId } = await db.query(
      `INSERT INTO billing_events (gym_id, member_id, event_type, source, amount, product_set_id, schedule_id,
          period_start, billing_date, is_scheduled, created_by)
       VALUES (?, ?, 'charge_created', 'system', ?, ?, ?, ?, ?, 1, 'System')`,
      [gymId, memberId, amount, setId, scheduleId, date, date]);
    return Number(insertId);
  }

  it('moves, regenerates or keeps each event of the merged schedule and moves its lines', async () => {
    const { setId, memberId } = await legacyChain();
    await realign(setId); // the plan schedule is now on the 1st, its future obligations regenerated
    const { rows: planRows } = await db.query<any>(
      `SELECT id FROM product_set_schedules WHERE root_product_set_id = ? AND schedule_key = 'plan'`, [setId]);
    const plan = Number(planRows[0].id);
    const planFuture = (await events(setId)).filter((e) => e.schedule_id === plan && e.billing_date > TODAY);
    expect(planFuture.length).toBeGreaterThanOrEqual(2);
    const [d1, d2] = [planFuture[0].billing_date, planFuture[1].billing_date];
    const past = day(-30);
    const planPast = await insertEvent(setId, memberId, plan, past, 31);

    // A second monthly schedule on the same grid, with one event of each kind.
    const { insertId: s1 } = await db.query(
      `INSERT INTO product_set_schedules (gym_id, root_product_set_id, owner_member_id, schedule_key, anchor_date, cadence_interval, cadence_unit)
       SELECT ?, ?, owner_member_id, 's1', ?, 1, 'month' FROM product_sets WHERE id = ?`, [gymId, setId, `${START.slice(0, 8)}01`, setId]);
    const pastCollision = await insertEvent(setId, memberId, s1, past);
    const regen = await insertEvent(setId, memberId, s1, d1);
    const attemptedCollision = await insertEvent(setId, memberId, s1, d2);
    await attempt(attemptedCollision, memberId);
    const moved = await insertEvent(setId, memberId, s1, day(50));
    // The plan snapshot bills on the merged schedule: it moves with it.
    await db.query(
      `UPDATE plan_snapshots SET schedule_id = ? WHERE id IN
         (SELECT plan_snapshot_id FROM product_set_plan_snapshots WHERE product_set_id = ?)`, [s1, setId]);

    const result = await realign(setId);
    expect(result.consolidations).toEqual([{
      targetScheduleId: plan, mergedScheduleId: s1,
      repointedEvents: 1, regeneratedEvents: 1, keptEvents: [pastCollision, attemptedCollision], removed: false,
    }]);

    const after = await events(setId);
    // Moved unchanged; kept on its own schedule; the plan's past event untouched.
    expect(after.find((e) => e.id === moved)).toMatchObject({ schedule_id: plan, billing_date: day(50) });
    expect(after.find((e) => e.id === pastCollision)).toMatchObject({ schedule_id: s1 });
    expect(after.find((e) => e.id === attemptedCollision)).toMatchObject({ schedule_id: s1, attempts: 1 });
    expect(after.find((e) => e.id === planPast)).toMatchObject({ schedule_id: plan, billing_date: past });
    // The colliding untouched obligation is gone and its date exists once, regenerated on the plan schedule.
    expect(after.find((e) => e.id === regen)).toBeUndefined();
    expect(after.filter((e) => e.billing_date === d1 && e.schedule_id === plan)).toHaveLength(1);
    expect(after.filter((e) => e.billing_date === d1)).toHaveLength(1);
    const { rows: snap } = await db.query<any>(
      `SELECT s.schedule_id FROM plan_snapshots s JOIN product_set_plan_snapshots psj ON psj.plan_snapshot_id = s.id
        WHERE psj.product_set_id = ?`, [setId]);
    expect(snap.map((r: any) => Number(r.schedule_id))).toEqual([plan]);
    const { rows: pr } = await db.query<any>(
      'SELECT COUNT(*) AS n FROM payment_requests WHERE billing_event_id IN (SELECT id FROM billing_events WHERE product_set_id = ?)', [setId]);
    expect(Number(pr[0].n)).toBe(1);

    // Idempotent: the kept schedule is reported again and nothing changes.
    const again = await realign(setId);
    expect(again.consolidations).toEqual([expect.objectContaining({
      repointedEvents: 0, regeneratedEvents: 0, keptEvents: [pastCollision, attemptedCollision], removed: false,
    })]);
    expect(await events(setId)).toEqual(after);
  });

  it('a plan joining a chain adopts the monthly schedule it already bills on', async () => {
    const { insertId: memberId } = await db.query(
      'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'M', `adopt-${uniq()}@example.com`]);
    const { insertId: planId } = await db.query(
      `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
       VALUES (?, ?, 'active', 'public', '1')`, [gymId, `Adopt-${uniq()}`]);
    await db.query(
      `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
       VALUES (?, ?, 1, 'month')`, [gymId, planId]);
    const setId = await db.transaction(async (tx) => {
      const d = await createDraft(tx, { gymId, ownerMemberId: memberId, membershipPlanId: null, startsAt: TODAY, actor });
      if (d.kind !== 'created') throw new Error(d.kind);
      return d.productSet.id;
    });
    const { insertId: s1 } = await db.query(
      `INSERT INTO product_set_schedules (gym_id, root_product_set_id, owner_member_id, schedule_key, anchor_date, cadence_interval, cadence_unit)
       SELECT ?, ?, owner_member_id, 's1', ?, 1, 'month' FROM product_sets WHERE id = ?`, [gymId, setId, `${day(-60).slice(0, 8)}01`, setId]);
    await db.transaction((tx) => snapshotProductSetFromPlan(tx, {
      gymId, productSetId: setId, membershipPlanId: planId, membershipFeePrice: 20, startsAt: TODAY }));

    const { rows } = await db.query<any>('SELECT id, schedule_key FROM product_set_schedules WHERE root_product_set_id = ?', [setId]);
    expect(rows.map((r: any) => [Number(r.id), r.schedule_key])).toEqual([[s1, 'plan']]);
  });
});
