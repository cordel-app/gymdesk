// #3251 stage 2 — a cart's plan snapshots, recurring lines and checkout Billing Events record the
// purchase they were written in; versions that are not checkouts (a reprice) create none and keep
// the original purchase on what they copy. Integration against the real stack; only the provider's
// `createPaymentRequest` is stubbed, and the webhook's signature check stays real.
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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

import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';

const SECRET = 'test-3251-purchase-links-webhook';
let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

const staff = (method: 'post' | 'get' | 'delete' | 'put', path: string) =>
  (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const asMember = (clerk: string, method: 'post' | 'get', path: string) => {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any);
  return (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
};
const must = (res: any, what: string) => {
  if (res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
};

async function member(): Promise<{ clerk: string; id: number }> {
  const clerk = `purchase-links-${uniq()}`;
  await createTestMembership(gymId, 'member', clerk);
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, 'Link Owner', `${clerk}@t.com`, clerk]);
  return { clerk, id: insertId };
}

async function product(amount: string, frequency: 'once' | 'month' = 'once'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', ?, 'active', 'public', 'EUR', ?, 'inclusive')`,
    [gymId, `P-${uniq()}`, frequency, amount]);
  return insertId;
}

async function plan(price = 30): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 1)`, [gymId, `Links Plan ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, ?, '2020-01-01', 'active')`, [gymId, insertId, price]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}

function webhook(orderId: string, status: string) {
  const id = crypto.randomBytes(12).toString('hex');
  const raw = JSON.stringify({ id, orderId, status });
  const t = String(Math.floor(Date.now() / 1000));
  const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
  return request.post('/webhooks/payment').set({ 'monei-signature': `t=${t},v1=${v1}` })
    .set('Content-Type', 'application/json').send(raw);
}
const orderOfEvent = async (eventId: number) =>
  (await db.query<any>('SELECT provider_order FROM payment_requests WHERE billing_event_id = ? ORDER BY id DESC', [eventId])).rows[0].provider_order;

const cartOfSet = async (setId: number) =>
  (await db.query<any>('SELECT purchase_id FROM product_sets WHERE id = ?', [setId])).rows[0]?.purchase_id ?? null;
const planSnapshotsOf = async (setId: number) =>
  (await db.query<any>(
    `SELECT s.id, s.purchase_id FROM product_set_plan_snapshots j JOIN plan_snapshots s ON s.id = j.plan_snapshot_id
      WHERE j.product_set_id = ? ORDER BY j.id`, [setId])).rows;
const linesOf = async (setId: number) =>
  (await db.query<any>(
    `SELECT s.id, s.source_id, s.product_id, s.purchase_id FROM product_set_periodical_snapshots j
       JOIN product_periodical_snapshots s ON s.id = j.product_periodical_snapshot_id
      WHERE j.product_set_id = ? ORDER BY j.id`, [setId])).rows;
const eventsOf = async (memberId: number) =>
  (await db.query<any>(
    `SELECT id, event_type, is_scheduled, amount, purchase_id, product_set_id FROM billing_events
      WHERE gym_id = ? AND member_id = ? ORDER BY id`, [gymId, memberId])).rows;
const purchasesOf = async (memberId: number) =>
  (await db.query<any>('SELECT id, status FROM purchases WHERE owner_member_id = ? ORDER BY id', [memberId])).rows;
const setOfAssignment = async (um: number) =>
  Number((await db.query<any>('SELECT id FROM product_sets WHERE plan_assignment_id = ? ORDER BY id DESC LIMIT 1', [um])).rows[0].id);
const activeSetOf = async (memberId: number) =>
  Number((await db.query<any>(
    `SELECT id FROM product_sets WHERE gym_id = ? AND owner_member_id = ? AND status = 'active'`, [gymId, memberId])).rows[0].id);

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = SECRET;
  gymId = await createTestGym('Purchase Links Gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  delete process.env.MONEI_API_KEY;
  delete process.env.MONEI_WEBHOOK_SECRET;
  await cleanupTestGyms();
  await db.end();
});

describe('a Membership Plan checkout (#3251 stage 2)', () => {
  it('stamps the plan snapshot and the initial event with the cart, and no scheduled obligation', async () => {
    const m = await member();
    const um = await createTestDraftAssignment(gymId, m.id, await plan(), { config: { membership_fee_price: 30 } });
    const setId = await setOfAssignment(um);
    const cart = await cartOfSet(setId);
    expect(cart).not.toBeNull();
    expect((await planSnapshotsOf(setId)).map((s: any) => s.purchase_id)).toEqual([cart]);

    const pay = must(await staff('post', `/user-memberships/${um}/save-and-pay`).send({}), 'save-and-pay');
    const initial = (await eventsOf(m.id)).find((e: any) => e.event_type === 'payment_recorded' && e.is_scheduled === 0);
    expect(initial?.purchase_id).toBe(cart);
    expect(pay.status).toBeLessThan(300);
    // A cash first payment on the initial event commits the checkout; a retry changes nothing.
    must(await staff('post', `/user-memberships/${um}/record-payment`).send({}), 'record-payment');
    expect((await staff('post', `/user-memberships/${um}/record-payment`).send({})).status).toBeGreaterThanOrEqual(400);

    expect(await purchasesOf(m.id)).toEqual([{ id: cart, status: 'completed' }]);
    const events = await eventsOf(m.id);
    expect(events.filter((e: any) => e.purchase_id === cart).map((e: any) => e.id)).toEqual([initial.id]);
    expect(events.filter((e: any) => e.is_scheduled === 1).every((e: any) => e.purchase_id == null)).toBe(true);
    // The Active version keeps the plan the cart wrote.
    expect((await planSnapshotsOf(await activeSetOf(m.id))).map((s: any) => s.purchase_id)).toEqual([cart]);
  });

  it('a plan price change creates no purchase and no charge, and its copy keeps the original purchase', async () => {
    const m = await member();
    const planId = await plan(30);
    const um = await createTestDraftAssignment(gymId, m.id, planId, { config: { membership_fee_price: 30 } });
    const cart = await cartOfSet(await setOfAssignment(um));
    must(await staff('post', `/user-memberships/${um}/save-and-pay`).send({}), 'save-and-pay');
    const initial = (await eventsOf(m.id)).find((e: any) => e.event_type === 'payment_recorded');
    expect(initial.purchase_id).toBe(cart);
    must(await staff('post', `/user-memberships/${um}/record-payment`).send({}), 'record-payment');
    const before = await eventsOf(m.id);

    must(await staff('put', `/membership-plans/${planId}/pricing`).send({ price: 45 }), 'pricing');
    const res = must(await staff('post', `/membership-plans/${planId}/pricing/apply-to-assigned-plans`), 'apply');
    expect(res.body.updated).toBe(1);

    expect(await purchasesOf(m.id)).toEqual([{ id: cart, status: 'completed' }]);
    const after = await eventsOf(m.id);
    // No new checkout charge: the only non-scheduled payment is still the initial one.
    expect(after.filter((e: any) => e.is_scheduled === 0).map((e: any) => e.id))
      .toEqual(before.filter((e: any) => e.is_scheduled === 0).map((e: any) => e.id));
    expect(after.filter((e: any) => e.purchase_id != null).map((e: any) => e.id)).toEqual([initial.id]);
    // The repriced plan still names the checkout that created it.
    expect((await planSnapshotsOf(await activeSetOf(m.id))).map((s: any) => s.purchase_id)).toEqual([cart]);
  });
});

describe('recurring Product lines (#3251 stage 2)', () => {
  it('a line takes its cart; a later cart links it unchanged and stamps only what it adds or changes', async () => {
    const m = await member();
    const first = must(await staff('post', `/members/${m.id}/product-purchases`).send({ product_id: await product('30.00', 'month') }), 'add');
    const setA = Number(first.body.product_set_id);
    const cartA = await cartOfSet(setA);
    const [lineA] = await linesOf(setA);
    expect(lineA.purchase_id).toBe(cartA);

    const pay = must(await staff('post', `/product-sets/${setA}/save-and-pay`).send({}), 'save-and-pay A');
    const initialA = (await eventsOf(m.id)).find((e: any) => e.id === Number(pay.body.billing_event_id));
    expect(initialA.purchase_id).toBe(cartA);
    expect((await webhook(await orderOfEvent(initialA.id), 'SUCCEEDED')).status).toBe(200);

    const second = must(await staff('post', `/members/${m.id}/product-purchases`).send({ product_id: await product('12.00', 'month') }), 'add B');
    const setB = Number(second.body.product_set_id);
    const cartB = await cartOfSet(setB);
    expect(cartB).not.toBe(cartA);
    const linesB = await linesOf(setB);
    expect(linesB.find((l: any) => l.id === lineA.id)?.purchase_id).toBe(cartA);
    expect(linesB.find((l: any) => l.id !== lineA.id)?.purchase_id).toBe(cartB);

    // Changing the inherited line in the new cart copies it, and the copy is the new cart's change.
    must(await staff('put', `/product-sets/${setB}/services/${lineA.source_id}`).send({ quantity: 2 }), 'quantity');
    const changed = (await linesOf(setB)).find((l: any) => l.product_id === lineA.product_id);
    expect(changed.id).not.toBe(lineA.id);
    expect(changed.purchase_id).toBe(cartB);
    expect((await linesOf(setA)).find((l: any) => l.id === lineA.id)?.purchase_id).toBe(cartA);
  });
});

describe('one-time Product checkouts (#3251 stage 2)', () => {
  it('a standalone cart checkout event is the checkout\'s purchase', async () => {
    const m = await member();
    const line = must(await asMember(m.clerk, 'post', '/me/cart/purchases').send({ product_id: await product('10.00') }), 'add');
    const res = must(await asMember(m.clerk, 'post', '/me/cart/checkout').send({}), 'checkout');
    const { rows } = await db.query<any>('SELECT purchase_id FROM product_oneoff_snapshots WHERE source_id = ?', [line.body.purchase_id]);
    const event = (await eventsOf(m.id)).find((e: any) => e.id === Number(res.body.billingEventId));
    expect(event.purchase_id).toBe(rows[0].purchase_id);
    expect(event.purchase_id).not.toBeNull();
  });

  it('a direct one-time purchase\'s event is its own checkout\'s purchase', async () => {
    const m = await member();
    const res = must(await staff('post', `/members/${m.id}/product-purchases`).send({ product_id: await product('15.00') }), 'buy');
    const events = (await eventsOf(m.id)).filter((e: any) => e.event_type === 'product_purchase');
    expect(events).toHaveLength(1);
    const lineId = res.body.purchaseId;
    const { rows } = await db.query<any>('SELECT purchase_id FROM product_oneoff_snapshots WHERE source_id = ?', [lineId]);
    expect(events[0].purchase_id).toBe(rows[0].purchase_id);
    expect(events[0].purchase_id).not.toBeNull();
  });
});
