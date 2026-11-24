// #3251 stage 1 — a purchase is a cart: one `purchases` row from the first thing put in the cart,
// shared by the Product Set and every one-time line added to it, following the checkout to the end.
// Integration against the real stack; only the provider's `createPaymentRequest` is stubbed, and
// the webhook's signature check stays real.
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
import { createDraft } from '../api/product-sets';
import { expireCarts } from '../api/cart-expiry';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request, openMemberCart } from './helpers';

const SECRET = 'test-3251-purchases-webhook';
let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

const asMember = (clerk: string, method: 'get' | 'post' | 'delete' | 'put', path: string) => {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any);
  return (request as any)[method](`/me/cart${path}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
};
const staff = (method: 'post' | 'get' | 'delete', path: string) =>
  (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function member(): Promise<{ clerk: string; id: number }> {
  const clerk = `purchases-${uniq()}`;
  await createTestMembership(gymId, 'member', clerk);
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, 'Cart Owner', `${clerk}@t.com`, clerk]);
  return { clerk, id: insertId };
}

async function product(amount: string, frequency: 'once' | 'month' = 'once'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', ?, 'active', 'public', 'EUR', ?, 'inclusive')`,
    [gymId, `P-${uniq()}`, frequency, amount]);
  return insertId;
}

/** The cart a one-time line (its line id, `source_id`) belongs to. */
async function cartOfLine(lineId: number): Promise<number | null> {
  const { rows } = await db.query<any>(
    `SELECT purchase_id FROM product_oneoff_snapshots WHERE source_id = ?
     UNION ALL SELECT purchase_id FROM product_session_snapshots WHERE source_id = ?`, [lineId, lineId]);
  return rows[0]?.purchase_id == null ? null : Number(rows[0].purchase_id);
}
const cartOfSet = async (setId: number) =>
  Number((await db.query<any>('SELECT purchase_id FROM product_sets WHERE id = ?', [setId])).rows[0]?.purchase_id ?? 0) || null;
const purchase = async (id: number | null) =>
  id == null ? null : (await db.query<any>('SELECT * FROM purchases WHERE id = ?', [id])).rows[0] ?? null;
const purchasesOf = async (memberId: number) =>
  (await db.query<any>('SELECT id, status FROM purchases WHERE owner_member_id = ? ORDER BY id', [memberId])).rows;

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

/** A member whose cart holds a Draft Product Set with one monthly Product. */
async function memberWithDraft() {
  const m = await member();
  // #3305: the member opens the cart, so it stays theirs while staff add to it.
  await openMemberCart(gymId, m.clerk);
  const res = await staff('post', `/members/${m.id}/product-purchases`).send({ product_id: await product('30.00', 'month') });
  expect(res.status).toBe(201);
  return { ...m, setId: Number(res.body.product_set_id) };
}

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = SECRET;
  gymId = await createTestGym('Purchases Gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  delete process.env.MONEI_API_KEY;
  delete process.env.MONEI_WEBHOOK_SECRET;
  await cleanupTestGyms();
  await db.end();
});

describe('one cart, one purchase (#3251)', () => {
  it('starts a purchase with the cart and shares it with everything added to it', async () => {
    const m = await memberWithDraft();
    const cart = await cartOfSet(m.setId);
    expect(cart).not.toBeNull();
    const row = await purchase(cart);
    expect(row).toMatchObject({ gym_id: gymId, owner_member_id: m.id, status: 'in_cart' });

    const a = await asMember(m.clerk, 'post', '/purchases').send({ product_id: await product('10.00') });
    const b = await asMember(m.clerk, 'post', '/purchases').send({ product_id: await product('12.00') });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(await cartOfLine(a.body.purchase_id)).toBe(cart);
    expect(await cartOfLine(b.body.purchase_id)).toBe(cart);
    // Editing the cart allocates no purchase.
    await asMember(m.clerk, 'delete', `/purchases/${a.body.purchase_id}`);
    expect(await purchasesOf(m.id)).toEqual([{ id: cart, status: 'in_cart' }]);
  });

  it('a standalone cart is one purchase, deleted when the last thing in it is removed', async () => {
    const m = await member();
    const a = await asMember(m.clerk, 'post', '/purchases').send({ product_id: await product('5.00') });
    const b = await asMember(m.clerk, 'post', '/purchases').send({ product_id: await product('6.00') });
    const cart = await cartOfLine(a.body.purchase_id);
    expect(cart).not.toBeNull();
    expect(await cartOfLine(b.body.purchase_id)).toBe(cart);

    expect((await asMember(m.clerk, 'delete', `/purchases/${a.body.purchase_id}`)).status).toBeLessThan(300);
    expect((await purchase(cart))?.status).toBe('in_cart');
    expect((await asMember(m.clerk, 'delete', `/purchases/${b.body.purchase_id}`)).status).toBeLessThan(300);
    expect(await purchase(cart)).toBeNull();
  });

  it('expiring a standalone cart deletes its purchase', async () => {
    const m = await member();
    const a = await asMember(m.clerk, 'post', '/purchases').send({ product_id: await product('4.00') });
    const cart = await cartOfLine(a.body.purchase_id);
    await db.query('UPDATE purchases SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE id = ?', [cart]);
    const expired = await expireCarts({ gymId, ownerMemberId: m.id });
    expect(expired.lines.map((e) => e.id)).toEqual([a.body.purchase_id]);
    expect(await purchase(cart)).toBeNull();
  });
});

describe('the purchase follows its checkout (#3251)', () => {
  it('Save & Pay makes it pending, the provider\'s success completes it, and a retry changes nothing', async () => {
    const m = await memberWithDraft();
    const line = await asMember(m.clerk, 'post', '/purchases').send({ product_id: await product('8.00') });
    const cart = await cartOfSet(m.setId);

    const res = await staff('post', `/product-sets/${m.setId}/save-and-pay`).send({});
    expect(res.status).toBe(201);
    expect((await purchase(cart))?.status).toBe('pending_payment');
    expect(await cartOfLine(line.body.purchase_id)).toBe(cart);

    const order = await orderOfEvent(Number(res.body.billing_event_id));
    expect((await webhook(order, 'SUCCEEDED')).status).toBe(200);
    expect((await purchase(cart))?.status).toBe('completed');
    // #3307 — the version's own read reports its purchase, so the Admin Summary can keep showing it.
    const read = await staff('get', `/product-sets/${m.setId}`);
    expect(read.status).toBe(200);
    expect(read.body.status).toBe('active');
    expect(read.body.purchase).toMatchObject({ id: cart, status: 'completed' });
    expect(typeof read.body.purchase.name).toBe('string');
    // The duplicate delivery neither re-opens nor duplicates anything.
    expect((await webhook(order, 'SUCCEEDED')).status).toBe(200);
    expect(await purchasesOf(m.id)).toEqual([{ id: cart, status: 'completed' }]);

    // The next thing put in the cart starts a new purchase; the completed one stays.
    const next = await asMember(m.clerk, 'post', '/purchases').send({ product_id: await product('3.00') });
    const nextCart = await cartOfLine(next.body.purchase_id);
    expect(nextCart).not.toBe(cart);
    expect((await purchase(cart))?.status).toBe('completed');
  });

  it('a checkout returned to Draft is the cart again, taking in what was added meanwhile', async () => {
    const m = await memberWithDraft();
    const cart = await cartOfSet(m.setId);
    const res = await staff('post', `/product-sets/${m.setId}/save-and-pay`).send({});
    expect(res.status).toBe(201);
    // Added while the checkout is pending: a cart of its own.
    const late = await asMember(m.clerk, 'post', '/purchases').send({ product_id: await product('9.00') });
    const lateCart = await cartOfLine(late.body.purchase_id);
    expect(lateCart).not.toBe(cart);
    expect((await purchase(lateCart))?.status).toBe('in_cart');

    expect((await webhook(await orderOfEvent(Number(res.body.billing_event_id)), 'FAILED')).status).toBe(200);
    expect((await staff('delete', `/product-sets/${m.setId}`)).status).toBe(204);
    expect((await purchase(cart))?.status).toBe('in_cart');
    expect(await cartOfSet(m.setId)).toBe(cart);
    expect(await cartOfLine(late.body.purchase_id)).toBe(cart);
    expect(await purchase(lateCart)).toBeNull();
  });

  it('cancelling an unconfirmed cart deletes its purchase and what it created, nothing else', async () => {
    const m = await memberWithDraft();
    const previous = await memberWithDraft();
    const line = await asMember(m.clerk, 'post', '/purchases').send({ product_id: await product('7.00') });
    const cart = await cartOfSet(m.setId);
    expect((await staff('delete', `/product-sets/${m.setId}`)).status).toBe(204);
    expect(await purchase(cart)).toBeNull();
    expect(await cartOfLine(line.body.purchase_id)).toBeNull();
    expect((await db.query<any>('SELECT id FROM product_sets WHERE id = ?', [m.setId])).rows).toEqual([]);
    // Another owner's cart is untouched.
    expect((await purchase(await cartOfSet(previous.setId)))?.status).toBe('in_cart');
  });

  it('a cancelled Pending Payment checkout keeps its purchase, cancelled', async () => {
    const m = await memberWithDraft();
    const cart = await cartOfSet(m.setId);
    const res = await staff('post', `/product-sets/${m.setId}/save-and-pay`).send({});
    expect((await webhook(await orderOfEvent(Number(res.body.billing_event_id)), 'FAILED')).status).toBe(200);
    expect((await staff('post', `/product-sets/${m.setId}/cancel`).send({})).status).toBe(200);
    expect((await purchase(cart))?.status).toBe('cancelled');
    expect(await cartOfSet(m.setId)).toBe(cart);
  });

  it('paying part of a standalone cart gives the paid lines a purchase of their own; the rest keeps the cart', async () => {
    const m = await member();
    const a = await asMember(m.clerk, 'post', '/purchases').send({ product_id: await product('10.00') });
    const b = await asMember(m.clerk, 'post', '/purchases').send({ product_id: await product('11.00') });
    const cart = await cartOfLine(a.body.purchase_id);
    const res = await asMember(m.clerk, 'post', '/checkout').send({ purchase_ids: [a.body.purchase_id] });
    expect(res.status).toBe(201);
    const checkout = await cartOfLine(a.body.purchase_id);
    expect(checkout).not.toBe(cart);
    expect((await purchase(checkout))?.status).toBe('pending_payment');
    expect(await cartOfLine(b.body.purchase_id)).toBe(cart);
    expect((await purchase(cart))?.status).toBe('in_cart');
  });

  it('paying a whole standalone cart keeps its purchase', async () => {
    const m = await member();
    const a = await asMember(m.clerk, 'post', '/purchases').send({ product_id: await product('10.00') });
    const cart = await cartOfLine(a.body.purchase_id);
    const res = await asMember(m.clerk, 'post', '/checkout').send({});
    expect(res.status).toBe(201);
    expect(await cartOfLine(a.body.purchase_id)).toBe(cart);
    expect((await purchase(cart))?.status).toBe('pending_payment');
    const order = await orderOfEvent(Number(res.body.billingEventId));
    expect((await webhook(order, 'SUCCEEDED')).status).toBe(200);
    expect((await purchase(cart))?.status).toBe('completed');
  });
});

describe('versions that are not checkouts (#3251)', () => {
  it('a Draft created with `purchase: false` (the bridge\'s edit or retire version) starts no cart', async () => {
    const m = await member();
    const out = await db.transaction((tx) => createDraft(tx, {
      gymId, ownerMemberId: m.id, membershipPlanId: null, startsAt: '2026-01-01', actor: { name: 'Staff' }, purchase: false,
    }));
    expect(out.kind).toBe('created');
    expect(await cartOfSet((out as any).productSet.id)).toBeNull();
    expect(await purchasesOf(m.id)).toEqual([]);
  });
});
