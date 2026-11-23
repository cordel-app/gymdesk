// #2962 / #3274 — the cart (a `purchases` row in `in_cart`) expires two hours after its last
// change, as a whole: its standalone one-time Products and its Product Set Draft share the one clock
// `purchases.expires_at`. A cart past it is deleted before it can be listed, counted as held or paid
// for, and by the cleanup. Reading never moves the clock; a change does. Nothing is charged and no
// other purchase (a pending checkout, a completed one) is touched.
//
// Integration against the real stack; only the provider's `createPaymentRequest` is stubbed.

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

import { ageTestCart, cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';
import { expireCartInTx } from '../api/cart-expiry';
import { TEST_PURCHASES } from './productSnapshotReads';

const SECRET = 'cart-expiry-billing-secret';
let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const base = (memberId: number) => `/members/${memberId}/product-purchases`;

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Cart Member', `cart-${uniq()}@test.com`]);
  return insertId;
}

async function product(name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products
       (gym_id, name, type, billing_frequency, status, enrollment_status, is_system, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', 'once', 'active', 'public', 0, 'EUR', '25.00', 'inclusive')`,
    [gymId, name]);
  return insertId;
}

async function draft(memberId: number, productId: number): Promise<number> {
  const res = await auth(request.post(base(memberId))).send({ product_id: productId, draft: true });
  expect(res.status).toBe(201);
  return Number(res.body.purchaseId);
}

/** Moves the cart holding the line `purchaseId` back, as if its last change were `minutes` ago. */
async function age(purchaseId: number, minutes: number): Promise<void> {
  await ageTestCart({ lineId: purchaseId }, minutes);
}

/** The cart (`purchases`) holding the line, with its clock. */
async function cartOf(purchaseId: number): Promise<{ id: number; status: string; expires_at: Date | null } | null> {
  const { rows } = await db.query<any>(
    `SELECT p.id, p.status, p.expires_at FROM purchases p
      WHERE p.id IN (SELECT purchase_id FROM product_oneoff_snapshots WHERE source_id = ?
                     UNION ALL SELECT purchase_id FROM product_session_snapshots WHERE source_id = ?)`,
    [purchaseId, purchaseId]);
  return rows[0] ?? null;
}

async function recurringProduct(name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products
       (gym_id, name, type, billing_frequency, status, enrollment_status, is_system, currency, amount, tax_behavior)
     VALUES (?, ?, 'service', 'month', 'active', 'public', 0, 'EUR', '12.00', 'inclusive')`,
    [gymId, name]);
  return insertId;
}

async function exists(purchaseId: number): Promise<boolean> {
  const { rows } = await db.query<any>(`SELECT id FROM ${TEST_PURCHASES} AS legacy WHERE id = ?`, [purchaseId]);
  return rows.length > 0;
}

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = 'test-webhook-secret';
  process.env.BILLING_INTERNAL_SECRET = SECRET;
  gymId = await createTestGym('Cart Expiry Gym');
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

describe('a cart reports its one expiry', () => {
  it('lists a draft with its cart\'s expiry, two hours ahead, and nothing on a paid one', async () => {
    const m = await member();
    const d = await draft(m, await product('Towel'));
    const pending = await auth(request.post(base(m))).send({ product_id: await product('Locker') });
    expect(pending.status).toBe(201);

    const cart = await cartOf(d);
    expect(cart?.status).toBe('in_cart');
    const res = await auth(request.get(`/members/${m}/products`));
    expect(res.status).toBe(200);
    const row = res.body.items.find((i: any) => i.id === d);
    expect(Date.parse(row.cart_expires_at)).toBe(new Date(cart!.expires_at!).getTime());
    const left = Date.parse(row.cart_expires_at) - Date.now();
    expect(left).toBeGreaterThan(115 * 60_000);
    expect(left).toBeLessThanOrEqual(121 * 60_000);
    const paid = res.body.items.find((i: any) => i.id === Number(pending.body.purchaseId));
    expect(paid.cart_expires_at).toBeNull();
  });

  it('a mixed cart (a Product Set Draft and standalone Products) has one clock', async () => {
    const m = await member();
    const add = await auth(request.post(base(m))).send({ product_id: await recurringProduct('Mixed monthly') });
    expect(add.status).toBe(201);
    const d = await draft(m, await product('Mixed towel'));
    const cart = await cartOf(d);
    const { rows } = await db.query<any>('SELECT purchase_id FROM product_sets WHERE id = ?', [add.body.product_set_id]);
    expect(Number(rows[0].purchase_id)).toBe(cart!.id);

    const { rows: cfg } = await db.query<any>(
      'SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), expires_at) AS s FROM purchases WHERE id = ?', [cart!.id]);
    const conf = await auth(request.get(`/user-memberships/member/${m}/configuration`));
    expect(conf.status).toBe(200);
    const inFlight = conf.body.product_sets.find((x: any) => x.id === add.body.product_set_id);
    expect(Math.abs(inFlight.expires_in_seconds - Number(cfg[0].s))).toBeLessThanOrEqual(2);

    // Past its time, the whole cart goes: the set and the standalone item together.
    await age(d, 121);
    const res = await request.post('/billing/cleanup').set('x-internal-secret', SECRET);
    expect(res.status).toBe(200);
    expect(res.body.carts_expired).toBeGreaterThanOrEqual(1);
    expect(await exists(d)).toBe(false);
    const { rows: sets } = await db.query<any>('SELECT id FROM product_sets WHERE id = ?', [add.body.product_set_id]);
    expect(sets).toHaveLength(0);
    const { rows: gone } = await db.query<any>('SELECT id FROM purchases WHERE id = ?', [cart!.id]);
    expect(gone).toHaveLength(0);
  });

  it('reading the cart never moves its clock; a change does', async () => {
    const m = await member();
    const d = await draft(m, await product('Clock towel'));
    await age(d, 100);
    const before = (await cartOf(d))!.expires_at!;
    await auth(request.get(`/members/${m}/products`));
    await auth(request.get(`${base(m)}/cart-summary`));
    expect(new Date((await cartOf(d))!.expires_at!).getTime()).toBe(new Date(before).getTime());

    // Adding another item is a change: the same cart takes two hours from now.
    const second = await draft(m, await product('Clock robe'));
    const after = await cartOf(second);
    expect(after!.id).toBe((await cartOf(d))!.id);
    expect(new Date(after!.expires_at!).getTime() - Date.now()).toBeGreaterThan(115 * 60_000);
  });

  it('a cart that is not past its time is left alone by the expiry, even when asked directly', async () => {
    const m = await member();
    const d = await draft(m, await product('Live towel'));
    const cart = await cartOf(d);
    const out = await db.transaction((tx) => expireCartInTx(tx, gymId, cart!.id));
    expect(out.expired).toBe(false);
    expect(await exists(d)).toBe(true);
  });
});

describe('an expired cart', () => {
  it('is deleted before the list is read, with everything in it', async () => {
    const m = await member();
    const old = await draft(m, await product('Old towel'));
    const other = await draft(m, await product('Other towel'));
    await age(old, 121);

    const res = await auth(request.get(`/members/${m}/products`));
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i: any) => i.id);
    expect(ids).not.toContain(old);
    expect(ids).not.toContain(other);
    expect(await exists(old)).toBe(false);
    expect(await exists(other)).toBe(false);
  });

  it('cannot be paid for: Pay answers 410 and raises no payment', async () => {
    const m = await member();
    const d = await draft(m, await product('Expired pay'));
    await age(d, 121);

    const res = await auth(request.post(`${base(m)}/${d}/pay`)).send({});
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('purchase_expired');
    expect(await exists(d)).toBe(false);
    const { rows } = await db.query<any>(
      'SELECT COUNT(*) AS n FROM payment_requests WHERE gym_id = ? AND member_id = ?', [gymId, m]);
    expect(Number(rows[0].n)).toBe(0);
  });

  it('no longer blocks a new draft of the same Product, which starts a new cart', async () => {
    const m = await member();
    const p = await product('Re-added');
    const d = await draft(m, p);
    const oldCart = (await cartOf(d))!.id;
    expect((await auth(request.post(base(m))).send({ product_id: p, draft: true })).status).toBe(409);
    await age(d, 121);
    const again = await auth(request.post(base(m))).send({ product_id: p, draft: true });
    expect(again.status).toBe(201);
    expect(await exists(d)).toBe(false);
    expect((await cartOf(Number(again.body.purchaseId)))!.id).not.toBe(oldCart);
  });

  it('is swept by POST /billing/cleanup, which leaves another member\'s fresh cart and a pending purchase alone', async () => {
    const m = await member();
    const other = await member();
    const old = await draft(m, await product('Swept'));
    const fresh = await draft(other, await product('Kept'));
    const pending = await auth(request.post(base(m))).send({ product_id: await product('Pending') });
    const pendingId = Number(pending.body.purchaseId);
    await age(old, 121);
    await db.query(
      `UPDATE product_oneoff_snapshots SET created_at = UTC_TIMESTAMP() - INTERVAL 600 MINUTE WHERE source_id = ?`, [pendingId]);

    const res = await request.post('/billing/cleanup').set('x-internal-secret', SECRET);
    expect(res.status).toBe(200);
    expect(res.body.purchase_drafts_expired).toBeGreaterThanOrEqual(1);
    expect(await exists(old)).toBe(false);
    expect(await exists(fresh)).toBe(true);
    expect(await exists(pendingId)).toBe(true);
    expect((await cartOf(pendingId))?.status).toBe('pending_payment');
    expect((await cartOf(pendingId))?.expires_at).toBeNull();
  });
});
