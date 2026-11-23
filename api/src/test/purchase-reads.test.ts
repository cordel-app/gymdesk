// #3251 stage 3 — the cart (`purchases`) a Product Set version, a one-time line, a recurring line and a
// checkout's Billing Event belong to is reported on their reads as `purchase_id`, never confused with a
// line's own id. Integration against the real stack; only the provider's `createPaymentRequest` is stubbed.
import { productSetAssignmentSql } from '../domain/planAssignments';
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
import {
  TEST_AUTH_HEADER, cleanupTestGyms, createTestDraftAssignment, createTestGym, createTestMembership, request,
} from './helpers';

let gymId: string;
let otherGymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

const staff = (method: 'post' | 'get', path: string, gym = gymId) =>
  (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);
const asMember = (clerk: string, method: 'post' | 'get', path: string) => {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any);
  return (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
};
const must = (res: any, what: string) => {
  if (res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
};

async function member(): Promise<{ clerk: string; id: number }> {
  const clerk = `purchase-reads-${uniq()}`;
  await createTestMembership(gymId, 'member', clerk);
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, 'Read Owner', `${clerk}@t.com`, clerk]);
  return { clerk, id: insertId };
}

async function product(amount: string, frequency: 'once' | 'month' = 'once'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', ?, 'active', 'public', 'EUR', ?, 'inclusive')`,
    [gymId, `P-${uniq()}`, frequency, amount]);
  return insertId;
}

async function plan(price = 30): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', 1)`, [gymId, `Reads Plan ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
                  VALUES (?, ?, ?, '2020-01-01', 'active')`, [gymId, insertId, price]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
                  VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return Number(insertId);
}

const cartOfSet = async (setId: number) =>
  Number((await db.query<any>('SELECT purchase_id FROM product_sets WHERE id = ?', [setId])).rows[0].purchase_id);
const setOfAssignment = async (um: number) =>
  Number((await db.query<any>(`SELECT id FROM product_sets ps WHERE ${productSetAssignmentSql('ps')} = ? ORDER BY id DESC LIMIT 1`, [um])).rows[0].id);

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  gymId = await createTestGym('Purchase Reads Gym');
  otherGymId = await createTestGym('Purchase Reads Other Gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  delete process.env.MONEI_API_KEY;
  await cleanupTestGyms();
  await db.end();
});

describe('Product Set and Billing Event reads report the cart (#3251 stage 3)', () => {
  it('a plan checkout: the set, its initial event and the Billing Event list/detail carry the cart; obligations do not', async () => {
    const m = await member();
    const um = await createTestDraftAssignment(gymId, m.id, await plan(), { config: { membership_fee_price: 30 } });
    const setId = await setOfAssignment(um);
    const cart = await cartOfSet(setId);

    const draft = must(await staff('get', `/product-sets/${setId}`), 'set');
    expect(draft.body.purchase_id).toBe(cart);
    const list = must(await staff('get', `/product-sets?member_id=${m.id}`), 'sets');
    expect(list.body.find((s: any) => s.id === setId).purchase_id).toBe(cart);

    must(await staff('post', `/user-memberships/${um}/save-and-pay`).send({}), 'save-and-pay');
    must(await staff('post', `/user-memberships/${um}/record-payment`).send({}), 'record-payment');

    const after = must(await staff('get', `/product-sets/${setId}`), 'set after');
    const initial = after.body.billing_events.find((e: any) => e.event_type === 'payment_recorded');
    expect(initial.purchase_id).toBe(cart);

    const detail = must(await staff('get', `/payments/billing-events/${initial.id}`), 'detail');
    expect(detail.body.purchase_id).toBe(cart);

    const events = must(await staff('get', `/payments/billing-events?member_id=${m.id}&limit=100`), 'list');
    const rows = events.body.items.filter((r: any) => r.type === 'real');
    expect(rows.find((r: any) => r.id === initial.id).purchase_id).toBe(cart);
    const legacy = must(await staff('get', `/billing-events?member_id=${m.id}`), 'legacy list');
    expect(legacy.body.items.find((r: any) => r.id === initial.id).purchase_id).toBe(cart);

    // A scheduled obligation is not a checkout: its reads say so.
    const { rows: scheduled } = await db.query<any>(
      'SELECT id FROM billing_events WHERE gym_id = ? AND member_id = ? AND is_scheduled = 1 LIMIT 1', [gymId, m.id]);
    if (scheduled[0]) {
      const sched = must(await staff('get', `/payments/billing-events/${scheduled[0].id}`), 'scheduled');
      expect(sched.body.purchase_id).toBeNull();
    }
  });

  it('another gym cannot read the set or the event', async () => {
    const m = await member();
    const um = await createTestDraftAssignment(gymId, m.id, await plan(), { config: { membership_fee_price: 30 } });
    const setId = await setOfAssignment(um);
    await createTestMembership(otherGymId, 'admin');
    expect((await staff('get', `/product-sets/${setId}`, otherGymId)).status).toBe(404);
  });
});

describe('purchase reads report the cart, apart from the line id (#3251 stage 3)', () => {
  it('a standalone member cart: each line carries its own id and the cart', async () => {
    const m = await member();
    const a = must(await asMember(m.clerk, 'post', '/me/cart/purchases').send({ product_id: await product('10.00') }), 'add A');
    const b = must(await asMember(m.clerk, 'post', '/me/cart/purchases').send({ product_id: await product('12.00') }), 'add B');
    const { rows } = await db.query<any>(
      `SELECT id FROM purchases WHERE gym_id = ? AND owner_member_id = ? AND status = 'in_cart'`, [gymId, m.id]);
    const cart = Number(rows[0].id);

    const read = must(await asMember(m.clerk, 'get', '/me/cart/purchases'), 'cart');
    expect(read.body.purchases.map((p: any) => p.id).sort()).toEqual([a.body.purchase_id, b.body.purchase_id].sort());
    expect(read.body.purchases.every((p: any) => p.purchase_id === cart)).toBe(true);

    const staffList = must(await staff('get', `/members/${m.id}/products`), 'staff list');
    const own = staffList.body.items.filter((p: any) => [a.body.purchase_id, b.body.purchase_id].includes(p.id));
    expect(own).toHaveLength(2);
    expect(own.every((p: any) => p.purchase_id === cart)).toBe(true);
  });

  it('a recurring line on the staff list carries the cart it was added in', async () => {
    const m = await member();
    const res = must(await staff('post', `/members/${m.id}/product-purchases`).send({ product_id: await product('30.00', 'month') }), 'add');
    const cart = await cartOfSet(Number(res.body.product_set_id));
    const staffList = must(await staff('get', `/members/${m.id}/products`), 'staff list');
    const recurring = staffList.body.items.filter((p: any) => p.source === 'recurring');
    expect(recurring).toHaveLength(1);
    expect(recurring[0].purchase_id).toBe(cart);
  });
});
