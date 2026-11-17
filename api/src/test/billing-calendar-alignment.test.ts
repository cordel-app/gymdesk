// #2964 — the initial payment is prorated up to the shared billing calendar
// (the 1st of the month, the 28-day grid from 2026-11-02) and every later charge
// falls on it, for Membership Plans and recurring Products alike; the review, the
// Product Set's simulation and the Assigned Plan card's forecast all say what
// Save & Pay charges, and nothing is written until Save & Pay. Integration
// against real MySQL; only the provider's `createPaymentRequest` is stubbed.

import crypto from 'crypto';
import { productSetOfLegacyAssignmentSql } from '../domain/planAssignments';
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

import { advanceBillingDate } from '../domain/billingDate';
import { daysBetween } from '../domain/proration';
import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';

const SECRET = 'test-2964-webhook';
let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const day = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const TODAY = day(0);

const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Staff Buy Member', `sb-${uniq()}@test.com`]);
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

async function plan(price: number, cadence: { interval: number; unit: string } = { interval: 1, unit: 'month' }): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', NULL, NULL, 0, 0)`, [gymId, `SB-Plan-${uniq()}`]);
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status) VALUES (?, ?, ?, ?, 'active')`,
    [gymId, insertId, price, day(-365)]);
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit) VALUES (?, ?, ?, ?)`,
    [gymId, insertId, cadence.interval, cadence.unit]);
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
const FOUR_WEEKS = { interval: 4, unit: 'week' };

/** The next date of the billing calendar strictly after `from`, as the issue states it. */
function nextCalendarDate(from: string, grid: 'month' | 'four_week'): string {
  if (grid === 'month') return advanceBillingDate(`${from.slice(0, 8)}01`, 1, 'month');
  const ms = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
  const steps = Math.floor(Math.round((ms(from) - ms('2026-11-02')) / 86_400_000) / 28) + 1;
  return new Date(ms('2026-11-02') + steps * 28 * 86_400_000).toISOString().slice(0, 10);
}

/** What the first stretch costs: price ÷ period days × days to the next calendar date. */
function firstStretch(price: number, grid: 'month' | 'four_week'): { days: number; amount: number } {
  const period = grid === 'month' ? 31 : 28;
  const days = Math.min(daysBetween(TODAY, nextCalendarDate(TODAY, grid)), period);
  return { days, amount: Math.round((price / period) * days * 100) / 100 };
}

/** A start on a calendar date owes a full first period, which is not what these tests prove. */
const onGrid = (grid: 'month' | 'four_week') => grid === 'month'
  ? TODAY.endsWith('-01')
  : daysBetween(TODAY, nextCalendarDate(TODAY, grid)) === 28;

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = SECRET;
  gymId = await createTestGym('Billing Calendar Gym');
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

const eventCount = async (setId: number) => Number((await db.query<any>(
  'SELECT COUNT(*) AS n FROM billing_events WHERE product_set_id = ?', [setId])).rows[0].n);

describe('a 4-weekly item is prorated to the shared 28-day calendar (#2964)', () => {
  it('a 4-weekly Membership Plan: review, simulation and Save & Pay agree, later charges every 28 days', async () => {
    if (onGrid('four_week')) return; // a start on a calendar date is a full period, not prorated
    const m = await member();
    const planId = await plan(28, FOUR_WEEKS);
    const created = await auth(request.post('/product-sets')).send({ member_id: m, membership_plan_id: planId, starts_at: TODAY });
    expect(created.status).toBe(201);
    const setId = created.body.id as number;
    const { days, amount } = firstStretch(28, 'four_week');
    const next = nextCalendarDate(TODAY, 'four_week');

    const review = await auth(request.get(`${mset(setId)}/review`));
    expect(Number(review.body.amount_due)).toBe(amount);
    const sim = await auth(request.get(`${mset(setId)}/billing-event-simulation`));
    const initial = sim.body.dates.find((d: any) => d.kind === 'initial_payment');
    expect(initial.date).toBe(TODAY);
    expect(initial.lines[0].proration).toEqual({ prorated_days: days, period_days: 28 });
    const scheduled = sim.body.dates.filter((d: any) => d.kind === 'scheduled').map((d: any) => d.date);
    expect(scheduled.slice(0, 2)).toEqual([next, advanceBillingDate(next, 4, 'week')]);
    // Recalculating the cart writes nothing (AC 6).
    expect(await eventCount(setId)).toBe(0);

    const sp = await auth(request.post(`${mset(setId)}/save-and-pay`)).send({});
    expect(sp.status).toBe(201);
    const { rows: initialEvent } = await db.query<any>('SELECT amount FROM billing_events WHERE product_set_id = ?', [setId]);
    expect(Number(initialEvent[0].amount)).toBe(amount);
    expect((await pay(sp.body.payment_request_id)).status).toBe(200);
    const { rows: obligations } = await db.query<any>(
      `SELECT DATE_FORMAT(billing_date, '%Y-%m-%d') AS d, amount FROM billing_events
        WHERE product_set_id = ? AND is_scheduled = 1 ORDER BY billing_date`, [setId]);
    expect(obligations.map((r: any) => r.d)).toEqual([next, advanceBillingDate(next, 4, 'week')]);
    expect(obligations.every((r: any) => Number(r.amount) === 28)).toBe(true);
  });

  it('a 4-weekly recurring Product bought with no plan is prorated to the same calendar', async () => {
    if (onGrid('four_week')) return;
    const m = await member();
    const locker = await product({ name: 'Locker 4W', frequency: 'four_weeks', amount: '28.00', type: 'service' });
    const buy = await auth(request.post(`/members/${m}/product-purchases`)).send({ product_id: locker });
    expect(buy.status).toBe(201);
    const setId = buy.body.product_set_id as number;
    const { days, amount } = firstStretch(28, 'four_week');
    expect(Number((await auth(request.get(`${mset(setId)}/review`))).body.amount_due)).toBe(amount);
    const sim = await auth(request.get(`${mset(setId)}/billing-event-simulation`));
    const line = sim.body.dates.find((d: any) => d.kind === 'initial_payment').lines[0];
    expect(line.proration).toEqual({ prorated_days: days, period_days: 28 });
    expect(sim.body.dates.find((d: any) => d.kind === 'scheduled').date).toBe(nextCalendarDate(TODAY, 'four_week'));
  });
});

describe('the Assigned Plan card forecasts the calendar-aligned charge Save & Pay makes (#2964)', () => {
  for (const grid of ['month', 'four_week'] as const) {
    it(`a ${grid === 'month' ? 'monthly' : '4-weekly'} plan assigned from the Admin`, async () => {
      if (onGrid(grid)) return;
      const m = await member();
      const price = grid === 'month' ? 31 : 28;
      const planId = await plan(price, grid === 'month' ? { interval: 1, unit: 'month' } : FOUR_WEEKS);
      const assigned = await auth(request.post('/user-memberships')).send({ member_id: m, membership_plan_id: planId, starts_at: TODAY });
      expect(assigned.status).toBe(201);
      const { days, amount } = firstStretch(price, grid);
      const next = nextCalendarDate(TODAY, grid);

      // Before the fix this forecast billed the full price on the start date and every
      // period after it on the start's day of the month, while Save & Pay charged the
      // prorated stretch and the obligations fell on the calendar.
      const forecast = await auth(request.get(`/user-memberships/${assigned.body.id}/billing-event-simulation`));
      expect(forecast.status).toBe(200);
      const [first, second] = forecast.body.dates;
      expect(first.date).toBe(TODAY);
      expect(first.lines[0].actual_charge).toBe(amount);
      expect(first.lines[0].proration).toEqual({ prorated_days: days, period_days: price });
      expect(second.date).toBe(next);
      expect(second.lines[0].actual_charge).toBe(price);

      const card = await auth(request.get(`/user-memberships/${assigned.body.id}`));
      expect(card.body.billing_event_simulation.dates[0].lines[0].actual_charge).toBe(amount);

      const sp = await auth(request.post(`/user-memberships/${assigned.body.id}/save-and-pay`)).send({});
      expect(sp.status).toBe(200);
      const { rows } = await db.query<any>(
        `SELECT be.amount FROM billing_events be JOIN product_sets ps ON ps.id = be.product_set_id
          WHERE ${productSetOfLegacyAssignmentSql('?', 'ps')}`, [assigned.body.id]);
      expect(rows.map((r: any) => Number(r.amount))).toEqual([amount]);
    });
  }
});

describe('a Product a plan includes bills on the plan schedule (#2964)', () => {
  it('is prorated beside the fee and its obligations fall on the 1st', async () => {
    if (onGrid('month')) return;
    const m = await member();
    const planId = await plan(31);
    const locker = await product({ name: 'Included Locker', frequency: 'month', amount: '31.00', type: 'service' });
    await db.query(
      `INSERT INTO membership_plan_periodical (gym_id, membership_plan_id, product_id, quantity)
       VALUES (?, ?, ?, 1)`, [gymId, planId, locker]);
    const created = await auth(request.post('/product-sets')).send({ member_id: m, membership_plan_id: planId, starts_at: TODAY });
    expect(created.status).toBe(201);
    const setId = created.body.id as number;
    const { days, amount } = firstStretch(31, 'month');
    const next = nextCalendarDate(TODAY, 'month');

    // Before the fix the included locker kept billing on the start's day of the month,
    // at its full price, beside a fee that was prorated to the 1st.
    const review = await auth(request.get(`${mset(setId)}/review`));
    expect(Number(review.body.amount_due)).toBe(Math.round(amount * 2 * 100) / 100);
    const sim = await auth(request.get(`${mset(setId)}/billing-event-simulation`));
    const initial = sim.body.dates.find((d: any) => d.kind === 'initial_payment');
    const lockerLine = initial.lines.find((l: any) => l.label === 'Included Locker');
    expect(lockerLine.actual_charge).toBe(amount);
    expect(lockerLine.proration).toEqual({ prorated_days: days, period_days: 31 });

    const sp = await auth(request.post(`${mset(setId)}/save-and-pay`)).send({});
    expect((await pay(sp.body.payment_request_id)).status).toBe(200);
    const { rows } = await db.query<any>(
      `SELECT DATE_FORMAT(billing_date, '%Y-%m-%d') AS d FROM billing_events
        WHERE product_set_id = ? AND is_scheduled = 1 ORDER BY billing_date`, [setId]);
    expect(rows.map((r: any) => r.d)).toEqual([next, advanceBillingDate(next, 1, 'month')]);
  });
});
