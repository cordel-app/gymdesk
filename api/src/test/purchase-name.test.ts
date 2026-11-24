// #3270 / #3288 / #3287 — a purchase (cart) carries one canonical name, generated once at creation
// (`<Gym> - Purchase|Compra - <created_at in the gym's Time & Localization>`), which its checkout
// Billing Event copies verbatim and the provider payment is described with; the Summary's Initial
// Payment states each line's persisted Billing Event Line `source` (#3254). Integration against the
// real stack; only the provider's `createPaymentRequest` is stubbed (and records its description).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const sentDescriptions = vi.hoisted(() => new Map<string, string>());

vi.mock('../payments', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../payments')>();
  return {
    ...mod,
    getPaymentProvider: () => {
      const real = mod.getPaymentProvider();
      return Object.assign(Object.create(real), {
        createPaymentRequest: async (p: { orderId: string; description: string }) => {
          sentDescriptions.set(`monei-${p.orderId}`, p.description);
          return { providerOrderId: `monei-${p.orderId}`, checkoutUrl: 'https://pay.test/x' };
        },
      });
    },
  };
});

import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import { productSetOfLegacyAssignmentSql } from '../domain/planAssignments';
import { canonicalPurchaseName } from '../domain/purchaseName';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const firstOfNextMonth = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
};

const staff = (method: 'get' | 'post', path: string) =>
  (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);
const asMember = (clerk: string, method: 'get' | 'post', path: string, locale = 'es') => {
  vi.mocked(verifyToken).mockResolvedValueOnce({ sub: clerk } as any);
  return (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId).set('x-locale', locale);
};

/** What the purchase `id` should be called, from its own stored created_at and the gym as it is. */
async function expectedName(id: number, locale: string): Promise<string> {
  const { rows } = await db.query<any>(
    `SELECT g.name, g.time_zone, g.date_format, g.time_format, p.created_at
       FROM purchases p JOIN gyms g ON g.id = p.gym_id WHERE p.id = ?`, [id]);
  const r = rows[0];
  return canonicalPurchaseName({ gymName: r.name, locale, createdAt: new Date(r.created_at), settings: r });
}
const eventOfPurchase = async (purchaseId: number) =>
  (await db.query<any>(`SELECT be.id, be.name FROM billing_events be WHERE be.purchase_id = ? ORDER BY be.id`, [purchaseId])).rows;
const descriptionOfEvent = async (eventId: number) => {
  const { rows } = await db.query<any>('SELECT provider_ref FROM payment_requests WHERE billing_event_id = ? ORDER BY id DESC LIMIT 1', [eventId]);
  return sentDescriptions.get(rows[0].provider_ref);
};

async function member(): Promise<{ clerk: string; id: number }> {
  const clerk = `pname-${uniq()}`;
  await createTestMembership(gymId, 'member', clerk);
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email, clerk_user_id) VALUES (?, ?, ?, ?)',
    [gymId, 'Named Cart', `${clerk}@t.com`, clerk]);
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
     VALUES (?, ?, 'active', 'public', '1', 0, 12, 0, 0)`, [gymId, `Named Plan ${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, ?, '2025-01-01', 'active')`, [gymId, insertId, price]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return insertId;
}
const purchaseRow = async (id: number) =>
  (await db.query<any>(`SELECT id, name, status, DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%sZ') AS created FROM purchases WHERE id = ?`, [id])).rows[0];
const cartOfSet = async (setId: number) =>
  Number((await db.query<any>('SELECT purchase_id FROM product_sets WHERE id = ?', [setId])).rows[0].purchase_id);

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = 'test-3270';
  gymId = await createTestGym('Purchase Name Gym');
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

describe('a purchase name, generated once in canonical form (#3288)', () => {
  it('a staff-opened cart is named in English with the gym name, unchanged by edits and status moves; its event and payment carry it (#3287)', async () => {
    const m = await member();
    const add = await staff('post', `/members/${m.id}/product-purchases`).send({ product_id: await product('30.00', 'month') });
    expect(add.status).toBe(201);
    const setId = Number(add.body.product_set_id);
    const cartId = await cartOfSet(setId);
    const born = await purchaseRow(cartId);
    expect(born.name).toBe(await expectedName(cartId, 'en'));
    expect(born.name).toMatch(/^Purchase Name Gym - Purchase - \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);

    const config = await staff('get', `/user-memberships/member/${m.id}/configuration`);
    expect(config.status).toBe(200);
    const inFlight = config.body.product_sets.find((p: any) => p.id === setId);
    expect(inFlight.purchase).toEqual({ id: cartId, name: born.name, status: 'in_cart' });

    // Editing the cart (in another language) and moving it to Pending Payment leave the name as it was.
    expect((await asMember(m.clerk, 'post', '/me/cart/purchases').send({ product_id: await product('9.00', 'once') })).status).toBe(201);
    const pay = await staff('post', `/product-sets/${setId}/save-and-pay`).send({});
    expect(pay.status).toBe(201);
    const after = await purchaseRow(cartId);
    expect(after.status).toBe('pending_payment');
    expect(after.name).toBe(born.name);

    // The checkout's initial Billing Event (once 'Initial Engagement') and the provider payment.
    const events = await eventOfPurchase(cartId);
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe(born.name);
    expect(await descriptionOfEvent(events[0].id)).toBe(born.name);

    // A renamed gym or new settings never rewrite a stored name.
    await db.query("UPDATE gyms SET name = 'Renamed Gym', date_format = 'YYYY-MM-DD' WHERE id = ?", [gymId]);
    try {
      expect((await purchaseRow(cartId)).name).toBe(born.name);
    } finally {
      await db.query("UPDATE gyms SET name = 'Purchase Name Gym', date_format = 'DD/MM/YYYY' WHERE id = ?", [gymId]);
    }
  });

  it("a Members App cart is named in the request's language, with the gym's date format, zone and clock", async () => {
    await db.query("UPDATE gyms SET time_zone = 'America/New_York', date_format = 'MM/DD/YYYY', time_format = '12h' WHERE id = ?", [gymId]);
    try {
      const m = await member();
      const line = await asMember(m.clerk, 'post', '/me/cart/purchases', 'ca').send({ product_id: await product('12.00', 'once') });
      expect(line.status).toBe(201);
      const res = await staff('get', `/members/${m.id}/product-purchases/cart-summary`);
      expect(res.status).toBe(200);
      expect(res.body.purchase).toMatchObject({ status: 'in_cart' });
      expect(res.body.purchase.name).toBe(await expectedName(res.body.purchase.id, 'ca'));
      expect(res.body.purchase.name).toMatch(/^Purchase Name Gym - Compra - \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} (AM|PM)$/);
      expect(res.body.initial_payment.lines.map((l: any) => l.source)).toEqual(['product']);
      expect(res.body.initial_payment.total).toBe(12);

      // The standalone cart's checkout: one event and one payment, both named as the purchase.
      const checkout = await asMember(m.clerk, 'post', '/me/cart/checkout').send({});
      expect(checkout.status).toBe(201);
      const { rows } = await db.query<any>('SELECT be.name, p.name AS purchase_name FROM billing_events be JOIN purchases p ON p.id = be.purchase_id WHERE be.id = ?', [checkout.body.billingEventId]);
      expect(rows[0].name).toBe(rows[0].purchase_name);
      expect(rows[0].purchase_name).toBe(res.body.purchase.name);
      expect(await descriptionOfEvent(checkout.body.billingEventId)).toBe(res.body.purchase.name);
    } finally {
      await db.query("UPDATE gyms SET time_zone = 'Europe/Madrid', date_format = 'DD/MM/YYYY', time_format = '24h' WHERE id = ?", [gymId]);
    }
  });

  it('a one-time purchase bought directly gets a purchase of its own, its event and payment named alike', async () => {
    const m = await member();
    const res = await asMember(m.clerk, 'post', `/me/products/${await product('8.00', 'once')}/purchase`).send({});
    expect([200, 201]).toContain(res.status);
    const { rows } = await db.query<any>(
      `SELECT be.id, be.name, p.id AS purchase_id, p.name AS purchase_name
         FROM billing_events be JOIN purchases p ON p.id = be.purchase_id
        WHERE be.member_id = ? AND be.event_type = 'product_purchase'`, [m.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].purchase_name).toBe(await expectedName(rows[0].purchase_id, 'es'));
    expect(rows[0].name).toBe(rows[0].purchase_name);
    expect(await descriptionOfEvent(rows[0].id)).toBe(rows[0].purchase_name);
  });
});

describe('migration 475 converts legacy names and backfills their events (#3288, #3287)', () => {
  const knexLike = {
    raw: async (sql: string, bindings: unknown[] = []) => [(await db.query<any>(sql, bindings as any[])).rows],
    schema: { hasColumn: async () => true },
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const migration = require('../infra/migrations/475_purchase_canonical_name.js');

  it('an ISO name becomes the English canonical name, its events copy it, and nothing else moves', async () => {
    const m = await member();
    const { insertId: legacy } = await db.query(
      `INSERT INTO purchases (gym_id, owner_member_id, status, name, created_at, created_by)
       VALUES (?, ?, 'completed', '2026-11-23T10:56:00Z', '2026-11-23 10:56:00', 'Test')`, [gymId, m.id]);
    const { insertId: linked } = await db.query(
      `INSERT INTO billing_events (gym_id, member_id, event_type, name, amount, source, purchase_id)
       VALUES (?, ?, 'product_purchase', 'Initial Engagement', 5.00, 'system', ?)`, [gymId, m.id, legacy]);
    const { insertId: loose } = await db.query(
      `INSERT INTO billing_events (gym_id, member_id, event_type, name, amount, source)
       VALUES (?, ?, 'product_purchase', 'Gym - Towel', 3.00, 'system')`, [gymId, m.id]);

    await migration.up(knexLike);
    await migration.up(knexLike); // resumable: a second run changes nothing

    expect((await purchaseRow(legacy)).name).toBe('Purchase Name Gym - Purchase - 23/11/2026 11:56');
    const nameOf = async (id: number) => (await db.query<any>('SELECT name FROM billing_events WHERE id = ?', [id])).rows[0].name;
    expect(await nameOf(linked)).toBe('Purchase Name Gym - Purchase - 23/11/2026 11:56');
    expect(await nameOf(loose)).toBe('Gym - Towel');
  });
});

describe("the Summary's Initial Payment states each line's source (#3270)", () => {
  it('a mixed cart reads Plan on the plan lines and Product on the standalone ones, totals unchanged', async () => {
    const { insertId: memberId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
      [gymId, 'Mixed Cart', `mixed-${uniq()}@t.com`]);
    const assign = await staff('post', `/membership-plans/${await plan(40)}/assign`)
      .send({ starts_at: firstOfNextMonth(), owner_member_id: memberId, beneficiary_member_ids: [memberId] });
    expect(assign.status).toBe(201);
    const { rows } = await db.query<any>(
      `SELECT id FROM product_sets WHERE ${productSetOfLegacyAssignmentSql('?', 'product_sets')} ORDER BY id DESC LIMIT 1`, [assign.body.id]);
    const setId = Number(rows[0].id);
    // A recurring Product staff add goes into the member's open Draft (#2891).
    const add = await staff('post', `/members/${memberId}/product-purchases`).send({ product_id: await product('15.00', 'month') });
    expect(add.status).toBe(201);
    expect(Number(add.body.product_set_id)).toBe(setId);

    const review = await staff('get', `/product-sets/${setId}/review`);
    expect(review.status).toBe(200);
    const lines = review.body.initial_payment.lines;
    const sources = new Set(lines.map((l: any) => l.source));
    expect(sources).toEqual(new Set(['plan', 'product']));
    const fee = lines.find((l: any) => l.source === 'plan');
    expect(fee.amount).toBe(40);
    // The breakdown still sums to the charge.
    const sum = Math.round(lines.reduce((n: number, l: any) => n + l.amount, 0) * 100) / 100;
    expect(sum).toBe(review.body.initial_payment.total);
  });
});
