import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym } from './helpers';
import { createDraft, addCoverage } from '../api/product-sets';
import { activateWithEvents, snapshotProductSetFromPlan } from '../api/product-set-configuration';
import { recordPaymentAttempt } from '../api/payment-attempt';
import { syncPlanAssignment } from '../api/plan-assignment-sync';
import { findPlanAssignmentDrift } from '../api/plan-assignment-drift';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { backfillPaymentRequestAssignmentIds } = require('../infra/migrations/431_payment_request_plan_assignment_id.js');

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
  const { rows } = await db.query<any>('SELECT user_membership_id FROM product_sets WHERE id = ?', [setId]);
  return { setId, um: Number(rows[0].user_membership_id) };
}
/** Raises a payment request the way every writer does: INSERT, then `recordPaymentAttempt()`. */
async function raise(memberId: number, um: number | null): Promise<number> {
  return db.transaction(async (tx) => {
    const { insertId } = await tx.query(
      `INSERT INTO payment_requests
         (gym_id, user_membership_id, member_id, amount, currency, status, provider, provider_order, source, attempt, method)
       VALUES (?, ?, ?, '30.00', 'EUR', 'pending', 'monei', ?, 'customer', 1, 'provider')`,
      [gymId, um, memberId, `prk-${uniq()}`]);
    await recordPaymentAttempt(tx, Number(insertId));
    return Number(insertId);
  });
}
async function anchorOf(um: number): Promise<number> {
  const { rows } = await db.query<any>(
    'SELECT MIN(id) AS a FROM plan_snapshots WHERE gym_id = ? AND source_user_membership_id = ?', [gymId, um]);
  return Number(rows[0].a);
}
async function keyOf(id: number): Promise<number | null> {
  const { rows } = await db.query<any>('SELECT plan_assignment_id FROM payment_requests WHERE id = ?', [id]);
  return rows[0].plan_assignment_id == null ? null : Number(rows[0].plan_assignment_id);
}
async function requestDrift() {
  const report = await findPlanAssignmentDrift(db as any, gymId);
  return report.checks.find((c) => c.name === 'payment_request_assignment_mismatch')!;
}

beforeAll(async () => {
  gymId = await createTestGym('Payment request re-key gym');
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '1')`, [gymId, `PrRekey-${uniq()}`]);
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

describe('#2125 M6b-34: a payment request carries its plan_assignment_id beside user_membership_id', () => {
  it('a request raised for an assignment takes that assignment\'s anchor with its attempt', async () => {
    const owner = await member();
    const { um } = await commit(owner);
    const id = await raise(owner, um);
    expect(await keyOf(id)).toBe(await anchorOf(um));
  });

  it('a request that names no assignment has no plan_assignment_id', async () => {
    const owner = await member();
    const id = await raise(owner, null);
    expect(await keyOf(id)).toBeNull();
  });

  it('the assignment sync puts a drifted request back in step', async () => {
    const owner = await member();
    const { setId, um } = await commit(owner);
    const id = await raise(owner, um);
    await db.query('UPDATE payment_requests SET plan_assignment_id = NULL WHERE id = ?', [id]);
    await db.transaction((tx) => syncPlanAssignment(tx, gymId, setId));
    expect(await keyOf(id)).toBe(await anchorOf(um));
  });

  it('plan-assignments:validate reports a drifted request, and the backfill repairs it', async () => {
    expect((await requestDrift()).count).toBe(0);
    const owner = await member();
    const { um } = await commit(owner);
    const id = await raise(owner, um);
    await db.query('UPDATE payment_requests SET plan_assignment_id = NULL WHERE id = ?', [id]);
    const drift = await requestDrift();
    expect(drift.sample.map((r: any) => [Number(r.payment_request_id), r.plan_assignment_id, Number(r.expected_plan_assignment_id)]))
      .toEqual([[id, null, await anchorOf(um)]]);
    await backfillPaymentRequestAssignmentIds({ raw: (sql: string) => db.query(sql) });
    expect((await requestDrift()).count).toBe(0);
    expect(await keyOf(id)).toBe(await anchorOf(um));
  });
});
