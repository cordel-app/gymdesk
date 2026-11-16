// #2947 — the Product Set Summary's Initial Payment states each line's VAT rate and
// amount (its plan's own rate, else the gym's system rate), taxed on the line's final
// amount, and Total VAT is their sum. Before the fix every line read `—` / 0.00 €.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const today = () => new Date().toISOString().slice(0, 10);
let gymId: string;
let reducedRateId: number;

beforeAll(async () => {
  gymId = await createTestGym();
  await createTestMembership(gymId, 'admin');
  await db.query(`DELETE FROM tax_rates WHERE gym_id = ?`, [gymId]);
  await db.query(`INSERT INTO tax_rates (gym_id, name, rate_percent, is_system, status) VALUES (?, 'Standard VAT', 21, 1, 'active')`, [gymId]);
  reducedRateId = (await db.query(
    `INSERT INTO tax_rates (gym_id, name, rate_percent, is_system, status) VALUES (?, 'Reduced VAT', 10, 0, 'active')`, [gymId])).insertId;
});
afterAll(async () => {
  await db.query('DELETE FROM payment_requests WHERE gym_id = ?', [gymId]);
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

const staff = (method: 'get' | 'post', path: string) =>
  (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function plan(price: number, taxRateId: number | null): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods, tax_rate_id)
     VALUES (?, ?, 'active', 'public', '1', 0, 12, 0, 0, ?)`, [gymId, `VAT Plan ${uniq()}`, taxRateId]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, ?, '2025-01-01', 'active')`, [gymId, insertId, price]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return insertId;
}

async function reviewOfNewAssignment(planId: number) {
  const { insertId: memberId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'VAT Member', `vat-${uniq()}@t.com`]);
  const res = await staff('post', `/membership-plans/${planId}/assign`)
    .send({ starts_at: today(), owner_member_id: memberId, beneficiary_member_ids: [memberId] });
  expect(res.status).toBe(201);
  const { rows } = await db.query<any>(
    'SELECT id FROM product_sets WHERE user_membership_id = ? ORDER BY id DESC LIMIT 1', [res.body.id]);
  const review = await staff('get', `/product-sets/${rows[0].id}/review`);
  expect(review.status).toBe(200);
  return review.body;
}

describe('Initial Payment VAT (#2947)', () => {
  it("taxes the Membership Fee at the plan's own rate", async () => {
    const body = await reviewOfNewAssignment(await plan(55, reducedRateId));
    const p = body.initial_payment;
    const fee = p.lines[0];
    expect(fee.amount).toBe(55);
    expect(fee.tax_rate_percent).toBe(10);
    expect(fee.tax_amount).toBe(5);
    expect(p.tax_total).toBe(5);
    expect(p.subtotal_excl_tax).toBe(50);
    expect(p.taxes).toEqual([{ rate_percent: 10, base: 50, tax: 5 }]);
    expect(p.total).toBe(55);
  });

  it("taxes a plan on Default at the gym's system rate, and Total VAT is the lines' sum", async () => {
    const body = await reviewOfNewAssignment(await plan(121, null));
    const p = body.initial_payment;
    expect(p.lines.every((l: any) => l.tax_rate_percent === 21)).toBe(true);
    expect(p.tax_total).toBe(Math.round(p.lines.reduce((n: number, l: any) => n + l.tax_amount, 0) * 100) / 100);
    expect(p.tax_total).toBe(21);
    expect(Math.round((p.subtotal_excl_tax + p.tax_total) * 100) / 100).toBe(p.total);
  });
});
