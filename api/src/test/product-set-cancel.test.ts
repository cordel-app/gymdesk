// #2747 stage 1 — cancelling a Pending Payment Product Set from the Admin
// (`POST /product-sets/:id/cancel`) and the Members App (`POST /me/product-sets/:id/cancel`).
// Integration: the set is kept as `cancelled`, its events are cancelled, its open
// attempts closed with the provider's status untouched, its assignment and one-time
// purchases cancelled, and a late payment never reactivates it.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';

// The provider read-back is stubbed per order; everything else is the real provider.
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
import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';

const SECRET = 'test-product-set-cancel';
let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const asMember = (clerk: string, path: string) => {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any).mockResolvedValueOnce({ sub: clerk } as any);
  return request.post(`/me/product-sets${path}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
};

function signed(payload: unknown) {
  const raw = JSON.stringify(payload);
  const t = String(Math.floor(Date.now() / 1000));
  const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
  return request.post('/webhooks/payment').set({ 'monei-signature': `t=${t},v1=${v1}` })
    .set('Content-Type', 'application/json').send(raw);
}

async function member(clerk: string | null = null): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, 'Cancel Member', `cancel-${uniq()}@test.com`, clerk]);
  return insertId;
}
async function plan(price: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', NULL, NULL, 0, 0)`, [gymId, `Cancel-Plan-${uniq()}`]);
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status) VALUES (?, ?, ?, '2020-01-01', 'active')`,
    [gymId, insertId, price]);
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit) VALUES (?, ?, 1, 'month')`,
    [gymId, insertId]);
  return insertId;
}

async function pending(memberId?: number) {
  const ownerId = memberId ?? await member();
  const c = await auth(request.post('/product-sets')).send({ member_id: ownerId, membership_plan_id: await plan(40), starts_at: TODAY });
  expect(c.status).toBe(201);
  const pay = await auth(request.post(`/product-sets/${c.body.id}/save-and-pay`)).send({});
  expect(pay.body.status).toBe('pending_payment');
  const { insertId: umId } = await db.query(
    `INSERT INTO user_memberships (gym_id, member_id, status, starts_at) VALUES (?, ?, 'pending_payment', ?)`,
    [gymId, ownerId, TODAY]);
  await db.query('UPDATE product_sets SET user_membership_id = ? WHERE id = ?', [umId, c.body.id]);
  const { rows } = await db.query<any>(
    `SELECT pr.id, pr.provider_ref, pr.provider_order FROM payment_requests pr
       JOIN billing_events be ON be.id = pr.billing_event_id WHERE be.product_set_id = ?`, [c.body.id]);
  return { id: Number(c.body.id), memberId: ownerId, umId, request: rows[0] };
}

const one = async (sql: string, params: unknown[]) => (await db.query<any>(sql, params)).rows[0];

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = SECRET;
  gymId = await createTestGym('PS cancel gym');
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

describe('Cancel a Pending Payment Product Set (#2747)', () => {
  it('keeps the set as cancelled, cancels its event and closes its attempt with the provider status untouched', async () => {
    const p = await pending();
    lookups.set(p.request.provider_ref, 'PENDING');
    const amountBefore = (await one('SELECT amount FROM billing_events WHERE product_set_id = ?', [p.id])).amount;
    const res = await auth(request.post(`/product-sets/${p.id}/cancel`));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');

    const set = await one('SELECT status, cancelled_at, cancelled_by FROM product_sets WHERE id = ?', [p.id]);
    expect(set.status).toBe('cancelled');
    expect(set.cancelled_at).not.toBeNull();
    const ev = await one('SELECT amount, cancelled_at FROM billing_events WHERE product_set_id = ?', [p.id]);
    expect(ev.cancelled_at).not.toBeNull();
    expect(ev.amount).toBe(amountBefore);
    const pr = await one('SELECT status, provider_status FROM payment_requests WHERE id = ?', [p.request.id]);
    expect(pr.status).toBe('expired');
    expect(pr.provider_status).toBe('PENDING');
    const um = await one('SELECT status, closed_at FROM user_memberships WHERE id = ?', [p.umId]);
    expect(um.status).toBe('cancelled');
    expect(um.closed_at).not.toBeNull();
    // The snapshots are kept, and the owner's in-flight slot is free again.
    const snaps = await one('SELECT COUNT(*) AS n FROM product_set_plan_snapshots WHERE product_set_id = ?', [p.id]);
    expect(Number(snaps.n)).toBeGreaterThan(0);
    const next = await auth(request.post('/product-sets')).send({ member_id: p.memberId, membership_plan_id: await plan(10), starts_at: TODAY });
    expect(next.status).toBe(201);
  });

  it('is idempotent: a second cancel answers 200 and changes nothing', async () => {
    const p = await pending();
    lookups.set(p.request.provider_ref, 'PENDING');
    expect((await auth(request.post(`/product-sets/${p.id}/cancel`))).status).toBe(200);
    const before = await one('SELECT cancelled_at FROM product_sets WHERE id = ?', [p.id]);
    const again = await auth(request.post(`/product-sets/${p.id}/cancel`));
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('cancelled');
    const after = await one('SELECT cancelled_at FROM product_sets WHERE id = ?', [p.id]);
    expect(String(after.cancelled_at)).toBe(String(before.cancelled_at));
  });

  it('a payment the provider reports captured is settled first, so the set is active and not cancelled', async () => {
    const p = await pending();
    lookups.set(p.request.provider_ref, 'SUCCEEDED');
    const res = await auth(request.post(`/product-sets/${p.id}/cancel`));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_pending_payment');
    expect((await one('SELECT status FROM product_sets WHERE id = ?', [p.id])).status).toBe('active');
  });

  it('an authorized payment, or one the provider cannot be asked about, is not cancelled', async () => {
    const authorized = await pending();
    lookups.set(authorized.request.provider_ref, 'AUTHORIZED');
    const a = await auth(request.post(`/product-sets/${authorized.id}/cancel`));
    expect(a.status).toBe(409);
    expect(a.body.error).toBe('payment_unresolved');
    expect((await one('SELECT provider_status FROM payment_requests WHERE id = ?', [authorized.request.id])).provider_status).toBe('AUTHORIZED');

    const unreachable = await pending();
    lookups.delete(unreachable.request.provider_ref);
    const u = await auth(request.post(`/product-sets/${unreachable.id}/cancel`));
    expect(u.status).toBe(409);
    expect(u.body.error).toBe('payment_unresolved');
    expect((await one('SELECT status FROM product_sets WHERE id = ?', [unreachable.id])).status).toBe('pending_payment');
  });

  it('a late payment webhook records the money but never reactivates a cancelled set', async () => {
    const p = await pending();
    lookups.set(p.request.provider_ref, 'PENDING');
    expect((await auth(request.post(`/product-sets/${p.id}/cancel`))).status).toBe(200);
    const chargeId = `ch_${uniq()}`;
    const hook = await signed({
      id: `evt_${chargeId}`, type: 'charge.succeeded', objectId: chargeId, objectType: 'charge',
      object: { id: chargeId, orderId: p.request.provider_order, status: 'SUCCEEDED' },
    });
    expect(hook.status).toBe(200);
    expect((await one('SELECT status FROM product_sets WHERE id = ?', [p.id])).status).toBe('cancelled');
    expect((await one('SELECT status FROM user_memberships WHERE id = ?', [p.umId])).status).toBe('cancelled');
    const pr = await one('SELECT status FROM payment_requests WHERE id = ?', [p.request.id]);
    expect(pr.status).toBe('completed');
  });

  it('only a pending_payment set can be cancelled', async () => {
    const memberId = await member();
    const c = await auth(request.post('/product-sets')).send({ member_id: memberId, membership_plan_id: await plan(40), starts_at: TODAY });
    const res = await auth(request.post(`/product-sets/${c.body.id}/cancel`));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_pending_payment');
  });

  it('is tenant-scoped', async () => {
    const p = await pending();
    const other = await createTestGym('PS cancel other gym');
    await createTestMembership(other, 'admin');
    const res = await request.post(`/product-sets/${p.id}/cancel`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', other);
    expect(res.status).toBe(404);
    expect((await one('SELECT status FROM product_sets WHERE id = ?', [p.id])).status).toBe('pending_payment');
  });

  it('a member cancels their own pending set, and not another member\'s', async () => {
    const clerk = `ps-cancel-${uniq()}`;
    await createTestMembership(gymId, 'member', clerk);
    const own = await pending(await member(clerk));
    lookups.set(own.request.provider_ref, 'PENDING');
    const foreign = await pending();

    const denied = await asMember(clerk, `/${foreign.id}/cancel`);
    expect(denied.status).toBe(404);
    expect((await one('SELECT status FROM product_sets WHERE id = ?', [foreign.id])).status).toBe('pending_payment');

    const res = await asMember(clerk, `/${own.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
  });

  it('#2746 stage 3: the owner\'s read of a pending set reports the initial event amount the cart pays', async () => {
    const clerk = `ps-pending-read-${uniq()}`;
    await createTestMembership(gymId, 'member', clerk);
    const own = await pending(await member(clerk));
    const event = await one(
      `SELECT amount FROM billing_events WHERE product_set_id = ? AND event_type = 'payment_recorded' ORDER BY id DESC LIMIT 1`, [own.id]);

    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any).mockResolvedValueOnce({ sub: clerk } as any);
    const res = await request.get(`/me/product-sets/${own.id}`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending_payment');
    expect(res.body.pending_amount).toBe(Number(event.amount));
    expect(res.body.pending_amount).toBeGreaterThan(0);
    expect(res.body.cart).toEqual({ plans: 1, products: 0 });
  });
});
