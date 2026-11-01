import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym } from './helpers';
import { createDraft, addCoverage } from '../api/product-sets';
import { activateWithEvents, snapshotProductSetFromPlan } from '../api/product-set-configuration';
import { ensureRecurringDraft } from '../api/recurring-purchase-draft';
import { addPlanSnapshotToVersion } from '../api/plan-snapshot-add';

// #2125 stage 9 — a version holds a second Membership Plan: it survives sync and cloning, and
// activating the version bills both plans, so adding one never ends the first plan's billing.

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const day = (offset: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
const TODAY = day(0);
const actor = { name: 'T', type: 'staff' };

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'M', `add2-${uniq()}@example.com`]);
  return insertId;
}
async function plan(price: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '2')`, [gymId, `Add2-${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, ?, '2020-01-01', 'active')`, [gymId, insertId, price]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}
async function activeVersion(owner: number, planId: number, fee: number): Promise<number> {
  return db.transaction(async (tx) => {
    const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: planId, startsAt: TODAY, actor });
    if (d.kind !== 'created') throw new Error(d.kind);
    await snapshotProductSetFromPlan(tx, { gymId, productSetId: d.productSet.id, membershipPlanId: planId, membershipFeePrice: fee, startsAt: TODAY });
    await addCoverage(tx, { gymId, rootProductSetId: Number(d.productSet.root_product_set_id), memberId: owner, isOwner: true });
    const out = await activateWithEvents(tx, { gymId, productSetId: d.productSet.id, today: TODAY });
    if (out.kind !== 'ok') throw new Error(out.kind);
    return d.productSet.id;
  });
}
const feeLines = async (setId: number) => {
  const { rows } = await db.query<any>(
    `SELECT be.billing_date, bl.regular_unit_price AS price, bl.amount, bl.prorated_days
       FROM billing_events be JOIN billing_event_lines bl ON bl.billing_event_id = be.id
      WHERE be.product_set_id = ? AND be.is_scheduled = 1 AND bl.kind = 'membership_fee'
      ORDER BY be.billing_date, bl.regular_unit_price DESC`, [setId]);
  return rows.map((r: any) => ({ date: (r.billing_date instanceof Date ? r.billing_date.toISOString() : String(r.billing_date)).slice(0, 10), price: Number(r.price), amount: Number(r.amount), prorated: r.prorated_days }));
};

beforeAll(async () => { gymId = await createTestGym('Add second plan gym'); });
afterAll(async () => { await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]); await cleanupTestGyms(); await db.end(); });

describe('adding a second Membership Plan to an active version', () => {
  it('keeps the first plan billing and bills the second beside it', async () => {
    const owner = await member();
    const first = await plan(50);
    const second = await plan(30);
    const v1 = await activeVersion(owner, first, 50);
    const before = await feeLines(v1);
    expect(before.length).toBeGreaterThan(0);

    const v2 = await db.transaction(async (tx) => {
      const out = await ensureRecurringDraft(tx, { gymId, memberId: owner, actor, today: TODAY });
      if (out.kind !== 'ok') throw new Error(out.kind);
      await addPlanSnapshotToVersion(tx, {
        gymId, productSetId: out.productSetId, memberId: owner, membershipPlanId: second,
        membershipFeePrice: 30, startsAt: day(10),
      });
      const act = await activateWithEvents(tx, { gymId, productSetId: out.productSetId, today: TODAY });
      if (act.kind !== 'ok') throw new Error(act.kind);
      return out.productSetId;
    });

    const { rows: snaps } = await db.query<any>(
      'SELECT membership_plan_id, is_inherited, status FROM plan_snapshots WHERE product_set_id = ? ORDER BY id', [v2]);
    expect(snaps.map((s: any) => [Number(s.membership_plan_id), s.is_inherited, s.status]))
      .toEqual([[first, 1, 'active'], [second, 0, 'active']]);

    const after = await feeLines(v2);
    // The first plan keeps billing on exactly the dates it had: what was due today stays with the
    // superseded version (never deleted, never duplicated) and the rest is regenerated by the new one.
    const kept = (await feeLines(v1)).filter((l) => l.price === 50).map((l) => l.date);
    const regenerated = after.filter((l) => l.price === 50).map((l) => l.date);
    expect([...kept, ...regenerated].sort()).toEqual(before.map((l) => l.date));
    expect(kept.filter((d) => regenerated.includes(d))).toEqual([]);
    // The second one bills too: a prorated first stretch on its start, then the shared schedule.
    const secondLines = after.filter((l) => l.price === 30);
    expect(secondLines.length).toBeGreaterThan(0);
    expect(secondLines[0].date).toBe(day(10));
    expect(secondLines[0].prorated).toBeTruthy();
  });

  it('a native snapshot survives a re-sync and a further clone', async () => {
    const owner = await member();
    const first = await plan(40);
    const second = await plan(20);
    await activeVersion(owner, first, 40);
    const v2 = await db.transaction(async (tx) => {
      const out = await ensureRecurringDraft(tx, { gymId, memberId: owner, actor, today: TODAY });
      if (out.kind !== 'ok') throw new Error(out.kind);
      await addPlanSnapshotToVersion(tx, { gymId, productSetId: out.productSetId, memberId: owner, membershipPlanId: second, membershipFeePrice: 20, startsAt: TODAY });
      const act = await activateWithEvents(tx, { gymId, productSetId: out.productSetId, today: TODAY });
      if (act.kind !== 'ok') throw new Error(act.kind);
      return out.productSetId;
    });
    const v3 = await db.transaction(async (tx) => {
      const out = await ensureRecurringDraft(tx, { gymId, memberId: owner, actor, today: TODAY });
      if (out.kind !== 'ok') throw new Error(out.kind);
      return out.productSetId;
    });
    const { rows } = await db.query<any>(
      'SELECT membership_plan_id, is_inherited FROM plan_snapshots WHERE product_set_id = ? ORDER BY id', [v3]);
    expect(rows.map((r: any) => [Number(r.membership_plan_id), r.is_inherited])).toEqual([[first, 1], [second, 1]]);
    expect(v3).not.toBe(v2);
  });
});
