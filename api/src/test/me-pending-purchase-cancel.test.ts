// #3537 — the member cancels (or pays) their own purchase awaiting payment, from My Products and
// from the Purchases tab: `POST /me/purchase-history/:id/cancel` and `…/:id/pay`.
//
// Integration: the purchase is created the real way (staff buy a one-time Product for the member,
// which sends it for payment), then the member acts as themself. Cancelling is staff's
// `cancelPendingPurchase()` unchanged: the purchase, its line and its Billing Event are kept as
// cancelled, its open attempt is closed, and no attempt, charge or refund is written. Only the
// payment provider is stubbed.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';

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

import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const staff = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const one = async (sql: string, params: unknown[]) => (await db.query<any>(sql, params)).rows[0];

function asMember(clerk: string, method: 'get' | 'post', path: string) {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any);
  return (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
}

async function memberWithLogin(): Promise<{ id: number; clerk: string }> {
  const clerk = `mppc-${uniq()}`;
  await createTestMembership(gymId, 'member', clerk);
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, 'Pending Buyer', `mppc-${uniq()}@test.com`, clerk]);
  return { id: Number(insertId), clerk };
}

async function product(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, is_system, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', 'once', 'active', 'public', 0, 'EUR', '30.00', 'inclusive')`,
    [gymId, `MPPC Product ${uniq()}`]);
  return Number(insertId);
}

/** A one-time Product staff bought for the member and sent for payment. */
async function pendingOneTime(memberId: number) {
  const res = await staff(request.post(`/members/${memberId}/product-purchases`)).send({ product_id: await product() });
  expect(res.status).toBe(201);
  const line = await one(
    `SELECT id, source_id, purchase_id FROM product_oneoff_snapshots
      WHERE gym_id = ? AND member_id = ? AND source_id IS NOT NULL ORDER BY id DESC LIMIT 1`, [gymId, memberId]);
  const ev = await one(
    `SELECT be.id FROM billing_events be JOIN billing_event_oneoff_snapshots j ON j.billing_event_id = be.id
      WHERE j.product_oneoff_snapshot_id = ?`, [line.id]);
  const pr = await one('SELECT id, provider_ref FROM payment_requests WHERE billing_event_id = ?', [ev.id]);
  lookups.set(pr.provider_ref, 'PENDING');
  return { purchaseId: Number(line.purchase_id), lineSourceId: Number(line.source_id), eventId: Number(ev.id), requestId: Number(pr.id), providerRef: pr.provider_ref };
}

const requestCount = async (eventId: number) =>
  Number((await one('SELECT COUNT(*) AS n FROM payment_requests WHERE billing_event_id = ?', [eventId])).n);

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = 'test-member-pending-cancel';
  gymId = await createTestGym('Member Pending Purchase Cancel');
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

describe('a purchase awaiting payment, as the member sees it', () => {
  it('offers Pay and Cancel on the Purchases tab, and names its purchase on My Products', async () => {
    const m = await memberWithLogin();
    const p = await pendingOneTime(m.id);

    const history = await asMember(m.clerk, 'get', '/me/purchase-history');
    expect(history.status).toBe(200);
    const row = history.body.items.find((i: any) => i.id === p.purchaseId);
    expect(row).toMatchObject({ status: 'pending_payment', can_pay: true, can_cancel: true });

    const own = await asMember(m.clerk, 'get', '/me/purchases');
    expect(own.status).toBe(200);
    const item = own.body.items.find((i: any) => i.id === p.lineSourceId);
    expect(item).toMatchObject({ own_state: 'pending_payment', purchase_id: p.purchaseId });
  });

  it('Pay reissues the existing payment and writes no second attempt', async () => {
    const m = await memberWithLogin();
    const p = await pendingOneTime(m.id);
    const before = await requestCount(p.eventId);
    const res = await asMember(m.clerk, 'post', `/me/purchase-history/${p.purchaseId}/pay`);
    expect(res.status).toBe(200);
    expect(typeof res.body.checkoutUrl).toBe('string');
    expect(await requestCount(p.eventId)).toBe(before);
  });
});

describe('the member cancels it', () => {
  it('cancels the purchase, its Product and its Billing Event, charging and refunding nothing', async () => {
    const m = await memberWithLogin();
    const p = await pendingOneTime(m.id);
    const before = await requestCount(p.eventId);

    const res = await asMember(m.clerk, 'post', `/me/purchase-history/${p.purchaseId}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ purchase_id: p.purchaseId, status: 'cancelled' });

    expect((await one('SELECT status FROM purchases WHERE id = ?', [p.purchaseId])).status).toBe('cancelled');
    expect((await one('SELECT status FROM product_oneoff_snapshots WHERE source_id = ?', [p.lineSourceId])).status).toBe('cancelled');
    expect((await one('SELECT cancelled_at FROM billing_events WHERE id = ?', [p.eventId])).cancelled_at).not.toBeNull();
    expect((await one('SELECT status FROM payment_requests WHERE id = ?', [p.requestId])).status).toBe('expired');
    // No payment attempt, charge or refund was written.
    expect(await requestCount(p.eventId)).toBe(before);
    expect(Number((await one(
      `SELECT COUNT(*) AS n FROM payment_requests WHERE refund_of_payment_request_id = ?`, [p.requestId])).n)).toBe(0);

    // Both apps now read it as no longer awaiting payment.
    const own = await asMember(m.clerk, 'get', '/me/purchases');
    expect(own.body.items.find((i: any) => i.id === p.lineSourceId)).toBeUndefined();
    const history = await asMember(m.clerk, 'get', '/me/purchase-history');
    expect(history.body.items.find((i: any) => i.id === p.purchaseId)).toMatchObject({ status: 'cancelled', can_pay: false, can_cancel: false });
    const staffList = await staff(request.get(`/payments/purchases?member_id=${m.id}`));
    expect(staffList.body.items.find((i: any) => i.id === p.purchaseId).status).toBe('cancelled');
  });

  it('is safe to repeat', async () => {
    const m = await memberWithLogin();
    const p = await pendingOneTime(m.id);
    expect((await asMember(m.clerk, 'post', `/me/purchase-history/${p.purchaseId}/cancel`)).status).toBe(200);
    const cancelledAt = (await one('SELECT cancelled_at FROM billing_events WHERE id = ?', [p.eventId])).cancelled_at;
    const again = await asMember(m.clerk, 'post', `/me/purchase-history/${p.purchaseId}/cancel`);
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('cancelled');
    expect((await one('SELECT cancelled_at FROM billing_events WHERE id = ?', [p.eventId])).cancelled_at).toEqual(cancelledAt);
  });

  it('cancels only the purchase it names', async () => {
    // (Staff may not raise a second purchase while one awaits payment, #3355, so the other one is
    // another member's.)
    const m = await memberWithLogin();
    const a = await pendingOneTime(m.id);
    const b = await pendingOneTime((await memberWithLogin()).id);
    expect(a.purchaseId).not.toBe(b.purchaseId);
    expect((await asMember(m.clerk, 'post', `/me/purchase-history/${a.purchaseId}/cancel`)).status).toBe(200);
    expect((await one('SELECT status FROM purchases WHERE id = ?', [b.purchaseId])).status).toBe('pending_payment');
    expect((await one('SELECT cancelled_at FROM billing_events WHERE id = ?', [b.eventId])).cancelled_at).toBeNull();
  });
});

describe('what is refused', () => {
  it('another member cannot cancel or pay it', async () => {
    const m = await memberWithLogin();
    const other = await memberWithLogin();
    const p = await pendingOneTime(m.id);
    expect((await asMember(other.clerk, 'post', `/me/purchase-history/${p.purchaseId}/cancel`)).status).toBe(404);
    expect((await asMember(other.clerk, 'post', `/me/purchase-history/${p.purchaseId}/pay`)).status).toBe(404);
    expect((await one('SELECT status FROM purchases WHERE id = ?', [p.purchaseId])).status).toBe('pending_payment');
  });

  it('refuses a purchase whose payment has gone through', async () => {
    const m = await memberWithLogin();
    const p = await pendingOneTime(m.id);
    lookups.set(p.providerRef, 'SUCCEEDED');
    const res = await asMember(m.clerk, 'post', `/me/purchase-history/${p.purchaseId}/cancel`);
    expect(res.status).toBe(409);
    expect(['not_pending_payment', 'payment_settled']).toContain(res.body.error);
    expect((await one('SELECT cancelled_at FROM billing_events WHERE id = ?', [p.eventId])).cancelled_at).toBeNull();
  });

  it('refuses a purchase still in the cart, and an unauthenticated caller', async () => {
    const m = await memberWithLogin();
    const draft = await staff(request.post(`/members/${m.id}/product-purchases`)).send({ product_id: await product(), draft: true });
    expect(draft.status).toBe(201);
    const line = await one('SELECT purchase_id FROM product_oneoff_snapshots WHERE source_id = ?', [draft.body.purchaseId]);
    const res = await asMember(m.clerk, 'post', `/me/purchase-history/${line.purchase_id}/cancel`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_pending_payment');
    expect((await request.post(`/me/purchase-history/${line.purchase_id}/cancel`)).status).toBe(401);
  });
});
