// #2125 M5c-3 — a billing schedule is the owner's (`(owner, periodicity)`,
// migration 396), not the Product Set chain's: an owner who starts a new chain
// keeps billing on the schedule they already had when it is the same schedule,
// a different one opens its own (the old one re-keyed, untouched), and the
// realign script folds schedules of one identity across the owner's chains.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym } from './helpers';
import { createDraft } from '../api/product-sets';
import { snapshotProductSetFromPlan } from '../api/product-set-configuration';
import { realignOwnerSchedules } from '../api/schedule-realignment';

let gymId: string;
const actor = { name: 'Test', type: 'staff' };
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const TODAY = new Date().toISOString().slice(0, 10);

async function member(): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'M', `owner-sched-${uniq()}@example.com`]);
  return Number(insertId);
}

async function plan(interval: number, unit: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '1')`, [gymId, `Owner-${uniq()}`]);
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, ?, ?)`, [gymId, insertId, interval, unit]);
  return Number(insertId);
}

/** A chain whose only version is a Draft with the plan frozen on it. */
async function chainWithPlan(memberId: number, planId: number): Promise<number> {
  return db.transaction(async (tx) => {
    const d = await createDraft(tx, { gymId, ownerMemberId: memberId, membershipPlanId: planId, startsAt: TODAY, actor });
    if (d.kind !== 'created') throw new Error(d.kind);
    await snapshotProductSetFromPlan(tx, {
      gymId, productSetId: d.productSet.id, membershipPlanId: planId, membershipFeePrice: 20, startsAt: TODAY });
    return d.productSet.id;
  });
}

/** Ends a chain: its version leaves the owner's in-flight slot, so a new chain may start. */
const finish = (setId: number) => db.query(`UPDATE product_sets SET status = 'superseded' WHERE id = ?`, [setId]);

async function schedulesOf(memberId: number) {
  const { rows } = await db.query<any>(
    `SELECT id, opened_by_product_set_id, schedule_key, cadence_interval, cadence_unit
       FROM product_set_schedules WHERE owner_member_id = ? ORDER BY id`, [memberId]);
  return rows.map((r: any) => ({
    id: Number(r.id), root: Number(r.opened_by_product_set_id), key: String(r.schedule_key),
    cadence: `${r.cadence_interval} ${r.cadence_unit}`,
  }));
}

async function planScheduleOf(setId: number): Promise<number | null> {
  const { rows } = await db.query<any>(
    `SELECT s.schedule_id FROM plan_snapshots s JOIN product_set_plan_snapshots psj ON psj.plan_snapshot_id = s.id
      WHERE psj.product_set_id = ?`, [setId]);
  return rows[0]?.schedule_id == null ? null : Number(rows[0].schedule_id);
}

beforeAll(async () => { gymId = await createTestGym('Schedule owner identity gym'); });
afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('a schedule is the owner\'s (#2125 M5c-3)', () => {
  it('records the owner, and one owner holds a key once', async () => {
    const memberId = await member();
    const setId = await chainWithPlan(memberId, await plan(1, 'month'));
    const [s] = await schedulesOf(memberId);
    expect(s).toMatchObject({ root: setId, key: 'plan', cadence: '1 month' });
    await expect(db.query(
      `INSERT INTO product_set_schedules (gym_id, opened_by_product_set_id, owner_member_id, schedule_key, anchor_date, cadence_interval, cadence_unit)
       VALUES (?, ?, ?, 'plan', ?, 1, 'month')`, [gymId, setId, memberId, TODAY])).rejects.toThrow();
  });

  it('a new chain of the owner bills on the schedule the owner already has when it is the same one', async () => {
    const memberId = await member();
    const monthly = await plan(1, 'month');
    const first = await chainWithPlan(memberId, monthly);
    const firstSchedule = await planScheduleOf(first);
    await finish(first);

    const second = await chainWithPlan(memberId, await plan(1, 'month'));
    expect(second).not.toBe(first);
    expect(await planScheduleOf(second)).toBe(firstSchedule);
    expect(await schedulesOf(memberId)).toHaveLength(1);
  });

  it('a new chain on another cadence opens its own, the old schedule re-keyed and left as it was', async () => {
    const memberId = await member();
    const first = await chainWithPlan(memberId, await plan(1, 'month'));
    const firstSchedule = await planScheduleOf(first);
    await finish(first);

    const second = await chainWithPlan(memberId, await plan(4, 'week'));
    const secondSchedule = await planScheduleOf(second);
    expect(secondSchedule).not.toBe(firstSchedule);
    expect(await schedulesOf(memberId)).toEqual([
      { id: firstSchedule, root: first, key: `plan-${firstSchedule}`, cadence: '1 month' },
      { id: secondSchedule, root: second, key: 'plan', cadence: '4 week' },
    ]);
    // The first chain's plan snapshot still bills on its own schedule.
    expect(await planScheduleOf(first)).toBe(firstSchedule);
  });

  it('the realign script consolidates schedules of one identity across the owner\'s chains', async () => {
    const memberId = await member();
    const first = await chainWithPlan(memberId, await plan(1, 'month'));
    await finish(first);
    const second = await chainWithPlan(memberId, await plan(4, 'week'));
    // A monthly Product line the second chain opened: one schedule with the first chain's (re-keyed) plan schedule.
    const { insertId: s1 } = await db.query(
      `INSERT INTO product_set_schedules (gym_id, opened_by_product_set_id, owner_member_id, schedule_key, anchor_date, cadence_interval, cadence_unit)
       VALUES (?, ?, ?, 's1', ?, 1, 'month')`, [gymId, second, memberId, `${TODAY.slice(0, 8)}01`]);
    const firstSchedule = await planScheduleOf(first);

    const result = await db.transaction((tx) => realignOwnerSchedules(tx, { gymId, ownerMemberId: memberId, today: TODAY }));
    expect(result.ownerMemberId).toBe(memberId);
    expect(result.consolidations).toEqual([
      expect.objectContaining({ targetScheduleId: firstSchedule, mergedScheduleId: Number(s1), removed: true, keptEvents: [] }),
    ]);
    expect((await schedulesOf(memberId)).map((s) => s.cadence).sort()).toEqual(['1 month', '4 week']);
  });
});
