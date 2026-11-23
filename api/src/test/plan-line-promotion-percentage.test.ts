// #3282 — a 50% Periodical Promotion on a Product the Membership Plan includes discounts that
// line by 50% through the whole path: the frozen grant, the Draft's review (Initial Payment), the
// persisted initial Billing Event Lines and the next full cycle. And where the Plan line itself is
// waived, the €0.00 line names the Waive rather than the Promotion folded over it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/** The 18th of next month: a mid-period start, on or after the 15th (#3024), always in the future. */
function nextMonth18(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return `${d.toISOString().slice(0, 8)}18`;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

async function scenario(planLineAction: 'no_benefit' | 'waive') {
  const gymId = await createTestGym(`Plan line promo ${planLineAction}`);
  await createTestMembership(gymId, 'admin');
  const { insertId: memberId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'Locker Member', `plp-${uniq()}@test.com`]);
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans
       (gym_id, name, lifecycle_status, enrollment_status, member_limit, free_periods, paid_periods, bonus_periods)
     VALUES (?, ?, 'active', 'public', '1', 0, 12, 0)`, [gymId, `PLP-Plan-${uniq()}`]);
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, 40, '2025-01-01', 'active')`, [gymId, planId]);
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`, [gymId, planId]);
  const lockerName = `Locker Rental ${uniq()}`;
  const { insertId: lockerId } = await db.query(
    `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system)
     VALUES (?, ?, 'service', 15, 'EUR', 'month', 'active', 'available', 0)`, [gymId, lockerName]);
  await db.query(
    'INSERT INTO membership_plan_periodical (gym_id, membership_plan_id, product_id, quantity, action) VALUES (?, ?, ?, 5, ?)',
    [gymId, planId, lockerId, planLineAction]);
  const { insertId: promotionId } = await db.query(
    `INSERT INTO promotions
       (gym_id, name, lifecycle_status, stackable, only_applicable_for_new_members,
        starts_at, ends_at, free_months, paid_months, bonus_months, pay_beforehand_months)
     VALUES (?, ?, 'active', 1, 0, '2025-01-01', '2030-12-31', 0, 0, 0, 0)`, [gymId, `PLP-Promo-${uniq()}`]);
  await db.query('INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
    [gymId, promotionId, planId]);
  // One month (Duration 1) of 50% off the Locker.
  await db.query(
    `INSERT INTO promotion_periodical (gym_id, promotion_id, product_id, quantity, action, value)
     VALUES (?, ?, ?, 1, 'percentage_discount', 50)`, [gymId, promotionId, lockerId]);

  const startsAt = nextMonth18();
  const assigned = await request.post(`/membership-plans/${planId}/assign`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId)
    .send({ owner_member_id: memberId, beneficiary_member_ids: [memberId], starts_at: startsAt, promotion_ids: [promotionId] });
  expect(assigned.status).toBe(201);
  const { rows: sets } = await db.query<{ id: number }>('SELECT id FROM product_sets WHERE gym_id = ?', [gymId]);
  const setId = Number(sets[0].id);
  const review = await request.get(`/product-sets/${setId}/review`)
    .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
  expect(review.status).toBe(200);
  return { gymId, setId, lockerName, review: review.body };
}

describe('a 50% Promotion on a Plan-included Product (#3282)', () => {
  let s: Awaited<ReturnType<typeof scenario>>;
  beforeAll(async () => { s = await scenario('no_benefit'); });

  it('the Initial Payment charges the prorated stretch at 50%, named as the 50% Promotion', () => {
    const line = s.review.initial_payment.lines.find((l: any) => l.name === s.lockerName);
    expect(line).toMatchObject({ quantity: 5, line_total: 75, treatment_action: 'percentage_discount', treatment_value: 50 });
    expect(line.promotion_name).toMatch(/^PLP-Promo-/);
    const { days, period_days } = line.proration;
    expect(line.amount).toBe(round2(37.5 * days / period_days));
    expect(line.amount).toBeGreaterThan(0);
  });

  it('keeps the frozen grant at percentage_discount / 50 and persists the same amount on Save & Pay', async () => {
    const { rows: anchors } = await db.query<{ id: number }>(
      'SELECT id FROM plan_snapshots WHERE gym_id = ? AND anchor_plan_snapshot_id = id', [s.gymId]);
    const umId = Number(anchors[0].id);
    const paid = await request.post(`/user-memberships/${umId}/save-and-pay`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', s.gymId).send({});
    expect(paid.status).toBe(200);

    const { rows: grants } = await db.query<{ action: string; value: string }>(
      'SELECT `action`, `value` FROM plan_promotion_periodical_product_snapshots WHERE gym_id = ?', [s.gymId]);
    expect(grants).toEqual([{ action: 'percentage_discount', value: '50.00' }]);

    const expected = s.review.initial_payment.lines.find((l: any) => l.name === s.lockerName).amount;
    const { rows: lines } = await db.query<{ amount: string; treatment_action: string; treatment_value: string }>(
      `SELECT bel.amount, bel.treatment_action, bel.treatment_value
         FROM billing_event_lines bel JOIN billing_events be ON be.id = bel.billing_event_id
        WHERE be.gym_id = ? AND be.event_type = 'payment_recorded' AND bel.item_name = ?`, [s.gymId, s.lockerName]);
    expect(lines).toEqual([{ amount: expected.toFixed(2), treatment_action: 'percentage_discount', treatment_value: '50.00' }]);
  });
});

describe('a 50% Promotion on a Plan line the Plan already waives (#3282)', () => {
  it('stays at €0.00 and names the Waive, not the Promotion', async () => {
    const s = await scenario('waive');
    const line = s.review.initial_payment.lines.find((l: any) => l.name === s.lockerName);
    expect(line).toMatchObject({ amount: 0, treatment_action: 'waive', treatment_value: null, promotion_name: null });
  });
});
