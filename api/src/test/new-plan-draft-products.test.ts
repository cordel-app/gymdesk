// #2891 — the open Draft is the member's shopping cart until Save & Pay: a recurring Product staff
// add while a new Membership Plan is being assigned lands in that same Draft, beside the plan,
// instead of answering `A draft is already in progress for this member`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';

let gymId: string;
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  gymId = await createTestGym('New Plan Draft Products Gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  delete process.env.MONEI_API_KEY;
  await db.query('DELETE FROM payment_requests WHERE gym_id = ?', [gymId]);
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function plan(price: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', NULL, NULL, 0, 0)`, [gymId, `NPD-Plan-${uniq()}`]);
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status) VALUES (?, ?, ?, ?, 'active')`,
    [gymId, insertId, price, day(-365)]);
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit) VALUES (?, ?, 1, 'month')`,
    [gymId, insertId]);
  return Number(insertId);
}

async function monthlyProduct(amount = '20.00'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products
       (gym_id, name, type, billing_frequency, status, enrollment_status, is_system, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', 'month', 'active', 'public', 0, 'EUR', ?, 'inclusive')`,
    [gymId, `Locker-${uniq()}`, amount]);
  return Number(insertId);
}

async function memberWithNewPlanDraft() {
  const { insertId: memberId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'Cart Owner', `npd-${uniq()}@test.com`]);
  const planId = await plan(40);
  const umId = await createTestDraftAssignment(gymId, Number(memberId), planId);
  const { rows } = await db.query<any>(
    `SELECT id FROM product_sets WHERE gym_id = ? AND owner_member_id = ? AND status = 'in_cart'`, [gymId, memberId]);
  return { memberId: Number(memberId), umId, planId, draftId: Number(rows[0].id) };
}

const setsOf = async (memberId: number) => (await db.query<any>(
  'SELECT id, status FROM product_sets WHERE gym_id = ? AND owner_member_id = ? ORDER BY id', [gymId, memberId])).rows;

const draftLines = async (setId: number) => (await db.query<any>(
  `SELECT s.product_id, s.quantity, s.unit_price, s.direct_discount_percent
     FROM product_set_periodical_snapshots lnk
     JOIN product_periodical_snapshots s ON s.id = lnk.product_periodical_snapshot_id
    WHERE lnk.product_set_id = ? AND s.ends_at IS NULL`, [setId])).rows;

describe('adding a recurring Product to a new-plan Draft (#2891)', () => {
  it('adds the Product to the same Draft, keeping the plan, and the review lists it', async () => {
    const { memberId, planId, draftId } = await memberWithNewPlanDraft();
    const productId = await monthlyProduct('20.00');

    const res = await auth(request.post(`/members/${memberId}/product-purchases`))
      .send({ product_id: productId, direct_discount_percent: 10 });
    expect(res.status).toBe(201);
    expect(res.body.product_set_id).toBe(draftId);

    // One Draft, no second version.
    expect((await setsOf(memberId)).map((s: any) => s.status)).toEqual(['in_cart']);

    // The plan is still the Draft's.
    const { rows: plans } = await db.query<any>(
      `SELECT s.membership_plan_id FROM product_set_plan_snapshots j JOIN plan_snapshots s ON s.id = j.plan_snapshot_id
        WHERE j.product_set_id = ? AND j.entitlement_only = 0`, [draftId]);
    expect(plans.map((p: any) => Number(p.membership_plan_id))).toEqual([planId]);

    // The Product line carries its discount.
    const lines = await draftLines(draftId);
    expect(lines).toHaveLength(1);
    expect(Number(lines[0].product_id)).toBe(productId);
    expect(Number(lines[0].direct_discount_percent)).toBe(10);
    expect(Number(lines[0].unit_price)).toBe(18);

    // Nothing is charged: no Billing Event for the Draft yet.
    const { rows: events } = await db.query<any>('SELECT id FROM billing_events WHERE product_set_id = ?', [draftId]);
    expect(events).toHaveLength(0);

    // A second add is an edit of that same Draft.
    // Past the duplicate-submission window, so the second add is a purchase of its own.
    await db.query(
      `UPDATE product_periodical_snapshots s
         JOIN product_set_periodical_snapshots lnk ON lnk.product_periodical_snapshot_id = s.id
         SET s.created_at = s.created_at - INTERVAL 1 MINUTE WHERE lnk.product_set_id = ?`, [draftId]);
    const again = await auth(request.post(`/members/${memberId}/product-purchases`)).send({ product_id: productId });
    expect(again.status).toBe(201);
    expect(again.body.product_set_id).toBe(draftId);
    expect(await setsOf(memberId)).toHaveLength(1);
    expect(await draftLines(draftId)).toHaveLength(2);

    // The products Draft endpoint answers the same Draft too.
    const ensured = await auth(request.post('/product-sets/draft')).send({ member_id: memberId });
    expect(ensured.status).toBe(200);
    expect(Number(ensured.body.id)).toBe(draftId);
  });

  it('a Save & Pay version awaiting payment still answers in_flight', async () => {
    const { memberId, umId } = await memberWithNewPlanDraft();
    const productId = await monthlyProduct();
    const added = await auth(request.post(`/members/${memberId}/product-purchases`)).send({ product_id: productId });
    expect(added.status).toBe(201);

    const paid = await auth(request.post(`/user-memberships/${umId}/save-and-pay`)).send({});
    expect(paid.status).toBeLessThan(300);
    expect((await setsOf(memberId)).map((s: any) => s.status)).toEqual(['pending_payment']);

    const res = await auth(request.post(`/members/${memberId}/product-purchases`)).send({ product_id: productId });
    expect(res.status).toBe(409);
    expect(await setsOf(memberId)).toHaveLength(1);
  });

  it('an expired new-plan Draft is not reused', async () => {
    const { memberId, draftId } = await memberWithNewPlanDraft();
    await db.query('UPDATE product_sets SET last_activity_at = UTC_TIMESTAMP() - INTERVAL 3 HOUR WHERE id = ?', [draftId]);
    const productId = await monthlyProduct();
    const res = await auth(request.post(`/members/${memberId}/product-purchases`)).send({ product_id: productId });
    expect(res.status).toBe(201);
    expect(res.body.product_set_id).not.toBe(draftId);
    expect((await setsOf(memberId)).map((s: any) => s.status)).toEqual(['in_cart']);
  });
});
