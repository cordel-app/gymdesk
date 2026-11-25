// #3282 follow-up — a Promotion reason states how long the Promotion lasts, read as
// `Promotion: <name> (3 months)`: the Draft's review (Initial Payment) carries the grant's Duration
// on the reason, Save & Pay persists it beside the reason, and the Billing Event detail reads it back.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../payments', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../payments')>();
  return {
    ...mod,
    getPaymentProvider: () => Object.assign(Object.create(mod.getPaymentProvider()), {
      createPaymentRequest: async (p: { orderId: string }) => ({ providerOrderId: `monei-${p.orderId}`, checkoutUrl: 'https://pay.test/x' }),
    }),
  };
});
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

beforeAll(() => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = 'test-3282';
});
afterAll(async () => {
  delete process.env.MONEI_API_KEY;
  delete process.env.MONEI_WEBHOOK_SECRET;
  await db.query('DELETE FROM payment_requests WHERE gym_id IN (SELECT id FROM gyms WHERE name LIKE ?)', ['Promotion duration%']);
  await db.query('DELETE FROM billing_events WHERE gym_id IN (SELECT id FROM gyms WHERE name LIKE ?)', ['Promotion duration%']);
  await cleanupTestGyms();
  await db.end();
});

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function firstOfNextMonth(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

describe('a Promotion reason carries the Promotion’s duration (#3282)', () => {
  let gymId: string;
  let otherGymId: string;
  let setId: number;
  let lockerName: string;
  let promoName: string;
  let review: any;
  const staff = (method: 'get' | 'post', path: string, gym = gymId) =>
    (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);

  beforeAll(async () => {
    gymId = await createTestGym('Promotion duration reason');
    otherGymId = await createTestGym('Promotion duration other');
    await createTestMembership(gymId, 'admin');
    await createTestMembership(otherGymId, 'admin');
    const { insertId: memberId } = await db.query(
      'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'Duration Member', `prd-${uniq()}@test.com`]);
    const { insertId: planId } = await db.query(
      `INSERT INTO membership_plans
         (gym_id, name, lifecycle_status, enrollment_status, member_limit, free_periods, paid_periods, bonus_periods)
       VALUES (?, ?, 'active', 'public', '1', 0, 12, 0)`, [gymId, `PRD-Plan-${uniq()}`]);
    await db.query(
      `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
       VALUES (?, ?, 40, '2025-01-01', 'active')`, [gymId, planId]);
    await db.query(
      `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
       VALUES (?, ?, 1, 'month')`, [gymId, planId]);
    lockerName = `Locker Rental ${uniq()}`;
    const { insertId: lockerId } = await db.query(
      `INSERT INTO products (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system)
       VALUES (?, ?, 'service', 15, 'EUR', 'month', 'active', 'available', 0)`, [gymId, lockerName]);
    await db.query(
      `INSERT INTO membership_plan_periodical (gym_id, membership_plan_id, product_id, quantity, action)
       VALUES (?, ?, ?, 1, 'no_benefit')`, [gymId, planId, lockerId]);
    promoName = `Todos los productos al 50% ${uniq()}`;
    const { insertId: promotionId } = await db.query(
      `INSERT INTO promotions
         (gym_id, name, lifecycle_status, stackable, only_applicable_for_new_members,
          starts_at, ends_at, free_months, paid_months, bonus_months, pay_beforehand_months)
       VALUES (?, ?, 'active', 1, 0, '2025-01-01', '2030-12-31', 0, 0, 0, 0)`, [gymId, promoName]);
    await db.query('INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
      [gymId, promotionId, planId]);
    // Duration 3 (#1135): three of the Locker's monthly periods at 50%.
    await db.query(
      `INSERT INTO promotion_periodical (gym_id, promotion_id, product_id, quantity, action, value)
       VALUES (?, ?, ?, 3, 'percentage_discount', 50)`, [gymId, promotionId, lockerId]);

    const assigned = await staff('post', `/membership-plans/${planId}/assign`)
      .send({ owner_member_id: memberId, beneficiary_member_ids: [memberId], starts_at: firstOfNextMonth(), promotion_ids: [promotionId] });
    expect(assigned.status).toBe(201);
    const { rows: sets } = await db.query<{ id: number }>('SELECT id FROM product_sets WHERE gym_id = ?', [gymId]);
    setId = Number(sets[0].id);
    const r = await staff('get', `/product-sets/${setId}/review`);
    expect(r.status).toBe(200);
    review = r.body;
  });

  it('the Initial Payment reason names the Promotion with its Duration in the Product’s periods', () => {
    const line = review.initial_payment.lines.find((l: any) => l.name === lockerName);
    expect(line.reasons).toEqual([{
      type: 'discount', source: 'promotion', code: null, action: 'percentage_discount', value: 50, name: promoName,
      duration: { count: 3, unit: 'month' },
    }]);
  });

  it('Save & Pay persists the duration and the Billing Event detail reads it back', async () => {
    const pay = await staff('post', `/product-sets/${setId}/save-and-pay`).send({});
    expect(pay.status).toBe(201);
    const { rows: events } = await db.query<any>(
      `SELECT id FROM billing_events WHERE product_set_id = ? AND event_type = 'payment_recorded' ORDER BY id DESC LIMIT 1`, [setId]);
    const eventId = Number(events[0].id);
    const { rows: stored } = await db.query<any>(
      `SELECT r.name, r.duration_count, r.duration_unit
         FROM billing_event_line_reasons r JOIN billing_event_lines l ON l.id = r.billing_event_line_id
        WHERE l.billing_event_id = ? AND l.item_name = ?`, [eventId, lockerName]);
    expect(stored).toEqual([{ name: promoName, duration_count: 3, duration_unit: 'month' }]);

    const detail = await staff('get', `/payments/billing-events/${eventId}`);
    expect(detail.status).toBe(200);
    const line = detail.body.lines.find((l: any) => l.item_name === lockerName);
    expect(line.reasons[0].duration).toEqual({ count: 3, unit: 'month' });
    expect((await staff('get', `/payments/billing-events/${eventId}`, otherGymId)).status).toBe(404);
  });
});
