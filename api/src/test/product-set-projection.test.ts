import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym } from './helpers';
import { createDraft } from '../api/product-sets';
import { activateWithEvents, snapshotProductSetFromPlan } from '../api/product-set-configuration';
import { addCoverage } from '../api/product-sets';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const actor = { name: 'T', type: 'staff' };

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'M', `proj-${uniq()}@example.com`]);
  return insertId;
}
async function plan(price = 30): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '1')`, [gymId, `Proj-${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, ?, '2020-01-01', 'active')`, [gymId, insertId, price]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return insertId;
}
async function product(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system)
     VALUES (?, ?, 'fee', 10, 'EUR', 'month', 'active', 'available', 0)`, [gymId, `P-${uniq()}`]);
  return insertId;
}
async function commit(owner: number, planId: number | null, fee = 30) {
  return db.transaction(async (tx) => {
    const d = await createDraft(tx, { gymId, ownerMemberId: owner, membershipPlanId: planId, startsAt: TODAY, actor });
    if (d.kind !== 'created') throw new Error(d.kind);
    if (planId != null) {
      await snapshotProductSetFromPlan(tx, { gymId, productSetId: d.productSet.id, membershipPlanId: planId, membershipFeePrice: fee, startsAt: TODAY });
    }
    await addCoverage(tx, { gymId, rootProductSetId: Number(d.productSet.root_product_set_id), memberId: owner, isOwner: true });
    const out = await activateWithEvents(tx, { gymId, productSetId: d.productSet.id, today: TODAY });
    if (out.kind !== 'ok') throw new Error(out.kind);
    return d.productSet.id;
  });
}
async function assignments(owner: number) {
  const { rows } = await db.query<any>(
    'SELECT id, status, membership_plan_id, membership_fee_price FROM user_memberships WHERE member_id = ? ORDER BY id', [owner]);
  return rows;
}

beforeAll(async () => { gymId = await createTestGym('Projection gym'); });
afterAll(async () => {
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('an Active ProductSet projects its operational assignment (#1325 PR 3a)', () => {
  it('creates one assignment, never billable by the assignment pass', async () => {
    const owner = await member();
    const p = await plan(30);
    const setId = await commit(owner, p, 30);
    const rows = await assignments(owner);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ status: 'active', membership_plan_id: p });
    expect(Number(rows[0].membership_fee_price)).toBe(30);
    const { rows: link } = await db.query<any>('SELECT user_membership_id FROM product_sets WHERE id = ?', [setId]);
    expect(Number(link[0].user_membership_id)).toBe(Number(rows[0].id));
    const { rows: cover } = await db.query<any>('SELECT is_owner FROM user_membership_members WHERE user_membership_id = ?', [rows[0].id]);
    expect(cover.length).toBe(1);
  });

  it('a new version of the same plan updates the assignment in place', async () => {
    const owner = await member();
    const p = await plan(30);
    await commit(owner, p, 30);
    await commit(owner, p, 35);
    const rows = await assignments(owner);
    expect(rows.length).toBe(1);
    expect(Number(rows[0].membership_fee_price)).toBe(35);
  });

  it('a different plan closes the previous assignment and opens a new one', async () => {
    const owner = await member();
    await commit(owner, await plan(30), 30);
    const second = await plan(50);
    await commit(owner, second, 50);
    const rows = await assignments(owner);
    expect(rows.map((r: any) => r.status)).toEqual(['cancelled', 'active']);
    expect(Number(rows[1].membership_plan_id)).toBe(second);
  });

  it('a plan-less version has no assignment, and closes a previous one', async () => {
    const owner = await member();
    await commit(owner, await plan(30), 30);
    await commit(owner, null);
    const rows = await assignments(owner);
    expect(rows.map((r: any) => r.status)).toEqual(['cancelled']);

    const lockerOnly = await member();
    await commit(lockerOnly, null);
    expect((await assignments(lockerOnly)).length).toBe(0);
  });

  it('copies the frozen benefit rows to the assignment for the legacy readers', async () => {
    const owner = await member();
    const prod = await product();
    const p = await plan(30);
    await db.query(`INSERT INTO membership_plan_periodical (gym_id, membership_plan_id, product_id, quantity) VALUES (?, ?, ?, 2)`,
      [gymId, p, prod]);
    await commit(owner, p, 30);
    const [um] = await assignments(owner);
    const { rows } = await db.query<any>(
      'SELECT product_id, quantity FROM user_membership_periodical WHERE user_membership_id = ?', [um.id]);
    expect(rows).toEqual([expect.objectContaining({ product_id: prod, quantity: 2 })]);
  });
});
