// #2940 — Billing Event names, written by the event's own writer and reported to
// both apps. Integration: recurring obligations are named for their month, and the
// Admin's Payments read and the member's ledger report the same stored name. Since
// #3287 a checkout's event a Purchase owns carries that purchase's canonical name
// (#3288) instead of `Initial Engagement` or a name for what it adds.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Only the call that would reach Monei is stubbed.
vi.mock('../payments', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../payments')>();
  return {
    ...mod,
    getPaymentProvider: () => {
      let real: object = {};
      try { real = mod.getPaymentProvider(); } catch { /* only createPaymentRequest is needed */ }
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
import { recurringEventName } from '../domain/billingEventName';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let gymName: string;
let adminClerk: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const today = () => new Date().toISOString().slice(0, 10);

const h = () => ({ Authorization: TEST_AUTH_HEADER, 'x-gym-id': gymId });
const once = (sub: string) => vi.mocked(verifyToken).mockResolvedValueOnce({ sub } as any);
const twice = (sub: string) => { once(sub); once(sub); };

async function member(): Promise<{ clerk: string; id: number }> {
  const clerk = `ben-${uniq()}`;
  await createTestMembership(gymId, 'member', clerk);
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, 'Named Member', `${clerk}@t.com`, clerk]);
  return { clerk, id: insertId };
}

async function product(name: string, amount: string, frequency: 'once' | 'month'): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, currency, amount, tax_behavior)
     VALUES (?, ?, 'fee', ?, 'active', 'public', 'EUR', ?, 'inclusive')`, [gymId, name, frequency, amount]);
  return insertId;
}

async function plan(name: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '1')`, [gymId, name]);
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, 40, '2020-01-01', 'active')`, [gymId, insertId]);
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return insertId;
}

const set = (clerk: string, method: 'get' | 'post', path: string) => {
  twice(clerk);
  return (request as any)[method](`/me/product-sets${path}`).set(h());
};

const initialName = async (setId: number) => (await db.query<any>(
  `SELECT name FROM billing_events WHERE product_set_id = ? AND event_type = 'payment_recorded'`, [setId])).rows[0]?.name;
/** #3287: the canonical name of the purchase (cart) the set belongs to. */
const purchaseNameOfSet = async (setId: number) => (await db.query<any>(
  'SELECT p.name FROM product_sets ps JOIN purchases p ON p.id = ps.purchase_id WHERE ps.id = ?', [setId])).rows[0]?.name;

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = 'test-ben';
  gymId = await createTestGym('Named Billing Gym');
  gymName = (await db.query<any>('SELECT name FROM gyms WHERE id = ?', [gymId])).rows[0].name;
  adminClerk = `ben-admin-${uniq()}`;
  await createTestMembership(gymId, 'admin', adminClerk);
});
afterAll(async () => {
  delete process.env.MONEI_API_KEY;
  delete process.env.MONEI_WEBHOOK_SECRET;
  await db.query('DELETE FROM payment_requests WHERE gym_id = ?', [gymId]);
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('Billing Event names (#2940)', () => {
  it("names a first plan's event and a later Product's by their purchase, and its obligations by month", async () => {
    const m = await member();
    const planId = await plan(`Premium ${uniq()}`);
    once(m.clerk);
    const assigned = await request.post(`/me/membership-plans/${planId}/assign`).set(h()).send({});
    expect(assigned.status).toBe(201);
    const first = Number(assigned.body.id);

    expect((await set(m.clerk, 'post', `/${first}/save-and-pay`).send({})).status).toBe(201);
    const firstName = await purchaseNameOfSet(first);
    expect(firstName).toMatch(/ - Purchase - /);
    expect(await initialName(first)).toBe(firstName);

    expect((await db.transaction((tx) => activateWithEvents(tx, { gymId, productSetId: first, today: today(), actor: 'System' }))).kind).toBe('ok');
    const { rows: scheduled } = await db.query<any>(
      `SELECT name, DATE_FORMAT(billing_date, '%Y-%m-%d') AS d FROM billing_events
        WHERE product_set_id = ? AND is_scheduled = 1`, [first]);
    expect(scheduled.length).toBeGreaterThan(0);
    for (const e of scheduled) {
      expect(e.name).toBe(recurringEventName({ gymName, billingDate: e.d, cadence: { interval: 1, unit: 'month' } }));
    }
    // A monthly plan bills on the 1st, so its obligations read `Gym - <Month>` with no date.
    expect(scheduled.some((e: any) => e.d.endsWith('-01') && !e.name.includes('('))).toBe(true);

    // A recurring Product added later is a purchase of that one Product.
    const locker = `Locker ${uniq()}`;
    const draft = (await set(m.clerk, 'post', '/draft')).body;
    expect((await set(m.clerk, 'post', `/${draft.id}/services`).send({ product_id: await product(locker, '10.00', 'month') })).status).toBe(200);
    expect((await set(m.clerk, 'post', `/${draft.id}/save-and-pay`).send({})).status).toBe(201);
    const lockerName = await purchaseNameOfSet(Number(draft.id));
    expect(await initialName(Number(draft.id))).toBe(lockerName);

    // Both apps read the same stored name.
    once(adminClerk);
    const admin = await request.get(`/payments/billing-events?member_id=${m.id}&limit=200`).set(h());
    expect(admin.status).toBe(200);
    const adminNames = admin.body.items.map((r: any) => r.name);
    expect(adminNames).toContain(firstName);
    expect(adminNames).toContain(lockerName);
    once(m.clerk);
    const own = await request.get('/me/billing-events').set(h());
    expect(own.status).toBe(200);
    expect(own.body.items.map((r: any) => r.name)).toContain(lockerName);
  });

  it("names a cart's event by its purchase, whether it holds one Product or several", async () => {
    const single = await member();
    const gloves = `Boxing Gloves ${uniq()}`;
    const d1 = (await set(single.clerk, 'post', '/draft')).body;
    expect((await set(single.clerk, 'post', `/${d1.id}/purchases`).send({ product_id: await product(gloves, '25.00', 'once') })).status).toBe(200);
    expect((await set(single.clerk, 'post', `/${d1.id}/save-and-pay`).send({})).status).toBe(201);
    expect(await initialName(Number(d1.id))).toBe(await purchaseNameOfSet(Number(d1.id)));

    const several = await member();
    const d2 = (await set(several.clerk, 'post', '/draft')).body;
    for (const n of ['Towel', 'Bottle']) {
      expect((await set(several.clerk, 'post', `/${d2.id}/purchases`).send({ product_id: await product(`${n} ${uniq()}`, '5.00', 'once') })).status).toBe(200);
    }
    expect((await set(several.clerk, 'post', `/${d2.id}/save-and-pay`).send({})).status).toBe(201);
    expect(await initialName(Number(d2.id))).toBe(await purchaseNameOfSet(Number(d2.id)));
  });

  it('names a one-time purchase outside a Product Set by its own purchase', async () => {
    const m = await member();
    const mat = `Yoga Mat ${uniq()}`;
    const productId = await product(mat, '15.00', 'once');
    once(m.clerk);
    const res = await request.post(`/me/products/${productId}/purchase`).set(h()).send({});
    expect(res.status).toBeLessThan(300);
    const { rows } = await db.query<any>(
      `SELECT be.name, p.name AS purchase_name FROM billing_events be JOIN purchases p ON p.id = be.purchase_id
        WHERE be.gym_id = ? AND be.member_id = ? AND be.event_type = 'product_purchase'`, [gymId, m.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe(rows[0].purchase_name);
    expect(rows[0].name).not.toContain(mat);
  });
});
