// #2125 M5c (Oscar, 2026-11-11, Option B) — existing schedules move onto the
// billing calendar (monthly on the 1st). The not-yet-attempted future events are
// regenerated on the new dates; an attempted one, past events and payment
// history are kept as they are; nothing is prorated or duplicated; a chain with
// two monthly schedules keeps both (consolidation is the re-keying's) and is
// reported; a second run changes nothing.

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

  it('moves two monthly schedules of one chain and reports them for consolidation', async () => {
    const { setId, memberId } = await legacyChain();
    const otherAnchor = day(-20).endsWith('-01') ? day(-21) : day(-20);
    const { insertId: s1 } = await db.query(
      `INSERT INTO product_set_schedules (gym_id, root_product_set_id, schedule_key, anchor_date, cadence_interval, cadence_unit)
       VALUES (?, ?, 's1', ?, 1, 'month')`, [gymId, setId, otherAnchor]);
    const { insertId: orphan } = await db.query(
      `INSERT INTO billing_events (gym_id, member_id, event_type, source, amount, product_set_id, schedule_id,
          period_start, billing_date, is_scheduled, created_by)
       VALUES (?, ?, 'charge_created', 'system', 10, ?, ?, ?, ?, 1, 'System')`,
      [gymId, memberId, setId, s1, day(10), day(10)]);

    const result = await realign(setId);
    expect(result.sameCadenceSchedules).toBe(true);
    expect(result.schedules.map((s) => s.to).sort()).toEqual([`${otherAnchor.slice(0, 8)}01`, `${START.slice(0, 8)}01`].sort());
    const { rows } = await db.query('SELECT id FROM billing_events WHERE id = ?', [orphan]);
    expect(rows).toHaveLength(0);
  });
});
