// #3305 — a cart staff created (`purchases.channel = 'admin_app'`, #3278) is one they are still
// preparing while it is In Cart, whatever it holds: the member reads it (contents and Summary) but
// cannot pay, cancel, remove, change a quantity or add to it, and every member write refuses it with
// `409 awaiting_staff_setup`. Staff submitting it (Save & Pay) hands it to the member as a pending
// payment; staff discarding it clears the lock. A cart the member created keeps its self-service.
// Integration: the real member and staff routes against MySQL; the provider is stubbed.
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
import { awaitsStaffSetup, staffPreparesCart } from '../domain/shoppingCart';
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, openMemberCart, request,
} from './helpers';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

/** A Members App call; `/me/product-sets` verifies twice (`/me` first, then its own router). */
const as = (clerk: string, method: 'get' | 'post' | 'put' | 'delete', path: string) => {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any);
  if (path.startsWith('/me/product-sets')) vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any);
  return (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
};
const staff = (method: 'get' | 'post' | 'delete', path: string) =>
  (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function member(): Promise<{ clerk: string; id: number }> {
  const clerk = `spc-${uniq()}`;
  await createTestMembership(gymId, 'member', clerk);
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, 'Prepared Member', `${clerk}@t.com`, clerk]);
  return { clerk, id: insertId };
}
async function product(amount: string, frequency: 'once' | 'month' = 'once'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', ?, 'active', 'public', 'EUR', ?, 'inclusive')`,
    [gymId, `P-${uniq()}`, frequency, amount]);
  return insertId;
}
async function plan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', 0, 12, 0, 0)`, [gymId, `Plan ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, 25, '2025-01-01', 'active')`, [gymId, insertId]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return insertId;
}
const cartOf = async (memberId: number) =>
  (await db.query<any>(`SELECT id, status, channel FROM purchases WHERE gym_id = ? AND owner_member_id = ? AND status = 'in_cart'`,
    [gymId, memberId])).rows[0] ?? null;
const purchaseStatus = async (purchaseId: number) =>
  (await db.query<any>('SELECT status FROM product_oneoff_snapshots WHERE source_id = ?', [purchaseId])).rows[0]?.status ?? null;
const eventsOf = async (memberId: number) =>
  Number((await db.query<any>('SELECT COUNT(*) AS n FROM billing_events WHERE gym_id = ? AND member_id = ?', [gymId, memberId])).rows[0].n);

/** A cart of standalone one-time purchases staff opened (#1657's Save, no Product Set). */
async function staffStandaloneCart() {
  const m = await member();
  const res = await staff('post', `/members/${m.id}/product-purchases`).send({ product_id: await product('12.00'), draft: true });
  expect(res.status).toBe(201);
  return { ...m, purchaseId: Number(res.body.purchaseId) };
}

/** A cart staff opened by adding a recurring Product: an In Cart Product Set linked to no assignment. */
async function staffSetCart() {
  const m = await member();
  const res = await staff('post', `/members/${m.id}/product-purchases`).send({ product_id: await product('30.00', 'month') });
  expect(res.status).toBe(201);
  return { ...m, setId: Number(res.body.product_set_id) };
}

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = 'test-3305';
  gymId = await createTestGym('Staff Prepared Cart Gym');
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

describe('the rule (#3305)', () => {
  it('an In Cart cart is staff-prepared only when created from the Admin App', () => {
    expect(staffPreparesCart({ status: 'in_cart', channel: 'admin_app' })).toBe(true);
    expect(staffPreparesCart({ status: 'in_cart', channel: 'members_app' })).toBe(false);
    expect(staffPreparesCart({ status: 'in_cart', channel: null })).toBe(false);
    expect(staffPreparesCart({ status: 'pending_payment', channel: 'admin_app' })).toBe(false);
    expect(staffPreparesCart(null)).toBe(false);
    expect(awaitsStaffSetup({ status: 'in_cart', cart_channel: 'admin_app' })).toBe(true);
    expect(awaitsStaffSetup({ status: 'in_cart', cart_channel: 'members_app' })).toBe(false);
    // #2895's staff assignment Draft still answers yes in a cart with no recorded channel.
    expect(awaitsStaffSetup({ status: 'in_cart', linked_user_membership_id: 4, cart_channel: null })).toBe(true);
  });
});

describe('a standalone cart staff are preparing (#3305)', () => {
  it('is readable, reported as awaiting staff setup, with its Summary', async () => {
    const m = await staffStandaloneCart();
    expect((await cartOf(m.id)).channel).toBe('admin_app');
    const list = await as(m.clerk, 'get', '/me/cart/purchases');
    expect(list.status).toBe(200);
    expect(list.body.awaiting_staff_setup).toBe(true);
    expect(list.body.purchases.map((p: any) => p.id)).toEqual([m.purchaseId]);
    const summary = await as(m.clerk, 'get', '/me/cart/summary');
    expect(summary.status).toBe(200);
    expect(summary.body.awaiting_staff_setup).toBe(true);
    expect(summary.body.amount_due).toBe(12);
  });

  it('refuses the member\'s Pay, remove, quantity and adds, changing nothing', async () => {
    const m = await staffStandaloneCart();
    const writes = [
      await as(m.clerk, 'post', '/me/cart/checkout').send({}),
      await as(m.clerk, 'delete', `/me/cart/purchases/${m.purchaseId}`),
      await as(m.clerk, 'put', `/me/cart/purchases/${m.purchaseId}`).send({ quantity: 2 }),
      await as(m.clerk, 'post', '/me/cart/purchases').send({ product_id: await product('5.00') }),
      await as(m.clerk, 'post', '/me/product-sets/draft'),
      await as(m.clerk, 'post', `/me/membership-plans/${await plan()}/assign`).send({}),
    ];
    for (const r of writes) {
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('awaiting_staff_setup');
    }
    expect(await purchaseStatus(m.purchaseId)).toBe('in_cart');
    const list = await as(m.clerk, 'get', '/me/cart/purchases');
    expect(list.body.purchases).toHaveLength(1);
    expect(await eventsOf(m.id)).toBe(0);
    const { rows } = await db.query<any>('SELECT COUNT(*) AS n FROM product_sets WHERE gym_id = ? AND owner_member_id = ?', [gymId, m.id]);
    expect(Number(rows[0].n)).toBe(0);
  });

  it('staff submitting it hands the member a pending payment, no longer locked', async () => {
    const m = await staffStandaloneCart();
    const pay = await staff('post', `/members/${m.id}/product-purchases/checkout`).send({});
    expect(pay.status).toBe(201);
    expect(await purchaseStatus(m.purchaseId)).toBe('pending_payment');
    expect(await cartOf(m.id)).toBeNull();
    const list = await as(m.clerk, 'get', '/me/cart/purchases');
    expect(list.body.awaiting_staff_setup).toBe(false);
    // A new cart is the member's own.
    const add = await as(m.clerk, 'post', '/me/cart/purchases').send({ product_id: await product('4.00') });
    expect(add.status).toBe(201);
    expect((await cartOf(m.id)).channel).toBe('members_app');
  });

  it('staff discarding it clears the lock', async () => {
    const m = await staffStandaloneCart();
    expect((await staff('delete', `/members/${m.id}/product-purchases/${m.purchaseId}`)).status).toBeLessThan(300);
    expect(await cartOf(m.id)).toBeNull();
    const list = await as(m.clerk, 'get', '/me/cart/purchases');
    expect(list.body).toMatchObject({ purchases: [], awaiting_staff_setup: false });
    expect((await as(m.clerk, 'post', '/me/cart/purchases').send({ product_id: await product('6.00') })).status).toBe(201);
  });
});

describe('a Product Set cart staff are preparing (#3305)', () => {
  it('is awaiting staff setup though it changes no plan, and refuses every member write', async () => {
    const m = await staffSetCart();
    const read = await as(m.clerk, 'get', `/me/product-sets/${m.setId}`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ status: 'in_cart', awaiting_staff_setup: true });
    expect(read.body.cart.plans).toBe(0);
    expect((await as(m.clerk, 'get', `/me/product-sets/${m.setId}/review`)).status).toBe(200);

    const writes = [
      await as(m.clerk, 'post', `/me/product-sets/${m.setId}/save-and-pay`).send({}),
      await as(m.clerk, 'post', `/me/product-sets/${m.setId}/activate`).send({}),
      await as(m.clerk, 'delete', `/me/product-sets/${m.setId}`),
      await as(m.clerk, 'post', `/me/product-sets/${m.setId}/services`).send({ product_id: await product('8.00', 'month') }),
      await as(m.clerk, 'post', '/me/product-sets/draft'),
    ];
    for (const r of writes) {
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('awaiting_staff_setup');
    }
    const { rows } = await db.query<any>('SELECT status FROM product_sets WHERE id = ?', [m.setId]);
    expect(rows[0].status).toBe('in_cart');
    expect(await eventsOf(m.id)).toBe(0);
  });

  it('staff Save & Pay makes it the member\'s pending payment', async () => {
    const m = await staffSetCart();
    expect((await staff('post', `/product-sets/${m.setId}/save-and-pay`).send({})).status).toBe(201);
    const read = await as(m.clerk, 'get', `/me/product-sets/${m.setId}`);
    expect(read.body).toMatchObject({ status: 'pending_payment', awaiting_staff_setup: false });
  });
});

describe('a cart the member created keeps its self-service (#3305)', () => {
  it('staff adding to it does not lock it', async () => {
    const m = await member();
    const setId = await openMemberCart(gymId, m.clerk);
    const staffAdd = await staff('post', `/members/${m.id}/product-purchases`).send({ product_id: await product('20.00', 'month') });
    expect(staffAdd.status).toBe(201);
    expect(Number(staffAdd.body.product_set_id)).toBe(setId);
    expect((await cartOf(m.id)).channel).toBe('members_app');

    const read = await as(m.clerk, 'get', `/me/product-sets/${setId}`);
    expect(read.body.awaiting_staff_setup).toBe(false);
    const add = await as(m.clerk, 'post', '/me/cart/purchases').send({ product_id: await product('3.00') });
    expect(add.status).toBe(201);
    const list = await as(m.clerk, 'get', '/me/cart/purchases');
    expect(list.body.awaiting_staff_setup).toBe(false);
    const changed = await as(m.clerk, 'put', `/me/cart/purchases/${add.body.purchase_id}`).send({ quantity: 2 });
    expect(changed.status).toBe(200);
    expect((await as(m.clerk, 'delete', `/me/cart/purchases/${changed.body.purchase_id}`)).status).toBe(200);
  });
});
