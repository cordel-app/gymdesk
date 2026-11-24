// #3284 stage 2 — staff waive one Initial Payment line of an In Cart Product Set and revert it. The
// waiver is stored on the cart, applied by `initialCharge()` after the engine priced the line, and
// Save & Pay persists exactly the waived lines the review showed (amount 0, the original reasons and
// the `initial_payment_waive` manual adjustment, the same `line_key`).
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
  process.env.MONEI_WEBHOOK_SECRET = 'test-3284-2';
  gymId = await createTestGym('Waive gym');
  otherGymId = await createTestGym('Waive other gym');
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
     VALUES (?, ?, 'active', 'public', '1', 0, 12, 0, 0)`, [gymId, `Waive Plan ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, 40, '2025-01-01', 'active')`, [gymId, planId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`, [gymId, planId]);
  await db.query(
    `INSERT INTO membership_plan_oneoff (gym_id, membership_plan_id, product_id, quantity, action, value)
     VALUES (?, ?, ?, 1, 'percentage_discount', 20)`, [gymId, planId, productId]);
  const { insertId: memberId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Waive Member', `waive-${uniq()}@t.com`]);
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
const waive = (setId: number, key: unknown, gym = gymId) =>
  staff('post', `/product-sets/${setId}/initial-payment/waive`, gym).send({ line_key: key });
const revert = (setId: number, key: unknown) =>
  staff('post', `/product-sets/${setId}/initial-payment/revert-waive`).send({ line_key: key });

describe('Initial Payment per-line waive (#3284 stage 2)', () => {
  const productName = `Kit-${uniq()}`;
  let setId: number;
  let before: any;
  let kitKey: string;
  let feeKey: string;

  beforeAll(async () => {
    setId = await draftWithPlanAndProduct(productName);
    before = await review(setId);
    kitKey = lineNamed(before, productName).line_key;
    feeKey = before.initial_payment.lines.find((l: any) => l.name !== productName).line_key;
  });

  it('every line carries a stable key and is offered Waive; reads repeat the same keys', async () => {
    expect(kitKey).toEqual(expect.any(String));
    expect(feeKey).toEqual(expect.any(String));
    expect(kitKey).not.toBe(feeKey);
    for (const l of before.initial_payment.lines) expect(l).toMatchObject({ waived: false, waivable: true });
    const again = await review(setId);
    expect(again.initial_payment.lines.map((l: any) => l.line_key)).toEqual(before.initial_payment.lines.map((l: any) => l.line_key));
  });

  it('refuses an unauthenticated call, another gym, a missing key and an unknown line', async () => {
    expect((await (request as any).post(`/product-sets/${setId}/initial-payment/waive`).send({ line_key: kitKey })).status).toBe(401);
    expect((await waive(setId, kitKey, otherGymId)).status).toBe(404);
    expect((await waive(setId, '')).status).toBe(400);
    expect((await waive(setId, 'item:0:0:0#9')).status).toBe(404);
  });

  it('Waive takes only that line to zero, keeps its price and reasons, and recalculates the totals', async () => {
    const res = await waive(setId, kitKey);
    expect(res.status).toBe(200);
    const after = await review(setId);
    const kitBefore = lineNamed(before, productName);
    const kit = lineNamed(after, productName);
    expect(kit).toMatchObject({ amount: 0, tax_amount: 0, waived: true, line_key: kitKey });
    expect(kit.quantity).toBe(kitBefore.quantity);
    expect(kit.unit_price).toBeCloseTo(kitBefore.unit_price, 2);
    expect(kit.line_total).toBeCloseTo(kitBefore.line_total, 2);
    expect(kit.discount).toBeCloseTo(kitBefore.line_total, 2);
    expect(kit.reasons).toEqual([
      ...kitBefore.reasons,
      { type: 'manual_adjustment', source: 'personal', code: 'initial_payment_waive', action: 'waive', value: null, name: null },
    ]);
    const fee = after.initial_payment.lines.find((l: any) => l.line_key === feeKey);
    expect(fee.amount).toBeCloseTo(before.initial_payment.lines.find((l: any) => l.line_key === feeKey).amount, 2);
    expect(after.amount_due).toBeCloseTo(before.amount_due - kitBefore.amount, 2);
    expect(after.initial_payment.total).toBeCloseTo(after.amount_due, 2);
    expect(after.initial_payment.discount_total).toBeCloseTo(before.initial_payment.discount_total + kitBefore.amount, 2);
    expect(after.initial_payment.tax_total).toBeCloseTo(before.initial_payment.tax_total - kitBefore.tax_amount, 2);
    // The last positive line cannot be waived: the Initial Payment must keep a charge.
    expect(fee.waivable).toBe(false);
    expect((await waive(setId, feeKey)).body.error).toBe('would_leave_nothing_to_pay');
    expect((await waive(setId, kitKey)).body.error).toBe('already_waived');

    // recordAudit is fire-and-forget: poll briefly for the row it writes.
    let actions: string[] = [];
    for (let i = 0; i < 20 && !actions.includes('waive_initial_payment_line'); i++) {
      const { rows } = await db.query<any>(
        `SELECT action FROM audit_logs WHERE gym_id = ? AND entity_type = 'product_set' AND entity_id = ?`, [gymId, String(setId)]);
      actions = rows.map((r: any) => String(r.action));
      if (!actions.includes('waive_initial_payment_line')) await new Promise((r) => setTimeout(r, 100));
    }
    expect(actions).toContain('waive_initial_payment_line');
  });

  it('Revert waive restores the server-calculated amount and reasons exactly', async () => {
    expect((await revert(setId, kitKey)).status).toBe(200);
    const after = await review(setId);
    expect(after.amount_due).toBeCloseTo(before.amount_due, 2);
    expect(lineNamed(after, productName)).toEqual(lineNamed(before, productName));
    expect((await revert(setId, kitKey)).body.error).toBe('not_waived');
  });

  it('Save & Pay charges the waived review and persists the same lines, keys and reasons', async () => {
    expect((await waive(setId, kitKey)).status).toBe(200);
    const shown = await review(setId);
    const pay = await staff('post', `/product-sets/${setId}/save-and-pay`).send({});
    expect(pay.status).toBe(201);
    expect(pay.body.amount).toBeCloseTo(shown.amount_due, 2);
    const { rows: pr } = await db.query<any>('SELECT amount FROM payment_requests WHERE id = ?', [pay.body.payment_request_id]);
    expect(Number(pr[0].amount)).toBeCloseTo(shown.amount_due, 2);

    const { rows: lines } = await db.query<any>(
      'SELECT id, item_name, amount, line_key FROM billing_event_lines WHERE billing_event_id = ? ORDER BY id', [pay.body.billing_event_id]);
    expect(lines.map((l: any) => [l.line_key, Number(l.amount)]))
      .toEqual(shown.initial_payment.lines.map((l: any) => [l.line_key, l.amount]));
    const kit = lines.find((l: any) => l.line_key === kitKey);
    const { rows: stored } = await db.query<any>(
      `SELECT reason_type, source, reason_code, action FROM billing_event_line_reasons
        WHERE billing_event_line_id = ? ORDER BY position`, [kit.id]);
    expect(stored.at(-1)).toEqual({ reason_type: 'manual_adjustment', source: 'personal', reason_code: 'initial_payment_waive', action: 'waive' });
    expect(stored.length).toBe(lineNamed(shown, productName).reasons.length);

    // Once the cart has left In Cart, nothing can be waived or reverted.
    expect((await waive(setId, feeKey)).status).toBe(409);
    expect((await revert(setId, kitKey)).status).toBe(409);
  });

  it('a waiver changes no configuration: the plan line keeps its own treatment', async () => {
    const { rows } = await db.query<any>(
      `SELECT s.action, s.value FROM plan_oneoff_snapshots s
         JOIN product_set_plan_snapshots psj ON psj.plan_snapshot_id = s.plan_snapshot_id
        WHERE psj.product_set_id = ?`, [setId]);
    expect(rows.map((r: any) => [r.action, Number(r.value)])).toEqual([['percentage_discount', 20]]);
  });
});
