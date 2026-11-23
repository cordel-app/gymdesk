// #2125 N3a (migration 463): a payment request names its plan assignment by one column,
// `anchor_plan_snapshot_id`; `user_membership_id` and `plan_assignment_id` are gone.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ANCHOR_PLAN_SNAPSHOT_VALUE_SQL, productSetLegacyAssignmentIdSql } from '../domain/planAssignments';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym } from './helpers';
import { createDraft, addCoverage } from '../api/product-sets';
import { activateWithEvents, snapshotProductSetFromPlan } from '../api/product-set-configuration';
import { recordPaymentAttempt } from '../api/payment-attempt';
import { findPlanAssignmentDrift } from '../api/plan-assignment-drift';

let gymId: string;
let planId: number;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const actor = { name: 'T', type: 'staff' };

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'M', `pr-rekey-${uniq()}@example.com`]);
  return Number(insertId);
}
/** Commits a first version for `owner`, returning its set id and the assignment it projects. */
async function commit(owner: number): Promise<{ setId: number; um: number }> {
  const setId = await db.transaction(async (tx) => {
    const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: planId, startsAt: TODAY, actor });
    if (d.kind !== 'created') throw new Error(d.kind);
    await snapshotProductSetFromPlan(tx, { gymId, productSetId: d.productSet.id, membershipPlanId: planId, membershipFeePrice: 30, startsAt: TODAY });
    await addCoverage(tx, { gymId, productSetId: d.productSet.id, memberId: owner, isOwner: true });
    const out = await activateWithEvents(tx, { gymId, productSetId: d.productSet.id, today: TODAY });
    if (out.kind !== 'ok') throw new Error(out.kind);
    return d.productSet.id;
  });
  const { rows } = await db.query<any>(`SELECT ${productSetLegacyAssignmentIdSql('product_sets')} AS user_membership_id FROM product_sets WHERE id = ?`, [setId]);
  return { setId, um: Number(rows[0].user_membership_id) };
}
/** Raises a payment request the way every writer does: INSERT through the anchor value, then the attempt. */
async function raise(memberId: number, um: number | null): Promise<number> {
  return db.transaction(async (tx) => {
    const { insertId } = await tx.query(
      `INSERT INTO payment_requests
         (gym_id, anchor_plan_snapshot_id, member_id, amount, currency, status, provider, provider_order, source, attempt, method)
       VALUES (?, ${ANCHOR_PLAN_SNAPSHOT_VALUE_SQL}, ?, '30.00', 'EUR', 'pending', 'monei', ?, 'customer', 1, 'provider')`,
      [gymId, um, gymId, memberId, `prk-${uniq()}`]);
    await recordPaymentAttempt(tx, Number(insertId));
    return Number(insertId);
  });
}
async function keyOf(id: number): Promise<number | null> {
  const { rows } = await db.query<any>('SELECT anchor_plan_snapshot_id FROM payment_requests WHERE id = ?', [id]);
  return rows[0].anchor_plan_snapshot_id == null ? null : Number(rows[0].anchor_plan_snapshot_id);
}
async function requestDrift() {
  const report = await findPlanAssignmentDrift(db as any, gymId);
  return report.checks.find((c) => c.name === 'payment_request_assignment_mismatch')!;
}

beforeAll(async () => {
  gymId = await createTestGym('Payment request anchor gym');
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '1')`, [gymId, `PrAnchor-${uniq()}`]);
  planId = Number(insertId);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, 30, '2020-01-01', 'active')`, [gymId, planId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, planId]);
});
afterAll(async () => {
  await db.query('DELETE FROM payment_requests WHERE gym_id = ?', [gymId]);
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('#2125 N3a: a payment request names its assignment by anchor_plan_snapshot_id alone', () => {
  it('the legacy columns are gone', async () => {
    const { rows } = await db.query<any>(
      `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_requests'
          AND COLUMN_NAME IN ('user_membership_id', 'plan_assignment_id', 'anchor_plan_snapshot_id')`);
    expect(rows.map((r: any) => r.c)).toEqual(['anchor_plan_snapshot_id']);
  });

  it('a request raised for an assignment names its anchor, which is the assignment id', async () => {
    const owner = await member();
    const { um } = await commit(owner);
    const id = await raise(owner, um);
    expect(await keyOf(id)).toBe(um);
    const { rows } = await db.query<any>('SELECT assignment_id FROM plan_snapshots WHERE id = ?', [um]);
    expect(Number(rows[0].assignment_id)).toBe(um);
  });

  it('a request that names no assignment, or an id that is no anchor of the gym, names none', async () => {
    const owner = await member();
    expect(await keyOf(await raise(owner, null))).toBeNull();
    const { rows } = await db.query<any>('SELECT COALESCE(MAX(id), 0) + 1000 AS n FROM plan_snapshots');
    expect(await keyOf(await raise(owner, Number(rows[0].n)))).toBeNull();
  });

  it('plan-assignments:validate reports a request pointing at a snapshot that is no anchor', async () => {
    expect((await requestDrift()).count).toBe(0);
    const owner = await member();
    const { um } = await commit(owner);
    const id = await raise(owner, um);
    await db.query('UPDATE plan_snapshots SET assignment_id = NULL WHERE id = ?', [um]);
    try {
      const drift = await requestDrift();
      expect(drift.sample.map((r: any) => [Number(r.payment_request_id), Number(r.anchor_plan_snapshot_id)]))
        .toEqual([[id, um]]);
    } finally {
      await db.query('UPDATE plan_snapshots SET assignment_id = id WHERE id = ?', [um]);
    }
    expect((await requestDrift()).count).toBe(0);
  });
});
