// #3358 stage 2 — the unified cancellation lifecycle of a recurring Product line, and Cancel
// Immediately for one whose cancellation is already committed.
//
// Integration: the rules under test are which status the Products list reports at each step (the
// Membership Plan vocabulary, no `pending_termination`), that the mark lives in the member's In
// Cart Draft until Save & Pay, that discarding the Draft restores the committed End Date, and that
// the commit ends the line today. Only the provider's `createPaymentRequest` is stubbed.

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

import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';

const SECRET = 'test-3358-webhook';
let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const day = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const TODAY = day(0);

const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const base = (memberId: number) => `/members/${memberId}/product-purchases`;

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Cancel Now Member', `cn-${uniq()}@test.com`]);
  return insertId;
}

async function product(name: string, amount = '20.00'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, is_system,
        currency, amount, tax_behavior)
     VALUES (?, ?, 'service', 'month', 'active', 'public', 0, 'EUR', ?, 'inclusive')`,
    [gymId, name, amount]);
  return insertId;
}

async function plan(price: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', NULL, NULL, 0, 0)`, [gymId, `CN-Plan-${uniq()}`]);
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

/** The recurring row of `GET /members/:id/products` for one Product. */
async function line(memberId: number, productId: number) {
  const list = await auth(request.get(`/members/${memberId}/products`));
  expect(list.status).toBe(200);
  const rows = (list.body.items as any[]).filter((r) => r.source === 'recurring' && r.product_id === productId);
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** A member holding one Active recurring Product (bought and paid beside a paid plan). */
async function memberWithLine(name: string): Promise<{ memberId: number; productId: number }> {
  const memberId = await member();
  const planId = await plan(40);
  const set = await auth(request.post('/product-sets')).send({ member_id: memberId, membership_plan_id: planId, starts_at: TODAY });
  expect(set.status).toBeLessThan(300);
  const first = await auth(request.post(`/product-sets/${set.body.id}/save-and-pay`)).send({});
  expect(first.status).toBeLessThan(300);
  expect((await pay(first.body.payment_request_id)).status).toBe(200);

  const productId = await product(name);
  const add = await auth(request.post(base(memberId))).send({ product_id: productId });
  expect(add.status).toBeLessThan(300);
  const sp = await auth(request.post(`/product-sets/${add.body.product_set_id}/save-and-pay`)).send({});
  expect(sp.status).toBeLessThan(300);
  expect((await pay(sp.body.payment_request_id)).status).toBe(200);
  return { memberId, productId };
}

/** Commits the member's open Draft; a removal or a cancellation owes nothing, so it is activated. */
async function commitDraft(memberId: number) {
  const { rows } = await db.query<any>(
    `SELECT id FROM product_sets WHERE gym_id = ? AND owner_member_id = ? AND status = 'in_cart' ORDER BY id DESC LIMIT 1`,
    [gymId, memberId]);
  expect(rows[0]).toBeTruthy();
  const out = await auth(request.post(`/product-sets/${rows[0].id}/activate`)).send({});
  expect(out.status, JSON.stringify(out.body)).toBeLessThan(300);
  return Number(rows[0].id);
}

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = SECRET;
  gymId = await createTestGym();
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('#3358 stage 2 — a recurring Product line uses the Membership Plan cancellation lifecycle', () => {
  it('reads To Be Canceled while the Draft removes it, then Cancels at End Date once committed', async () => {
    const { memberId, productId } = await memberWithLine(`Locker 3358-a-${uniq()}`);
    const active = await line(memberId, productId);
    expect(active).toMatchObject({ status: 'active', ends_at: null, can_cancel_immediately: false });

    // Removing it from the Draft only marks it: the Active version keeps billing it.
    const removed = await auth(request.delete(`${base(memberId)}/recurring/${Math.abs(active.id)}`));
    expect(removed.status).toBe(200);
    const marked = await line(memberId, productId);
    expect(marked.status).toBe('to_be_canceled');
    expect(marked.ends_at).toBeNull();
    expect(marked.can_cancel_immediately).toBe(false);

    // Save & Pay (nothing owed) commits it: it ends on its last paid day and is still entitled.
    await commitDraft(memberId);
    const committed = await line(memberId, productId);
    expect(committed.status).toBe('active_cancel_at_period_end');
    expect(String(committed.ends_at) > TODAY).toBe(true);
    expect(committed.can_cancel_immediately).toBe(true);
  });

  it('marks Cancel Immediately in the cart, lists it in the review and commits it as cancelled', async () => {
    const { memberId, productId } = await memberWithLine(`Locker 3358-b-${uniq()}`);
    const active = await line(memberId, productId);
    expect((await auth(request.delete(`${base(memberId)}/recurring/${Math.abs(active.id)}`))).status).toBe(200);
    await commitDraft(memberId);
    const cancelling = await line(memberId, productId);
    expect(cancelling.status).toBe('active_cancel_at_period_end');
    const periodEnd = String(cancelling.ends_at);

    const now = await auth(request.post(`${base(memberId)}/recurring/${Math.abs(cancelling.id)}/cancel-immediately`)).send({});
    expect(now.status, JSON.stringify(now.body)).toBe(200);
    expect(now.body.ends_at).toBe(TODAY);

    // The mark is the Draft's: the committed line still ends at its period end.
    const pending = await line(memberId, productId);
    expect(pending.status).toBe('to_be_canceled_immediately');
    expect(String(pending.ends_at)).toBe(periodEnd);

    // It is what the commit does, so the review lists it as a change.
    const review = await auth(request.get(`/product-sets/${now.body.product_set_id}/review`));
    expect(review.status).toBe(200);
    expect(review.body.lines_to_cancel_immediately).toEqual([
      { line_id: expect.any(Number), product_name: expect.any(String) },
    ]);

    await commitDraft(memberId);
    const done = await line(memberId, productId);
    expect(done.status).toBe('cancelled');
    expect(String(done.ends_at)).toBe(TODAY);
    expect(done.can_cancel_immediately).toBe(false);
  });

  it('restores the committed End Date when the Draft is discarded', async () => {
    const { memberId, productId } = await memberWithLine(`Locker 3358-c-${uniq()}`);
    const active = await line(memberId, productId);
    expect((await auth(request.delete(`${base(memberId)}/recurring/${Math.abs(active.id)}`))).status).toBe(200);
    await commitDraft(memberId);
    const cancelling = await line(memberId, productId);
    const periodEnd = String(cancelling.ends_at);

    const now = await auth(request.post(`${base(memberId)}/recurring/${Math.abs(cancelling.id)}/cancel-immediately`)).send({});
    expect(now.status, JSON.stringify(now.body)).toBe(200);
    expect((await line(memberId, productId)).status).toBe('to_be_canceled_immediately');

    // Discarding the Draft takes the mark with it; nothing restores anything by hand.
    expect((await auth(request.delete(`/product-sets/${now.body.product_set_id}`))).status).toBe(204);
    const back = await line(memberId, productId);
    expect(back.status).toBe('active_cancel_at_period_end');
    expect(String(back.ends_at)).toBe(periodEnd);
    expect(back.can_cancel_immediately).toBe(true);
  });

  it('refuses Cancel Immediately for a line that is not cancelling at its period end', async () => {
    const { memberId, productId } = await memberWithLine(`Locker 3358-d-${uniq()}`);
    const active = await line(memberId, productId);
    const out = await auth(request.post(`${base(memberId)}/recurring/${Math.abs(active.id)}/cancel-immediately`)).send({});
    expect(out.status).toBe(409);
    expect(out.body.error).toBe('not_cancelling_at_period_end');
    expect((await line(memberId, productId)).status).toBe('active');
  });

  it('answers 404 for a line of another member', async () => {
    const a = await memberWithLine(`Locker 3358-e-${uniq()}`);
    const other = await member();
    const row = await line(a.memberId, a.productId);
    const out = await auth(request.post(`${base(other)}/recurring/${Math.abs(row.id)}/cancel-immediately`)).send({});
    expect(out.status).toBe(404);
  });
});
