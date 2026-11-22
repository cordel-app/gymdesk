// #3007 stage 7 — the integration pass the issue's acceptance criteria ask for, for
// recurring Product lines (standalone and beside a Membership Plan), through the HTTP routes:
// removing a line running on the Active version marks it to be cancelled on the Draft's own copy
// (the Active version keeps billing it), the Review lists it as removed, discarding the Draft
// leaves the Active version exactly as it was, and committing the Draft applies the cancellation
// once, ending the line on its last paid day. A one-time Product is never touched by any of it.
// Integration against real MySQL; only the provider's `createPaymentRequest` is stubbed.

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

const SECRET = 'test-3007-7-webhook';
let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const dateOf = (v: unknown) => (v == null ? null : new Date(v as string).toISOString().slice(0, 10));

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Pending Cancel Member', `pc-${uniq()}@test.com`]);
  return insertId;
}

async function product(name: string, frequency: string, amount: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products
       (gym_id, name, type, billing_frequency, status, enrollment_status, is_system, currency, amount, tax_behavior)
     VALUES (?, ?, 'service', ?, 'active', 'public', 0, 'EUR', ?, 'inclusive')`,
    [gymId, `${name} ${uniq()}`, frequency, amount]);
  return insertId;
}

async function plan(price: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', NULL, NULL, 0, 0)`, [gymId, `PC-Plan-${uniq()}`]);
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status) VALUES (?, ?, ?, '2025-01-01', 'active')`,
    [gymId, insertId, price]);
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
  const res = await webhook({
    id: `evt_${id}`, type: 'charge.succeeded', objectId: id, objectType: 'charge',
    object: { id, orderId: rows[0].provider_order, status: 'SUCCEEDED' },
  });
  expect(res.status).toBe(200);
}

async function saveAndPay(setId: number) {
  const sp = await auth(request.post(`/product-sets/${setId}/save-and-pay`)).send({});
  expect(sp.status).toBe(201);
  await pay(sp.body.payment_request_id);
}

/** A set's recurring lines (its links), running or ended. */
const linesOf = async (setId: number) => (await db.query<any>(
  `SELECT s.id AS snapshot_id, s.source_id, s.product_id, s.ends_at FROM product_set_periodical_snapshots lnk
     JOIN product_periodical_snapshots s ON s.id = lnk.product_periodical_snapshot_id
    WHERE lnk.product_set_id = ? ORDER BY s.id`, [setId])).rows;
const setStatus = async (setId: number) => (await db.query<any>(
  'SELECT status FROM product_sets WHERE id = ?', [setId])).rows[0]?.status ?? null;
const snapshotsOfProduct = async (productId: number) => Number((await db.query<any>(
  'SELECT COUNT(*) AS n FROM product_periodical_snapshots WHERE product_id = ? AND gym_id = ?', [productId, gymId])).rows[0].n);
const activeSetOf = async (m: number) => Number((await db.query<any>(
  "SELECT id FROM product_sets WHERE owner_member_id = ? AND status = 'active'", [m])).rows[0]?.id ?? 0);
/** Scheduled obligations of the owner that still bill the Product after a date. */
const futureChargesFor = async (m: number, productId: number, after: string) => Number((await db.query<any>(
  `SELECT COUNT(*) AS n FROM billing_events be JOIN billing_event_lines l ON l.billing_event_id = be.id
    WHERE be.member_id = ? AND be.is_scheduled = 1 AND l.product_id = ? AND be.billing_date > ?`,
  [m, productId, after])).rows[0].n);

/** An Active set holding one monthly recurring line (and a plan, when asked), paid today. */
async function activeWithLine(withPlan: boolean) {
  const m = await member();
  const towel = await product('Towel', 'month', '12.00');
  let setId: number;
  if (withPlan) {
    const created = await auth(request.post('/product-sets')).send({ member_id: m, membership_plan_id: await plan(40), starts_at: TODAY });
    expect(created.status).toBe(201);
    setId = created.body.id;
    await saveAndPay(setId);
    const add = await auth(request.post(`/members/${m}/product-purchases`)).send({ product_id: towel });
    expect(add.status).toBe(201);
    const draftId = add.body.product_set_id as number;
    await saveAndPay(draftId);
    setId = draftId;
  } else {
    const add = await auth(request.post(`/members/${m}/product-purchases`)).send({ product_id: towel });
    expect(add.status).toBe(201);
    setId = add.body.product_set_id as number;
    await saveAndPay(setId);
  }
  expect(await setStatus(setId)).toBe('active');
  const [line] = await linesOf(setId);
  expect(line.ends_at).toBeNull();
  return { m, towel, activeId: setId, line };
}

async function openDraft(m: number): Promise<number> {
  const d = await auth(request.post('/product-sets/draft')).send({ member_id: m });
  expect([200, 201]).toContain(d.status);
  return d.body.id as number;
}

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = SECRET;
  gymId = await createTestGym('Recurring Pending Cancel Gym');
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

describe.each([
  ['a standalone recurring line', false],
  ['a recurring line beside a Membership Plan', true],
])('removing %s from the Draft (#3007)', (_label, withPlan) => {
  it('marks it on the Draft only, lists it as removed, and a discarded Draft restores the Active version', async () => {
    const { m, towel, activeId, line } = await activeWithLine(withPlan);
    const draftId = await openDraft(m);
    // The Draft links the Active line (no copy just for opening it).
    expect((await linesOf(draftId)).map((l) => l.snapshot_id)).toEqual([line.snapshot_id]);

    const del = await auth(request.delete(`/product-sets/${draftId}/services/${line.source_id}`));
    expect(del.status).toBe(200);

    // The Active version keeps the line, untouched, and keeps billing it.
    const active = await linesOf(activeId);
    expect(active.map((l) => l.snapshot_id)).toEqual([line.snapshot_id]);
    expect(active[0].ends_at).toBeNull();
    // The Draft carries its own copy, ended on a date that is today or later.
    const [mine] = await linesOf(draftId);
    expect(mine.snapshot_id).not.toBe(line.snapshot_id);
    expect(dateOf(mine.ends_at)! >= TODAY).toBe(true);

    const review = await auth(request.get(`/product-sets/${draftId}/review`));
    expect(review.status).toBe(200);
    const removed = (review.body.changes as any[]).filter((c) => c.kind === 'removed');
    expect(removed.map((c) => Number(c.line.productId ?? c.line.product_id))).toEqual([towel]);
    expect(review.body.payment_required).toBe(false);

    // Removing it twice is refused rather than ending it again.
    expect((await auth(request.delete(`/product-sets/${draftId}/services/${mine.source_id}`))).status).toBe(409);

    // Discard: the Draft's copy goes with the Draft; the Active version is exactly as before.
    expect((await auth(request.delete(`/product-sets/${draftId}`))).status).toBe(204);
    expect(await setStatus(draftId)).toBeNull();
    const after = await linesOf(activeId);
    expect(after.map((l) => l.snapshot_id)).toEqual([line.snapshot_id]);
    expect(after[0].ends_at).toBeNull();
    expect(await setStatus(activeId)).toBe('active');
    expect(await snapshotsOfProduct(towel)).toBe(1);
  });

  it('committing the Draft ends the line once, on its last paid day, and stops its later charges', async () => {
    const { m, towel, activeId, line } = await activeWithLine(withPlan);
    const draftId = await openDraft(m);
    const del = await auth(request.delete(`/product-sets/${draftId}/services/${line.source_id}`));
    expect(del.status).toBe(200);
    const endsAt = del.body.ends_at as string;
    expect(endsAt >= TODAY).toBe(true);
    // Until the commit the Active version keeps the line's later obligations.
    expect(await futureChargesFor(m, towel, endsAt)).toBeGreaterThan(0);

    // The removal owes nothing, so the Draft is committed without a payment.
    const act = await auth(request.post(`/product-sets/${draftId}/activate`)).send({});
    expect(act.status).toBe(200);
    expect(await activeSetOf(m)).toBe(draftId);
    expect(await setStatus(activeId)).toBe('superseded');

    // The new Active version carries the line ended on that date; the superseded one is the
    // record of what it billed and still links the original, running snapshot.
    const committed = await linesOf(draftId);
    expect(committed).toHaveLength(1);
    expect(dateOf(committed[0].ends_at)).toBe(endsAt);
    expect((await linesOf(activeId))[0].ends_at).toBeNull();
    // One copy for the Draft and nothing more: no second snapshot from the commit.
    expect(await snapshotsOfProduct(towel)).toBe(2);
    expect(await futureChargesFor(m, towel, endsAt)).toBe(0);

    // Applied exactly once: activating again changes nothing.
    await auth(request.post(`/product-sets/${draftId}/activate`)).send({});
    expect(await activeSetOf(m)).toBe(draftId);
    expect(await snapshotsOfProduct(towel)).toBe(2);
    expect(dateOf((await linesOf(draftId))[0].ends_at)).toBe(endsAt);
  });
});

describe('a line the Draft added itself (In Cart, #3007)', () => {
  it('is removed from the cart outright, never marked', async () => {
    const { m, activeId } = await activeWithLine(false);
    const locker = await product('Locker', 'month', '9.00');
    const add = await auth(request.post(`/members/${m}/product-purchases`)).send({ product_id: locker });
    expect(add.status).toBe(201);
    const draftId = add.body.product_set_id as number;
    const added = (await linesOf(draftId)).find((l) => Number(l.product_id) === locker)!;
    const del = await auth(request.delete(`/product-sets/${draftId}/services/${added.source_id}`));
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);
    expect((await linesOf(draftId)).some((l) => Number(l.product_id) === locker)).toBe(false);
    expect(await snapshotsOfProduct(locker)).toBe(0);
    expect(await setStatus(activeId)).toBe('active');
  });
});

describe('one-time Products are out of scope (#3007)', () => {
  it('a bought one-time Product is untouched by marking, discarding and committing', async () => {
    const { m, line } = await activeWithLine(false);
    const bottle = await product('Bottle', 'once', '8.00');
    const buy = await auth(request.post(`/members/${m}/product-purchases`)).send({ product_id: bottle });
    expect(buy.status).toBe(201);
    if (buy.body.payment_request_id) await pay(buy.body.payment_request_id);
    const purchase = async () => (await db.query<any>(
      'SELECT id, status, valid_until, cancelled_on FROM product_oneoff_snapshots WHERE member_id = ? AND product_id = ?',
      [m, bottle])).rows;
    const before = await purchase();
    expect(before).toHaveLength(1);

    let draftId = await openDraft(m);
    expect((await auth(request.delete(`/product-sets/${draftId}/services/${line.source_id}`))).status).toBe(200);
    expect((await auth(request.delete(`/product-sets/${draftId}`))).status).toBe(204);
    expect(await purchase()).toEqual(before);

    draftId = await openDraft(m);
    expect((await auth(request.delete(`/product-sets/${draftId}/services/${line.source_id}`))).status).toBe(200);
    expect((await auth(request.post(`/product-sets/${draftId}/activate`)).send({})).status).toBe(200);
    expect(await purchase()).toEqual(before);
  });
});
