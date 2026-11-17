// #2962 — a standalone one-time Product in the cart (a staff `draft` purchase no Product Set
// carries) expires two hours after it was added: it is reported with its expiry instant while it
// lasts, and once past it is deleted before it can be listed, counted as held or paid for, and by
// the nightly cleanup. Nothing is charged and no other purchase is touched.
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

import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';
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

/** Moves a purchase's `created_at` back by `minutes`, as if it had been added then. */
async function age(purchaseId: number, minutes: number): Promise<void> {
  for (const table of ['product_oneoff_snapshots', 'product_session_snapshots']) {
    await db.query(
      `UPDATE ${table} SET created_at = UTC_TIMESTAMP() - INTERVAL ${minutes} MINUTE WHERE gym_id = ? AND source_id = ?`,
      [gymId, purchaseId]);
  }
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

describe('a standalone cart purchase reports when it expires', () => {
  it('lists the draft with an expiry two hours after it was added, and nothing on a paid one', async () => {
    const m = await member();
    const d = await draft(m, await product('Towel'));
    const pending = await auth(request.post(base(m))).send({ product_id: await product('Locker') });
    expect(pending.status).toBe(201);

    const res = await auth(request.get(`/members/${m}/products`));
    expect(res.status).toBe(200);
    const row = res.body.items.find((i: any) => i.id === d);
    const created = Date.parse(row.created_at);
    expect(Date.parse(row.cart_expires_at) - created).toBe(120 * 60_000);
    const paid = res.body.items.find((i: any) => i.id === Number(pending.body.purchaseId));
    expect(paid.cart_expires_at).toBeNull();
  });
});

describe('an expired cart purchase', () => {
  it('is deleted before the list is read, while a fresh one stays', async () => {
    const m = await member();
    const old = await draft(m, await product('Old towel'));
    const fresh = await draft(m, await product('Fresh towel'));
    await age(old, 121);

    const res = await auth(request.get(`/members/${m}/products`));
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i: any) => i.id);
    expect(ids).not.toContain(old);
    expect(ids).toContain(fresh);
    expect(await exists(old)).toBe(false);
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

  it('no longer blocks a new draft of the same Product', async () => {
    const m = await member();
    const p = await product('Re-added');
    const d = await draft(m, p);
    expect((await auth(request.post(base(m))).send({ product_id: p, draft: true })).status).toBe(409);
    await age(d, 121);
    const again = await auth(request.post(base(m))).send({ product_id: p, draft: true });
    expect(again.status).toBe(201);
    expect(await exists(d)).toBe(false);
  });

  it('is swept by POST /billing/cleanup, which leaves a fresh draft and a pending purchase alone', async () => {
    const m = await member();
    const old = await draft(m, await product('Swept'));
    const fresh = await draft(m, await product('Kept'));
    const pending = await auth(request.post(base(m))).send({ product_id: await product('Pending') });
    const pendingId = Number(pending.body.purchaseId);
    await age(old, 121);
    await age(pendingId, 600);

    const res = await request.post('/billing/cleanup').set('x-internal-secret', SECRET);
    expect(res.status).toBe(200);
    expect(res.body.purchase_drafts_expired).toBeGreaterThanOrEqual(1);
    expect(await exists(old)).toBe(false);
    expect(await exists(fresh)).toBe(true);
    expect(await exists(pendingId)).toBe(true);
  });
});
