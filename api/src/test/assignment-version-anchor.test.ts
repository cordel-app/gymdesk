// #2125 M6b-39: the version an assignment is read from (`assignmentVersionId()`, reported as
// `product_set_id` by `GET /user-memberships/:id`) is picked by the set's anchor,
// `product_sets.plan_assignment_id`, instead of `product_sets.user_membership_id`. Each test makes
// the two columns disagree and asserts the read follows the anchor.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { productSetLegacyAssignmentIdSql } from '../domain/planAssignments';
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


async function setsOf(owner: number): Promise<Array<{ id: number; um: number | null; anchor: number | null }>> {
  const { rows } = await db.query<any>(
    `SELECT id, ${productSetLegacyAssignmentIdSql('product_sets')} AS user_membership_id, plan_assignment_id FROM product_sets WHERE gym_id = ? AND owner_member_id = ?`, [gymId, owner]);
  return rows.map((r: any) => ({
    id: Number(r.id),
    um: r.user_membership_id == null ? null : Number(r.user_membership_id),
    anchor: r.plan_assignment_id == null ? null : Number(r.plan_assignment_id),
  }));
}
async function restore(sets: Array<{ id: number; um: number | null; anchor: number | null }>): Promise<void> {
  for (const s of sets) {
    await db.query('UPDATE product_sets SET plan_assignment_id = ? WHERE id = ?', [s.anchor, s.id]);
  }
}
const readOf = (um: number) => auth(request.get(`/user-memberships/${um}`));

beforeAll(async () => {
  gymId = await createTestGym('Version Anchor Gym');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('an assignment\'s version is found through plan_assignment_id', () => {
  it('follows the anchor when the legacy link is cleared', async () => {
    const owner = await member();
    const um = await commit(owner, await plan(), 30);
    const before = await readOf(um);
    expect(before.status).toBe(200);
    expect(before.body.product_set_id).not.toBeNull();

    const sets = await setsOf(owner);
    try {
      const after = await readOf(um);
      expect(after.status).toBe(200);
      expect(after.body.product_set_id).toBe(before.body.product_set_id);
    } finally {
      await restore(sets);
    }
  });

  it('finds no version once the anchor is cleared, whatever the legacy link says', async () => {
    const owner = await member();
    const um = await commit(owner, await plan(), 30);
    const sets = await setsOf(owner);
    await db.query('UPDATE product_sets SET plan_assignment_id = NULL WHERE gym_id = ? AND owner_member_id = ?', [gymId, owner]);
    try {
      const after = await readOf(um);
      expect(after.status).toBe(200);
      expect(after.body.product_set_id).toBeNull();
    } finally {
      await restore(sets);
    }
  });
});
