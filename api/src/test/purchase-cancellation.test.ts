// #3355 stage 3 — staff cancel a Purchase awaiting its payment (`POST /payments/purchases/:id/cancel`,
// the Member card's Purchases tab `⋮ → Cancel`).
//
// Integration: with a Billing Event the purchase is kept as `cancelled` with its event cancelled and
// its open attempt closed, its newly added items cancelled, and the plan its checkout marked
// `to_be_canceled` back to `active` with its previous end date; without one, what it added is
// hard-deleted and the purchase goes with it. A settled payment, a non-pending purchase, another
// gym's purchase and a member caller are refused. Only the provider is stubbed.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';

const lookups = new Map<string, string>();
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
        getPaymentStatus: async (ref: string) => {
          const { rows } = await (await import('../infra/db')).db.query<any>(
            'SELECT provider_order FROM payment_requests WHERE provider_ref = ?', [ref]);
          const providerStatus = lookups.get(ref);
          if (!providerStatus) throw new Error('provider unreachable');
          return { orderId: rows[0].provider_order, providerRef: ref, providerStatus,
            status: providerStatus === 'SUCCEEDED' ? 'completed' : 'failed' };
        },
      });
    },
  };
});

import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, activateTestAssignment, cleanupTestGyms, createTestDraftAssignment, createTestGym,
  createTestMembership, request,
} from './helpers';

const SECRET = 'test-purchase-cancel';
let gymId: string;
let otherGymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any, gym = gymId) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
const one = async (sql: string, params: unknown[]) => (await db.query<any>(sql, params)).rows[0];
const cancel = (purchaseId: number, gym = gymId) => auth(request.post(`/payments/purchases/${purchaseId}/cancel`), gym);

function signed(payload: unknown) {
  const raw = JSON.stringify(payload);
  const t = String(Math.floor(Date.now() / 1000));
  const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
  return request.post('/webhooks/payment').set({ 'monei-signature': `t=${t},v1=${v1}` })
    .set('Content-Type', 'application/json').send(raw);
}
async function pay(paymentRequestId: number) {
  const { provider_order } = await one('SELECT provider_order FROM payment_requests WHERE id = ?', [paymentRequestId]);
  const id = crypto.randomBytes(12).toString('hex');
  return signed({ id: `evt_${id}`, type: 'charge.succeeded', objectId: id, objectType: 'charge',
    object: { id, orderId: provider_order, status: 'SUCCEEDED' } });
}

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Purchase Cancel Member', `pcx-${uniq()}@test.com`]);
  return insertId;
}
async function product(frequency: 'once' | 'month', amount = '30.00'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, is_system, currency, amount, tax_behavior)
     VALUES (?, ?, ?, ?, 'active', 'public', 0, 'EUR', ?, 'inclusive')`,
    [gymId, `PC Product ${uniq()}`, frequency === 'once' ? 'fee' : 'service', frequency, amount]);
  return insertId;
}

/** A one-time Product staff bought and sent for payment: a pending purchase with its own Billing Event. */
async function pendingOneTime() {
  const m = await member();
  const res = await auth(request.post(`/members/${m}/product-purchases`)).send({ product_id: await product('once') });
  expect(res.status).toBe(201);
  const line = await one(
    'SELECT id, source_id, purchase_id, status FROM product_oneoff_snapshots WHERE gym_id = ? AND member_id = ? AND source_id IS NOT NULL',
    [gymId, m]);
  const ev = await one(
    `SELECT be.id FROM billing_events be JOIN billing_event_oneoff_snapshots j ON j.billing_event_id = be.id
      WHERE j.product_oneoff_snapshot_id = ?`, [line.id]);
  const pr = await one('SELECT id, provider_ref FROM payment_requests WHERE billing_event_id = ?', [ev.id]);
  // The provider answers that nobody has paid yet (an unknown outcome would be refused).
  lookups.set(pr.provider_ref, 'PENDING');
  return { memberId: m, purchaseId: Number(line.purchase_id), lineSourceId: Number(line.source_id), eventId: Number(ev.id), request: pr };
}

/**
 * A running plan marked `to_be_canceled` in the owner's cart, plus a recurring Product added to that
 * cart and sent for payment: one Pending Payment Product Set with its initial Billing Event.
 */
async function pendingSetWithMarkedPlan() {
  const m = await member();
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status) VALUES (?, ?, 'active', 'staff_only')`,
    [gymId, `PC Plan ${uniq()}`]);
  const umId = await createTestDraftAssignment(gymId, m, planId, { startsAt: '2026-01-01' });
  await activateTestAssignment(gymId, umId);
  await db.query('UPDATE plan_snapshots SET ends_at = ? WHERE gym_id = ? AND anchor_plan_snapshot_id = ?', ['2027-06-30', gymId, umId]);
  const mark = await auth(request.post(`/user-memberships/${umId}/mark-cancel`));
  expect(mark.status).toBe(200);
  const add = await auth(request.post(`/members/${m}/product-purchases`)).send({ product_id: await product('month', '20.00') });
  expect(add.status).toBe(201);
  expect(Number(add.body.product_set_id)).toBe(Number(mark.body.product_set_id));
  const sp = await auth(request.post(`/product-sets/${mark.body.product_set_id}/save-and-pay`)).send({});
  expect(sp.status).toBe(201);
  expect(sp.body.status).toBe('pending_payment');
  const set = await one('SELECT id, purchase_id FROM product_sets WHERE id = ?', [mark.body.product_set_id]);
  const pr = await one('SELECT provider_ref FROM payment_requests WHERE id = ?', [sp.body.payment_request_id]);
  if (pr?.provider_ref) lookups.set(pr.provider_ref, 'PENDING');
  return { memberId: m, umId, setId: Number(set.id), purchaseId: Number(set.purchase_id), paymentRequestId: Number(sp.body.payment_request_id) };
}

const planState = (umId: number) => one(
  'SELECT status, ends_at, previous_end_date FROM plan_snapshots WHERE gym_id = ? AND anchor_plan_snapshot_id = ? ORDER BY id DESC LIMIT 1',
  [gymId, umId]);

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = SECRET;
  gymId = await createTestGym('Purchase Cancel Gym');
  await createTestMembership(gymId, 'admin');
  otherGymId = await createTestGym('Purchase Cancel Other Gym');
  await createTestMembership(otherGymId, 'admin');
});
afterAll(async () => {
  delete process.env.MONEI_API_KEY;
  delete process.env.MONEI_WEBHOOK_SECRET;
  await db.query('DELETE FROM payment_requests WHERE gym_id = ?', [gymId]);
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('a pending purchase with Billing Events is kept as cancelled (scenario A)', () => {
  it('cancels a standalone checkout: its event, its open attempt and its one-time Product', async () => {
    const p = await pendingOneTime();
    const amountBefore = (await one('SELECT amount FROM billing_events WHERE id = ?', [p.eventId])).amount;
    const res = await cancel(p.purchaseId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ purchase_id: p.purchaseId, status: 'cancelled' });

    expect((await one('SELECT status FROM purchases WHERE id = ?', [p.purchaseId])).status).toBe('cancelled');
    const ev = await one('SELECT amount, cancelled_at FROM billing_events WHERE id = ?', [p.eventId]);
    expect(ev.cancelled_at).not.toBeNull();
    expect(ev.amount).toBe(amountBefore);
    expect((await one('SELECT status FROM payment_requests WHERE id = ?', [p.request.id])).status).toBe('expired');
    expect((await one('SELECT status FROM product_oneoff_snapshots WHERE source_id = ?', [p.lineSourceId])).status).toBe('cancelled');
    // The Purchases tab reads it cancelled, with its Billing Event still there.
    const list = await auth(request.get(`/payments/purchases?member_id=${p.memberId}`));
    const row = list.body.items.find((i: any) => i.id === p.purchaseId);
    expect(row.status).toBe('cancelled');
    expect(row.billing_events.map((e: any) => e.id)).toEqual([p.eventId]);
    expect(row.billing_events[0].status).toBe('cancelled');
  });

  it('cancels a Product Set checkout and restores the plan it marked, with its previous end date', async () => {
    const p = await pendingSetWithMarkedPlan();
    expect((await planState(p.umId)).status).toBe('to_be_canceled');

    const res = await cancel(p.purchaseId);
    expect(res.status).toBe(200);

    expect((await one('SELECT status FROM product_sets WHERE id = ?', [p.setId])).status).toBe('cancelled');
    expect((await one('SELECT status FROM purchases WHERE id = ?', [p.purchaseId])).status).toBe('cancelled');
    const ev = await one('SELECT cancelled_at FROM billing_events WHERE product_set_id = ?', [p.setId]);
    expect(ev.cancelled_at).not.toBeNull();
    expect((await one('SELECT status FROM payment_requests WHERE id = ?', [p.paymentRequestId])).status).toBe('expired');
    const plan = await planState(p.umId);
    expect(plan.status).toBe('active');
    expect(String(plan.ends_at instanceof Date ? plan.ends_at.toISOString() : plan.ends_at).slice(0, 10)).toBe('2027-06-30');
    expect(plan.previous_end_date).toBeNull();
    // The member may buy again: nothing is left awaiting payment.
    const config = await auth(request.get(`/user-memberships/member/${p.memberId}/configuration`));
    expect(config.body.has_pending_payment_purchase).toBe(false);
  });

  it('is safe to repeat: a second cancel changes nothing', async () => {
    const p = await pendingOneTime();
    expect((await cancel(p.purchaseId)).status).toBe(200);
    const cancelledAt = (await one('SELECT cancelled_at FROM billing_events WHERE id = ?', [p.eventId])).cancelled_at;
    const again = await cancel(p.purchaseId);
    expect(again.status).toBe(200);
    expect((await one('SELECT cancelled_at FROM billing_events WHERE id = ?', [p.eventId])).cancelled_at).toEqual(cancelledAt);
  });
});

describe('a pending purchase with no Billing Event is hard-deleted (scenario B)', () => {
  it('deletes the purchase and the one-time Product it added, and nothing else', async () => {
    const m = await member();
    const held = await auth(request.post(`/members/${m}/product-purchases`)).send({ product_id: await product('once') });
    expect(held.status).toBe(201);
    const heldLine = await one(
      'SELECT source_id, purchase_id FROM product_oneoff_snapshots WHERE gym_id = ? AND member_id = ? AND source_id IS NOT NULL', [gymId, m]);
    expect((await pay(Number(held.body.payment_request_id ?? (await one(
      `SELECT pr.id FROM payment_requests pr JOIN billing_event_oneoff_snapshots j ON j.billing_event_id = pr.billing_event_id
         JOIN product_oneoff_snapshots s ON s.id = j.product_oneoff_snapshot_id WHERE s.source_id = ?`, [heldLine.source_id])).id))).status).toBe(200);

    // A purchase awaiting payment with no Billing Event (a row the checkout never reached).
    const draft = await auth(request.post(`/members/${m}/product-purchases`)).send({ product_id: await product('once'), draft: true });
    expect(draft.status).toBe(201);
    const line = await one('SELECT purchase_id FROM product_oneoff_snapshots WHERE source_id = ?', [draft.body.purchaseId]);
    await db.query(`UPDATE product_oneoff_snapshots SET status = 'pending_payment' WHERE source_id = ?`, [draft.body.purchaseId]);
    await db.query(`UPDATE purchases SET status = 'pending_payment', expires_at = NULL WHERE id = ?`, [line.purchase_id]);

    const res = await cancel(Number(line.purchase_id));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('deleted');
    expect(await one('SELECT id FROM purchases WHERE id = ?', [line.purchase_id])).toBeUndefined();
    expect(await one('SELECT id FROM product_oneoff_snapshots WHERE source_id = ?', [draft.body.purchaseId])).toBeUndefined();
    // The Product bought earlier is untouched.
    expect((await one('SELECT status FROM product_oneoff_snapshots WHERE source_id = ?', [heldLine.source_id])).status).toBe('active');
    expect((await one('SELECT status FROM purchases WHERE id = ?', [heldLine.purchase_id])).status).toBe('completed');
    // A repeat answers 404: the purchase is gone.
    expect((await cancel(Number(line.purchase_id))).status).toBe(404);
  });
});

describe('what is refused', () => {
  it('refuses a purchase whose payment has settled', async () => {
    const p = await pendingOneTime();
    lookups.set(p.request.provider_ref, 'SUCCEEDED');
    const res = await cancel(p.purchaseId);
    // The provider read-back settles it first, so the purchase is no longer awaiting payment.
    expect(res.status).toBe(409);
    expect(['not_pending_payment', 'payment_settled']).toContain(res.body.error);
    expect((await one('SELECT cancelled_at FROM billing_events WHERE id = ?', [p.eventId])).cancelled_at).toBeNull();
  });

  it('refuses a purchase whose payment the provider still holds in flight', async () => {
    const p = await pendingOneTime();
    lookups.set(p.request.provider_ref, 'AUTHORIZED');
    const res = await cancel(p.purchaseId);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('payment_unresolved');
    expect((await one('SELECT status FROM purchases WHERE id = ?', [p.purchaseId])).status).toBe('pending_payment');
  });

  it('refuses a purchase that is not awaiting payment', async () => {
    const m = await member();
    const draft = await auth(request.post(`/members/${m}/product-purchases`)).send({ product_id: await product('once'), draft: true });
    const line = await one('SELECT purchase_id FROM product_oneoff_snapshots WHERE source_id = ?', [draft.body.purchaseId]);
    const res = await cancel(Number(line.purchase_id));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'not_pending_payment', status: 'in_cart' });
  });

  it('isolates gyms and requires a signed-in staff caller', async () => {
    const p = await pendingOneTime();
    expect((await cancel(p.purchaseId, otherGymId)).status).toBe(404);
    expect((await request.post(`/payments/purchases/${p.purchaseId}/cancel`)).status).toBe(401);
    expect((await one('SELECT status FROM purchases WHERE id = ?', [p.purchaseId])).status).toBe('pending_payment');
  });
});
