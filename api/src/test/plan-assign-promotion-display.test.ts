// #2946 — a Promotion selected while assigning a Membership Plan is still the plan's
// when the Assigned Plan is opened for editing.
//
// `⋮ → Edit` on a committed plan (`POST /user-memberships/:id/edit-draft`) opens a
// **new** Draft assignment whose version is a clone of the Active one. The clone
// copied the Promotion applications with no assignment, and every reader of an
// assignment's Plan Promotions joins on `user_membership_id`, so the Draft read as
// "No promotions applied to this plan", its lines lost the Promotion Benefit and
// the fee simulation and forecast lost the discount.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request, proratedToNextFirst } from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let gymId: string;
let otherGymId: string;
const api = (method: 'get' | 'post', path: string, gym = gymId) =>
  (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);

beforeAll(async () => {
  gymId = await createTestGym('Plan Assign Promotion Display Gym');
  otherGymId = await createTestGym('Plan Assign Promotion Display Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
});

/**
 * A €50/month plan carrying a €20/month locker and a €10 one-off towel, and a
 * Promotion targeting it: 20% off the fee and the locker waived. The towel is
 * not covered by the Promotion.
 */
async function setup() {
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit, paid_periods)
     VALUES (?, ?, 'active', 'staff_only', '1', 12)`, [gymId, `PAPD Plan ${uniq()}`]);
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, 50, '2020-01-01', 'active')`, [gymId, planId]);
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`, [gymId, planId]);
  const product = async (name: string, amount: number, frequency: string) => Number((await db.query(
    `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system, tax_behavior)
     VALUES (?, ?, 'service', ?, 'EUR', ?, 'active', 'available', 0, 'inclusive')`,
    [gymId, `${name} ${uniq()}`, amount, frequency])).insertId);
  const locker = await product('PAPD Locker', 20, 'month');
  const towel = await product('PAPD Towel', 10, 'once');
  await db.query('INSERT INTO membership_plan_periodical (gym_id, membership_plan_id, product_id, quantity) VALUES (?, ?, ?, 1)',
    [gymId, planId, locker]);
  await db.query('INSERT INTO membership_plan_oneoff (gym_id, membership_plan_id, product_id, quantity) VALUES (?, ?, ?, 1)',
    [gymId, planId, towel]);
  const { insertId: promoId } = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable, only_applicable_for_new_members, paid_months)
     VALUES (?, ?, '2026-01-01', '2099-12-31', 'active', 1, 0, 6)`, [gymId, `PAPD Promo ${uniq()}`]);
  await db.query('INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
    [gymId, promoId, planId]);
  await db.query(
    `INSERT INTO promotion_membership_fee_benefits (gym_id, promotion_id, duration_months, enabled, action, value)
     VALUES (?, ?, NULL, 1, 'percentage_discount', 20)`, [gymId, promoId]);
  await db.query(
    `INSERT INTO promotion_periodical (gym_id, promotion_id, product_id, quantity, \`action\`, \`value\`)
     VALUES (?, ?, ?, 3, 'waive', NULL)`, [gymId, promoId, locker]);
  const { insertId: memberId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'PAPD Member', `papd-${uniq()}@test.com`]);
  return { planId: Number(planId), promoId: Number(promoId), locker, towel, memberId: Number(memberId) };
}

/** Assigns the plan with the Promotion selected and commits it, as staff do. */
async function assignAndCommit(s: Awaited<ReturnType<typeof setup>>): Promise<number> {
  const res = await api('post', `/membership-plans/${s.planId}/assign`).send({
    owner_member_id: s.memberId, beneficiary_member_ids: [s.memberId],
    starts_at: new Date().toISOString().slice(0, 10), promotion_ids: [s.promoId],
  });
  expect(res.status).toBe(201);
  expect((await api('post', `/user-memberships/${res.body.id}/activate`).send({})).status).toBe(200);
  return Number(res.body.id);
}

function forecastCharge(body: any, kind: string, productId?: number): number | undefined {
  const line = body.billing_event_simulation?.dates?.[0]?.lines
    ?.find((l: any) => l.kind === kind && (productId == null || l.product_id === productId));
  return line?.actual_charge;
}

/** Everything the edit window reads about the Promotion, from one detail read. */
function expectPromotionReflected(body: any, s: Awaited<ReturnType<typeof setup>>) {
  const applied = body.promotions.filter((p: any) => p.status === 'applied');
  expect(applied.map((p: any) => p.promotion_id)).toEqual([s.promoId]);
  const locker = body.snapshot.periodical_benefits.find((l: any) => l.product_id === s.locker);
  const towel = body.snapshot.oneoff_benefits.find((l: any) => l.product_id === s.towel);
  expect(locker.original_price_incl_tax).toBe(20);
  expect(locker.final_price_incl_tax).toBe(0);
  // A line the Promotion does not cover keeps its own price.
  expect(towel.final_price_incl_tax).toBe(10);
  expect(body.membership_fee).toBe(40);
  // #2964: the forecast's first charge is prorated up to the plan's billing calendar (the 1st).
  expect(forecastCharge(body, 'membership_fee')).toBe(proratedToNextFirst(40));
  expect(forecastCharge(body, 'product', s.locker)).toBe(0);
}

async function applicationsOf(umId: number) {
  const { rows } = await db.query<any>(
    'SELECT id, promotion_id, status FROM user_membership_promotions WHERE gym_id = ? AND user_membership_id = ?',
    [gymId, umId]);
  return rows;
}

describe('Promotions selected at assignment survive ⋮ → Edit (#2946)', () => {
  it('the committed plan shows the Promotion it was assigned with', async () => {
    const s = await setup();
    const umId = await assignAndCommit(s);
    const res = await api('get', `/user-memberships/${umId}`);
    expect(res.status).toBe(200);
    expectPromotionReflected(res.body, s);
  });

  it('the Draft ⋮ → Edit opens carries the Promotion, its line benefit and its discount', async () => {
    const s = await setup();
    const umId = await assignAndCommit(s);
    const edit = await api('post', `/user-memberships/${umId}/edit-draft`).send({});
    expect(edit.status).toBe(201);
    const draftId = Number(edit.body.id);

    const res = await api('get', `/user-memberships/${draftId}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('in_cart');
    expectPromotionReflected(res.body, s);

    // One application each: the running plan keeps its own, the Draft holds a copy.
    expect(await applicationsOf(umId)).toHaveLength(1);
    expect(await applicationsOf(draftId)).toHaveLength(1);

    // Reopening (the idempotent edit-draft) changes nothing and duplicates nothing.
    const again = await api('post', `/user-memberships/${umId}/edit-draft`).send({});
    expect(again.status).toBe(200);
    expect(Number(again.body.id)).toBe(draftId);
    expectPromotionReflected((await api('get', `/user-memberships/${draftId}`)).body, s);
    expect(await applicationsOf(draftId)).toHaveLength(1);
  });

  it('applying the already-applied Promotion again is refused and leaves the state intact', async () => {
    const s = await setup();
    const umId = await assignAndCommit(s);
    const draftId = Number((await api('post', `/user-memberships/${umId}/edit-draft`).send({})).body.id);

    const res = await api('post', `/user-memberships/${draftId}/promotions`).send({ promotion_id: s.promoId });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await applicationsOf(draftId)).toHaveLength(1);
    expectPromotionReflected((await api('get', `/user-memberships/${draftId}`)).body, s);
  });

  it('a plain Draft adopted as the edit carries the Promotion too', async () => {
    const s = await setup();
    const umId = await assignAndCommit(s);
    // The owner's recurring-products Draft, cloned from the same Active version (#2858).
    expect((await api('post', '/product-sets/draft').send({ member_id: s.memberId })).status).toBeLessThan(300);
    const edit = await api('post', `/user-memberships/${umId}/edit-draft`).send({});
    expect(edit.status).toBe(201);
    const draftId = Number(edit.body.id);

    const res = await api('get', `/user-memberships/${draftId}`);
    expectPromotionReflected(res.body, s);
    expect(await applicationsOf(draftId)).toHaveLength(1);
  });

  it('committing the edited Draft keeps exactly one standing application', async () => {
    const s = await setup();
    const umId = await assignAndCommit(s);
    const draftId = Number((await api('post', `/user-memberships/${umId}/edit-draft`).send({})).body.id);
    const commit = await api('post', `/user-memberships/${draftId}/activate`).send({ on_conflict: 'replace' });
    expect(commit.status).toBe(200);

    const res = await api('get', `/user-memberships/${draftId}`);
    expect(res.status).toBe(200);
    expectPromotionReflected(res.body, s);
    const standing = (await applicationsOf(draftId)).filter((a: any) => a.status === 'applied');
    expect(standing).toHaveLength(1);
  });

  it('does not reveal the Draft to another gym', async () => {
    const s = await setup();
    const umId = await assignAndCommit(s);
    const draftId = Number((await api('post', `/user-memberships/${umId}/edit-draft`).send({})).body.id);
    expect((await api('get', `/user-memberships/${draftId}`, otherGymId)).status).toBe(404);
    expect((await api('post', `/user-memberships/${umId}/edit-draft`, otherGymId).send({})).status).toBe(404);
  });
});
