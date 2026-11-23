// #2125 M6b-38: a Billing Event's assignment is read through its Product Sets' anchor,
// `product_sets.plan_assignment_id`, instead of `product_sets.user_membership_id`
// (`domain/billingEventOwnership.ts`). Each test makes the two columns disagree and asserts the
// Billing Events list (its `user_membership_id` filter and the derived `user_membership_id` it
// reports) follows the anchor.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { productSetLegacyAssignmentIdSql, productSetAssignmentSql } from '../domain/planAssignments';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request, setTestSetAssignmentLink } from './helpers';
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
    `SELECT id, ${productSetLegacyAssignmentIdSql('product_sets')} AS user_membership_id, ${productSetAssignmentSql('product_sets')} AS plan_assignment_id FROM product_sets WHERE gym_id = ? AND owner_member_id = ?`, [gymId, owner]);
  return rows.map((r: any) => ({
    id: Number(r.id),
    um: r.user_membership_id == null ? null : Number(r.user_membership_id),
    anchor: r.plan_assignment_id == null ? null : Number(r.plan_assignment_id),
  }));
}
async function restore(sets: Array<{ id: number; um: number | null; anchor: number | null }>): Promise<void> {
  for (const s of sets) {
    await setTestSetAssignmentLink(s.id, s.anchor);
  }
}
const listFor = (um: number) => auth(request.get(`/billing-events?user_membership_id=${um}&limit=200`));

beforeAll(async () => {
  gymId = await createTestGym('Event Owner Anchor Gym');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('a Billing Event\'s assignment is found through plan_assignment_id', () => {
  it('follows the anchor when the legacy link is cleared', async () => {
    const owner = await member();
    const um = await commit(owner, await plan(), 30);
    const before = await listFor(um);
    expect(before.status).toBe(200);
    expect(before.body.items.length).toBeGreaterThan(0);
    expect(before.body.items.every((e: any) => Number(e.user_membership_id) === um)).toBe(true);

    const sets = await setsOf(owner);
    expect(sets.some((s) => s.anchor != null)).toBe(true);
    try {
      const after = await listFor(um);
      expect(after.status).toBe(200);
      expect(after.body.items.map((e: any) => e.id)).toEqual(before.body.items.map((e: any) => e.id));
      expect(after.body.items.every((e: any) => Number(e.user_membership_id) === um)).toBe(true);
    } finally {
      await restore(sets);
    }
  });

  it('finds nothing once the anchor is cleared, whatever the legacy link says', async () => {
    const owner = await member();
    const um = await commit(owner, await plan(), 30);
    const sets = await setsOf(owner);
    for (const s of sets) await setTestSetAssignmentLink(s.id, null);
    try {
      const after = await listFor(um);
      expect(after.status).toBe(200);
      expect(after.body.items).toEqual([]);
      const byMember = await auth(request.get(`/billing-events?member_id=${owner}&limit=200`));
      expect(byMember.body.items.length).toBeGreaterThan(0);
      expect(byMember.body.items.every((e: any) => e.user_membership_id == null)).toBe(true);
    } finally {
      await restore(sets);
    }
  });
});
