// #3309 — a member's Cancel on a pending Members App payment ends the payment
// attempt and returns the purchase to In Cart (`returnCancelledCheckoutToCart()`).
// Integration against the real stack: the attempt reads `cancelled` (never
// `expired`) and stays in history, the event is stamped cancelled, the set, its
// plan snapshot and its assignment go back to the cart intact, a new Save & Pay
// opens a new event and attempt, a repeated cancel changes nothing, and staff
// cancellation (#2747) and a real expiry are unchanged.
import { TEST_ASSIGNMENTS } from './assignmentReads';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';

// The provider read-back is stubbed per order; everything else is the real provider.
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

import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym, createTestMembership, linkTestSetToAssignment, request, TEST_AUTH_HEADER } from './helpers';
import { testAssignmentWrite } from './assignmentFixture';

const SECRET = 'test-member-cancel-in-cart';
let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const asMember = (clerk: string, path: string) => {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any).mockResolvedValueOnce({ sub: clerk } as any);
  return request.post(`/me/product-sets${path}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
};

function signed(payload: unknown) {
  const raw = JSON.stringify(payload);
  const t = String(Math.floor(Date.now() / 1000));
  const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
  return request.post('/webhooks/payment').set({ 'monei-signature': `t=${t},v1=${v1}` })
    .set('Content-Type', 'application/json').send(raw);
}

async function member(clerk: string | null = null): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, 'Cancel Member', `cancel-${uniq()}@test.com`, clerk]);
  return insertId;
}
async function plan(price: number, cadence: [number, string] = [1, 'month']): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', NULL, NULL, 0, 0)`, [gymId, `Cancel-Plan-${uniq()}`]);
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status) VALUES (?, ?, ?, '2020-01-01', 'active')`,
    [gymId, insertId, price]);
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit) VALUES (?, ?, ?, ?)`,
    [gymId, insertId, cadence[0], cadence[1]]);
  return insertId;
}

async function pending(memberId?: number, opts: { assignment?: boolean; cadence?: [number, string] } = {}) {
  const ownerId = memberId ?? await member();
  const c = await auth(request.post('/product-sets')).send({ member_id: ownerId, membership_plan_id: await plan(40, opts.cadence), starts_at: TODAY });
  expect(c.status).toBe(201);
  const pay = await auth(request.post(`/product-sets/${c.body.id}/save-and-pay`)).send({});
  expect(pay.body.status).toBe('pending_payment');
  // A plan chosen in the Members App has no assignment until it is paid (#2743);
  // an Admin Save & Pay is linked to one.
  let umId: number | null = null;
  if (opts.assignment !== false) {
    ({ insertId: umId } = await testAssignmentWrite(
      `INSERT INTO user_memberships (gym_id, member_id, status, starts_at) VALUES (?, ?, 'pending_payment', ?)`,
      [gymId, ownerId, TODAY]));
    await linkTestSetToAssignment(Number(c.body.id), Number(umId));
  }
  const { rows } = await db.query<any>(
    `SELECT pr.id, pr.provider_ref, pr.provider_order FROM payment_requests pr
       JOIN billing_events be ON be.id = pr.billing_event_id WHERE be.product_set_id = ?`, [c.body.id]);
  return { id: Number(c.body.id), memberId: ownerId, umId, request: rows[0] };
}

const one = async (sql: string, params: unknown[]) => (await db.query<any>(sql, params)).rows[0];

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = SECRET;
  gymId = await createTestGym('Member cancel to cart gym');
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


async function snapshotIds(setId: number): Promise<number[]> {
  const { rows } = await db.query<any>('SELECT plan_snapshot_id FROM product_set_plan_snapshots WHERE product_set_id = ? ORDER BY id', [setId]);
  return rows.map((r) => Number(r.plan_snapshot_id));
}

describe('Members App Cancel returns the purchase to In Cart (#3309)', () => {
  it('cancels the attempt, keeps it and its event in history, and returns the set and its assignment to the cart intact', async () => {
    const clerk = `in-cart-${uniq()}`;
    await createTestMembership(gymId, 'member', clerk);
    const p = await pending(await member(clerk));
    lookups.set(p.request.provider_ref, 'PENDING');
    const event = await one('SELECT id, amount FROM billing_events WHERE product_set_id = ?', [p.id]);
    const before = await one('SELECT provider_order, amount, payment_method_name, provider_status FROM payment_requests WHERE id = ?', [p.request.id]);
    const snapshots = await snapshotIds(p.id);
    expect(snapshots.length).toBeGreaterThan(0);

    const res = await asMember(clerk, `/${p.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ product_set_id: p.id, status: 'in_cart' });

    const set = await one('SELECT status, payment_request_id, pending_at, cancelled_at FROM product_sets WHERE id = ?', [p.id]);
    expect(set).toMatchObject({ status: 'in_cart', payment_request_id: null, pending_at: null, cancelled_at: null });
    // The configuration is untouched: the same plan snapshots, still linked.
    expect(await snapshotIds(p.id)).toEqual(snapshots);

    const attempt = await one('SELECT status, provider_order, amount, payment_method_name, provider_status, billing_event_id FROM payment_requests WHERE id = ?', [p.request.id]);
    expect(attempt.status).toBe('cancelled');
    // The provider's own read-back answer is kept verbatim (#3289); nothing writes `EXPIRED` or `CANCELED`.
    expect(attempt.provider_status).toBe('PENDING');
    expect(attempt).toMatchObject({
      provider_order: before.provider_order, amount: before.amount, payment_method_name: before.payment_method_name,
      billing_event_id: event.id,
    });
    const ev = await one('SELECT amount, cancelled_at FROM billing_events WHERE id = ?', [event.id]);
    expect(ev.cancelled_at).not.toBeNull();
    expect(ev.amount).toBe(event.amount);

    expect((await one(`SELECT status FROM ${TEST_ASSIGNMENTS} um WHERE id = ?`, [p.umId])).status).toBe('in_cart');

    // Staff see the attempt in the transaction list as cancelled.
    const list = await auth(request.get('/payment-requests').query({ status: 'cancelled' }));
    expect(list.status).toBe(200);
    expect(list.body.map((r: any) => r.id)).toContain(p.request.id);
  });

  it('a repeated cancel is safe, and the member can pay again with a new event and attempt', async () => {
    const clerk = `in-cart-retry-${uniq()}`;
    await createTestMembership(gymId, 'member', clerk);
    const p = await pending(await member(clerk), { assignment: false });
    lookups.set(p.request.provider_ref, 'PENDING');
    expect((await asMember(clerk, `/${p.id}/cancel`)).status).toBe(200);
    const again = await asMember(clerk, `/${p.id}/cancel`);
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('in_cart');

    const retry = await auth(request.post(`/product-sets/${p.id}/save-and-pay`)).send({});
    expect(retry.status).toBeLessThan(300);
    expect(retry.body.status).toBe('pending_payment');

    const { rows: events } = await db.query<any>(
      `SELECT id, cancelled_at FROM billing_events WHERE product_set_id = ? AND event_type = 'payment_recorded' ORDER BY id`, [p.id]);
    expect(events).toHaveLength(2);
    expect(events[0].cancelled_at).not.toBeNull();
    expect(events[1].cancelled_at).toBeNull();
    const { rows: attempts } = await db.query<any>(
      'SELECT id, status, billing_event_id FROM payment_requests WHERE billing_event_id IN (?, ?) ORDER BY id', [events[0].id, events[1].id]);
    expect(attempts.map((a) => [Number(a.billing_event_id), a.status])).toEqual([
      [Number(events[0].id), 'cancelled'], [Number(events[1].id), 'pending'],
    ]);
  });

  it('a late payment on a cancelled attempt is recorded but activates nothing', async () => {
    const clerk = `in-cart-late-${uniq()}`;
    await createTestMembership(gymId, 'member', clerk);
    const p = await pending(await member(clerk), { assignment: false });
    lookups.set(p.request.provider_ref, 'PENDING');
    expect((await asMember(clerk, `/${p.id}/cancel`)).status).toBe(200);

    const hook = await signed({ id: p.request.provider_ref, orderId: p.request.provider_order, status: 'SUCCEEDED', amount: 4000 });
    expect(hook.status).toBe(200);
    expect((await one('SELECT status FROM payment_requests WHERE id = ?', [p.request.id])).status).toBe('completed');
    expect((await one('SELECT status FROM product_sets WHERE id = ?', [p.id])).status).toBe('in_cart');
  });

  it('a settled payment is not cancelled, and staff cancellation still keeps the set as cancelled (#2747)', async () => {
    const clerk = `in-cart-settled-${uniq()}`;
    await createTestMembership(gymId, 'member', clerk);
    const paid = await pending(await member(clerk), { assignment: false });
    await db.query(`UPDATE payment_requests SET status = 'completed', provider_status = 'SUCCEEDED' WHERE id = ?`, [paid.request.id]);
    const refused = await asMember(clerk, `/${paid.id}/cancel`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('payment_settled');

    const staffSet = await pending(undefined, { assignment: false });
    lookups.set(staffSet.request.provider_ref, 'PENDING');
    expect((await auth(request.post(`/product-sets/${staffSet.id}/cancel`)).send({})).status).toBe(200);
    expect((await one('SELECT status FROM product_sets WHERE id = ?', [staffSet.id])).status).toBe('cancelled');
    expect((await one('SELECT status FROM payment_requests WHERE id = ?', [staffSet.request.id])).status).toBe('expired');
  });

  it('a payment link that actually expired still returns to the cart as expired, not cancelled', async () => {
    const p = await pending(undefined, { assignment: false });
    await db.query(`UPDATE payment_requests SET status = 'expired' WHERE id = ?`, [p.request.id]);
    const { expirePendingPayments } = await import('../api/product-sets');
    await expirePendingPayments();
    expect((await one('SELECT status FROM product_sets WHERE id = ?', [p.id])).status).toBe('in_cart');
    // #1991 stage 4's expiry is unchanged: the unpaid event and its attempt are removed, never relabelled.
    expect(await one('SELECT status FROM payment_requests WHERE id = ?', [p.request.id])).toBeUndefined();
  });

  it('only the owner may cancel, and only their own gym\'s set', async () => {
    const clerk = `in-cart-owner-${uniq()}`;
    await createTestMembership(gymId, 'member', clerk);
    await member(clerk);
    const foreign = await pending(undefined, { assignment: false });
    const res = await asMember(clerk, `/${foreign.id}/cancel`);
    expect(res.status).toBe(404);
    expect((await one('SELECT status FROM product_sets WHERE id = ?', [foreign.id])).status).toBe('pending_payment');
  });
});
