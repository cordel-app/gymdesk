// #3165 — a newly added Product's first charge follows its own billing frequency, from today:
// OneOff in full, Monthly prorated to month end, 4 weeks prorated to the next 2026-11-02 grid
// date, Yearly in full. The Summary (Review), the Billing Event Simulation and Save & Pay quote
// one figure; a replacement version owes only the new line; and no scheduled obligation charges
// the first stretch again. Integration against real MySQL; only `createPaymentRequest` is stubbed.

import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';

vi.mock('../payments', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../payments')>();
  return {
    ...mod,
    getPaymentProvider: () => {
      const real = mod.getPaymentProvider();
      return Object.assign(Object.create(real), {
        createPaymentRequest: async (p: { orderId: string }) => ({
          providerOrderId: `monei-${p.orderId}`, checkoutUrl: 'https://pay.test/x',
        }),
      });
    },
  };
});

import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER, proratedToNextFirst } from './helpers';
import { calendarAnchorOnOrBefore } from '../domain/calendarSchedule';
import { daysBetween } from '../domain/proration';

const SECRET = 'test-3165-webhook';
let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const day = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const TODAY = day(0);

const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'First Charge Member', `fc-${uniq()}@test.com`]);
  return insertId;
}

async function product(opts: {
  name: string; amount?: string; frequency?: string | null; enrollment?: 'public' | 'staff_only';
  status?: 'active' | 'inactive'; type?: string;
}): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products
       (gym_id, name, type, billing_frequency, status, enrollment_status, is_system, currency,
        amount, tax_behavior)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'EUR', ?, 'inclusive')`,
    [gymId, opts.name, opts.type ?? 'fee', opts.frequency ?? 'once', opts.status ?? 'active',
      opts.enrollment ?? 'public', opts.amount ?? '100.00']);
  return insertId;
}

async function plan(price: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', NULL, NULL, 0, 0)`, [gymId, `FC-Plan-${uniq()}`]);
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status) VALUES (?, ?, ?, ?, 'active')`,
    [gymId, insertId, price, day(-365)]);
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit) VALUES (?, ?, 1, 'month')`,
    [gymId, insertId]);
  return insertId;
}

function webhook(payload: unknown) {
  const raw = JSON.stringify(payload);
  const t = String(Math.floor(Date.now() / 1000));
  const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
  return request.post('/webhooks/payment').set({ 'monei-signature': `t=${t},v1=${v1}` })
    .set('Content-Type', 'application/json').send(raw);
}

async function pay(paymentRequestId: number) {
  const { rows } = await db.query<any>('SELECT provider_order FROM payment_requests WHERE id = ?', [paymentRequestId]);
  const id = crypto.randomBytes(12).toString('hex');
  return webhook({
    id: `evt_${id}`, type: 'charge.succeeded', objectId: id, objectType: 'charge',
    object: { id, orderId: rows[0].provider_order, status: 'SUCCEEDED' },
  });
}




const mset = (id: number) => `/product-sets/${id}`;
const firstOfNextMonth = (() => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10); })();
const plusDays = (date: string, n: number) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/** The next date of the shared 28-day grid strictly after today, and today's 4-week first charge. */
const gridToday = calendarAnchorOnOrBefore({ interval: 4, unit: 'week' }, TODAY);
const nextGridDate = gridToday === TODAY ? plusDays(TODAY, 28) : plusDays(gridToday, 28);
const fourWeekFirst = (price: number) => gridToday === TODAY
  ? price : Math.round(price / 28 * daysBetween(TODAY, nextGridDate) * 100) / 100;

async function addRecurring(m: number, productId: number): Promise<number> {
  const buy = await auth(request.post(`/members/${m}/product-purchases`)).send({ product_id: productId });
  expect(buy.status).toBe(201);
  expect(buy.body.kind).toBe('recurring_draft');
  return buy.body.product_set_id as number;
}

async function reviewDue(setId: number): Promise<number> {
  const review = await auth(request.get(`${mset(setId)}/review`));
  expect(review.status).toBe(200);
  return Number(review.body.amount_due);
}

async function initialForecast(setId: number) {
  const sim = await auth(request.get(`${mset(setId)}/billing-event-simulation`));
  expect(sim.status).toBe(200);
  const initial = sim.body.dates.filter((d: any) => d.kind === 'initial_payment');
  expect(initial).toHaveLength(1);
  return { initial: initial[0], dates: sim.body.dates as any[] };
}

/** Save & Pay, settle the payment, and answer the initial event's amount and the scheduled rows. */
async function saveAndPay(setId: number) {
  const paid = await auth(request.post(`${mset(setId)}/save-and-pay`)).send({});
  expect(paid.status).toBe(201);
  const { rows: initial } = await db.query<any>(
    `SELECT amount FROM billing_events WHERE product_set_id = ? AND event_type = 'payment_recorded'`, [setId]);
  expect(initial).toHaveLength(1);
  expect((await pay(paid.body.payment_request_id)).status).toBe(200);
  const { rows: active } = await db.query<any>('SELECT status FROM product_sets WHERE id = ?', [setId]);
  expect(active[0].status).toBe('active');
  return { initialAmount: Number(initial[0].amount) };
}

/** The scheduled obligations of a set that carry a line of `productId`. */
async function scheduledFor(setId: number, productId: number) {
  const { rows } = await db.query<any>(
    `SELECT DATE_FORMAT(be.billing_date, '%Y-%m-%d') AS d, bl.amount AS charge FROM billing_events be
       JOIN billing_event_lines bl ON bl.billing_event_id = be.id
      WHERE be.product_set_id = ? AND be.is_scheduled = 1 AND bl.product_id = ? ORDER BY be.billing_date`,
    [setId, productId]);
  return rows.map((r: any) => ({ d: r.d as string, charge: Number(r.charge) }));
}

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = SECRET;
  gymId = await createTestGym('First Charge Gym');
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

describe('a Product added to a cart with no plan is charged its first stretch by frequency (#3165)', () => {
  it('Monthly: prorated to the end of this month today, the next full amount on the 1st', async () => {
    const m = await member();
    const p = await product({ name: 'FC Monthly', frequency: 'month', amount: '31.00', type: 'service' });
    const setId = await addRecurring(m, p);
    const first = proratedToNextFirst(31);

    expect(await reviewDue(setId)).toBeCloseTo(first, 2);
    const { initial, dates } = await initialForecast(setId);
    expect(initial.date).toBe(TODAY);
    expect(Number(initial.total)).toBeCloseTo(first, 2);
    if (!TODAY.endsWith('-01')) {
      const next = dates.find((d: any) => d.date === firstOfNextMonth);
      expect(next.lines.find((l: any) => l.label === 'FC Monthly').actual_charge).toBe(31);
    }

    const { initialAmount } = await saveAndPay(setId);
    expect(initialAmount).toBeCloseTo(first, 2);
    const scheduled = await scheduledFor(setId, p);
    expect(scheduled.map((e) => e.d)).not.toContain(TODAY);
    if (!TODAY.endsWith('-01')) expect(scheduled.find((e) => e.d === firstOfNextMonth)?.charge).toBe(31);
  });

  it('4 weeks: prorated to the next date of the 2026-11-02 grid, the full amount on that date', async () => {
    const m = await member();
    const p = await product({ name: 'FC Four Weeks', frequency: 'four_weeks', amount: '28.00', type: 'service' });
    const setId = await addRecurring(m, p);
    const first = fourWeekFirst(28);

    expect(await reviewDue(setId)).toBeCloseTo(first, 2);
    const { initial, dates } = await initialForecast(setId);
    expect(initial.date).toBe(TODAY);
    expect(Number(initial.total)).toBeCloseTo(first, 2);
    expect(dates.find((d: any) => d.date === nextGridDate).lines.find((l: any) => l.label === 'FC Four Weeks').actual_charge).toBe(28);

    const { initialAmount } = await saveAndPay(setId);
    expect(initialAmount).toBeCloseTo(first, 2);
    const scheduled = await scheduledFor(setId, p);
    expect(scheduled.map((e) => e.d)).not.toContain(TODAY);
    expect(scheduled.find((e) => e.d === nextGridDate)?.charge).toBe(28);
  });

  it('Yearly: the full amount today, no proration, not scheduled again before the anniversary', async () => {
    const m = await member();
    const p = await product({ name: 'FC Yearly', frequency: 'year', amount: '120.00', type: 'service' });
    const setId = await addRecurring(m, p);

    expect(await reviewDue(setId)).toBeCloseTo(120, 2);
    const { initial } = await initialForecast(setId);
    expect(Number(initial.total)).toBeCloseTo(120, 2);

    const { initialAmount } = await saveAndPay(setId);
    expect(initialAmount).toBeCloseTo(120, 2);
    expect((await scheduledFor(setId, p)).every((e) => e.d > TODAY)).toBe(true);
  });

  it('OneOff beside a recurring Product: charged in full once, in the same Initial Payment', async () => {
    const m = await member();
    const towel = await product({ name: 'FC Towel', frequency: 'once', amount: '12.50', type: 'fee' });
    const monthly = await product({ name: 'FC Monthly Two', frequency: 'month', amount: '31.00', type: 'service' });
    const draft = await auth(request.post(`/members/${m}/product-purchases`)).send({ product_id: towel, draft: true });
    expect(draft.status).toBe(201);
    expect(draft.body.kind).toBe('one_time_draft');
    const setId = await addRecurring(m, monthly);
    const expected = 12.5 + proratedToNextFirst(31);

    expect(await reviewDue(setId)).toBeCloseTo(expected, 2);
    const { initial } = await initialForecast(setId);
    expect(Number(initial.total)).toBeCloseTo(expected, 2);

    const { initialAmount } = await saveAndPay(setId);
    expect(initialAmount).toBeCloseTo(expected, 2);
    // The one-time Product is never a scheduled obligation.
    expect(await scheduledFor(setId, towel)).toHaveLength(0);
  });
});

describe('a Product added to a running Product Set owes only the new line (#3165)', () => {
  it('charges the new Product\'s first stretch alone, never the plan or an inherited line again', async () => {
    const m = await member();
    const planId = await plan(40);
    const created = await auth(request.post('/product-sets')).send({ member_id: m, membership_plan_id: planId, starts_at: TODAY });
    expect(created.status).toBe(201);
    const held = await product({ name: 'FC Held Monthly', frequency: 'month', amount: '31.00', type: 'service' });
    expect(await addRecurring(m, held)).toBe(created.body.id);
    await saveAndPay(created.body.id);

    const added = await product({ name: 'FC Added Monthly', frequency: 'month', amount: '62.00', type: 'service' });
    const nextId = await addRecurring(m, added);
    expect(nextId).not.toBe(created.body.id);
    const first = proratedToNextFirst(62);

    expect(await reviewDue(nextId)).toBeCloseTo(first, 2);
    const { initial } = await initialForecast(nextId);
    expect(Number(initial.total)).toBeCloseTo(first, 2);
    const { initialAmount } = await saveAndPay(nextId);
    expect(initialAmount).toBeCloseTo(first, 2);
    expect((await scheduledFor(nextId, added)).map((e) => e.d)).not.toContain(TODAY);
  });

  it('charges a second line of a Product the member already holds, which is a new obligation', async () => {
    const m = await member();
    const planId = await plan(40);
    const created = await auth(request.post('/product-sets')).send({ member_id: m, membership_plan_id: planId, starts_at: TODAY });
    expect(created.status).toBe(201);
    const locker = await product({ name: 'FC Locker Monthly', frequency: 'month', amount: '31.00', type: 'service' });
    await addRecurring(m, locker);
    await saveAndPay(created.body.id);

    // The same Product again: an independent line (#1865), owed in full by its own first stretch.
    const nextId = await addRecurring(m, locker);
    expect(nextId).not.toBe(created.body.id);
    const first = proratedToNextFirst(31);
    expect(await reviewDue(nextId)).toBeCloseTo(first, 2);
    const { initial } = await initialForecast(nextId);
    expect(Number(initial.total)).toBeCloseTo(first, 2);
    const { initialAmount } = await saveAndPay(nextId);
    expect(initialAmount).toBeCloseTo(first, 2);
  });
});

describe('a Product follows its own frequency calendar, never the plan\'s billing date (#3165 stage 2)', () => {
  it('a Monthly Product beside a plan billing on the 7th is prorated to month end and bills on the 1st', async () => {
    const m = await member();
    const planId = await plan(40);
    const created = await auth(request.post('/product-sets')).send({ member_id: m, membership_plan_id: planId, starts_at: TODAY });
    expect(created.status).toBe(201);
    await saveAndPay(created.body.id);
    // A plan schedule opened before the billing calendar (#2125 M5c) bills on its own start date.
    const { rows: sched } = await db.query<any>(
      `SELECT id FROM product_set_schedules WHERE gym_id = ? AND owner_member_id = ? AND schedule_key = 'plan'`, [gymId, m]);
    expect(sched).toHaveLength(1);
    await db.query(`UPDATE product_set_schedules SET anchor_date = '2026-10-07' WHERE id = ?`, [sched[0].id]);

    const locker = await product({ name: 'FC Locker Own Calendar', frequency: 'month', amount: '31.00', type: 'service' });
    const nextId = await addRecurring(m, locker);
    const first = proratedToNextFirst(31);

    // The line is not on the plan's schedule: it has one of its own, on the 1st.
    const { rows: line } = await db.query<any>(
      `SELECT DATE_FORMAT(sch.anchor_date, '%Y-%m-%d') AS anchor, sch.schedule_key
         FROM product_set_periodical_snapshots lnk
         JOIN product_periodical_snapshots s ON s.id = lnk.product_periodical_snapshot_id
         JOIN product_set_schedules sch ON sch.id = s.schedule_id
        WHERE lnk.product_set_id = ? AND s.product_id = ?`, [nextId, locker]);
    expect(line).toHaveLength(1);
    expect(line[0].schedule_key).not.toBe('plan');
    expect(line[0].anchor.endsWith('-01')).toBe(true);

    const review = await auth(request.get(`${mset(nextId)}/review`));
    expect(review.status).toBe(200);
    expect(Number(review.body.amount_due)).toBeCloseTo(first, 2);
    const initialLine = review.body.initial_payment.lines.find((l: any) => l.name === 'FC Locker Own Calendar');
    if (TODAY.endsWith('-01')) {
      expect(initialLine.proration).toBeNull();
    } else {
      expect(initialLine.proration).toEqual({ days: daysBetween(TODAY, firstOfNextMonth), period_days: expect.any(Number) });
    }

    const { initial, dates } = await initialForecast(nextId);
    expect(Number(initial.total)).toBeCloseTo(first, 2);
    if (!TODAY.endsWith('-01')) {
      expect(dates.find((d: any) => d.date === firstOfNextMonth).lines.find((l: any) => l.label === 'FC Locker Own Calendar').actual_charge).toBe(31);
    }
    const { initialAmount } = await saveAndPay(nextId);
    expect(initialAmount).toBeCloseTo(first, 2);
    const scheduled = await scheduledFor(nextId, locker);
    expect(scheduled.map((e) => e.d)).not.toContain(TODAY);
    expect(scheduled.every((e) => e.d.endsWith('-01'))).toBe(true);
  });
});
