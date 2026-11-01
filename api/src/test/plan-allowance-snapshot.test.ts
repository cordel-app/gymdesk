import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym } from './helpers';
import { createDraft, addCoverage } from '../api/product-sets';
import { activateWithEvents, snapshotProductSetFromPlan } from '../api/product-set-configuration';
import { ensureRecurringDraft } from '../api/recurring-purchase-draft';
import { runPlanAllowanceRenewals } from '../api/plan-allowance-renewals';
import { loadMemberProfessionalServiceGrants } from '../domain/memberProfessionalServices';

// #2125 stage 12 — a renewing Session Benefit allowance is renewed against its plan snapshot line.

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const day = (offset: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
const TODAY = day(0);
const actor = { name: 'T', type: 'staff' };

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'M', `allow-${uniq()}@example.com`]);
  return insertId;
}
async function plan(price: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '2')`, [gymId, `Allow-${uniq()}`]);
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

beforeAll(async () => { gymId = await createTestGym('Allowance snapshot gym'); });
afterAll(async () => { await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]); await cleanupTestGyms(); await db.end(); });

describe('plan allowance renewals by plan snapshot', () => {
  it('renews against the plan session snapshot, once per date, and the wallet counts the renewal', async () => {
    const owner = await member();
    const planId = await plan(50);
    const { insertId: serviceId } = await db.query(
      `INSERT INTO professional_services (gym_id, name, is_system) VALUES (?, ?, 0)`, [gymId, `PS-${uniq()}`]);
    await db.query(`INSERT INTO gym_professional_services (gym_id, professional_service_id, status) VALUES (?, ?, 'active')`, [gymId, serviceId]);
    const { insertId: productId } = await db.query(
      `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system, units)
       VALUES (?, ?, 'sessions', 0, 'EUR', 'once', 'active', 'available', 0, 1)`, [gymId, `Nutri-${uniq()}`]);
    await db.query('INSERT INTO product_professional_services (gym_id, product_id, professional_service_id) VALUES (?, ?, ?)', [gymId, productId, serviceId]);
    await db.query(
      `INSERT INTO membership_plan_session (gym_id, membership_plan_id, product_id, quantity, frequency) VALUES (?, ?, ?, 2, 'week')`,
      [gymId, planId, productId]);

    const setId = await activeVersion(owner, planId, 50);
    const { rows: line } = await db.query<any>(
      'SELECT id FROM plan_session_snapshots WHERE plan_snapshot_id = (SELECT id FROM plan_snapshots WHERE product_set_id = ?)', [setId]);
    expect(line).toHaveLength(1);

    const inTwoWeeks = day(14);
    const first = await runPlanAllowanceRenewals(inTwoWeeks);
    expect(first.renewed).toBeGreaterThan(0);
    const { rows: renewals } = await db.query<any>(
      'SELECT plan_session_snapshot_id, user_membership_session_id FROM plan_allowance_renewals WHERE gym_id = ?', [gymId]);
    expect(renewals.length).toBeGreaterThan(0);
    for (const r of renewals) {
      expect(Number(r.plan_session_snapshot_id)).toBe(Number(line[0].id));
      expect(r.user_membership_session_id).toBeNull();
    }
    const again = await runPlanAllowanceRenewals(inTwoWeeks);
    expect(again.renewed).toBe(0);

    // The grant is the snapshot line's quantity plus its renewals, referenced by the snapshot id.
    const { rows: sum } = await db.query<any>(
      'SELECT SUM(quantity) AS q FROM plan_allowance_renewals WHERE plan_session_snapshot_id = ?', [line[0].id]);
    const grants = (await loadMemberProfessionalServiceGrants(gymId, owner)).filter((g) => g.kind === 'plan_session');
    expect(grants).toHaveLength(1);
    expect(Number(grants[0].reference_id)).toBe(Number(line[0].id));
    expect(Number(grants[0].sessions)).toBe(2 + Number(sum[0].q));
  });
});
