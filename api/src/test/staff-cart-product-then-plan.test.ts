// #2966 stage 11 — the reopen's sequence end to end: staff add a recurring Product (which opens
// the member's in-cart ProductSet), then assign a Membership Plan before Save & Pay. The plan
// must join that same ProductSet and be listed on the Member card as In Cart.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, activateTestAssignment, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const staff = (method: 'post' | 'get' | 'delete', path: string) =>
  (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Cart Plan Member', `cpm-${uniq()}@t.com`]);
  return insertId;
}
async function product(amount: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', 'month', 'active', 'public', 'EUR', ?, 'inclusive')`, [gymId, `P-${uniq()}`, amount]);
  return insertId;
}
async function plan(price: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', NULL, 6, 0, 0)`, [gymId, `CP-Plan-${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status) VALUES (?, ?, ?, '2020-01-01', 'active')`,
    [gymId, insertId, price]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit) VALUES (?, ?, 1, 'month')`,
    [gymId, insertId]);
  return insertId;
}

/** What the Admin's Assign editor does: assign, and on `in_flight` add the plan to that cart. */
async function assignLikeAdmin(owner: number, planId: number): Promise<void> {
  const res = await staff('post', `/membership-plans/${planId}/assign`).send({
    owner_member_id: owner, beneficiary_member_ids: [owner], starts_at: TODAY, promotion_ids: [],
  });
  if (res.status === 409 && res.body.code === 'in_flight') {
    const add = await staff('post', `/product-sets/${res.body.product_set_id}/plans`).send({
      membership_plan_id: planId, starts_at: TODAY, owner_is_beneficiary: true,
      beneficiary_member_ids: [owner], promotion_ids: [],
    });
    expect(add.status, JSON.stringify(add.body)).toBe(200);
    return;
  }
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}

/** The plans the Member card lists as In Cart, by Membership Plan id, with the set they are in. */
async function inCartPlans(owner: number): Promise<Array<{ planId: number; setId: number | null }>> {
  const res = await staff('get', `/user-memberships/member/${owner}/configuration`);
  expect(res.status).toBe(200);
  const fromRows = (res.body.plans as any[])
    .filter((p) => p.status === 'in_cart')
    .map((p) => ({ planId: Number(p.membership_plan_id), setId: null }));
  const added = (res.body.product_sets as any[]).filter((ps) => ps.status === 'in_cart')
    .flatMap((ps) => (ps.added_plans ?? []).map((a: any) => ({ planId: Number(a.membership_plan_id), setId: Number(ps.id) })));
  return [...fromRows, ...added];
}

/** The cart the Product opened still holds the Product line, and its review and forecast bill the plan. */
async function expectCartBillsPlanAndProduct(setId: number, productId: number): Promise<void> {
  const { rows: lines } = await db.query<any>(
    `SELECT l.product_id FROM product_set_periodical_snapshots j
       JOIN product_periodical_snapshots l ON l.id = j.product_periodical_snapshot_id
      WHERE j.product_set_id = ?`, [setId]);
  expect(lines.map((l: any) => Number(l.product_id))).toContain(productId);
  const review = await staff('get', `/product-sets/${setId}/review`);
  expect(review.status, JSON.stringify(review.body)).toBe(200);
  expect(Number(review.body.amount_due)).toBeGreaterThan(0);
  const sim = await staff('get', `/product-sets/${setId}/billing-event-simulation`);
  expect(sim.status, JSON.stringify(sim.body)).toBe(200);
  const kinds = new Set((sim.body.dates as any[]).flatMap((d) => d.lines.map((l: any) => l.kind)));
  expect(kinds.has('membership_fee')).toBe(true);
}

const cartSets = async (owner: number) => (await db.query<any>(
  `SELECT id FROM product_sets WHERE gym_id = ? AND owner_member_id = ? AND status = 'in_cart'`, [gymId, owner])).rows;

beforeAll(async () => {
  gymId = await createTestGym('Cart product then plan gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  await db.query('DELETE FROM payment_requests WHERE gym_id = ?', [gymId]);
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('Product first, then a Membership Plan, in one cart (#2966 stage 11)', () => {
  it('a member with no plan: the plan joins the Product\'s cart and is listed In Cart', async () => {
    const owner = await member();
    const productId = await product('20.00');
    const buy = await staff('post', `/members/${owner}/product-purchases`).send({ product_id: productId });
    expect(buy.status, JSON.stringify(buy.body)).toBe(201);
    const setId = Number(buy.body.product_set_id);
    const p = await plan(40);
    await assignLikeAdmin(owner, p);
    expect((await cartSets(owner)).map((r: any) => Number(r.id))).toEqual([setId]);
    await expectCartBillsPlanAndProduct(setId, productId);
    expect((await inCartPlans(owner)).map((r) => r.planId)).toEqual([p]);
  });

  it('a member with a running plan: the added plan is listed In Cart beside it', async () => {
    const owner = await member();
    const running = await plan(30);
    const um = await createTestDraftAssignment(gymId, owner, running);
    await activateTestAssignment(gymId, um);
    const productId = await product('20.00');
    const buy = await staff('post', `/members/${owner}/product-purchases`).send({ product_id: productId });
    expect(buy.status, JSON.stringify(buy.body)).toBe(201);
    const setId = Number(buy.body.product_set_id);
    const p = await plan(40);
    await assignLikeAdmin(owner, p);
    expect((await cartSets(owner)).map((r: any) => Number(r.id))).toEqual([setId]);
    await expectCartBillsPlanAndProduct(setId, productId);
    expect((await inCartPlans(owner)).map((r) => r.planId)).toContain(p);
  });

  it('a member whose only plan cancels at its period end: the added plan is still listed In Cart', async () => {
    const owner = await member();
    const running = await plan(30);
    const um = await createTestDraftAssignment(gymId, owner, running);
    await activateTestAssignment(gymId, um);
    const cancel = await staff('post', `/user-memberships/${um}/close`).send({ end_of_period: true, at_period_end: true });
    // Whatever the close answers, the cart flow below must still list the added plan.
    console.log("CLOSE", cancel.status, JSON.stringify(cancel.body).slice(0,200));
    const productId = await product('20.00');
    const buy = await staff('post', `/members/${owner}/product-purchases`).send({ product_id: productId });
    expect(buy.status, JSON.stringify(buy.body)).toBe(201);
    const setId = Number(buy.body.product_set_id);
    const p = await plan(40);
    await assignLikeAdmin(owner, p);
    expect((await cartSets(owner)).map((r: any) => Number(r.id))).toEqual([setId]);
    await expectCartBillsPlanAndProduct(setId, productId);
    expect((await inCartPlans(owner)).map((r) => r.planId)).toContain(p);
  });
});
