// #1521 stage 2 — a staff member buying a Product for a member, from the
// Members → Products tab: `GET/POST /members/:id/product-purchases`.
//
// Integration: the rules under test are which Products are offered, what the
// stack of Promotions and the Admin's direct discount charge, what is frozen on
// the purchase, and that a recurring Product only ever becomes a Draft
// ProductSet that Save & Pay (the existing workflow) activates. Only the
// provider's `createPaymentRequest` is stubbed.

import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';

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

import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';

const SECRET = 'test-1521-webhook';
let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const day = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const TODAY = day(0);

const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Staff Buy Member', `sb-${uniq()}@test.com`]);
  return insertId;
}

async function product(opts: {
  name: string; amount?: string; frequency?: string | null; enrollment?: 'public' | 'staff_only';
  status?: 'active' | 'inactive'; type?: string;
}): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products
       (gym_id, name, type, billing_frequency, status, enrollment_status, is_system, currency,
        amount, tax_behavior)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'EUR', ?, 'inclusive')`,
    [gymId, opts.name, opts.type ?? 'fee', opts.frequency ?? 'once', opts.status ?? 'active',
      opts.enrollment ?? 'public', opts.amount ?? '100.00']);
  return insertId;
}

async function promotion(opts: { name: string; stackable?: 0 | 1; newMembersOnly?: 0 | 1 }): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO promotions
       (gym_id, name, starts_at, ends_at, lifecycle_status, applies_to, stackable,
        only_applicable_for_new_members, free_months, paid_months, bonus_months)
     VALUES (?, ?, '2026-01-01', '2099-12-31', 'active', 'product', ?, ?, 0, 6, 0)`,
    [gymId, opts.name, opts.stackable ?? 1, opts.newMembersOnly ?? 0]);
  return insertId;
}

async function grant(promotionId: number, productId: number, category: 'oneoff' | 'periodical', action = 'percentage_discount', value: number | null = 50) {
  await db.query(
    `INSERT INTO promotion_${category} (gym_id, promotion_id, product_id, quantity, \`action\`, \`value\`)
     VALUES (?, ?, ?, 1, ?, ?)`, [gymId, promotionId, productId, action, value]);
}

async function plan(price: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', NULL, NULL, 0, 0)`, [gymId, `SB-Plan-${uniq()}`]);
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status) VALUES (?, ?, ?, ?, 'active')`,
    [gymId, insertId, price, day(-365)]);
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit) VALUES (?, ?, 1, 'month')`,
    [gymId, insertId]);
  return insertId;
}

function webhook(payload: unknown) {
  const raw = JSON.stringify(payload);
  const t = String(Math.floor(Date.now() / 1000));
  const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
  return request.post('/webhooks/payment').set({ 'monei-signature': `t=${t},v1=${v1}` })
    .set('Content-Type', 'application/json').send(raw);
}

async function pay(paymentRequestId: number) {
  const { rows } = await db.query<any>('SELECT provider_order FROM payment_requests WHERE id = ?', [paymentRequestId]);
  const id = crypto.randomBytes(12).toString('hex');
  return webhook({
    id: `evt_${id}`, type: 'charge.succeeded', objectId: id, objectType: 'charge',
    object: { id, orderId: rows[0].provider_order, status: 'SUCCEEDED' },
  });
}

const base = (memberId: number) => `/members/${memberId}/product-purchases`;

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = SECRET;
  gymId = await createTestGym('Staff Purchase Gym');
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

describe('who is offered what (#1521 decisions 1 and 3)', () => {
  it('offers active Products to staff — staff-only included — and never an inactive one', async () => {
    const m = await member();
    const pub = await product({ name: 'Locker Public' });
    const staffOnly = await product({ name: 'Locker Staff', enrollment: 'staff_only' });
    const off = await product({ name: 'Locker Off', status: 'inactive' });
    const res = await auth(request.get(`${base(m)}/catalogue`));
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i: any) => i.id);
    expect(ids).toContain(pub);
    expect(ids).toContain(staffOnly);
    expect(ids).not.toContain(off);
  });

  it('keeps offering a one-time Product the member holds, and a recurring one', async () => {
    const m = await member();
    const once = await product({ name: 'Registration fee', frequency: 'once' });
    const weekly = await product({ name: 'One class per week', frequency: 'month' });
    for (const id of [once, weekly]) {
      await db.query(
        `INSERT INTO member_products_oneoff_snapshot
           (gym_id, member_id, product_id, status, product_name, product_type, amount, currency)
         VALUES (?, ?, ?, 'active', 'x', 'fee', 10.00, 'EUR')`, [gymId, m, id]);
    }
    const res = await auth(request.get(`${base(m)}/catalogue`));
    const ids = res.body.items.map((i: any) => i.id);
    expect(ids).toContain(once);
    expect(ids).toContain(weekly);
  });

  it('is scoped to the caller’s gym', async () => {
    const other = await createTestGym('Staff Purchase Other Gym');
    const { insertId: foreign } = await db.query(
      'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [other, 'F', `f-${uniq()}@test.com`]);
    const res = await auth(request.get(`${base(foreign)}/catalogue`));
    expect(res.status).toBe(404);
    expect((await request.get(`${base(foreign)}/catalogue`)).status).toBe(401);
  });
});

describe('the price: stacked Promotions then the Admin’s direct discount (decisions 2 and 4)', () => {
  it('quotes list price, each Promotion, the discount percentage and amount, and the final price', async () => {
    const m = await member();
    const p = await product({ name: 'Day Pass', amount: '100.00' });
    const a = await promotion({ name: 'Half' });
    const b = await promotion({ name: 'Ten off' });
    await grant(a, p, 'oneoff', 'percentage_discount', 50);
    await grant(b, p, 'oneoff', 'fixed_discount', 10);

    const res = await auth(request.post(`${base(m)}/quote`))
      .send({ product_id: p, promotion_ids: [a, b], direct_discount_percent: 10 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      list_price: 100, after_promotions: 40, direct_discount_percent: 10,
      direct_discount_amount: 4, final_price: 36,
    });
    expect(res.body.promotions.map((s: any) => [s.regular_amount, s.final_amount])).toEqual([[100, 50], [50, 40]]);
  });

  it('refuses two promotions when one is not stackable', async () => {
    const m = await member();
    const p = await product({ name: 'Day Pass 2' });
    const a = await promotion({ name: 'Stackable' });
    const b = await promotion({ name: 'Solo', stackable: 0 });
    await grant(a, p, 'oneoff');
    await grant(b, p, 'oneoff');
    const res = await auth(request.post(`${base(m)}/quote`)).send({ product_id: p, promotion_ids: [a, b] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('promotions_not_stackable');
  });

  it('refuses a promotion that is not a configured offer for this Product', async () => {
    const m = await member();
    const p = await product({ name: 'Day Pass 3' });
    const other = await product({ name: 'Other' });
    const promo = await promotion({ name: 'For other' });
    await grant(promo, other, 'oneoff');
    const res = await auth(request.post(`${base(m)}/quote`)).send({ product_id: p, promotion_ids: [promo] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('promotion_not_applicable');
  });

  it('honours only-for-new-members through the existing definition of a new member', async () => {
    const m = await member();
    const p = await product({ name: 'New only' });
    const promo = await promotion({ name: 'Welcome', newMembersOnly: 1 });
    await grant(promo, p, 'oneoff');
    // A fresh member is new…
    const fresh = await auth(request.get(`${base(m)}/catalogue`));
    expect(fresh.body.items.find((i: any) => i.id === p).promotions).toHaveLength(1);
    // …a member with a live plan is not.
    const planId = await plan(30);
    await db.query(
      `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at)
       VALUES (?, ?, ?, 'active', ?)`, [gymId, m, planId, day(-10)]);
    const later = await auth(request.get(`${base(m)}/catalogue`));
    const hidden = later.body.items.find((i: any) => i.id === p);
    expect(hidden.promotions).toHaveLength(0);
    // #1655 — the staff selector is told why, so "no promotions" is explicable;
    // the Promotion is still not an offer and cannot be applied.
    expect(hidden.unavailable_promotions).toEqual([
      { promotion_id: promo, promotion_name: 'Welcome', reason: 'new_members_only' },
    ]);
    const quote = await auth(request.post(`${base(m)}/quote`)).send({ product_id: p, promotion_ids: [promo] });
    expect(quote.status).toBe(409);
  });

  it('lets only an Admin apply a direct discount', async () => {
    // A gym where the caller is Front Desk: Members write access, not Admin.
    const fdGym = await createTestGym('Staff Purchase Front Desk Gym');
    await createTestMembership(fdGym, 'front_desk');
    const { insertId: m } = await db.query(
      'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [fdGym, 'FD Member', `fd-${uniq()}@test.com`]);
    const { insertId: p } = await db.query(
      `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, is_system, currency, amount, tax_behavior)
       VALUES (?, 'Pass', 'fee', 'once', 'active', 'public', 0, 'EUR', '100.00', 'inclusive')`, [fdGym]);
    const as = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', fdGym);

    const res = await as(request.post(`${base(m)}/quote`)).send({ product_id: p, direct_discount_percent: 10 });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('direct_discount_not_allowed');
    // The same role may still quote and buy without one.
    const ok = await as(request.post(`${base(m)}/quote`)).send({ product_id: p });
    expect(ok.status).toBe(200);
    expect(ok.body.final_price).toBe(100);
    const buy = await as(request.post(base(m))).send({ product_id: p, direct_discount_percent: 10 });
    expect(buy.status).toBe(403);
  });

  it('refuses an invalid or price-zeroing discount rather than clamping', async () => {
    const m = await member();
    const p = await product({ name: 'Day Pass 5' });
    for (const bad of [100, 120, -5, 'abc']) {
      const res = await auth(request.post(`${base(m)}/quote`)).send({ product_id: p, direct_discount_percent: bad });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_direct_discount');
    }
  });
});

describe('a one-time purchase (#1521)', () => {
  it('freezes list price, promotions and the direct discount, and is pending until paid', async () => {
    const m = await member();
    const p = await product({ name: 'Day Pass 6', amount: '100.00' });
    const a = await promotion({ name: 'Half 6' });
    await grant(a, p, 'oneoff', 'percentage_discount', 50);

    const res = await auth(request.post(base(m))).send({ product_id: p, promotion_ids: [a], direct_discount_percent: 20 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'one_time', amount: 40 });

    const { rows } = await db.query<any>(
      `SELECT * FROM member_products_oneoff_snapshot WHERE gym_id = ? AND member_id = ?`, [gymId, m]);
    expect(rows[0]).toMatchObject({ status: 'pending_payment', created_by: expect.any(String) });
    expect(Number(rows[0].list_price)).toBe(100);
    expect(Number(rows[0].direct_discount_percent)).toBe(20);
    expect(Number(rows[0].direct_discount_amount)).toBe(10);
    expect(Number(rows[0].amount)).toBe(40);

    // A later price change moves nothing about it.
    await db.query('UPDATE products SET amount = ? WHERE id = ?', ['999.00', p]);
    const read = await auth(request.get(`/members/${m}/products`));
    expect(read.body.items[0]).toMatchObject({ regular_amount: 100, amount: 40, direct_discount_percent: 20 });
    expect(read.body.items[0].promotions).toHaveLength(1);
  });

  it('sells the same one-time Product again once it is held, while a checkout in flight still blocks (#1864)', async () => {
    const m = await member();
    const p = await product({ name: 'Registration fee 2' });
    const first = await auth(request.post(base(m))).send({ product_id: p });
    expect(first.status).toBe(201);
    // Pending blocks (the existing key)…
    const dup = await auth(request.post(base(m))).send({ product_id: p });
    expect(dup.status).toBe(409);
    // …and once paid, the same Product can be bought again (#1864).
    const { rows } = await db.query<any>(
      'SELECT payment_request_id FROM member_products_oneoff_snapshot WHERE gym_id = ? AND member_id = ?', [gymId, m]);
    expect((await pay(Number(rows[0].payment_request_id))).status).toBe(200);
    const again = await auth(request.post(base(m))).send({ product_id: p });
    expect(again.status).toBe(201);
    const { rows: both } = await db.query<any>(
      'SELECT status FROM member_products_oneoff_snapshot WHERE gym_id = ? AND member_id = ? AND product_id = ? ORDER BY id', [gymId, m, p]);
    expect(both.map((r: any) => r.status)).toEqual(['active', 'pending_payment']);
  });

  it('needs Members write access and a Product of this gym', async () => {
    const m = await member();
    const p = await product({ name: 'Day Pass 7' });
    expect((await request.post(base(m)).send({ product_id: p })).status).toBe(401);
    const other = await createTestGym('Staff Purchase Other Gym 2');
    const { insertId: foreignProduct } = await db.query(
      `INSERT INTO products (gym_id, name, type, billing_frequency, status, enrollment_status, is_system, currency, amount, tax_behavior)
       VALUES (?, 'Foreign', 'fee', 'once', 'active', 'public', 0, 'EUR', '10.00', 'inclusive')`, [other]);
    expect((await auth(request.post(base(m))).send({ product_id: foreignProduct })).status).toBe(404);
  });
});

describe('a recurring purchase is a Draft ProductSet, activated only by Save & Pay (decision 1)', () => {
  // #1865: a `sessions` Product billed monthly (a Duo class) is recurring by frequency.
  it('adds a recurring Product of type sessions and asks before mixing billing frequencies', async () => {
    const m = await member();
    const duo = await product({ name: 'Duo class', frequency: 'month', amount: '50.00', type: 'sessions' });
    const first = await auth(request.post(base(m))).send({ product_id: duo });
    expect(first.status).toBe(201);
    expect(first.body.kind).toBe('recurring_draft');

    const fourWeekly = await product({ name: 'Four weekly locker', frequency: 'four_weeks', amount: '10.00', type: 'service' });
    const asked = await auth(request.post(base(m))).send({ product_id: fourWeekly });
    expect(asked.status).toBe(409);
    expect(asked.body).toMatchObject({ error: 'billing_frequency_differs', existing: ['month'], incoming: 'four_weeks' });
    const lines = async () => (await db.query<any>(
      'SELECT COUNT(*) AS n FROM member_products_recurrent_snapshot WHERE gym_id = ? AND product_set_id = ?',
      [gymId, first.body.product_set_id])).rows[0].n;
    expect(Number(await lines())).toBe(1);

    const confirmed = await auth(request.post(base(m))).send({ product_id: fourWeekly, confirm_billing_frequency: true });
    expect(confirmed.status).toBe(201);
    expect(Number(await lines())).toBe(2);
  });

  it('creates a Draft on top of the Active version without activating or charging anything', async () => {
    const m = await member();
    const planId = await plan(40);
    // The member's Active version, through the existing workflow.
    const created = await auth(request.post('/product-sets')).send({ member_id: m, membership_plan_id: planId, starts_at: TODAY });
    const paid = await auth(request.post(`/product-sets/${created.body.id}/save-and-pay`)).send({});
    expect((await pay(paid.body.payment_request_id)).status).toBe(200);
    const active = await auth(request.get(`/product-sets/${created.body.id}`));
    expect(active.body.status).toBe('active');
    const eventsBefore = await db.query<any>('SELECT COUNT(*) AS n FROM billing_events WHERE gym_id = ? AND member_id = ?', [gymId, m]);

    const weekly = await product({ name: 'One class per week', frequency: 'month', amount: '20.00', type: 'service' });
    const buy = await auth(request.post(base(m))).send({ product_id: weekly });
    expect(buy.status).toBe(201);
    expect(buy.body.kind).toBe('recurring_draft');

    const draft = await auth(request.get(`/product-sets/${buy.body.product_set_id}`));
    expect(draft.body.status).toBe('draft');
    expect(Number(draft.body.membership_plan_id)).toBe(planId);
    // The previous version is untouched and nothing was charged or written.
    const still = await auth(request.get(`/product-sets/${created.body.id}`));
    expect(still.body.status).toBe('active');
    const eventsAfter = await db.query<any>('SELECT COUNT(*) AS n FROM billing_events WHERE gym_id = ? AND member_id = ?', [gymId, m]);
    expect(Number(eventsAfter.rows[0].n)).toBe(Number(eventsBefore.rows[0].n));

    // The Draft's own forecast reflects the new line, creating nothing.
    const sim = await auth(request.get(`/product-sets/${buy.body.product_set_id}/billing-event-simulation`));
    expect(sim.status).toBe(200);

    // Save & Pay asks for what the new line owes — not the plan's first cycle
    // again — and only its payment makes the version the member's.
    const sp = await auth(request.post(`/product-sets/${buy.body.product_set_id}/save-and-pay`)).send({});
    expect(sp.status).toBe(201);
    expect(sp.body.amount).toBe(20);
    expect((await pay(sp.body.payment_request_id)).status).toBe(200);
    const now = await auth(request.get(`/product-sets/${buy.body.product_set_id}`));
    expect(now.body.status).toBe('active');
    const old = await auth(request.get(`/product-sets/${created.body.id}`));
    expect(old.body.status).toBe('superseded');
  });

  it('applies the direct discount to the line and keeps the list price beside it', async () => {
    const m = await member();
    const weekly = await product({ name: 'Weekly 2', frequency: 'month', amount: '20.00', type: 'service' });
    const buy = await auth(request.post(base(m))).send({ product_id: weekly, direct_discount_percent: 25 });
    expect(buy.status).toBe(201);
    const { rows } = await db.query<any>(
      'SELECT unit_price, list_unit_price, direct_discount_percent FROM member_products_recurrent_snapshot WHERE product_set_id = ?',
      [buy.body.product_set_id]);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].unit_price)).toBe(15);
    expect(Number(rows[0].list_unit_price)).toBe(20);
    expect(Number(rows[0].direct_discount_percent)).toBe(25);
  });

  it('adds to the same Draft while one is open, and lets the same recurring Product be bought again once it is resolved', async () => {
    const m = await member();
    const weekly = await product({ name: 'Weekly 3', frequency: 'month', amount: '20.00', type: 'service' });
    const first = await auth(request.post(base(m))).send({ product_id: weekly });
    expect(first.status).toBe(201);
    // #1537: a second add is an edit of the same Draft, never a second version.
    // An immediate identical submission is a double click, not a second purchase…
    const dupe = await auth(request.post(base(m))).send({ product_id: weekly });
    expect(dupe.status).toBe(409);
    expect(dupe.body.error).toBe('duplicate_submission');
    // …while a deliberate repeat a moment later is.
    await db.query(
      'UPDATE member_products_recurrent_snapshot SET created_at = created_at - INTERVAL 1 MINUTE WHERE product_set_id = ?',
      [first.body.product_set_id]);
    const second = await auth(request.post(base(m))).send({ product_id: weekly });
    expect(second.status).toBe(201);
    expect(second.body.product_set_id).toBe(first.body.product_set_id);
    const { rows: lines } = await db.query<any>(
      'SELECT id, line_ref, quantity FROM member_products_recurrent_snapshot WHERE product_set_id = ? ORDER BY id', [first.body.product_set_id]);
    // #1865: a repeat purchase is a line of its own, not a quantity on the first.
    expect(lines.map((l: any) => Number(l.quantity))).toEqual([1, 1]);
    expect(lines.map((l: any) => Number(l.line_ref))).toEqual(lines.map((l: any) => Number(l.id)));
    // Editing one line leaves the other alone.
    const qty = await auth(request.put(`/product-sets/${first.body.product_set_id}/services/${lines[0].id}`)).send({ quantity: 2 });
    expect(qty.status).toBe(200);
    const { rows: afterQty } = await db.query<any>(
      'SELECT quantity FROM member_products_recurrent_snapshot WHERE product_set_id = ? ORDER BY id', [first.body.product_set_id]);
    expect(afterQty.map((l: any) => Number(l.quantity))).toEqual([2, 1]);
    // Removing one purchase leaves the other running.
    const del = await auth(request.delete(`/product-sets/${first.body.product_set_id}/services/${lines[0].id}`));
    expect(del.status).toBe(200);
    const { rows: left } = await db.query<any>(
      'SELECT id FROM member_products_recurrent_snapshot WHERE product_set_id = ? AND ends_at IS NULL', [first.body.product_set_id]);
    expect(left.map((l: any) => Number(l.id))).toEqual([Number(lines[1].id)]);

    // Save & Pay + the webhook is the only way it becomes the member's…
    const sp = await auth(request.post(`/product-sets/${first.body.product_set_id}/save-and-pay`)).send({});
    expect(sp.status).toBe(201);
    expect((await pay(sp.body.payment_request_id)).status).toBe(200);
    const active = await auth(request.get(`/product-sets/${first.body.product_set_id}`));
    expect(active.body.status).toBe('active');
    // The first period was paid by the initial payment: no second obligation
    // is created for the same date (the nightly run would charge it again).
    const today = active.body.billing_events.filter((e: any) => String(e.billing_date).slice(0, 10) === TODAY);
    expect(today.map((e: any) => e.event_type)).toEqual(['payment_recorded']);

    // …and an owned recurring Product is not excluded: buying it again drafts a
    // new version carrying both lines.
    const again = await auth(request.post(base(m))).send({ product_id: weekly });
    expect(again.status).toBe(201);
    const { rows } = await db.query<any>(
      'SELECT quantity FROM member_products_recurrent_snapshot WHERE product_set_id = ? AND product_id = ?',
      [again.body.product_set_id, weekly]);
    // The remaining purchase is carried into the new version, and the new
    // purchase is a line of its own beside it.
    expect(rows.map((r: any) => Number(r.quantity))).toEqual([1, 1]);
  });

  it('applies a Product Promotion to the Draft and refuses a non-stackable pair', async () => {
    const m = await member();
    const weekly = await product({ name: 'Weekly 4', frequency: 'month', amount: '20.00', type: 'service' });
    const a = await promotion({ name: 'Rec A' });
    const b = await promotion({ name: 'Rec B', stackable: 0 });
    await grant(a, weekly, 'periodical', 'percentage_discount', 50);
    await grant(b, weekly, 'periodical', 'percentage_discount', 10);

    const bad = await auth(request.post(base(m))).send({ product_id: weekly, promotion_ids: [a, b] });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toBe('promotions_not_stackable');
    // Nothing was created by the refused request.
    const none = await db.query<any>(`SELECT COUNT(*) AS n FROM product_sets WHERE owner_member_id = ?`, [m]);
    expect(Number(none.rows[0].n)).toBe(0);

    const ok = await auth(request.post(base(m))).send({ product_id: weekly, promotion_ids: [a] });
    expect(ok.status).toBe(201);
    const { rows } = await db.query<any>(
      `SELECT promotion_id FROM user_membership_promotions WHERE product_set_id = ? AND status = 'applied'`,
      [ok.body.product_set_id]);
    expect(rows.map((r: any) => Number(r.promotion_id))).toEqual([a]);
  });
});
