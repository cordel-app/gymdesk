// #3313 — a Members App payment is created only by an explicit Pay. Reading what the cart would
// charge (the Summary the Admin's payment modal shows, and what choosing Members App re-reads)
// writes no Billing Event, payment request or purchase change; one Pay writes exactly one Billing
// Event and one payment request; and a double-click or two concurrent Pays cannot write a second.
// Integration against the real stack; only the provider's `createPaymentRequest` is stubbed.
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

import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';
import { TEST_PURCHASES } from './productSnapshotReads';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

const staff = (method: 'post' | 'get', path: string) =>
  (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Pay Confirmation Member', `pay-${uniq()}@t.com`]);
  return insertId;
}

async function product(amount: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', 'once', 'active', 'public', 'EUR', ?, 'inclusive')`,
    [gymId, `P-${uniq()}`, amount]);
  return insertId;
}

/** A staff cart purchase (#1657 draft): in the cart, no payment started. */
async function cartPurchase(memberId: number, amount: string): Promise<number> {
  const res = await staff('post', `/members/${memberId}/product-purchases`).send({ product_id: await product(amount), draft: true });
  expect(res.status).toBe(201);
  return Number(res.body.purchaseId);
}

async function financialRows(memberId: number): Promise<{ events: number; requests: number }> {
  const { rows: e } = await db.query<any>('SELECT COUNT(*) AS n FROM billing_events WHERE gym_id = ? AND member_id = ?', [gymId, memberId]);
  const { rows: r } = await db.query<any>('SELECT COUNT(*) AS n FROM payment_requests WHERE gym_id = ? AND member_id = ?', [gymId, memberId]);
  return { events: Number(e[0].n), requests: Number(r[0].n) };
}

const purchaseStatus = async (id: number) =>
  (await db.query<any>(`SELECT status FROM ${TEST_PURCHASES} AS legacy WHERE id = ?`, [id])).rows[0]?.status ?? null;

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = 'test-3313-webhook';
  gymId = await createTestGym('Members App Pay Confirmation Gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  delete process.env.MONEI_API_KEY;
  delete process.env.MONEI_WEBHOOK_SECRET;
  await cleanupTestGyms();
  await db.end();
});

describe('Members App payment of a standalone cart (#3313)', () => {
  it('reading the cart Summary (what choosing Members App re-reads) writes nothing and keeps the cart', async () => {
    const m = await member();
    const id = await cartPurchase(m, '12.00');
    for (let i = 0; i < 2; i += 1) {
      const res = await staff('get', `/members/${m}/product-purchases/cart-summary`);
      expect(res.status).toBe(200);
      expect(res.body.purchase_ids).toEqual([id]);
      expect(res.body.amount_due).toBe(12);
    }
    expect(await financialRows(m)).toEqual({ events: 0, requests: 0 });
    expect(await purchaseStatus(id)).toBe('in_cart');
  });

  it('one Pay writes exactly one Billing Event and one payment request for the reviewed purchases', async () => {
    const m = await member();
    const ids = [await cartPurchase(m, '10.00'), await cartPurchase(m, '5.00')];
    const summary = await staff('get', `/members/${m}/product-purchases/cart-summary`);
    const res = await staff('post', `/members/${m}/product-purchases/checkout`).send({ purchase_ids: summary.body.purchase_ids });
    expect(res.status).toBe(201);
    expect(res.body.amount).toBe(15);
    expect(await financialRows(m)).toEqual({ events: 1, requests: 1 });
    for (const id of ids) expect(await purchaseStatus(id)).toBe('pending_payment');
  });

  it('a repeated Pay after the first is refused and writes nothing more', async () => {
    const m = await member();
    await cartPurchase(m, '8.00');
    const summary = await staff('get', `/members/${m}/product-purchases/cart-summary`);
    const body = { purchase_ids: summary.body.purchase_ids };
    expect((await staff('post', `/members/${m}/product-purchases/checkout`).send(body)).status).toBe(201);
    const again = await staff('post', `/members/${m}/product-purchases/checkout`).send(body);
    // The purchases are no longer in the cart: refused (404 for named ids no longer in it).
    expect([404, 409]).toContain(again.status);
    expect(await financialRows(m)).toEqual({ events: 1, requests: 1 });
  });

  it('two concurrent Pays write one Billing Event and one payment request', async () => {
    const m = await member();
    await cartPurchase(m, '9.00');
    const summary = await staff('get', `/members/${m}/product-purchases/cart-summary`);
    const body = { purchase_ids: summary.body.purchase_ids };
    const results = await Promise.all([
      staff('post', `/members/${m}/product-purchases/checkout`).send(body),
      staff('post', `/members/${m}/product-purchases/checkout`).send(body),
    ]);
    const statuses = results.map((r: any) => r.status).sort();
    expect(statuses[0]).toBe(201);
    expect([404, 409]).toContain(statuses[1]);
    expect(await financialRows(m)).toEqual({ events: 1, requests: 1 });
  });
});
