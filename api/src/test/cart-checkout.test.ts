// #2949 stage 4 — a one-time Product in the cart no longer needs a Product Set: the member adds one
// standalone (`/me/cart/purchases`), and the member's or staff's checkout pays every standalone cart
// purchase together — one Billing Event, one payment request — which the provider's answer
// completes or cancels as a whole. Integration against the real stack; only the provider's
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
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';
import { TEST_PURCHASES } from './productSnapshotReads';

const SECRET = 'test-2949-stage-4-webhook';
let gymId: string;
let otherGymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

const asMember = (clerk: string, method: 'get' | 'post' | 'delete', path: string, gym = gymId) => {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any);
  return (request as any)[method](`/me/cart${path}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
};
const staff = (method: 'post' | 'get', path: string) =>
  (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function member(): Promise<{ clerk: string; id: number }> {
  const clerk = `cart-co-${uniq()}`;
  await createTestMembership(gymId, 'member', clerk);
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, 'Cart Member', `${clerk}@t.com`, clerk]);
  return { clerk, id: insertId };
}

async function product(amount: string, frequency: 'once' | 'month' = 'once', type = 'fee', units: number | null = null): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior, units)
     VALUES (?, ?, ?, ?, 'active', 'public', 'EUR', ?, 'inclusive', ?)`,
    [gymId, `P-${uniq()}`, type, frequency, amount, units]);
  return insertId;
}

const purchaseStatus = async (id: number) =>
  (await db.query<any>(`SELECT status FROM ${TEST_PURCHASES} AS legacy WHERE id = ?`, [id])).rows[0]?.status ?? null;

/** The Billing Event a purchase's snapshot is linked to (either arm). */
async function eventOf(purchaseId: number): Promise<number | null> {
  const { rows } = await db.query<any>(
    `SELECT j.billing_event_id FROM billing_event_oneoff_snapshots j
       JOIN product_oneoff_snapshots s ON s.id = j.product_oneoff_snapshot_id WHERE s.source_id = ?
     UNION ALL
     SELECT j.billing_event_id FROM billing_event_session_snapshots j
       JOIN product_session_snapshots s ON s.id = j.product_session_snapshot_id WHERE s.source_id = ?`,
    [purchaseId, purchaseId]);
  return rows[0] ? Number(rows[0].billing_event_id) : null;
}

function webhook(orderId: string, status: string) {
  const id = crypto.randomBytes(12).toString('hex');
  const raw = JSON.stringify({ id, orderId, status });
  const t = String(Math.floor(Date.now() / 1000));
  const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
  return request.post('/webhooks/payment').set({ 'monei-signature': `t=${t},v1=${v1}` })
    .set('Content-Type', 'application/json').send(raw);
}

async function orderOfEvent(eventId: number): Promise<{ id: number; provider_order: string; amount: string }> {
  const { rows } = await db.query<any>(
    'SELECT id, provider_order, amount FROM payment_requests WHERE billing_event_id = ? ORDER BY id DESC', [eventId]);
  return rows[0];
}

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = SECRET;
  gymId = await createTestGym('Cart Checkout Gym');
  otherGymId = await createTestGym('Cart Checkout Other Gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  delete process.env.MONEI_API_KEY;
  delete process.env.MONEI_WEBHOOK_SECRET;
  await cleanupTestGyms();
  await db.end();
});

describe('POST /me/cart/purchases (#2949 stage 4)', () => {
  it('adds a one-time Product to the cart with no Product Set', async () => {
    const m = await member();
    const p = await product('20.00');
    const res = await asMember(m.clerk, 'post', '/purchases').send({ product_id: p });
    expect(res.status).toBe(201);
    expect(res.body.amount).toBe(20);
    expect(await purchaseStatus(res.body.purchase_id)).toBe('in_cart');
    const { rows } = await db.query<any>('SELECT COUNT(*) AS n FROM product_sets WHERE gym_id = ? AND owner_member_id = ?', [gymId, m.id]);
    expect(Number(rows[0].n)).toBe(0);

    const cart = await asMember(m.clerk, 'get', '/purchases');
    expect(cart.status).toBe(200);
    expect(cart.body.purchases.map((x: any) => x.id)).toEqual([res.body.purchase_id]);
    expect(cart.body.total).toBe(20);
    expect(cart.body.purchases[0].cart_expires_at).toBeTruthy();
  });

  it('refuses the same Product twice, a recurring Product and a direct discount', async () => {
    const m = await member();
    const p = await product('10.00');
    expect((await asMember(m.clerk, 'post', '/purchases').send({ product_id: p })).status).toBe(201);
    const again = await asMember(m.clerk, 'post', '/purchases').send({ product_id: p });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('already_in_cart');
    const monthly = await asMember(m.clerk, 'post', '/purchases').send({ product_id: await product('30.00', 'month') });
    expect(monthly.status).toBe(400);
    expect(monthly.body.error).toBe('recurring_product');
    const discounted = await asMember(m.clerk, 'post', '/purchases').send({ product_id: await product('5.00'), direct_discount_percent: 10 });
    expect(discounted.status).toBe(403);
  });

  it('removes one of the member\'s standalone purchases and nobody else\'s', async () => {
    const a = await member();
    const b = await member();
    const added = await asMember(a.clerk, 'post', '/purchases').send({ product_id: await product('8.00') });
    expect((await asMember(b.clerk, 'delete', `/purchases/${added.body.purchase_id}`)).status).toBe(404);
    expect(await purchaseStatus(added.body.purchase_id)).toBe('in_cart');
    expect((await asMember(a.clerk, 'delete', `/purchases/${added.body.purchase_id}`)).status).toBe(200);
    expect(await purchaseStatus(added.body.purchase_id)).toBeNull();
  });

  it('answers 401 with no session and never reads another gym\'s cart', async () => {
    expect((await request.get('/me/cart/purchases').set('x-gym-id', gymId)).status).toBe(401);
    const m = await member();
    await asMember(m.clerk, 'post', '/purchases').send({ product_id: await product('3.00') });
    const res = await asMember(m.clerk, 'get', '/purchases', otherGymId);
    expect([403, 404]).toContain(res.status);
  });
});

describe('POST /me/cart/checkout (#2949 stage 4)', () => {
  it('pays every standalone cart purchase in one Billing Event, and the provider\'s success completes them all', async () => {
    const m = await member();
    const one = await asMember(m.clerk, 'post', '/purchases').send({ product_id: await product('12.50') });
    const two = await asMember(m.clerk, 'post', '/purchases').send({ product_id: await product('30.00', 'once', 'sessions', 5) });
    const res = await asMember(m.clerk, 'post', '/checkout').send({});
    expect(res.status).toBe(201);
    expect(res.body.amount).toBe(42.5);
    expect(res.body.purchaseIds.sort()).toEqual([one.body.purchase_id, two.body.purchase_id].sort());
    expect(res.body.checkoutUrl).toBeTruthy();

    const eventId = res.body.billingEventId;
    expect(await eventOf(one.body.purchase_id)).toBe(eventId);
    expect(await eventOf(two.body.purchase_id)).toBe(eventId);
    const { rows: ev } = await db.query<any>(
      'SELECT event_type, amount, product_set_id, name FROM billing_events WHERE id = ?', [eventId]);
    expect(ev[0]).toMatchObject({ event_type: 'product_purchase', amount: '42.50', product_set_id: null });
    expect(ev[0].name).toContain('Compra');
    const { rows: lines } = await db.query<any>(
      'SELECT amount FROM billing_event_lines WHERE billing_event_id = ? ORDER BY amount', [eventId]);
    expect(lines.map((l: any) => l.amount)).toEqual(['12.50', '30.00']);
    const { rows: reqs } = await db.query<any>('SELECT COUNT(*) AS n FROM payment_requests WHERE billing_event_id = ?', [eventId]);
    expect(Number(reqs[0].n)).toBe(1);
    expect(await purchaseStatus(one.body.purchase_id)).toBe('pending_payment');
    expect(await purchaseStatus(two.body.purchase_id)).toBe('pending_payment');
    // The cart is empty now: nothing is paid twice.
    expect((await asMember(m.clerk, 'post', '/checkout').send({})).body.error).toBe('cart_empty');

    const pr = await orderOfEvent(eventId);
    expect(pr.amount).toBe('42.50');
    expect((await webhook(pr.provider_order, 'SUCCEEDED')).status).toBe(200);
    expect(await purchaseStatus(one.body.purchase_id)).toBe('active');
    expect(await purchaseStatus(two.body.purchase_id)).toBe('active');
  });

  it('cancels every purchase of the checkout when the payment fails', async () => {
    const m = await member();
    const one = await asMember(m.clerk, 'post', '/purchases').send({ product_id: await product('4.00') });
    const two = await asMember(m.clerk, 'post', '/purchases').send({ product_id: await product('6.00') });
    const res = await asMember(m.clerk, 'post', '/checkout').send({});
    const pr = await orderOfEvent(res.body.billingEventId);
    expect((await webhook(pr.provider_order, 'FAILED')).status).toBe(200);
    expect(await purchaseStatus(one.body.purchase_id)).toBe('cancelled');
    expect(await purchaseStatus(two.body.purchase_id)).toBe('cancelled');
  });

  it('pays only the purchases named, leaving the rest in the cart', async () => {
    const m = await member();
    const one = await asMember(m.clerk, 'post', '/purchases').send({ product_id: await product('9.00') });
    const two = await asMember(m.clerk, 'post', '/purchases').send({ product_id: await product('11.00') });
    const res = await asMember(m.clerk, 'post', '/checkout').send({ purchase_ids: [two.body.purchase_id] });
    expect(res.status).toBe(201);
    expect(res.body.amount).toBe(11);
    expect(await purchaseStatus(one.body.purchase_id)).toBe('in_cart');
    expect(await purchaseStatus(two.body.purchase_id)).toBe('pending_payment');
    const bad = await asMember(m.clerk, 'post', '/checkout').send({ purchase_ids: [two.body.purchase_id] });
    expect(bad.status).toBe(404);
    expect(bad.body.error).toBe('purchase_not_in_cart');
  });
});

describe('POST /members/:id/product-purchases/checkout (#2949 stage 4)', () => {
  it('pays the member\'s standalone staff drafts together', async () => {
    const m = await member();
    const ids: number[] = [];
    for (const amount of ['15.00', '5.00']) {
      const res = await staff('post', `/members/${m.id}/product-purchases`).send({ product_id: await product(amount), draft: true });
      expect(res.status).toBe(201);
      ids.push(Number(res.body.purchaseId));
    }
    const res = await staff('post', `/members/${m.id}/product-purchases/checkout`).send({});
    expect(res.status).toBe(201);
    expect(res.body.amount).toBe(20);
    for (const id of ids) {
      expect(await purchaseStatus(id)).toBe('pending_payment');
      expect(await eventOf(id)).toBe(res.body.billingEventId);
    }
  });

  it('answers 409 cart_empty for a member with nothing in the cart', async () => {
    const m = await member();
    const res = await staff('post', `/members/${m.id}/product-purchases/checkout`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cart_empty');
  });
});
