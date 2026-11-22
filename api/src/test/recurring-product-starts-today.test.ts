// #3167 — a recurring ad-hoc Product added to a cart whose Membership Plan starts later starts
// today, on its own: its first stretch is charged now by the initial payment, the plan keeps its
// start date, the forecast lists that charge once, and the scheduled obligations never charge it
// again. Integration against real MySQL; only the provider's `createPaymentRequest` is stubbed.

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

const SECRET = 'test-3167-webhook';
let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const day = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const TODAY = day(0);

const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Starts Today Member', `sb-${uniq()}@test.com`]);
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
     VALUES (?, ?, 'active', 'public', '1', NULL, NULL, 0, 0)`, [gymId, `SB-Plan-${uniq()}`]);
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
/** The 15th of next month: a plan start in the future and off the monthly billing calendar. */
const nextMonth15 = (() => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 15)).toISOString().slice(0, 10); })();
const firstOfNextMonth = (() => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10); })();

/** A member with a Draft (In Cart) holding a monthly plan that starts on the 15th of next month. */
async function futurePlanDraft(): Promise<{ m: number; draftId: number; planOnlyDue: number }> {
  const m = await member();
  const planId = await plan(40);
  const created = await auth(request.post('/product-sets')).send({ member_id: m, membership_plan_id: planId, starts_at: nextMonth15 });
  expect(created.status).toBe(201);
  const review = await auth(request.get(`${mset(created.body.id)}/review`));
  expect(review.status).toBe(200);
  return { m, draftId: created.body.id as number, planOnlyDue: Number(review.body.amount_due) };
}

async function addRecurring(m: number, productId: number): Promise<number> {
  const buy = await auth(request.post(`/members/${m}/product-purchases`)).send({ product_id: productId });
  expect(buy.status).toBe(201);
  return buy.body.product_set_id as number;
}

const lineStart = async (setId: number, productId: number) => (await db.query<any>(
  `SELECT DATE_FORMAT(s.starts_at, '%Y-%m-%d') AS starts_at FROM product_set_periodical_snapshots lnk
     JOIN product_periodical_snapshots s ON s.id = lnk.product_periodical_snapshot_id
    WHERE lnk.product_set_id = ? AND s.product_id = ?`, [setId, productId])).rows[0]?.starts_at;

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = SECRET;
  gymId = await createTestGym('Starts Today Gym');
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

describe('a recurring Product added beside a plan that starts later (#3167)', () => {
  it('starts today, leaves the plan\'s date alone and is charged its first stretch now, once', async () => {
    const { m, draftId, planOnlyDue } = await futurePlanDraft();
    const trainer = await product({ name: 'Monthly Trainer', frequency: 'month', amount: '31.00', type: 'service' });
    expect(await addRecurring(m, trainer)).toBe(draftId);

    // The line is dated today; the version (the plan) keeps its later start.
    expect(await lineStart(draftId, trainer)).toBe(TODAY);
    const { rows: set } = await db.query<any>(`SELECT DATE_FORMAT(starts_at, '%Y-%m-%d') AS s FROM product_sets WHERE id = ?`, [draftId]);
    expect(set[0].s).toBe(nextMonth15);

    // Initial Payment: the plan's first cycle plus the Product prorated to the end of this month.
    const stub = proratedToNextFirst(31);
    const review = await auth(request.get(`${mset(draftId)}/review`));
    expect(review.status).toBe(200);
    expect(Number(review.body.amount_due)).toBeCloseTo(planOnlyDue + stub, 2);

    // The forecast shows that charge once, dated today, and no separate group for it or for the plan's start.
    const sim = await auth(request.get(`${mset(draftId)}/billing-event-simulation`));
    expect(sim.status).toBe(200);
    const initial = sim.body.dates.filter((d: any) => d.kind === 'initial_payment');
    expect(initial).toHaveLength(1);
    expect(initial[0].date).toBe(TODAY);
    expect(Number(initial[0].total)).toBeCloseTo(planOnlyDue + stub, 2);
    expect(sim.body.dates.filter((d: any) => d.date === TODAY || d.date === nextMonth15)).toHaveLength(1);
    // The next full monthly charge falls on the 1st (unless today already is the 1st).
    if (TODAY !== firstOfNextMonth && !TODAY.endsWith('-01')) {
      const next = sim.body.dates.find((d: any) => d.date === firstOfNextMonth);
      expect(next.lines.find((l: any) => l.label === 'Monthly Trainer').actual_charge).toBe(31);
    }

    // Save & Pay charges exactly the reviewed figure, and the payment activates the version.
    const paid = await auth(request.post(`${mset(draftId)}/save-and-pay`)).send({});
    expect(paid.status).toBe(201);
    const { rows: initialEvent } = await db.query<any>(
      `SELECT amount, DATE_FORMAT(billing_date, '%Y-%m-%d') AS billing_date FROM billing_events
        WHERE product_set_id = ? AND event_type = 'payment_recorded'`, [draftId]);
    expect(Number(initialEvent[0].amount)).toBeCloseTo(planOnlyDue + stub, 2);
    expect(initialEvent[0].billing_date).toBe(TODAY);
    expect((await pay(paid.body.payment_request_id)).status).toBe(200);

    // No scheduled obligation charges today's stretch or the plan's first cycle again.
    const { rows: scheduled } = await db.query<any>(
      `SELECT DATE_FORMAT(be.billing_date, '%Y-%m-%d') AS d, be.amount FROM billing_events be
        WHERE be.product_set_id = ? AND be.is_scheduled = 1 ORDER BY be.billing_date`, [draftId]);
    expect(scheduled.map((e: any) => e.d)).not.toContain(TODAY);
    expect(scheduled.map((e: any) => e.d)).not.toContain(nextMonth15);
    if (!TODAY.endsWith('-01')) {
      const dec = scheduled.find((e: any) => e.d === firstOfNextMonth);
      expect(Number(dec.amount)).toBe(31);
    }
  });

  it('charges a yearly Product in full today, with no proration', async () => {
    const { m, draftId, planOnlyDue } = await futurePlanDraft();
    const locker = await product({ name: 'Yearly Locker', frequency: 'year', amount: '120.00', type: 'service' });
    await addRecurring(m, locker);
    expect(await lineStart(draftId, locker)).toBe(TODAY);

    const review = await auth(request.get(`${mset(draftId)}/review`));
    expect(Number(review.body.amount_due)).toBeCloseTo(planOnlyDue + 120, 2);

    const paid = await auth(request.post(`${mset(draftId)}/save-and-pay`)).send({});
    expect((await pay(paid.body.payment_request_id)).status).toBe(200);
    const { rows: scheduled } = await db.query<any>(
      `SELECT DATE_FORMAT(be.billing_date, '%Y-%m-%d') AS d FROM billing_events be
         JOIN billing_event_lines bl ON bl.billing_event_id = be.id
        WHERE be.product_set_id = ? AND be.is_scheduled = 1 AND bl.product_id = ?`, [draftId, locker]);
    // Not charged again today; its next charge is the anniversary, beyond the covered cycles.
    expect(scheduled.map((e: any) => e.d)).not.toContain(TODAY);
  });
});
