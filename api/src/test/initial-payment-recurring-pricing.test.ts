// #3360 — a recurring Product line with a quantity, a Product Promotion and a direct discount,
// joining its monthly calendar mid-month: the Initial Payment applies each discount once, keeps
// the quantity, prorates the discounted line, states its regular (list) price before discounts and
// never counts the proration as a discount; Save & Pay persists exactly what the review showed.
// Integration against real MySQL; only the provider's createPaymentRequest is stubbed.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';

vi.mock('../payments', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../payments')>();
  return {
    ...mod,
    getPaymentProvider: () => Object.assign(Object.create(mod.getPaymentProvider()), {
      createPaymentRequest: async (p: { orderId: string }) => ({ providerOrderId: `monei-${p.orderId}`, checkoutUrl: 'https://pay.test/x' }),
    }),
  };
});

import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const r2 = (n: number) => Math.round(n * 100) / 100;

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = 'test-3360';
  gymId = await createTestGym('Recurring pricing gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  delete process.env.MONEI_API_KEY;
  delete process.env.MONEI_WEBHOOK_SECRET;
  await db.query('DELETE FROM payment_requests WHERE gym_id = ?', [gymId]);
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

async function addLocker(opts: { quantity: number; promo: boolean; direct: number | null }) {
  const { insertId: memberId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Locker Member', `lk-${uniq()}@t.com`]);
  const name = `Locker-${uniq()}`;
  const { insertId: productId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, is_system, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', 'month', 'active', 'public', 0, 'EUR', '30.00', 'inclusive')`, [gymId, name]);
  const promotionIds: number[] = [];
  let promoName: string | null = null;
  if (opts.promo) {
    promoName = `Half-${uniq()}`;
    const { insertId: promoId } = await db.query(
      `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, applies_to, stackable,
          only_applicable_for_new_members, free_months, paid_months, bonus_months)
       VALUES (?, ?, '2026-01-01', '2099-12-31', 'active', 'product', 1, 0, 0, 6, 0)`, [gymId, promoName]);
    await db.query(
      `INSERT INTO promotion_periodical (gym_id, promotion_id, product_id, quantity, \`action\`, \`value\`)
       VALUES (?, ?, ?, 12, 'percentage_discount', 50)`, [gymId, promoId, productId]);
    promotionIds.push(promoId);
  }
  const res = await auth(request.post(`/members/${memberId}/product-purchases`)).send({
    product_id: productId, quantity: opts.quantity, promotion_ids: promotionIds,
    ...(opts.direct != null ? { direct_discount_percent: opts.direct } : {}),
  });
  expect(res.status).toBe(201);
  return { memberId, name, promoName, setId: Number(res.body.product_set_id) };
}

async function review(setId: number, name: string) {
  const res = await auth(request.get(`/product-sets/${setId}/review`));
  expect(res.status).toBe(200);
  const line = res.body.initial_payment.lines.find((l: any) => l.name === name);
  expect(line).toBeDefined();
  const ratio = line.proration ? line.proration.days / line.proration.period_days : 1;
  return { body: res.body, line, ratio };
}

describe('Initial Payment of a recurring Product (#3360)', () => {
  it('quantity 2, 50% Promotion and 10% direct discount: each discount once, quantity kept, prorated', async () => {
    const { setId, name, promoName } = await addLocker({ quantity: 2, promo: true, direct: 10 });
    const { body, line, ratio } = await review(setId, name);
    // 30 × 2 = 60 regular; × 0.5 × 0.9 = 27.00 for a whole month; prorated to the days charged.
    expect(line).toEqual(expect.objectContaining({
      quantity: 2, unit_price: 30, line_total: r2(60 * ratio), amount: r2(27 * ratio),
    }));
    expect(line.discount).toBeCloseTo(r2(r2(60 * ratio) - r2(27 * ratio)), 2);
    expect(line.reasons.map((r: any) => [r.type, r.code, r.value, r.name])).toEqual([
      ['manual_adjustment', 'direct_discount', 10, null],
      ['discount', null, 50, promoName],
    ]);
    const ip = body.initial_payment;
    expect(ip.total_before_discounts).toBe(line.line_total);
    expect(r2(ip.total_before_discounts - ip.discount_total)).toBe(ip.total);
    expect(ip.total).toBe(body.amount_due);
    expect(body.financial_summary.initial_discounts).toBe(line.discount);
  });

  it('quantity 2 with no discount: the proration is not reported as a discount', async () => {
    const { setId, name } = await addLocker({ quantity: 2, promo: false, direct: null });
    const { line, ratio } = await review(setId, name);
    expect(line).toEqual(expect.objectContaining({ quantity: 2, unit_price: 30, line_total: r2(60 * ratio), discount: 0, amount: r2(60 * ratio) }));
  });

  it('changing the quantity updates the charge, and Save & Pay persists exactly what the review showed', async () => {
    const { memberId, setId, name } = await addLocker({ quantity: 1, promo: true, direct: 10 });
    const { rows } = await db.query<any>(
      `SELECT s.source_id FROM product_set_periodical_snapshots lnk
         JOIN product_periodical_snapshots s ON s.id = lnk.product_periodical_snapshot_id
        WHERE lnk.product_set_id = ?`, [setId]);
    const put = await auth(request.put(`/members/${memberId}/product-purchases/recurring/${rows[0].source_id}`)).send({ quantity: 2 });
    expect(put.status).toBe(200);
    const { body, line, ratio } = await review(setId, name);
    expect(line).toEqual(expect.objectContaining({ quantity: 2, line_total: r2(60 * ratio), amount: r2(27 * ratio) }));

    const pay = await auth(request.post(`/product-sets/${setId}/save-and-pay`)).send({});
    expect(pay.status).toBe(201);
    const { rows: events } = await db.query<any>(
      `SELECT id, amount FROM billing_events WHERE product_set_id = ? AND event_type = 'payment_recorded' ORDER BY id DESC LIMIT 1`, [setId]);
    expect(Number(events[0].amount)).toBeCloseTo(body.amount_due, 2);
    const { rows: stored } = await db.query<any>(
      'SELECT quantity, amount, regular_unit_price FROM billing_event_lines WHERE billing_event_id = ? AND item_name = ?', [events[0].id, name]);
    expect(stored.map((l: any) => [Number(l.quantity), Number(l.amount), Number(l.regular_unit_price)]))
      .toEqual([[2, line.amount, 60]]);
  });
});
