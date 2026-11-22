import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';

// #2966 stage 9 — staff edit the configuration of one plan of the in-cart ProductSet by its snapshot id.
let gymId: string;
let otherGymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const auth = (r: any, gym = gymId) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'APC Member', `apc-${uniq()}@test.com`]);
  return insertId;
}
async function plan(price: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', NULL, 6, 0, 0)`, [gymId, `APC-Plan-${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status) VALUES (?, ?, ?, '2020-01-01', 'active')`,
    [gymId, insertId, price]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit) VALUES (?, ?, 1, 'month')`,
    [gymId, insertId]);
  return insertId;
}
async function product(name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system)
     VALUES (?, ?, 'other', 12, 'EUR', 'month', 'active', 'available', 0)`, [gymId, `${name}-${uniq()}`]);
  return insertId;
}
const snapshot = async (id: number) => (await db.query<any>(
  `SELECT paid_periods, auto_renew, membership_fee_price, discount_reason, personal_fee_benefit_action, personal_fee_benefit_value
     FROM plan_snapshots WHERE id = ?`, [id])).rows[0];

/** A cart with one plan (the primary) and a second plan added to it; answers both snapshot ids. */
async function cartWithAddedPlan() {
  const owner = await member();
  const res = await auth(request.post('/product-sets')).send({ member_id: owner, membership_plan_id: await plan(30), starts_at: TODAY });
  expect(res.status).toBe(201);
  const setId = res.body.id as number;
  const added = await auth(request.post(`/product-sets/${setId}/plans`)).send({ membership_plan_id: await plan(50) });
  expect(added.status).toBe(200);
  const { rows } = await db.query<any>(
    'SELECT plan_snapshot_id FROM product_set_plan_snapshots WHERE product_set_id = ? ORDER BY id', [setId]);
  return { setId, primary: Number(rows[0].plan_snapshot_id), addedId: Number(added.body.plan_snapshot_id) };
}

beforeAll(async () => {
  gymId = await createTestGym('Added plan config gym');
  await createTestMembership(gymId, 'admin');
  otherGymId = await createTestGym('Added plan config other gym');
  await createTestMembership(otherGymId, 'admin');
});
afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('editing an added plan of the cart (#2966 stage 9)', () => {
  it('writes Billing & Duration, the negotiated fee and the fee benefit on the named plan only', async () => {
    const { setId, primary, addedId } = await cartWithAddedPlan();
    const before = await snapshot(primary);

    expect((await auth(request.put(`/product-sets/${setId}/plans/${addedId}/billing-duration`))
      .send({ paid_periods: 9, auto_renew: true })).status).toBe(200);
    expect((await auth(request.put(`/product-sets/${setId}/plans/${addedId}/fee`))
      .send({ membership_fee_price: 41.5, discount_reason: 'Loyalty' })).status).toBe(200);
    expect((await auth(request.put(`/product-sets/${setId}/plans/${addedId}/fee-benefit`))
      .send({ action: 'percentage_discount', value: 10 })).status).toBe(200);

    const added = await snapshot(addedId);
    expect(Number(added.paid_periods)).toBe(9);
    expect(Number(added.auto_renew)).toBe(1);
    expect(Number(added.membership_fee_price)).toBe(41.5);
    expect(added.discount_reason).toBe('Loyalty');
    expect(added.personal_fee_benefit_action).toBe('percentage_discount');
    expect(Number(added.personal_fee_benefit_value)).toBe(10);
    // The primary plan and the cart's other plans are untouched; no copy was made.
    expect(await snapshot(primary)).toEqual(before);
    const { rows } = await db.query<any>('SELECT plan_snapshot_id FROM product_set_plan_snapshots WHERE product_set_id = ? ORDER BY id', [setId]);
    expect(rows.map((r: any) => Number(r.plan_snapshot_id))).toEqual([primary, addedId]);
  });

  it('replaces a benefit section of the named plan and reads it back by snapshot id', async () => {
    const { setId, primary, addedId } = await cartWithAddedPlan();
    const locker = await product('Locker');
    const put = await auth(request.put(`/product-sets/${setId}/plans/${addedId}/benefits/periodical`))
      .send({ items: [{ product_id: locker, quantity: 2 }] });
    expect(put.status).toBe(200);
    const section = await auth(request.get(`/product-sets/${setId}/plans/${addedId}/benefits/periodical`));
    expect(section.status).toBe(200);
    expect(section.body).toEqual([expect.objectContaining({ product_id: locker, quantity: 2 })]);
    // The set-level read is still the primary plan's, which has no such line.
    const primarySection = await auth(request.get(`/product-sets/${setId}/benefits/periodical`));
    expect(primarySection.body.some((l: any) => l.product_id === locker)).toBe(false);
    const { rows } = await db.query<any>('SELECT COUNT(*) AS n FROM plan_periodical_snapshots WHERE plan_snapshot_id = ? AND product_id = ?', [primary, locker]);
    expect(Number(rows[0].n)).toBe(0);
  });

  it('validates the body as the set-level routes do', async () => {
    const { setId, addedId } = await cartWithAddedPlan();
    expect((await auth(request.put(`/product-sets/${setId}/plans/${addedId}/billing-duration`))
      .send({ paid_periods: 2, pay_beforehand_periods: 3 })).status).toBe(400);
    expect((await auth(request.put(`/product-sets/${setId}/plans/${addedId}/fee`))
      .send({ membership_fee_price: 20 })).status).toBe(400);
    expect((await auth(request.put(`/product-sets/${setId}/plans/${addedId}/benefits/nope`)).send({ items: [] })).status).toBe(404);
  });

  it('answers 404 for a plan the cart does not hold, and keeps tenants apart', async () => {
    const a = await cartWithAddedPlan();
    const b = await cartWithAddedPlan();
    // B's plan addressed through A's cart.
    expect((await auth(request.put(`/product-sets/${a.setId}/plans/${b.addedId}/billing-duration`))
      .send({ paid_periods: 3 })).status).toBe(404);
    expect((await auth(request.get(`/product-sets/${a.setId}/plans/${b.addedId}/benefits/oneoff`))).status).toBe(404);
    expect((await auth(request.put(`/product-sets/${a.setId}/plans/${a.addedId}/billing-duration`), otherGymId)
      .send({ paid_periods: 3 })).status).toBe(404);
    expect((await request.put(`/product-sets/${a.setId}/plans/${a.addedId}/billing-duration`).send({ paid_periods: 3 })).status).toBe(401);
    expect(Number((await snapshot(a.addedId)).paid_periods)).toBe(6);
  });

  it('refuses a committed version and a plan another version links', async () => {
    const { setId, addedId } = await cartWithAddedPlan();
    // Another set linking the same snapshot makes it shared: it is a running version's plan.
    const { insertId: other } = await db.query(
      `INSERT INTO product_sets (gym_id, owner_member_id, status, starts_at)
       SELECT gym_id, owner_member_id, 'superseded', starts_at FROM product_sets WHERE id = ?`, [setId]);
    await db.query('INSERT INTO product_set_plan_snapshots (product_set_id, plan_snapshot_id) VALUES (?, ?)', [other, addedId]);
    const shared = await auth(request.put(`/product-sets/${setId}/plans/${addedId}/billing-duration`)).send({ paid_periods: 3 });
    expect(shared.status).toBe(409);
    expect(shared.body.error).toBe('plan_not_editable');
    await db.query('DELETE FROM product_set_plan_snapshots WHERE product_set_id = ?', [other]);
    await db.query(`UPDATE product_sets SET status = 'superseded' WHERE id = ?`, [setId]);
    expect((await auth(request.put(`/product-sets/${setId}/plans/${addedId}/billing-duration`)).send({ paid_periods: 3 })).status).toBe(409);
  });
});
