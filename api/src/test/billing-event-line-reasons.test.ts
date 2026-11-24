// #3284 stage 1 — every treatment that explains an Initial Payment line is classified (Benefit /
// Discount / Manual adjustment) and the very same reasons are persisted on the initial Billing Event
// Line by Save & Pay, then read back by the staff Billing Event detail.
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
import { productSetOfLegacyAssignmentSql } from '../domain/planAssignments';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const firstOfNextMonth = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
};
let gymId: string;
let otherGymId: string;

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = 'test-3284';
  gymId = await createTestGym('Line reasons gym');
  otherGymId = await createTestGym('Line reasons other gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
});
afterAll(async () => {
  delete process.env.MONEI_API_KEY;
  delete process.env.MONEI_WEBHOOK_SECRET;
  await db.query('DELETE FROM payment_requests WHERE gym_id IN (?, ?)', [gymId, otherGymId]);
  await db.query('DELETE FROM billing_events WHERE gym_id IN (?, ?)', [gymId, otherGymId]);
  await cleanupTestGyms();
  await db.end();
});

const staff = (method: 'get' | 'post', path: string, gym = gymId) =>
  (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);

/** A monthly plan including a one-off Product its Plan Benefit discounts 20%, plus a 10% Direct Discount. */
async function planWithTwoTreatments(productName: string): Promise<number> {
  const { insertId: productId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', 'once', 'active', 'public', 'EUR', '100.00', 'inclusive')`, [gymId, productName]);
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', 0, 12, 0, 0)`, [gymId, `Reasons Plan ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, 40, '2025-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  await db.query(
    `INSERT INTO membership_plan_oneoff (gym_id, membership_plan_id, product_id, quantity, action, value, direct_discount_percent)
     VALUES (?, ?, ?, 1, 'percentage_discount', 20, 10)`, [gymId, insertId, productId]);
  return insertId;
}

describe('Initial Payment and Billing Event Line reasons (#3284)', () => {
  let setId: number;
  let review: any;
  const productName = `Kit-${uniq()}`;

  beforeAll(async () => {
    const planId = await planWithTwoTreatments(productName);
    const { insertId: memberId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
      [gymId, 'Reasons Member', `reasons-${uniq()}@t.com`]);
    const res = await staff('post', `/membership-plans/${planId}/assign`)
      .send({ starts_at: firstOfNextMonth(), owner_member_id: memberId, beneficiary_member_ids: [memberId] });
    expect(res.status).toBe(201);
    const { rows } = await db.query<any>(
      `SELECT id FROM product_sets WHERE ${productSetOfLegacyAssignmentSql('?', 'product_sets')} ORDER BY id DESC LIMIT 1`, [res.body.id]);
    setId = Number(rows[0].id);
    const r = await staff('get', `/product-sets/${setId}/review`);
    expect(r.status).toBe(200);
    review = r.body;
  });

  it('the review keeps both treatments of one line, each with its type, in the order applied', () => {
    const line = review.initial_payment.lines.find((l: any) => l.name === productName);
    expect(line).toBeDefined();
    // 100 → −20% Plan Benefit → 80 → −10% Direct Discount → 72.
    expect(line.amount).toBeCloseTo(72, 2);
    expect(line.reasons).toEqual([
      { type: 'benefit', source: 'membership_plan', code: null, action: 'percentage_discount', value: 20, name: null },
      { type: 'manual_adjustment', source: 'personal', code: 'direct_discount', action: 'percentage_discount', value: 10, name: null },
    ]);
    const fee = review.initial_payment.lines.find((l: any) => l.name !== productName);
    expect(fee.reasons).toEqual([]);
  });

  it('Save & Pay persists the same reasons on the initial Billing Event Line, and the detail reads them', async () => {
    const pay = await staff('post', `/product-sets/${setId}/save-and-pay`).send({});
    expect(pay.status).toBe(201);
    const { rows: events } = await db.query<any>(
      `SELECT id, amount FROM billing_events WHERE product_set_id = ? AND event_type = 'payment_recorded' ORDER BY id DESC LIMIT 1`,
      [setId]);
    const eventId = Number(events[0].id);
    expect(Number(events[0].amount)).toBeCloseTo(review.amount_due, 2);

    const { rows: lines } = await db.query<any>(
      'SELECT id, item_name, amount FROM billing_event_lines WHERE billing_event_id = ? ORDER BY id', [eventId]);
    expect(lines.map((l: any) => [l.item_name, Number(l.amount)]))
      .toEqual(review.initial_payment.lines.map((l: any) => [l.name, l.amount]));
    const kit = lines.find((l: any) => l.item_name === productName);
    const { rows: stored } = await db.query<any>(
      `SELECT position, reason_type, source, reason_code, action, value, name
         FROM billing_event_line_reasons WHERE billing_event_line_id = ? ORDER BY position`, [kit.id]);
    expect(stored.map((r: any) => [r.position, r.reason_type, r.source, r.reason_code, Number(r.value)])).toEqual([
      [1, 'benefit', 'membership_plan', null, 20],
      [2, 'manual_adjustment', 'personal', 'direct_discount', 10],
    ]);

    const detail = await staff('get', `/payments/billing-events/${eventId}`);
    expect(detail.status).toBe(200);
    const detailLine = detail.body.lines.find((l: any) => l.item_name === productName);
    expect(detailLine.reasons).toEqual(review.initial_payment.lines.find((l: any) => l.name === productName).reasons);

    const other = await staff('get', `/payments/billing-events/${eventId}`, otherGymId);
    expect(other.status).toBe(404);
  });
});
