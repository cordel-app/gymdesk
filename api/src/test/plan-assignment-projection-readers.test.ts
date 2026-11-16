// #2125 M6b-28: two more readers take an assignment from its current plan snapshot instead of the
// `user_memberships` row. The projection clamps a superseded predecessor's end date to the
// predecessor's start date (`projectActiveProductSet()`), and the Member card's Product Sets list
// reports the end date of the assignment each version projects (`GET
// /user-memberships/member/:id/configuration`). Each test makes the snapshot and the legacy row
// disagree and asserts the reader follows the snapshot.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request,
} from './helpers';
import { addCoverage, createDraft } from '../api/product-sets';
import { activateWithEvents, snapshotProductSetFromPlan } from '../api/product-set-configuration';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const actor = { name: 'T', type: 'staff' };
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const dateOnly = (v: unknown) => (v == null ? null : (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10));

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Projection Reader', `pjr-${uniq()}@example.com`]);
  return Number(insertId);
}
async function plan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 1)`, [gymId, `PJR Plan ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 30, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}
/** Commits a version of `planId` for `owner` and answers the assignment it projects. */
async function commit(owner: number, planId: number, fee: number): Promise<number> {
  const setId = await db.transaction(async (tx) => {
    const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: planId, startsAt: TODAY, actor });
    if (d.kind !== 'created') throw new Error(d.kind);
    await snapshotProductSetFromPlan(tx, { gymId, productSetId: d.productSet.id, membershipPlanId: planId, membershipFeePrice: fee, startsAt: TODAY });
    await addCoverage(tx, { gymId, productSetId: d.productSet.id, memberId: owner, isOwner: true });
    const out = await activateWithEvents(tx, { gymId, productSetId: d.productSet.id, today: TODAY });
    if (out.kind !== 'ok') throw new Error(out.kind);
    return d.productSet.id;
  });
  const { rows } = await db.query<any>('SELECT user_membership_id FROM product_sets WHERE id = ?', [setId]);
  return Number(rows[0].user_membership_id);
}

const setLegacy = (um: number, column: string, value: string) =>
  db.query(`UPDATE user_memberships SET ${column} = ? WHERE id = ?`, [value, um]);
const setSnapshots = (um: number, column: string, value: string) =>
  db.query(`UPDATE plan_snapshots SET ${column} = ? WHERE gym_id = ? AND source_user_membership_id = ?`, [value, gymId, um]);

beforeAll(async () => {
  gymId = await createTestGym('Projection Readers Gym');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('a superseded same-plan predecessor is clamped to its plan snapshot\'s start date', () => {
  it('ends on the snapshot\'s start, not on the legacy row\'s', async () => {
    const owner = await member();
    const p = await plan();
    const first = await commit(owner, p, 30);
    // The day before today would be the end date; the clamp moves it to the predecessor's start,
    // today. Activating the successor re-syncs the predecessor's snapshot dates before the
    // projection reads them, so the disagreement is made on the legacy row: read from it, the
    // clamp would end the predecessor in 2099.
    await setLegacy(first, 'starts_at', '2099-01-01');
    const second = await commit(owner, p, 35);
    expect(second).not.toBe(first);
    const { rows: snap } = await db.query<any>(
      'SELECT MIN(starts_at) AS starts_at FROM plan_snapshots WHERE gym_id = ? AND source_user_membership_id = ?', [gymId, first]);
    expect(dateOnly(snap[0].starts_at)).toBe(TODAY);
    const { rows } = await db.query<any>('SELECT status, ends_at FROM user_memberships WHERE id = ?', [first]);
    expect(rows[0].status).toBe('superseded');
    expect(dateOnly(rows[0].ends_at)).toBe(TODAY);
  });
});

describe('the Member card\'s Product Sets report the plan snapshot\'s end date', () => {
  it('reports the snapshot\'s end date, not the legacy row\'s', async () => {
    const owner = await member();
    const um = await commit(owner, await plan(), 30);
    await setSnapshots(um, 'ends_at', '2099-02-01');
    await setLegacy(um, 'ends_at', '2098-01-01');
    const res = await auth(request.get(`/user-memberships/member/${owner}/configuration`));
    expect(res.status).toBe(200);
    expect(res.body.current_product_set?.ends_at).toBe('2099-02-01');
  });
});
