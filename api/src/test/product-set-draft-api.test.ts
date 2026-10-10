import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const day = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const TODAY = day(0);
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'DR Member', `dr-${uniq()}@test.com`]);
  return insertId;
}
async function product(name: string, amount: number, frequency: string, type = 'fee'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system)
     VALUES (?, ?, ?, ?, 'EUR', ?, 'active', 'available', 0)`, [gymId, `${name}-${uniq()}`, type, amount, frequency]);
  return insertId;
}
async function plan(price: number, memberLimit = '1'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', ?, NULL, 6, 0, 0)`, [gymId, `DR-Plan-${uniq()}`, memberLimit]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status) VALUES (?, ?, ?, ?, 'active')`,
    [gymId, insertId, price, day(-365)]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit) VALUES (?, ?, 1, 'month')`,
    [gymId, insertId]);
  return insertId;
}
async function draft(planId: number | null = null, owner?: number) {
  const memberId = owner ?? await member();
  const res = await auth(request.post('/product-sets')).send({ member_id: memberId, membership_plan_id: planId, starts_at: TODAY });
  expect(res.status).toBe(201);
  return { id: res.body.id as number, memberId };
}

beforeAll(async () => {
  gymId = await createTestGym('Draft API gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  await db.query('DELETE FROM payment_requests WHERE gym_id = ?', [gymId]);
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('editing a Draft ProductSet (#1325 PR 4)', () => {
  it('replaces a benefit section, freezing a new item and keeping what was agreed', async () => {
    const { id } = await draft(await plan(30));
    const locker = await product('Locker', 12, 'month');
    const put = await auth(request.put(`/product-sets/${id}/benefits/periodical`)).send({ items: [{ product_id: locker, quantity: 2 }] });
    expect(put.status).toBe(200);
    const section = await auth(request.get(`/product-sets/${id}/benefits/periodical`));
    expect(section.body).toEqual([expect.objectContaining({ product_id: locker, quantity: 2, unit_price: '12.00' })]);

    // A catalogue repricing moves nothing already frozen, and a quantity change keeps the frozen price.
    await db.query('UPDATE products SET amount = 99 WHERE id = ?', [locker]);
    await auth(request.put(`/product-sets/${id}/benefits/periodical`)).send({ items: [{ product_id: locker, quantity: 3 }] });
    const again = await auth(request.get(`/product-sets/${id}/benefits/periodical`));
    expect(again.body[0]).toMatchObject({ quantity: 3, unit_price: '12.00' });

    // Removing it empties the section.
    const clear = await auth(request.put(`/product-sets/${id}/benefits/periodical`)).send({ items: [] });
    expect(clear.status).toBe(200);
    expect((await auth(request.get(`/product-sets/${id}/benefits/periodical`))).body).toEqual([]);
  });

  it('refuses a Product of another category, an inactive one and a duplicate', async () => {
    const { id } = await draft(await plan(30));
    const oneOff = await product('Registration', 20, 'once');
    const wrong = await auth(request.put(`/product-sets/${id}/benefits/periodical`)).send({ items: [{ product_id: oneOff, quantity: 1 }] });
    expect(wrong.status).toBe(400);
    const dup = await auth(request.put(`/product-sets/${id}/benefits/oneoff`)).send({ items: [{ product_id: oneOff, quantity: 1 }, { product_id: oneOff, quantity: 1 }] });
    expect(dup.status).toBe(400);
    const missing = await auth(request.put(`/product-sets/${id}/benefits/oneoff`)).send({ items: [{ product_id: 999999, quantity: 1 }] });
    expect(missing.status).toBe(400);
    expect((await auth(request.put(`/product-sets/${id}/benefits/nonsense`)).send({ items: [] })).status).toBe(404);
  });

  it('edits Billing & Duration, the negotiated fee and the personal benefit, validated', async () => {
    const { id } = await draft(await plan(30));
    expect((await auth(request.put(`/product-sets/${id}/billing-duration`)).send({ free_periods: 1, paid_periods: 4, pay_beforehand_periods: 2, auto_renew: true })).status).toBe(200);
    const bad = await auth(request.put(`/product-sets/${id}/billing-duration`)).send({ pay_beforehand_periods: 9 });
    expect(bad.status).toBe(400);
    expect((await auth(request.put(`/product-sets/${id}/billing-duration`)).send({ free_periods: -1 })).status).toBe(400);

    expect((await auth(request.put(`/product-sets/${id}/fee`)).send({ membership_fee_price: 25 })).status).toBe(400); // reason required
    expect((await auth(request.put(`/product-sets/${id}/fee`)).send({ membership_fee_price: 25, discount_reason: 'Friend of the gym' })).status).toBe(200);
    expect((await auth(request.put(`/product-sets/${id}/fee-benefit`)).send({ action: 'percentage_discount', value: 150 })).status).toBe(400);
    expect((await auth(request.put(`/product-sets/${id}/fee-benefit`)).send({ action: 'percentage_discount', value: 10 })).status).toBe(200);

    const { rows } = await db.query<any>(
      'SELECT membership_fee_price, free_periods, paid_periods, pay_beforehand_periods, auto_renew, personal_fee_benefit_value FROM product_set_plan_snapshots WHERE product_set_id = ?', [id]);
    expect(rows[0]).toMatchObject({ free_periods: 1, paid_periods: 4, pay_beforehand_periods: 2, auto_renew: 1 });
    expect(Number(rows[0].membership_fee_price)).toBe(25);
    expect(Number(rows[0].personal_fee_benefit_value)).toBe(10);
  });

  it('the Billing Event Forecast follows the edits, and nothing is written outside the Draft', async () => {
    const { id } = await draft(await plan(40));
    const before = await auth(request.get(`/product-sets/${id}/billing-event-simulation`));
    expect(before.status).toBe(200);
    await auth(request.put(`/product-sets/${id}/fee-benefit`)).send({ action: 'percentage_discount', value: 50 });
    const after = await auth(request.get(`/product-sets/${id}/billing-event-simulation`));
    expect(JSON.stringify(after.body)).not.toEqual(JSON.stringify(before.body));
    const { rows } = await db.query('SELECT id FROM billing_events WHERE product_set_id = ?', [id]);
    expect(rows.length).toBe(0);
  });

  it('attaches and removes a recurring service, and refuses a one-off', async () => {
    const { id } = await draft(null);
    const monthly = await product('Towel', 5, 'month');
    const once = await product('Fee', 5, 'once');
    expect((await auth(request.post(`/product-sets/${id}/services`)).send({ product_id: once })).status).toBe(400);
    const added = await auth(request.post(`/product-sets/${id}/services`)).send({ product_id: monthly, quantity: 2 });
    expect(added.status).toBe(200);
    expect((await auth(request.post(`/product-sets/${id}/services`)).send({ product_id: monthly })).status).toBe(400); // duplicate
    const del = await auth(request.delete(`/product-sets/${id}/services/${added.body.id}`));
    expect(del.status).toBe(200);
    expect((await auth(request.delete(`/product-sets/${id}/services/${added.body.id}`))).status).toBe(404);
  });

  it('covers a member up to the plan limit, never the owner twice, and removes coverage', async () => {
    const limited = await plan(30, '2');
    const { id, memberId } = await draft(limited);
    const second = await member();
    const third = await member();
    expect((await auth(request.post(`/product-sets/${id}/members`)).send({ member_id: second })).status).toBe(200);
    // The plan covers two Members and the owner is one of them.
    const over = await auth(request.post(`/product-sets/${id}/members`)).send({ member_id: third });
    expect(over.status).toBe(400);
    expect((await auth(request.delete(`/product-sets/${id}/members/${memberId}`))).status).toBe(400);
    expect((await auth(request.delete(`/product-sets/${id}/members/${second}`))).status).toBe(200);
  });

  it('applies a Promotion with its own snapshot and removes it again', async () => {
    const planId = await plan(30);
    const { id } = await draft(planId);
    const promo = await db.query(
      `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable, only_applicable_for_new_members, paid_months, applies_to)
       VALUES (?, ?, '2020-01-01', '2099-12-31', 'active', 1, 0, 3, 'membership_plan')`, [gymId, `DR-Promo-${uniq()}`]);
    await db.query('INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)', [gymId, promo.insertId, planId]);
    const applied = await auth(request.post(`/product-sets/${id}/promotions`)).send({ promotion_id: promo.insertId });
    expect(applied.status).toBe(200);
    const { rows } = await db.query<any>('SELECT snapshot FROM user_membership_promotions WHERE id = ?', [applied.body.application_id]);
    expect(rows[0].snapshot).not.toBeNull();
    expect((await auth(request.post(`/product-sets/${id}/promotions`)).send({ promotion_id: promo.insertId })).status).toBe(400); // already applied
    expect((await auth(request.delete(`/product-sets/${id}/promotions/${applied.body.application_id}`))).status).toBe(200);
  });

  it('refuses every edit of a committed version, an expired Draft and another gym\'s', async () => {
    const free = await plan(0);
    const { id } = await draft(free);
    const act = await auth(request.post(`/product-sets/${id}/activate`)).send({});
    expect(act.status).toBe(200);
    const committed = await auth(request.put(`/product-sets/${id}/benefits/periodical`)).send({ items: [] });
    expect(committed.status).toBe(409);
    expect(committed.body.error).toBe('not_a_draft');

    const { id: stale } = await draft(await plan(10));
    await db.query('UPDATE product_sets SET last_activity_at = UTC_TIMESTAMP() - INTERVAL 3 HOUR WHERE id = ?', [stale]);
    const gone = await auth(request.put(`/product-sets/${stale}/fee-benefit`)).send({ action: 'no_benefit' });
    expect(gone.status).toBe(410);

    const { id: mine } = await draft(await plan(10));
    const otherGym = await createTestGym('Draft other gym');
    await createTestMembership(otherGym, 'admin');
    const foreign = await request.put(`/product-sets/${mine}/fee-benefit`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', otherGym).send({ action: 'no_benefit' });
    expect(foreign.status).toBe(404);
  });

  it('an edit refreshes the Draft\'s two hours', async () => {
    const { id } = await draft(await plan(10));
    await db.query('UPDATE product_sets SET last_activity_at = UTC_TIMESTAMP() - INTERVAL 110 MINUTE WHERE id = ?', [id]);
    await auth(request.put(`/product-sets/${id}/fee-benefit`)).send({ action: 'no_benefit' });
    const { rows } = await db.query<any>(
      'SELECT TIMESTAMPDIFF(MINUTE, last_activity_at, UTC_TIMESTAMP()) AS idle FROM product_sets WHERE id = ?', [id]);
    expect(Number(rows[0].idle)).toBeLessThan(5);
  });
});
