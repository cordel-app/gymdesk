// #2746 stage 1 — a one-time Product in the member's cart (their Draft Product Set):
// `POST/DELETE /me/product-sets/:id/purchases`. Integration: the purchase is a `draft` linked to
// the Draft, charged by the Draft's one initial payment, and moves with the Draft (Save & Pay,
// back to Draft, activation, discard).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Only the call that would reach Monei is stubbed.
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
import { activateWithEvents } from '../api/product-set-configuration';
import { returnPendingToDraft } from '../api/product-sets';
import { cancelAbandonedPurchases } from '../api/me-products';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';
import { TEST_PURCHASES } from './productSnapshotReads';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}`;
const today = () => new Date().toISOString().slice(0, 10);

const as = (clerk: string, method: 'get' | 'post' | 'delete', path: string) => {
  // `/me` (meRouter) authenticates first, then falls through to this router: two verifications.
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any).mockResolvedValueOnce({ sub: clerk } as any);
  return (request as any)[method](`/me/product-sets${path}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
};

async function member(): Promise<{ clerk: string; id: number }> {
  const clerk = `me-cart-${uniq()}`;
  await createTestMembership(gymId, 'member', clerk);
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, 'M', `${clerk}@t.com`, clerk]);
  return { clerk, id: insertId };
}

async function product(amount: string, frequency: 'once' | 'month', type = 'fee', units: number | null = null): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior, units)
     VALUES (?, ?, ?, ?, 'active', 'public', 'EUR', ?, 'inclusive', ?)`,
    [gymId, `P-${uniq()}`, type, frequency, amount, units]);
  return insertId;
}

const purchaseStatus = async (purchaseId: number) =>
  (await db.query<any>(`SELECT status FROM ${TEST_PURCHASES} AS legacy WHERE id = ?`, [purchaseId])).rows[0]?.status ?? null;
const setStatus = async (id: number) =>
  (await db.query<any>('SELECT status FROM product_sets WHERE id = ?', [id])).rows[0]?.status ?? null;

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = 'test-me-cart';
  gymId = await createTestGym('Me Cart One-time Products Gym');
});
afterAll(async () => {
  delete process.env.MONEI_API_KEY;
  delete process.env.MONEI_WEBHOOK_SECRET;
  await db.query('DELETE FROM payment_requests WHERE gym_id = ?', [gymId]);
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('one-time Products in the member cart', () => {
  it('adds them to the Draft, charges them with its recurring lines in one payment, and activates them with it', async () => {
    const m = await member();
    const draft = (await as(m.clerk, 'post', '/draft')).body;
    const id = Number(draft.id);
    expect((await as(m.clerk, 'post', `/${id}/services`).send({ product_id: await product('10.00', 'month') })).status).toBe(200);
    // The recurring line's own first charge (prorated to the schedule by the engine, #1867).
    const recurringOnly = Number((await as(m.clerk, 'get', `/${id}/review`)).body.amount_due);
    const total = Math.round((recurringOnly + 65) * 100) / 100;

    const oneOff = await as(m.clerk, 'post', `/${id}/purchases`).send({ product_id: await product('25.00', 'once') });
    expect(oneOff.status).toBe(200);
    const sessions = await as(m.clerk, 'post', `/${id}/purchases`).send({ product_id: await product('40.00', 'once', 'sessions', 5) });
    expect(sessions.status).toBe(200);
    const oneOffId = Number(oneOff.body.purchase_id);
    const sessionsId = Number(sessions.body.purchase_id);
    expect(await purchaseStatus(oneOffId)).toBe('draft');

    // Nothing is charged before Pay.
    expect(Number((await db.query<any>('SELECT COUNT(*) AS n FROM billing_events WHERE product_set_id = ?', [id])).rows[0].n)).toBe(0);

    const view = await as(m.clerk, 'get', `/${id}`);
    expect(view.status).toBe(200);
    expect(view.body.purchases.map((p: any) => p.id)).toEqual([oneOffId, sessionsId]);
    expect(view.body.cart).toEqual({ plans: 0, products: 3 });

    const review = await as(m.clerk, 'get', `/${id}/review`);
    expect(review.body.amount_due).toBe(total);

    const pay = await as(m.clerk, 'post', `/${id}/save-and-pay`).send({});
    expect(pay.status).toBe(201);
    expect(pay.body.amount).toBe(total);
    expect(await setStatus(id)).toBe('pending_payment');
    expect(await purchaseStatus(oneOffId)).toBe('pending_payment');
    expect(await purchaseStatus(sessionsId)).toBe('pending_payment');
    const { rows: ev } = await db.query<any>(
      `SELECT be.id, be.amount FROM billing_events be WHERE be.product_set_id = ? AND be.event_type = 'payment_recorded'`, [id]);
    expect(ev).toHaveLength(1);
    expect(Number(ev[0].amount)).toBe(total);
    const { rows: lines } = await db.query<any>('SELECT SUM(amount) AS s FROM billing_event_lines WHERE billing_event_id = ?', [ev[0].id]);
    expect(Number(lines[0].s)).toBe(total);
    // Each purchase reaches the one payment request through the event, as any purchase does.
    const { rows: links } = await db.query<any>(
      `SELECT (SELECT COUNT(*) FROM billing_event_oneoff_snapshots WHERE billing_event_id = ?)
            + (SELECT COUNT(*) FROM billing_event_session_snapshots WHERE billing_event_id = ?) AS n`, [ev[0].id, ev[0].id]);
    expect(Number(links[0].n)).toBe(2);

    // The checkout's payment link expires: everything returns to the Draft, nothing is cancelled.
    await db.query(`UPDATE payment_requests SET status = 'expired' WHERE billing_event_id = ?`, [ev[0].id]);
    // The abandoned-purchase cleanup leaves a cart purchase to its Product Set.
    await cancelAbandonedPurchases();
    expect(await purchaseStatus(oneOffId)).toBe('pending_payment');
    expect((await db.transaction((tx) => returnPendingToDraft(tx, gymId, id))).kind).toBe('cancelled');
    expect(await setStatus(id)).toBe('draft');
    expect(await purchaseStatus(oneOffId)).toBe('draft');

    // Paid on the second try: the purchases become the member's with the set.
    expect((await as(m.clerk, 'post', `/${id}/save-and-pay`).send({})).status).toBe(201);
    const out = await db.transaction((tx) => activateWithEvents(tx, { gymId, productSetId: id, today: today(), actor: 'System' }));
    expect(out.kind).toBe('ok');
    expect(await setStatus(id)).toBe('active');
    expect(await purchaseStatus(oneOffId)).toBe('active');
    expect(await purchaseStatus(sessionsId)).toBe('active');
    const { rows: purchased } = await db.query<any>(`SELECT purchased_at FROM ${TEST_PURCHASES} AS legacy WHERE id = ?`, [oneOffId]);
    expect(purchased[0].purchased_at).not.toBeNull();
  });

  it('removes one item without touching the others, and refuses a recurring Product, a duplicate and another member', async () => {
    const m = await member();
    const other = await member();
    const id = Number((await as(m.clerk, 'post', '/draft')).body.id);
    const keep = await product('5.00', 'once');
    const a = Number((await as(m.clerk, 'post', `/${id}/purchases`).send({ product_id: keep })).body.purchase_id);
    const b = Number((await as(m.clerk, 'post', `/${id}/purchases`).send({ product_id: await product('7.00', 'once') })).body.purchase_id);

    expect((await as(m.clerk, 'post', `/${id}/purchases`).send({ product_id: keep })).body.error).toBe('already_in_cart');
    const recurring = await as(m.clerk, 'post', `/${id}/purchases`).send({ product_id: await product('9.00', 'month') });
    expect(recurring.status).toBe(400);
    expect(recurring.body.error).toBe('recurring_product');
    expect((await as(other.clerk, 'post', `/${id}/purchases`).send({ product_id: keep })).status).toBe(404);
    expect((await as(other.clerk, 'delete', `/${id}/purchases/${a}`)).status).toBe(404);

    const del = await as(m.clerk, 'delete', `/${id}/purchases/${a}`);
    expect(del.status).toBe(200);
    expect(await purchaseStatus(a)).toBeNull();
    expect(await purchaseStatus(b)).toBe('draft');
    const view = await as(m.clerk, 'get', `/${id}`);
    expect(view.body.purchases.map((p: any) => p.id)).toEqual([b]);
    expect(view.body.cart).toEqual({ plans: 0, products: 1 });
    expect((await as(m.clerk, 'delete', `/${id}/purchases/${a}`)).status).toBe(404);
  });

  it('discarding the Draft deletes the one-time Products it held', async () => {
    const m = await member();
    const id = Number((await as(m.clerk, 'post', '/draft')).body.id);
    const p = Number((await as(m.clerk, 'post', `/${id}/purchases`).send({ product_id: await product('5.00', 'once') })).body.purchase_id);

    expect((await as(m.clerk, 'delete', `/${id}`)).status).toBe(204);
    expect(await setStatus(id)).toBeNull();
    expect(await purchaseStatus(p)).toBeNull();
    const { rows } = await db.query<any>('SELECT COUNT(*) AS n FROM product_oneoff_snapshots WHERE source_id = ?', [p]);
    expect(Number(rows[0].n)).toBe(0);
  });
});
