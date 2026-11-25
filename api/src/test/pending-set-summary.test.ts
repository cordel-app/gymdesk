// #3307 stage 5 — the Summary of a version awaiting payment keeps the In Cart detail: its review
// states the Initial Payment Save & Pay persisted (the initial Billing Event and its lines), never a
// re-price, with nothing waivable, and reading it writes nothing.
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
  process.env.MONEI_WEBHOOK_SECRET = 'test-3307-5';
  gymId = await createTestGym('Pending summary gym');
  otherGymId = await createTestGym('Pending summary other gym');
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

/** A monthly €40 plan including a €100 one-off Product its Plan Benefit discounts 20%. */
async function draftWithPlanAndProduct(productName: string): Promise<number> {
  const { insertId: productId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', 'once', 'active', 'public', 'EUR', '100.00', 'inclusive')`, [gymId, productName]);
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', 0, 12, 0, 0)`, [gymId, `Pending Summary Plan ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, 40, '2025-01-01', 'active')`, [gymId, planId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`, [gymId, planId]);
  await db.query(
    `INSERT INTO membership_plan_oneoff (gym_id, membership_plan_id, product_id, quantity, action, value)
     VALUES (?, ?, ?, 1, 'percentage_discount', 20)`, [gymId, planId, productId]);
  const { insertId: memberId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Pending Summary Member', `pending-summary-${uniq()}@t.com`]);
  const res = await staff('post', `/membership-plans/${planId}/assign`)
    .send({ starts_at: firstOfNextMonth(), owner_member_id: memberId, beneficiary_member_ids: [memberId] });
  expect(res.status).toBe(201);
  const { rows } = await db.query<any>(
    `SELECT id FROM product_sets WHERE ${productSetOfLegacyAssignmentSql('?', 'product_sets')} ORDER BY id DESC LIMIT 1`, [res.body.id]);
  return Number(rows[0].id);
}

const review = async (setId: number) => {
  const r = await staff('get', `/product-sets/${setId}/review`);
  expect(r.status).toBe(200);
  return r.body;
};
const lineNamed = (body: any, name: string) => body.initial_payment.lines.find((l: any) => l.name === name);

describe('review of a version awaiting payment (#3307 stage 5)', () => {
  const productName = `Kit-${uniq()}`;
  let setId: number;
  let shown: any;
  let pay: any;

  beforeAll(async () => {
    setId = await draftWithPlanAndProduct(productName);
    const kitKey = lineNamed(await review(setId), productName).line_key;
    expect((await staff('post', `/product-sets/${setId}/initial-payment/waive`).send({ line_key: kitKey })).status).toBe(200);
    shown = await review(setId);
    pay = await staff('post', `/product-sets/${setId}/save-and-pay`).send({});
    expect(pay.status).toBe(201);
  });

  it('keeps the In Cart detail: the persisted Initial Payment and the contracted items', async () => {
    const after = await review(setId);
    expect(after.status).toBe('pending_payment');
    expect(after.error).toBeNull();
    expect(after.amount_due).toBeCloseTo(pay.body.amount, 2);
    expect(after.initial_payment.total).toBeCloseTo(pay.body.amount, 2);
    expect(after.initial_payment.lines.map((l: any) => [l.line_key, l.amount, l.waived]))
      .toEqual(shown.initial_payment.lines.map((l: any) => [l.line_key, l.amount, l.waived]));
    expect(lineNamed(after, productName)).toMatchObject({ waived: true, amount: 0 });
    for (const l of after.initial_payment.lines) expect(l.waivable).toBe(false);
    expect(lineNamed(after, productName).reasons).toEqual(lineNamed(shown, productName).reasons);
    // The same contracted plans and Products (Save & Pay splits a plan line per member, so who
    // holds an included Product is only filled in once committed).
    const ids = (items: any[]) => items.map((i: any) => [i.kind, i.name, (i.included ?? []).map((x: any) => x.name)]);
    expect(ids(after.contracted_items)).toEqual(ids(shown.contracted_items));
    expect(after.contracted_items.length).toBeGreaterThan(0);
  });

  it('states the committed figures even when the catalogue changes afterwards', async () => {
    await db.query('UPDATE products SET amount = ? WHERE gym_id = ? AND name = ?', ['999.00', gymId, productName]);
    await db.query('UPDATE membership_plan_prices SET price = 400 WHERE gym_id = ?', [gymId]);
    const after = await review(setId);
    expect(after.amount_due).toBeCloseTo(pay.body.amount, 2);
  });

  it('reading the review writes no Billing Event or payment request, and the waive stays refused', async () => {
    const count = async () => {
      const { rows } = await db.query<any>(
        `SELECT (SELECT COUNT(*) FROM billing_events WHERE product_set_id = ?) AS ev,
                (SELECT COUNT(*) FROM payment_requests pr JOIN billing_events be ON be.id = pr.billing_event_id
                  WHERE be.product_set_id = ?) AS pr`, [setId, setId]);
      return [Number(rows[0].ev), Number(rows[0].pr)];
    };
    const before = await count();
    await review(setId);
    await review(setId);
    expect(await count()).toEqual(before);
    const key = shown.initial_payment.lines[0].line_key;
    expect((await staff('post', `/product-sets/${setId}/initial-payment/waive`).send({ line_key: key })).status).not.toBe(200);
  });

  it('another gym cannot read it', async () => {
    expect((await staff('get', `/product-sets/${setId}/review`, otherGymId)).status).toBe(404);
  });
});
