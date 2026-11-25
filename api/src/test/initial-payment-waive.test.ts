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
    // #3282 stage 3 — a waiver is not a discount: the line keeps its Price, so Total discounts
    // (SUM(base) − SUM(price)) is unchanged and only the Amount and VAT Amount drop.
    expect(kit.price).toBeCloseTo(kitBefore.price, 2);
    expect(kit.base_price).toBeCloseTo(kitBefore.base_price, 2);
    expect(after.initial_payment.discount_total).toBeCloseTo(before.initial_payment.discount_total, 2);
    expect(after.initial_payment.tax_total).toBeCloseTo(before.initial_payment.tax_total - kitBefore.tax_amount, 2);
    // #3284 stage 4: the last positive line is still offered Waive (the total may reach zero).
    expect(fee).toMatchObject({ waivable: true, waive_refusal: null });
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

// #3284 stage 3 — reported on the PR's issue: Waive had no effect. A plan starting mid-period charges
// a prorated Membership Fee, whose `fee_split` was read as a Pre-paid Duration, so its Waive was
// always disabled. A prorated fee with no Pre-paid Duration is waived like any other line.
describe('Initial Payment waive of a prorated Membership Fee (#3284 stage 3)', () => {
  it('the prorated fee is offered Waive, waived, and persisted at zero by Save & Pay', async () => {
    const d = new Date();
    const startsAt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 10)).toISOString().slice(0, 10);
    const { insertId: productId } = await db.query(
      `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior)
       VALUES (?, ?, 'fee', 'month', 'active', 'public', 'EUR', '15.00', 'inclusive')`, [gymId, `Locker ${uniq()}`]);
    const { insertId: planId } = await db.query(
      `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
          free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
       VALUES (?, ?, 'active', 'public', '1', 0, 12, 0, 0)`, [gymId, `Prorated Plan ${uniq()}`]);
    await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
       VALUES (?, ?, 40, '2025-01-01', 'active')`, [gymId, planId]);
    await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
       VALUES (?, ?, 1, 'month')`, [gymId, planId]);
    await db.query(`INSERT INTO membership_plan_periodical (gym_id, membership_plan_id, product_id, quantity, action, value)
       VALUES (?, ?, ?, 2, 'no_benefit', NULL)`, [gymId, planId, productId]);
    const { insertId: memberId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
      [gymId, 'Prorated Member', `prorated-${uniq()}@t.com`]);
    const res = await staff('post', `/membership-plans/${planId}/assign`)
      .send({ starts_at: startsAt, owner_member_id: memberId, beneficiary_member_ids: [memberId] });
    expect(res.status).toBe(201);
    const { rows } = await db.query<any>(
      `SELECT id FROM product_sets WHERE ${productSetOfLegacyAssignmentSql('?', 'product_sets')} ORDER BY id DESC LIMIT 1`, [res.body.id]);
    const setId = Number(rows[0].id);

    const before = await review(setId);
    const fee = before.initial_payment.lines.find((l: any) => l.fee_split != null);
    expect(fee.fee_split.prepaid).toBeNull();
    expect(fee).toMatchObject({ waivable: true, waive_refusal: null });
    expect(fee.amount).toBeGreaterThan(0);

    expect((await waive(setId, fee.line_key)).status).toBe(200);
    const after = await review(setId);
    expect(after.initial_payment.lines.find((l: any) => l.line_key === fee.line_key)).toMatchObject({ amount: 0, waived: true });
    expect(after.amount_due).toBeCloseTo(before.amount_due - fee.amount, 2);
    // #3284 stage 4: the other line, now the last one to pay, is still offered Waive.
    const other = after.initial_payment.lines.find((l: any) => l.line_key !== fee.line_key);
    expect(other).toMatchObject({ waivable: true, waive_refusal: null });

    const pay = await staff('post', `/product-sets/${setId}/save-and-pay`).send({});
    expect(pay.status).toBe(201);
    expect(pay.body.amount).toBeCloseTo(after.amount_due, 2);
    const { rows: lines } = await db.query<any>(
      'SELECT amount, line_key FROM billing_event_lines WHERE billing_event_id = ? ORDER BY id', [pay.body.billing_event_id]);
    expect(lines.find((l: any) => l.line_key === fee.line_key).amount).toBe('0.00');
  });
});

// #3284 stage 4 — reported on 25 Nov: Waive was refused (and the button disabled) whenever it would
// leave the Initial Payment at zero. A waiver may now take the whole Initial Payment to €0.00; such a
// cart is committed by the free activation, which still records the waived first period as the
// initial Billing Event (a €0.00 `waive` attempt), so it is never charged as a scheduled obligation.
describe('Initial Payment waived down to zero (#3284 stage 4)', () => {
  const productName = `Kit0-${uniq()}`;
  let setId: number;
  let before: any;

  beforeAll(async () => {
    setId = await draftWithPlanAndProduct(productName);
    before = await review(setId);
  });

  it('every line can be waived, the total reaches zero, and Revert restores it', async () => {
    const keys: string[] = before.initial_payment.lines.map((l: any) => l.line_key);
    for (const k of keys) expect((await waive(setId, k)).status).toBe(200);
    const zero = await review(setId);
    expect(zero.amount_due).toBe(0);
    expect(zero.initial_payment.total).toBe(0);
    expect(zero.payment_required).toBe(false);
    for (const l of zero.initial_payment.lines) expect(l).toMatchObject({ amount: 0, waived: true });

    expect((await revert(setId, keys[0])).status).toBe(200);
    const partial = await review(setId);
    expect(partial.amount_due).toBeCloseTo(before.initial_payment.lines[0].amount, 2);
    expect((await waive(setId, keys[0])).status).toBe(200);
  });

  it('Save & Pay owes nothing; activation records the waived first period and charges it nowhere', async () => {
    const shown = await review(setId);
    expect((await staff('post', `/product-sets/${setId}/save-and-pay`).send({})).body.error).toBe('nothing_to_pay');

    const act = await staff('post', `/product-sets/${setId}/activate`).send({});
    expect(act.status).toBe(200);
    expect(act.body.status).toBe('active');
    const { rows: set } = await db.query<any>('SELECT status, starts_at FROM product_sets WHERE id = ?', [setId]);
    expect(set[0].status).toBe('active');

    const { rows: ev } = await db.query<any>(
      `SELECT id, amount, billing_date FROM billing_events
        WHERE product_set_id = ? AND event_type = 'payment_recorded' AND is_scheduled = 0`, [setId]);
    expect(ev).toHaveLength(1);
    expect(ev[0].id).toBe(act.body.billing_event_id);
    expect(Number(ev[0].amount)).toBe(0);
    const { rows: lines } = await db.query<any>(
      'SELECT amount, line_key FROM billing_event_lines WHERE billing_event_id = ? ORDER BY id', [ev[0].id]);
    expect(lines.map((l: any) => [l.line_key, Number(l.amount)]))
      .toEqual(shown.initial_payment.lines.map((l: any) => [l.line_key, 0]));
    const { rows: pr } = await db.query<any>(
      'SELECT amount, method, status FROM payment_requests WHERE billing_event_id = ?', [ev[0].id]);
    expect(pr.map((r: any) => [Number(r.amount), r.method, r.status])).toEqual([[0, 'waive', 'completed']]);

    // The waived first period is not an obligation; later periods still are.
    const firstPeriod = String(ev[0].billing_date instanceof Date ? ev[0].billing_date.toISOString() : ev[0].billing_date).slice(0, 10);
    const { rows: sched } = await db.query<any>(
      `SELECT billing_date FROM billing_events WHERE product_set_id = ? AND is_scheduled = 1`, [setId]);
    const dates = sched.map((r: any) => String(r.billing_date instanceof Date ? r.billing_date.toISOString() : r.billing_date).slice(0, 10));
    expect(dates).not.toContain(firstPeriod);
    expect(dates.length).toBeGreaterThan(0);
  });
});
