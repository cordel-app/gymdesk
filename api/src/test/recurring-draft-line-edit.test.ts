// #2856 — `⋮ → Edit` and `⋮ → Delete` on a recurring line of the member's open
// Draft Product Set: the edit stays on that one Draft, a deselected Promotion is
// gone, a newly selected one is a reference until Save & Pay snapshots it, a
// deleted line's snapshot is hard-deleted, and the Active version never moves.
// Integration against real MySQL; only the provider's `createPaymentRequest` is stubbed.

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

import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER, legacyChildQuery } from './helpers';

const SECRET = 'test-2856-webhook';
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
const mset = (id: number) => `/product-sets/${id}`;
async function activePlan(m: number, price = 40, startsAt = TODAY): Promise<number> {
  const planId = await plan(price);
  const created = await auth(request.post('/product-sets')).send({ member_id: m, membership_plan_id: planId, starts_at: startsAt });
  expect(created.status).toBe(201);
  const paid = await auth(request.post(`${mset(created.body.id)}/save-and-pay`)).send({});
  expect((await pay(paid.body.payment_request_id)).status).toBe(200);
  return created.body.id as number;
}
const openLines = async (setId: number) => (await db.query<any>(
  // #2126 stage 5c-2c-2: a set's lines are its links (a new version links its predecessor's lines).
  `SELECT s.source_id AS id, s.product_id, s.quantity FROM product_set_periodical_snapshots lnk
     JOIN product_periodical_snapshots s ON s.id = lnk.product_periodical_snapshot_id
    WHERE lnk.product_set_id = ? AND s.ends_at IS NULL ORDER BY s.source_id`, [setId])).rows;

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = SECRET;
  gymId = await createTestGym('Draft Line Edit Gym');
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

const line = (m: number, id: number) => `${base(m)}/recurring/${id}`;
const applications = async (setId: number) => (await legacyChildQuery(
  `SELECT id, promotion_id, recurrent_snapshot_id, snapshot, snapshot_confirmed_at FROM user_membership_promotions
    WHERE product_set_id = ? AND status = 'applied' ORDER BY id`, [setId])).rows;
const setsOf = async (m: number) => Number((await db.query<any>(
  'SELECT COUNT(*) AS n FROM product_sets WHERE owner_member_id = ?', [m])).rows[0].n);
const listed = async (m: number) => (await auth(request.get(`/members/${m}/products`))).body.items as any[];

describe('editing a Draft line (#2856)', () => {
  it('changes quantity, discount and Promotions on the same Draft, and snapshots them only at Save & Pay', async () => {
    const m = await member();
    const towel = await product({ name: 'Towel E', frequency: 'month', amount: '20.00', type: 'service' });
    const a = await promotion({ name: 'Half E' });
    const b = await promotion({ name: 'Quarter E' });
    await grant(a, towel, 'periodical', 'percentage_discount', 50);
    await grant(b, towel, 'periodical', 'percentage_discount', 25);

    const add = await auth(request.post(base(m))).send({ product_id: towel, promotion_ids: [a] });
    expect(add.status).toBe(201);
    const draftId = add.body.product_set_id as number;
    const [l] = await openLines(draftId);
    const row = (await listed(m)).find((i) => i.product_id === towel);
    expect(row).toMatchObject({ status: 'in_cart', source: 'recurring', draft_line_id: l.id });

    const edit = await auth(request.put(line(m, l.id))).send({ quantity: 2, promotion_ids: [b], direct_discount_percent: 10 });
    expect(edit.status).toBe(200);
    expect(edit.body.product_set_id).toBe(draftId);
    expect(await setsOf(m)).toBe(1);

    const [after] = await openLines(draftId);
    expect(Number(after.quantity)).toBe(2);
    const { rows: priced } = await db.query<any>(
      'SELECT unit_price, list_price, direct_discount_percent FROM product_periodical_snapshots WHERE source_id = ?', [after.id]);
    expect([Number(priced[0].unit_price), Number(priced[0].list_price), Number(priced[0].direct_discount_percent)]).toEqual([18, 20, 10]);

    // Only the final selection is on the line, as a reference with no snapshot yet.
    let apps = await applications(draftId);
    expect(apps.map((x) => Number(x.promotion_id))).toEqual([b]);
    expect(apps[0].snapshot).toBeNull();
    expect(apps[0].snapshot_confirmed_at).toBeNull();
    const { rows: grants } = await legacyChildQuery(
      `SELECT COUNT(*) AS n FROM user_membership_promotion_periodical_snapshot g
         JOIN user_membership_promotions ump ON ump.id = g.user_membership_promotion_id
        WHERE ump.product_set_id = ?`, [draftId]);
    expect(Number(grants[0].n)).toBe(0);

    // Removing every Promotion and the discount works too, still on the same Draft.
    const clear = await auth(request.put(line(m, after.id))).send({ promotion_ids: [], direct_discount_percent: null });
    expect(clear.status).toBe(200);
    expect(await applications(draftId)).toHaveLength(0);
    const again = await auth(request.put(line(m, after.id))).send({ promotion_ids: [b] });
    expect(again.status).toBe(200);

    // #3026 stage 3d-3a: the line's Product snapshot copy states the reference's confirmation too.
    const confirmationOnSnapshot = async () => (await db.query<any>(
      `SELECT pp.snapshot_confirmed_at, pp.source_application_id FROM product_promotion_snapshots pp
         JOIN product_set_periodical_snapshots lnk ON lnk.product_periodical_snapshot_id = pp.product_periodical_snapshot_id
        WHERE lnk.product_set_id = ?`, [draftId])).rows;
    const referenced = await confirmationOnSnapshot();
    expect(referenced).toHaveLength(1);
    expect(referenced[0].snapshot_confirmed_at).toBeNull();

    const sp = await auth(request.post(`${mset(draftId)}/save-and-pay`)).send({});
    expect(sp.status).toBe(201);
    apps = await applications(draftId);
    expect(apps).toHaveLength(1);
    expect(Number(apps[0].promotion_id)).toBe(b);
    expect(apps[0].snapshot).not.toBeNull();
    expect(apps[0].snapshot_confirmed_at).not.toBeNull();
    const { rows: frozen } = await db.query<any>(
      `SELECT COUNT(*) AS n FROM product_promotion_snapshots pp
         JOIN product_set_periodical_snapshots lnk ON lnk.product_periodical_snapshot_id = pp.product_periodical_snapshot_id
        WHERE lnk.product_set_id = ?`, [draftId]);
    expect(Number(frozen[0].n)).toBe(1);
    const confirmed = await confirmationOnSnapshot();
    expect(Number(confirmed[0].source_application_id)).toBe(Number(apps[0].id));
    expect(confirmed[0].snapshot_confirmed_at).not.toBeNull();
    expect(new Date(confirmed[0].snapshot_confirmed_at).getTime())
      .toBe(new Date(apps[0].snapshot_confirmed_at).getTime());

    // A version past Draft is no longer editable here.
    expect((await auth(request.put(line(m, after.id))).send({ quantity: 3 })).status).toBe(404);
    expect((await auth(request.delete(line(m, after.id)))).status).toBe(404);
  });

  it('refuses a Promotion that is not an offer for the line\'s Product', async () => {
    const m = await member();
    const towel = await product({ name: 'Towel N', frequency: 'month', amount: '20.00', type: 'service' });
    const other = await promotion({ name: 'Elsewhere' });
    const add = await auth(request.post(base(m))).send({ product_id: towel });
    const [l] = await openLines(add.body.product_set_id);
    const res = await auth(request.put(line(m, l.id))).send({ promotion_ids: [other] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('promotion_not_applicable');
  });

  it('hard-deletes a line the Draft added, leaving the other lines alone', async () => {
    const m = await member();
    const towel = await product({ name: 'Towel D', frequency: 'month', amount: '5.00', type: 'service' });
    const locker = await product({ name: 'Locker D', frequency: 'month', amount: '9.00', type: 'service' });
    const promo = await promotion({ name: 'Locker half' });
    await grant(promo, locker, 'periodical');
    await auth(request.post(base(m))).send({ product_id: towel });
    const add = await auth(request.post(base(m))).send({ product_id: locker, promotion_ids: [promo] });
    const draftId = add.body.product_set_id as number;
    const lockerLine = (await openLines(draftId)).find((x) => Number(x.product_id) === locker)!;

    const del = await auth(request.delete(line(m, lockerLine.id)));
    expect(del.status).toBe(200);
    const { rows } = await db.query<any>('SELECT COUNT(*) AS n FROM product_periodical_snapshots WHERE source_id = ?', [lockerLine.id]);
    expect(Number(rows[0].n)).toBe(0);
    expect(await applications(draftId)).toHaveLength(0);
    expect((await openLines(draftId)).map((x) => Number(x.product_id))).toEqual([towel]);
    expect((await listed(m)).some((i) => i.product_id === locker)).toBe(false);
    expect(await setsOf(m)).toBe(1);
  });

  it('edits and deletes a line carried over from the Active version without touching the Active version', async () => {
    const m = await member();
    const towel = await product({ name: 'Towel A', frequency: 'month', amount: '5.00', type: 'service' });
    const buy = await auth(request.post(base(m))).send({ product_id: towel });
    const activeId = buy.body.product_set_id as number;
    const sp = await auth(request.post(`${mset(activeId)}/save-and-pay`)).send({});
    expect((await pay(sp.body.payment_request_id)).status).toBe(200);
    // No open Draft: the Active line offers nothing to edit.
    const before = (await listed(m)).find((i) => i.product_id === towel);
    expect(before).toMatchObject({ status: 'active', draft_line_id: null });
    expect((await auth(request.put(line(m, -before.id))).send({ quantity: 2 })).status).toBe(404);

    const d = await auth(request.post('/product-sets/draft')).send({ member_id: m });
    const draftId = d.body.id as number;
    const carried = (await listed(m)).find((i) => i.product_id === towel);
    expect(carried.draft_line_id).not.toBeNull();

    expect((await auth(request.put(line(m, carried.draft_line_id))).send({ quantity: 3 })).status).toBe(200);
    expect(Number((await openLines(activeId))[0].quantity)).toBe(1);
    expect(Number((await openLines(draftId))[0].quantity)).toBe(3);

    const editedId = (await openLines(draftId))[0].id;
    expect((await auth(request.delete(line(m, editedId)))).status).toBe(200);
    expect(await openLines(draftId)).toHaveLength(0);
    expect(await openLines(activeId)).toHaveLength(1);
    const pending = (await listed(m)).find((i) => i.product_id === towel);
    // #3007 stage 6: a line running on the Active version is ended on the Draft's own copy (it stays
    // listed, carried by the Draft), never deleted from it; the Active version keeps billing it.
    expect(pending).toMatchObject({ status: 'active', });
    expect(pending.draft_line_id).not.toBeNull();
    expect(await setsOf(m)).toBe(2);
  });

  it('keeps each version\'s Promotions apart on a line the two share (#3026 stage 3d-3b)', async () => {
    const m = await member();
    const towel = await product({ name: 'Towel S', frequency: 'month', amount: '20.00', type: 'service' });
    const half = await promotion({ name: 'Half S' });
    await grant(half, towel, 'periodical', 'percentage_discount', 50);
    const buy = await auth(request.post(base(m))).send({ product_id: towel, promotion_ids: [half] });
    expect(buy.status).toBe(201);
    const activeId = buy.body.product_set_id as number;
    const sp = await auth(request.post(`${mset(activeId)}/save-and-pay`)).send({});
    expect((await pay(sp.body.payment_request_id)).status).toBe(200);

    const d = await auth(request.post('/product-sets/draft')).send({ member_id: m });
    const draftId = d.body.id as number;
    // The Draft links the Active line (one line), and holds its own copy of the line's application.
    const [shared] = await openLines(draftId);
    expect(shared.id).toBe((await openLines(activeId))[0].id);
    const owners = async () => (await db.query<any>(
      `SELECT pp.product_set_id, pp.source_application_id FROM product_promotion_snapshots pp
         JOIN product_periodical_snapshots par ON par.id = pp.product_periodical_snapshot_id
        WHERE par.source_id = ? ORDER BY pp.product_set_id`, [shared.id])).rows
      .map((r: any) => Number(r.product_set_id));
    expect(await owners()).toEqual([activeId, draftId].sort((x, y) => x - y));
    const towelRow = async () => (await listed(m)).find((i) => i.product_id === towel);
    expect((await towelRow()).promotions.map((p: any) => p.promotion_id)).toEqual([half]);

    // Removing the Promotion on the Draft leaves the Active version's application (and the shared line) alone.
    const { rows: draftApps } = await db.query<any>(
      'SELECT id FROM user_membership_promotions WHERE product_set_id = ? AND promotion_id = ?', [draftId, half]);
    expect(draftApps).toHaveLength(1);
    const del = await auth(request.delete(`${mset(draftId)}/promotions/${draftApps[0].id}`));
    expect(del.status).toBeLessThan(300);
    expect((await openLines(draftId))[0].id).toBe(shared.id);
    expect(await owners()).toEqual([activeId]);
    expect((await towelRow()).promotions).toEqual([]);
  });

  it('refuses another gym (404) and an unauthenticated call (401)', async () => {
    const m = await member();
    const towel = await product({ name: 'Towel T', frequency: 'month', amount: '5.00', type: 'service' });
    const add = await auth(request.post(base(m))).send({ product_id: towel });
    const [l] = await openLines(add.body.product_set_id);
    expect((await request.put(line(m, l.id)).send({ quantity: 2 })).status).toBe(401);
    const other = await createTestGym('Draft Line Edit Other Gym');
    await createTestMembership(other, 'admin');
    const res = await request.delete(line(m, l.id)).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', other);
    expect(res.status).toBe(404);
    expect(await openLines(add.body.product_set_id)).toHaveLength(1);
  });
});
