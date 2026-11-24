// #3278 — a purchase records who initiated it (`created_by`, reused) and through which application
// (`channel`), both decided by the server when the purchase is created and never rewritten.
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

import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { purchaseChannelForPath, toPurchaseChannel } from '../domain/purchaseChannel';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

const staff = (method: 'get' | 'post', path: string) =>
  (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const asMember = (clerk: string, method: 'get' | 'post', path: string) => {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any);
  return (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
};

async function member(name: string): Promise<{ clerk: string; id: number }> {
  const clerk = `pchan-${uniq()}`;
  await createTestMembership(gymId, 'member', clerk);
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, name, `${clerk}@t.com`, clerk]);
  return { clerk, id: insertId };
}
async function product(amount: string, frequency: 'once' | 'month'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', ?, 'active', 'public', 'EUR', ?, 'inclusive')`,
    [gymId, `P-${uniq()}`, frequency, amount]);
  return insertId;
}
async function plan(price: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', 0, 12, 0, 0)`, [gymId, `Chan Plan ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, ?, '2025-01-01', 'active')`, [gymId, insertId, price]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return insertId;
}
const purchaseRow = async (id: number) =>
  (await db.query<any>('SELECT id, status, created_by, channel FROM purchases WHERE id = ?', [id])).rows[0];
const cartOfSet = async (setId: number) =>
  Number((await db.query<any>('SELECT purchase_id FROM product_sets WHERE id = ?', [setId])).rows[0].purchase_id);
const purchasesOf = async (memberId: number) =>
  (await staff('get', `/payments/purchases?member_id=${memberId}`)).body.items as any[];

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = 'test-3278';
  gymId = await createTestGym('Purchase Channel Gym');
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

describe('the channel rule (#3278)', () => {
  it('the /me routes are the Members App, every other tenant route the Admin App', () => {
    expect(purchaseChannelForPath('/me/cart/purchases')).toBe('members_app');
    expect(purchaseChannelForPath('/me?x=1')).toBe('members_app');
    expect(purchaseChannelForPath('/members/4/product-purchases')).toBe('admin_app');
    expect(purchaseChannelForPath('/membership-plans/2/assign')).toBe('admin_app');
    expect(toPurchaseChannel('system')).toBeNull();
  });
});

describe('a purchase records who managed it and through which app (#3278)', () => {
  it('an Admin purchase is admin_app with the staff actor, kept through member edits and Save & Pay', async () => {
    const m = await member('Owner Admin');
    const add = await staff('post', `/members/${m.id}/product-purchases`).send({ product_id: await product('30.00', 'month') });
    expect(add.status).toBe(201);
    const cartId = await cartOfSet(Number(add.body.product_set_id));
    const born = await purchaseRow(cartId);
    expect(born.channel).toBe('admin_app');
    expect(born.created_by).not.toBe('Owner Admin');
    expect(born.created_by).not.toBe('System');

    // The member cannot add to a cart staff are preparing (#3305); staff paying it changes neither field.
    const refused = await asMember(m.clerk, 'post', '/me/cart/purchases').send({ product_id: await product('9.00', 'once') });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('awaiting_staff_setup');
    expect((await staff('post', `/product-sets/${add.body.product_set_id}/save-and-pay`).send({})).status).toBe(201);
    const after = await purchaseRow(cartId);
    expect(after.status).toBe('pending_payment');
    expect(after.channel).toBe('admin_app');
    expect(after.created_by).toBe(born.created_by);

    const listed = (await purchasesOf(m.id)).find((p) => p.id === cartId);
    expect(listed).toMatchObject({ channel: 'admin_app', created_by: born.created_by, owner: { id: m.id } });
  });

  it('a Members App one-time purchase is members_app, and a channel in the body is ignored', async () => {
    const m = await member('Self Buyer');
    const res = await asMember(m.clerk, 'post', '/me/cart/purchases')
      .send({ product_id: await product('12.00', 'once'), channel: 'admin_app' });
    expect(res.status).toBe(201);
    const [listed] = await purchasesOf(m.id);
    expect(listed).toMatchObject({ channel: 'members_app', created_by: 'Self Buyer' });
  });

  it('a Members App plan choice opens a members_app purchase', async () => {
    const m = await member('Plan Chooser');
    const res = await asMember(m.clerk, 'post', `/me/membership-plans/${await plan(40)}/assign`).send({});
    expect(res.status).toBeLessThan(300);
    const [listed] = await purchasesOf(m.id);
    expect(listed).toMatchObject({ channel: 'members_app', created_by: 'Plan Chooser' });
  });

  it('a checkout split from a cart is the checkout workflow\'s; the cart keeps its own', async () => {
    const m = await member('Split Owner');
    const first = await asMember(m.clerk, 'post', '/me/cart/purchases').send({ product_id: await product('5.00', 'once') });
    const second = await asMember(m.clerk, 'post', '/me/cart/purchases').send({ product_id: await product('6.00', 'once') });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const lineId = Number(first.body.purchase_id ?? first.body.id);
    const { rows: [cart] } = await db.query<any>(
      'SELECT purchase_id FROM product_oneoff_snapshots WHERE gym_id = ? AND source_id = ?', [gymId, lineId]);
    const cartId = Number(cart.purchase_id);

    const pay = await staff('post', `/members/${m.id}/product-purchases/checkout`).send({ purchase_ids: [lineId] });
    expect(pay.status).toBe(201);
    const { rows: [moved] } = await db.query<any>(
      'SELECT purchase_id FROM product_oneoff_snapshots WHERE gym_id = ? AND source_id = ?', [gymId, lineId]);
    expect(Number(moved.purchase_id)).not.toBe(cartId);
    expect(await purchaseRow(Number(moved.purchase_id))).toMatchObject({ channel: 'admin_app', status: 'pending_payment' });
    expect(await purchaseRow(cartId)).toMatchObject({ channel: 'members_app', created_by: 'Split Owner', status: 'in_cart' });
  });

  it('a legacy or system purchase reads its stored actor and a null channel', async () => {
    const m = await member('Legacy Owner');
    await db.query(
      `INSERT INTO purchases (gym_id, owner_member_id, status, created_by) VALUES (?, ?, 'completed', 'System')`,
      [gymId, m.id]);
    const [listed] = await purchasesOf(m.id);
    expect(listed).toMatchObject({ channel: null, created_by: 'System' });
  });

  it('the database refuses a channel outside the two', async () => {
    const m = await member('Bad Channel');
    await expect(db.query(
      `INSERT INTO purchases (gym_id, owner_member_id, status, channel) VALUES (?, ?, 'completed', 'kiosk')`,
      [gymId, m.id])).rejects.toThrow();
  });
});
