// #3307 stage 3 — a Pending Payment checkout not paid within 24 hours expires
// (`expirePendingPayments()`, run by `POST /billing/cleanup`), replacing #1991's
// two-hour return to the cart. Integration against the real stack: the set and
// its assignment close, the initial Billing Event reads `expired_24h` (cancelled
// for every other reader), its open attempt closes as `expired`, the one-time
// Products still `pending_payment` become `expired_24h`, nothing is deleted, a
// second run changes nothing, and a checkout younger than 24 hours, one whose
// payment outcome is unknown and one the provider reports paid are left alone.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
import { expirePendingPayments } from '../api/product-set-cancellation';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';
import { TEST_PURCHASES } from './productSnapshotReads';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const as = (clerk: string, method: 'get' | 'post', path: string) => {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any).mockResolvedValueOnce({ sub: clerk } as any);
  return (request as any)[method](`/me/product-sets${path}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
};
const one = async (sql: string, params: unknown[]) => (await db.query<any>(sql, params)).rows[0];

async function product(amount: string, frequency: 'once' | 'month'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', ?, 'active', 'public', 'EUR', ?, 'inclusive')`,
    [gymId, `P-${uniq()}`, frequency, amount]);
  return insertId;
}

/** A member's checkout (a recurring line and a one-time Product) saved for payment, aged by `hours`. */
async function checkout(hours: number) {
  const clerk = `expiry-${uniq()}`;
  await createTestMembership(gymId, 'member', clerk);
  await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, 'Expiry Member', `${clerk}@t.com`, clerk]);
  const id = Number((await as(clerk, 'post', '/draft')).body.id);
  expect((await as(clerk, 'post', `/${id}/services`).send({ product_id: await product('10.00', 'month') })).status).toBe(200);
  const oneOff = await as(clerk, 'post', `/${id}/purchases`).send({ product_id: await product('25.00', 'once') });
  expect(oneOff.status).toBe(200);
  expect((await as(clerk, 'post', `/${id}/save-and-pay`).send({})).status).toBe(201);
  await db.query(`UPDATE product_sets SET pending_at = UTC_TIMESTAMP() - INTERVAL ? HOUR WHERE id = ?`, [hours, id]);
  const event = await one(`SELECT id FROM billing_events WHERE product_set_id = ? AND event_type = 'payment_recorded'`, [id]);
  const attempt = await one('SELECT id, provider_ref FROM payment_requests WHERE billing_event_id = ?', [event.id]);
  return {
    id, eventId: Number(event.id), attemptId: Number(attempt.id), providerRef: attempt.provider_ref as string | null,
    purchaseId: Number(oneOff.body.purchase_id),
  };
}

const setStatus = async (id: number) => (await one('SELECT status FROM product_sets WHERE id = ?', [id]))?.status ?? null;
const purchaseStatus = async (id: number) =>
  (await one(`SELECT status FROM ${TEST_PURCHASES} AS legacy WHERE id = ?`, [id]))?.status ?? null;

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = 'test-24h-expiry';
  gymId = await createTestGym('Pending payment 24h expiry gym');
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

describe('a Pending Payment checkout expires after 24 hours', () => {
  it('closes the checkout, its event (24h expired), its attempt and its pending Products, and keeps every row', async () => {
    const c = await checkout(25);
    // The member opened the checkout and never submitted a card: the provider reports it `PENDING`.
    if (c.providerRef) lookups.set(c.providerRef, 'PENDING');
    expect(await expirePendingPayments()).toBeGreaterThanOrEqual(1);

    expect(await setStatus(c.id)).toBe('cancelled');
    const ev = await one('SELECT cancelled_at, expired_at FROM billing_events WHERE id = ?', [c.eventId]);
    expect(ev.cancelled_at).not.toBeNull();
    expect(ev.expired_at).not.toBeNull();
    expect((await one('SELECT status FROM payment_requests WHERE id = ?', [c.attemptId])).status).toBe('expired');
    expect(await purchaseStatus(c.purchaseId)).toBe('expired_24h');

    // The staff ledger shows it as 24h expired and offers no payment action on it.
    const detail = await auth(request.get(`/payments/billing-events/${c.eventId}`));
    expect(detail.status).toBe(200);
    expect(detail.body.status).toBe('expired_24h');
    expect(detail.body.can_cancel).toBe(false);
    const list = await auth(request.get('/payments/billing-events').query({ status: 'expired_24h' }));
    expect(list.status).toBe(200);
    expect(list.body.items.map((r: any) => r.id)).toContain(c.eventId);

    // A second run changes nothing.
    const before = await one('SELECT expired_at FROM billing_events WHERE id = ?', [c.eventId]);
    await expirePendingPayments();
    expect((await one('SELECT expired_at FROM billing_events WHERE id = ?', [c.eventId])).expired_at).toEqual(before.expired_at);
    expect(await setStatus(c.id)).toBe('cancelled');
    expect(Number((await one('SELECT COUNT(*) AS n FROM billing_events WHERE product_set_id = ?', [c.id])).n)).toBe(1);
  });

  it('leaves a checkout younger than 24 hours pending, even when its payment link expired', async () => {
    const young = await checkout(3);
    await db.query(`UPDATE payment_requests SET status = 'expired' WHERE id = ?`, [young.attemptId]);
    await expirePendingPayments();
    expect(await setStatus(young.id)).toBe('pending_payment');
    expect(await purchaseStatus(young.purchaseId)).toBe('pending_payment');
    expect((await one('SELECT expired_at FROM billing_events WHERE id = ?', [young.eventId])).expired_at).toBeNull();
  });

  it('reports the time left on the 24 hours to the Products Summary, by the expiry pass\'s clock (#3307 stage 4)', async () => {
    const c = await checkout(3);
    const owner = Number((await one('SELECT owner_member_id FROM product_sets WHERE id = ?', [c.id])).owner_member_id);
    const res = await auth(request.get(`/user-memberships/member/${owner}/configuration`));
    expect(res.status).toBe(200);
    const row = res.body.product_sets.find((p: any) => p.id === c.id);
    expect(row.status).toBe('pending_payment');
    // 21 hours left, within a minute of the read.
    expect(row.payment_expires_in_seconds).toBeGreaterThan(21 * 3600 - 60);
    expect(row.payment_expires_in_seconds).toBeLessThanOrEqual(21 * 3600);
    // A Draft has no payment expiry.
    expect(res.body.product_sets.filter((p: any) => p.status === 'in_cart').every((p: any) => p.payment_expires_in_seconds == null)).toBe(true);

    // Past its 24 hours and not yet swept, it reads zero, never a negative count.
    await db.query('UPDATE product_sets SET pending_at = UTC_TIMESTAMP() - INTERVAL 25 HOUR WHERE id = ?', [c.id]);
    const late = (await auth(request.get(`/user-memberships/member/${owner}/configuration`))).body.product_sets
      .find((p: any) => p.id === c.id);
    expect(late.payment_expires_in_seconds).toBe(0);
  });

  it('never expires a payment whose outcome is unknown, and activates one the provider reports paid', async () => {
    const unknown = await checkout(30);
    await db.query(`UPDATE payment_requests SET provider_ref = ?, status = 'pending', provider_status = NULL WHERE id = ?`,
      [`unknown-${unknown.attemptId}`, unknown.attemptId]);
    const paid = await checkout(30);
    const ref = `paid-${paid.attemptId}`;
    await db.query(`UPDATE payment_requests SET provider_ref = ?, status = 'pending' WHERE id = ?`, [ref, paid.attemptId]);
    lookups.set(ref, 'SUCCEEDED');

    await expirePendingPayments();
    expect(await setStatus(unknown.id)).toBe('pending_payment');
    expect((await one('SELECT expired_at FROM billing_events WHERE id = ?', [unknown.eventId])).expired_at).toBeNull();
    expect(await setStatus(paid.id)).toBe('active');
    expect((await one('SELECT expired_at, cancelled_at FROM billing_events WHERE id = ?', [paid.eventId])))
      .toEqual({ expired_at: null, cancelled_at: null });
  });
});
