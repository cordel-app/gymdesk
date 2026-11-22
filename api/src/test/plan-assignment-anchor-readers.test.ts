// #2125 M6b-37: the readers that join a Product Set to its assignment's current plan snapshot find
// that snapshot through the set's own anchor, `product_sets.plan_assignment_id` (M6b-36), instead of
// through `product_sets.user_membership_id`, so the old column can be dropped. Each test makes the
// two columns disagree (the anchor cleared, the legacy id left) and asserts the reader follows the
// anchor: the Member card's Product Sets list (end date) and the cancellation preview (start date).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { productSetOfLegacyAssignmentSql, productSetLegacyAssignmentIdSql } from '../domain/planAssignments';
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
    [gymId, 'Anchor Reader', `anchor-${uniq()}@example.com`]);
  return Number(insertId);
}
async function plan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 1)`, [gymId, `ANC Plan ${uniq()}`]);
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
  const { rows } = await db.query<any>(`SELECT ${productSetLegacyAssignmentIdSql('product_sets')} AS user_membership_id FROM product_sets WHERE id = ?`, [setId]);
  return Number(rows[0].user_membership_id);
}

const setSnapshots = (um: number, column: string, value: string) =>
  db.query(`UPDATE plan_snapshots SET ${column} = ? WHERE gym_id = ? AND assignment_id = ?`, [value, gymId, um]);

const setAnchor = (setId: number, value: number | null) =>
  db.query('UPDATE product_sets SET plan_assignment_id = ? WHERE id = ?', [value, setId]);
const activeSetOf = async (um: number): Promise<{ id: number; anchor: number | null }> => {
  const { rows } = await db.query<any>(
    `SELECT id, plan_assignment_id FROM product_sets WHERE gym_id = ? AND ${productSetOfLegacyAssignmentSql('?', 'product_sets')} AND status = 'active'`, [gymId, um]);
  return { id: Number(rows[0].id), anchor: rows[0].plan_assignment_id == null ? null : Number(rows[0].plan_assignment_id) };
};

beforeAll(async () => {
  gymId = await createTestGym('Anchor Readers Gym');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('the Member card\'s Product Sets find the assignment through plan_assignment_id', () => {
  it('reports the end date of the snapshot the anchor names, and none once the anchor is cleared', async () => {
    const owner = await member();
    const um = await commit(owner, await plan(), 30);
    await setSnapshots(um, 'ends_at', '2099-02-01');
    const set = await activeSetOf(um);
    expect(set.anchor).not.toBeNull();

    const before = await auth(request.get(`/user-memberships/member/${owner}/configuration`));
    expect(before.status).toBe(200);
    expect(before.body.current_product_set?.ends_at).toBe('2099-02-01');

    // The legacy id still names the assignment; read through it, the end date would not move.
    await setAnchor(set.id, null);
    const after = await auth(request.get(`/user-memberships/member/${owner}/configuration`));
    expect(after.status).toBe(200);
    expect(after.body.current_product_set?.ends_at ?? null).toBeNull();
    await setAnchor(set.id, set.anchor);
  });
});

describe('the cancellation preview takes the assignment\'s start date through plan_assignment_id', () => {
  it('floors the end date at the start of the snapshot the anchor names', async () => {
    const owner = await member();
    const um = await commit(owner, await plan(), 30);
    // Nothing paid: the end date is yesterday, floored at the assignment's start.
    await setSnapshots(um, 'starts_at', '2099-01-01');
    const set = await activeSetOf(um);

    const before = await auth(request.get(`/user-memberships/${um}/cancellation-preview`));
    expect(before.status).toBe(200);
    expect(before.body.ends_on).toBe('2099-01-01');

    // With the anchor cleared the assignment's start is not found and the set's own (today) applies.
    await setAnchor(set.id, null);
    const after = await auth(request.get(`/user-memberships/${um}/cancellation-preview`));
    expect(after.status).toBe(200);
    expect(after.body.ends_on).not.toBe('2099-01-01');
    await setAnchor(set.id, set.anchor);
  });
});
