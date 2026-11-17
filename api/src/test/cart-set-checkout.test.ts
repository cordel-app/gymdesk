// #2949 stage 5 — a Product Set's Save & Pay pays the owner's standalone cart purchases too: one
// Billing Event (the set's initial event) and one payment for the whole cart, the standalone
// purchases joined to that event and never to the set, following its checkout to the end. Integration against the real stack; only the provider's
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

const SECRET = 'test-2949-stage-5-webhook';
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
  gymId = await createTestGym('Cart Set Checkout Gym');
  otherGymId = await createTestGym('Cart Set Checkout Other Gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  delete process.env.MONEI_API_KEY;
  delete process.env.MONEI_WEBHOOK_SECRET;
  await cleanupTestGyms();
  await db.end();
});

/** A member with a Draft Product Set holding one monthly Product, and its id. */
async function memberWithDraft(): Promise<{ clerk: string; id: number; setId: number }> {
  const m = await member();
  const res = await staff('post', `/members/${m.id}/product-purchases`).send({ product_id: await product('30.00', 'month') });
  expect(res.status).toBe(201);
  return { ...m, setId: Number(res.body.product_set_id) };
}

const amountDue = async (setId: number) => (await staff('get', `/product-sets/${setId}/review`)).body.amount_due;

/** Whether the purchase's snapshot is linked to any Product Set (it must never be, standalone). */
async function linkedToSet(purchaseId: number): Promise<boolean> {
  const { rows } = await db.query<any>(
    `SELECT 1 FROM product_set_oneoff_snapshots j JOIN product_oneoff_snapshots s ON s.id = j.product_oneoff_snapshot_id
      WHERE s.source_id = ?
     UNION ALL
     SELECT 1 FROM product_set_session_snapshots j JOIN product_session_snapshots s ON s.id = j.product_session_snapshot_id
      WHERE s.source_id = ?`, [purchaseId, purchaseId]);
  return rows.length > 0;
}

describe('Product Set Save & Pay with standalone cart purchases (#2949 stage 5)', () => {
  it('charges the whole cart in one Billing Event and the provider\'s success activates everything', async () => {
    const m = await memberWithDraft();
    const before = await amountDue(m.setId);
    const one = await asMember(m.clerk, 'post', '/purchases').send({ product_id: await product('12.50') });
    const two = await asMember(m.clerk, 'post', '/purchases').send({ product_id: await product('20.00', 'once', 'sessions', 4) });
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    // The review's amount due is the figure Save & Pay takes, cart included.
    expect(await amountDue(m.setId)).toBeCloseTo(before + 32.5, 2);

    const res = await staff('post', `/product-sets/${m.setId}/save-and-pay`).send({});
    expect(res.status).toBe(201);
    expect(res.body.amount).toBeCloseTo(before + 32.5, 2);
    const eventId = Number(res.body.billing_event_id);
    const { rows: ev } = await db.query<any>('SELECT product_set_id, amount FROM billing_events WHERE id = ?', [eventId]);
    expect(Number(ev[0].product_set_id)).toBe(m.setId);
    expect(Number(ev[0].amount)).toBeCloseTo(before + 32.5, 2);
    const { rows: lines } = await db.query<any>('SELECT SUM(amount) AS total FROM billing_event_lines WHERE billing_event_id = ?', [eventId]);
    expect(Number(lines[0].total)).toBeCloseTo(before + 32.5, 2);
    for (const p of [one, two]) {
      expect(await purchaseStatus(p.body.purchase_id)).toBe('pending_payment');
      expect(await eventOf(p.body.purchase_id)).toBe(eventId);
      expect(await linkedToSet(p.body.purchase_id)).toBe(false);
    }
    // The cart has nothing left to pay on its own.
    expect((await asMember(m.clerk, 'post', '/checkout').send({})).body.error).toBe('cart_empty');

    const pr = await orderOfEvent(eventId);
    expect(Number(pr.amount)).toBeCloseTo(before + 32.5, 2);
    expect((await webhook(pr.provider_order, 'SUCCEEDED')).status).toBe(200);
    const { rows: set } = await db.query<any>('SELECT status FROM product_sets WHERE id = ?', [m.setId]);
    expect(set[0].status).toBe('active');
    expect(await purchaseStatus(one.body.purchase_id)).toBe('active');
    expect(await purchaseStatus(two.body.purchase_id)).toBe('active');
  });

  it('leaves a purchase added after Save & Pay in the cart, and another member\'s cart alone', async () => {
    const m = await memberWithDraft();
    const other = await member();
    const theirs = await asMember(other.clerk, 'post', '/purchases').send({ product_id: await product('7.00') });
    const res = await staff('post', `/product-sets/${m.setId}/save-and-pay`).send({});
    expect(res.status).toBe(201);
    const late = await asMember(m.clerk, 'post', '/purchases').send({ product_id: await product('9.00') });
    expect(late.status).toBe(201);
    const pr = await orderOfEvent(Number(res.body.billing_event_id));
    expect((await webhook(pr.provider_order, 'SUCCEEDED')).status).toBe(200);
    expect(await purchaseStatus(late.body.purchase_id)).toBe('in_cart');
    expect(await eventOf(late.body.purchase_id)).toBeNull();
    expect(await purchaseStatus(theirs.body.purchase_id)).toBe('in_cart');
  });

  it('puts the joined purchases back in the cart when the checkout returns to Draft', async () => {
    const m = await memberWithDraft();
    const p = await asMember(m.clerk, 'post', '/purchases').send({ product_id: await product('5.00') });
    const res = await staff('post', `/product-sets/${m.setId}/save-and-pay`).send({});
    expect(res.status).toBe(201);
    expect(await purchaseStatus(p.body.purchase_id)).toBe('pending_payment');

    // The payment failed, so the checkout may return to Draft.
    const pr = await orderOfEvent(Number(res.body.billing_event_id));
    expect((await webhook(pr.provider_order, 'FAILED')).status).toBe(200);
    expect(await purchaseStatus(p.body.purchase_id)).toBe('pending_payment');
    expect((await staff('delete' as any, `/product-sets/${m.setId}`)).status).toBe(204);
    const { rows: set } = await db.query<any>('SELECT status FROM product_sets WHERE id = ?', [m.setId]);
    expect(set[0].status).toBe('in_cart');
    expect(await purchaseStatus(p.body.purchase_id)).toBe('in_cart');
    expect(await eventOf(p.body.purchase_id)).toBeNull();
    // Back in the cart, it is paid by the next Save & Pay.
    const again = await staff('post', `/product-sets/${m.setId}/save-and-pay`).send({});
    expect(again.status).toBe(201);
    expect(await eventOf(p.body.purchase_id)).toBe(Number(again.body.billing_event_id));
  });

  it('cancels the joined purchases with a cancelled checkout', async () => {
    const m = await memberWithDraft();
    const p = await asMember(m.clerk, 'post', '/purchases').send({ product_id: await product('6.00') });
    const res = await staff('post', `/product-sets/${m.setId}/save-and-pay`).send({});
    expect(res.status).toBe(201);
    const pr = await orderOfEvent(Number(res.body.billing_event_id));
    expect((await webhook(pr.provider_order, 'FAILED')).status).toBe(200);
    const cancel = await staff('post', `/product-sets/${m.setId}/cancel`).send({});
    expect(cancel.status).toBe(200);
    expect(await purchaseStatus(p.body.purchase_id)).toBe('cancelled');
  });

  it('cash Save & Pay activates the set and the joined purchases at once', async () => {
    const m = await memberWithDraft();
    const p = await asMember(m.clerk, 'post', '/purchases').send({ product_id: await product('8.00') });
    const res = await staff('post', `/product-sets/${m.setId}/pay`).send({ method: 'cash' });
    expect(res.status).toBeLessThan(300);
    expect(await purchaseStatus(p.body.purchase_id)).toBe('active');
    expect(await linkedToSet(p.body.purchase_id)).toBe(false);
  });
});
