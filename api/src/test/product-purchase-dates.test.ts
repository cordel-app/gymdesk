// #1693 — purchase, cancellation and end dates of a purchased Product:
// the webhook stamps the purchase date and the end date once; a cancellation
// records its own day and never shortens the paid period; repeats change nothing.

import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';
import { db } from '../infra/db';
import { resolveTimeZone } from '../domain/homeDashboard';

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

import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';

const SECRET = 'test-1521-webhook';
let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const day = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// The route works in the gym's own calendar, which is not the UTC date for part of every day.
let TODAY = day(0);

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

async function promotion(opts: { name: string; stackable?: 0 | 1; newMembersOnly?: 0 | 1 }): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO promotions
       (gym_id, name, starts_at, ends_at, lifecycle_status, applies_to, stackable,
        only_applicable_for_new_members, free_months, paid_months, bonus_months)
     VALUES (?, ?, '2026-01-01', '2099-12-31', 'active', 'product', ?, ?, 0, 6, 0)`,
    [gymId, opts.name, opts.stackable ?? 1, opts.newMembersOnly ?? 0]);
  return insertId;
}

async function grant(promotionId: number, productId: number, category: 'oneoff' | 'periodical', action = 'percentage_discount', value: number | null = 50) {
  await db.query(
    `INSERT INTO promotion_${category} (gym_id, promotion_id, product_id, quantity, \`action\`, \`value\`)
     VALUES (?, ?, ?, 1, ?, ?)`, [gymId, promotionId, productId, action, value]);
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

const base = (memberId: number) => `/members/${memberId}/product-purchases`;

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = SECRET;
  gymId = await createTestGym('Staff Purchase Gym');
  await createTestMembership(gymId, 'admin');
  const { rows: gz } = await db.query<any>('SELECT time_zone FROM gyms WHERE id = ?', [gymId]);
  TODAY = DateTime.now().setZone(resolveTimeZone(gz[0].time_zone)).toISODate()!;
});
afterAll(async () => {
  delete process.env.MONEI_API_KEY;
  delete process.env.MONEI_WEBHOOK_SECRET;
  await db.query('DELETE FROM payment_requests WHERE gym_id = ?', [gymId]);
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});


async function buy(m: number, frequency: string, validityDays?: number): Promise<{ purchaseId: number; prId: number }> {
  const p = await product({ name: `Locker ${uniq()}`, frequency });
  if (validityDays) await db.query('UPDATE products SET validity_days = ? WHERE id = ?', [validityDays, p]);
  const res = await auth(request.post(base(m))).send({ product_id: p });
  expect(res.status).toBe(201);
  const { rows } = await db.query<any>('SELECT payment_request_id FROM member_products_oneoff_snapshot WHERE id = ?', [res.body.purchaseId]);
  return { purchaseId: res.body.purchaseId, prId: rows[0].payment_request_id };
}
const row = async (id: number) => (await db.query<any>(
  `SELECT status, purchased_at, DATE_FORMAT(valid_until,'%Y-%m-%d') AS valid_until,
          DATE_FORMAT(cancelled_on,'%Y-%m-%d') AS cancelled_on FROM member_products_oneoff_snapshot WHERE id = ?`, [id])).rows[0];

describe('purchase, cancellation and end dates (#1693)', () => {
  it('a pending purchase has no purchase or end date; the webhook stamps both once', async () => {
    const m = await member();
    const { purchaseId, prId } = await buy(m, 'once', 30);
    expect(await row(purchaseId)).toMatchObject({ status: 'pending_payment', purchased_at: null, valid_until: null });
    expect((await pay(prId)).status).toBeLessThan(300);
    const first = await row(purchaseId);
    expect(first.status).toBe('active');
    expect(first.purchased_at).not.toBeNull();
    expect(first.valid_until).not.toBeNull();
    await pay(prId); // duplicate webhook
    expect(await row(purchaseId)).toEqual(first);
  });

  it('cancelling records its day, keeps the paid end date, and is idempotent', async () => {
    const m = await member();
    const { purchaseId, prId } = await buy(m, 'once', 30);
    await pay(prId);
    const before = await row(purchaseId);
    const res = await auth(request.post(`${base(m)}/${purchaseId}/cancel`));
    expect(res.status).toBe(200);
    expect(res.body.cancelled_on).toBe(TODAY);
    expect(res.body.valid_until).toBe(before.valid_until);
    const again = await auth(request.post(`${base(m)}/${purchaseId}/cancel`));
    expect(again.status).toBe(200);
    expect(again.body).toEqual(res.body);
    const list = await auth(request.get(`/members/${m}/products`));
    expect(list.body.items.find((i: any) => i.id === purchaseId)).toMatchObject({
      cancelled_on: TODAY, valid_until: before.valid_until, validity_state: 'cancelled',
    });
  });

  it('a purchase with no defined validity ends the day it is cancelled', async () => {
    const m = await member();
    const { purchaseId, prId } = await buy(m, 'once');
    await pay(prId);
    expect((await row(purchaseId)).valid_until).toBeNull();
    const res = await auth(request.post(`${base(m)}/${purchaseId}/cancel`));
    expect(res.body).toMatchObject({ cancelled_on: TODAY, valid_until: TODAY });
  });

  it('refuses a pending purchase, another member\'s purchase and anonymous callers', async () => {
    const m = await member();
    const other = await member();
    const { purchaseId, prId } = await buy(m, 'once', 30);
    expect((await auth(request.post(`${base(m)}/${purchaseId}/cancel`))).status).toBe(409);
    await pay(prId);
    expect((await auth(request.post(`${base(other)}/${purchaseId}/cancel`))).status).toBe(404);
    expect((await request.post(`${base(m)}/${purchaseId}/cancel`)).status).toBe(401);
  });
});
