// #1537 — the recurring-configuration Draft is created on first use, edited as
// one Draft, reviewed against the Active version and committed only by the
// existing Save & Pay. Integration against real MySQL; only the provider's
// `createPaymentRequest` is stubbed.

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

import { advanceBillingDate } from '../domain/billingDate';
import { daysBetween } from '../domain/proration';
import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER, proratedToNextFirst } from './helpers';
import { TEST_RECURRING_LINES } from './productSnapshotReads';

const SECRET = 'test-1537-webhook';
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
  gymId = await createTestGym('Recurring Draft Gym');
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

describe('automatic Draft creation (#1537)', () => {
  it('creates the first Draft for a member with no configuration, and returns the same one afterwards', async () => {
    const m = await member();
    const a = await auth(request.post('/product-sets/draft')).send({ member_id: m });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ status: 'draft', created: true, membership_plan_id: null });
    const b = await auth(request.post('/product-sets/draft')).send({ member_id: m });
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.created).toBe(false);
    const { rows } = await db.query<any>('SELECT COUNT(*) AS n FROM product_sets WHERE owner_member_id = ?', [m]);
    expect(Number(rows[0].n)).toBe(1);
  });

  it('clones the Active configuration and leaves it untouched; every edit lands on the same Draft', async () => {
    const m = await member();
    const activeId = await activePlan(m);
    const towel = await product({ name: 'Towel', frequency: 'month', amount: '5.00', type: 'service' });
    const locker = await product({ name: 'Locker', frequency: 'month', amount: '12.00', type: 'service' });

    const d = await auth(request.post('/product-sets/draft')).send({ member_id: m });
    expect(d.status).toBe(201);
    expect(d.body.previous_product_set_id).toBe(activeId);
    const draftId = d.body.id as number;

    const add1 = await auth(request.post(base(m))).send({ product_id: towel });
    const add2 = await auth(request.post(base(m))).send({ product_id: locker });
    expect(add1.body.product_set_id).toBe(draftId);
    expect(add2.body.product_set_id).toBe(draftId);

    const lines = await openLines(draftId);
    expect(lines).toHaveLength(2);
    expect((await auth(request.put(`${mset(draftId)}/services/${lines[0].id}`)).send({ quantity: 3 })).status).toBe(200);
    expect(Number((await openLines(draftId))[0].quantity)).toBe(3);
    expect((await auth(request.put(`${mset(draftId)}/services/${lines[0].id}`)).send({ quantity: 0 })).status).toBe(400);
    expect((await auth(request.delete(`${mset(draftId)}/services/${lines[1].id}`))).status).toBe(200);
    expect(await openLines(draftId)).toHaveLength(1);

    // The Active version never moved and exactly one Draft exists.
    expect((await auth(request.get(mset(activeId)))).body.status).toBe('active');
    expect(await openLines(activeId)).toHaveLength(0);
    const { rows } = await db.query<any>(
      `SELECT COUNT(*) AS n FROM product_sets WHERE owner_member_id = ? AND status = 'draft'`, [m]);
    expect(Number(rows[0].n)).toBe(1);
  });

  it('refuses another gym (404) and an unauthenticated call (401)', async () => {
    const m = await member();
    expect((await request.post('/product-sets/draft').send({ member_id: m })).status).toBe(401);
    const other = await createTestGym('Recurring Draft Other Gym');
    await createTestMembership(other, 'admin');
    const res = await request.post('/product-sets/draft')
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', other).send({ member_id: m });
    expect(res.status).toBe(404);
    const noId = await auth(request.post('/product-sets/draft')).send({});
    expect(noId.status).toBe(400);
  });

  it('refuses to edit the quantity of a line of another set or of a committed version', async () => {
    const m = await member();
    const activeId = await activePlan(m);
    const towel = await product({ name: 'Towel Q', frequency: 'month', amount: '5.00', type: 'service' });
    const d = await auth(request.post(base(m))).send({ product_id: towel });
    const draftId = d.body.product_set_id as number;
    const [line] = await openLines(draftId);
    expect((await auth(request.put(`${mset(activeId)}/services/${line.id}`)).send({ quantity: 2 })).status).toBe(409);
    expect((await auth(request.put(`${mset(draftId)}/services/999999999`)).send({ quantity: 2 })).status).toBe(404);
  });
});

describe('Review your changes (#1537)', () => {
  it('lists the real differences and the amount Save & Pay will charge', async () => {
    const m = await member();
    await activePlan(m);
    const towel = await product({ name: 'Towel R', frequency: 'month', amount: '5.00', type: 'service' });
    const buy = await auth(request.post(base(m))).send({ product_id: towel });
    const draftId = buy.body.product_set_id as number;
    const [line] = await openLines(draftId);
    await auth(request.put(`${mset(draftId)}/services/${line.id}`)).send({ quantity: 2 });

    const review = await auth(request.get(`${mset(draftId)}/review`));
    expect(review.status).toBe(200);
    expect(review.body.error).toBeNull();
    expect(review.body.changes).toEqual([
      expect.objectContaining({ kind: 'added', line: expect.objectContaining({ productId: towel, quantity: 2 }) }),
    ]);
    expect(review.body.amount_due).toBe(proratedToNextFirst(10));
    expect(review.body.payment_required).toBe(true);
    // #2446 stage 3 — the new line's per-period price is the engine's, and the
    // Summary's amount payable is the amount Save & Pay charges.
    const towelItem = review.body.summary_items.find((i: any) => i.name === 'Towel R');
    expect(towelItem).toEqual(expect.objectContaining({ state: 'draft', final_price: 10 }));
    expect(review.body.financial_summary.amount_payable).toBe(review.body.amount_due);
    expect(review.body.financial_summary.recurring).toEqual(expect.arrayContaining([
      expect.objectContaining({ billing_frequency: 'month', new: 10 }),
    ]));

    const eventsBefore = await db.query<any>('SELECT COUNT(*) AS n FROM billing_events WHERE gym_id = ? AND product_set_id = ?', [gymId, draftId]);
    expect(Number(eventsBefore.rows[0].n)).toBe(0); // reading it wrote nothing

    const sp = await auth(request.post(`${mset(draftId)}/save-and-pay`)).send({});
    expect(sp.status).toBe(201);
    expect(sp.body.amount).toBe(review.body.amount_due);
  });

  it('a Draft that removes a line and adds nothing owed activates without payment', async () => {
    const m = await member();
    const towel = await product({ name: 'Towel Z', frequency: 'month', amount: '5.00', type: 'service' });
    const buy = await auth(request.post(base(m))).send({ product_id: towel });
    const first = buy.body.product_set_id as number;
    const sp = await auth(request.post(`${mset(first)}/save-and-pay`)).send({});
    expect((await pay(sp.body.payment_request_id)).status).toBe(200);

    const d = await auth(request.post('/product-sets/draft')).send({ member_id: m });
    const draftId = d.body.id as number;
    const [line] = await openLines(draftId);
    expect((await auth(request.delete(`${mset(draftId)}/services/${line.id}`))).status).toBe(200);

    const review = await auth(request.get(`${mset(draftId)}/review`));
    expect(review.body.changes).toEqual([expect.objectContaining({ kind: 'removed' })]);
    expect(review.body.amount_due).toBe(0);
    expect(review.body.payment_required).toBe(false);

    expect((await auth(request.post(`${mset(draftId)}/save-and-pay`)).send({})).body.error).toBe('nothing_to_pay');
    const act = await auth(request.post(`${mset(draftId)}/activate`)).send({});
    expect(act.status).toBe(200);
    expect((await auth(request.get(mset(first)))).body.status).toBe('superseded');
    expect((await auth(request.get(mset(draftId)))).body.status).toBe('active');
  });

  it('a new version links the active lines; only the line an edit changes is copied (#2126 stage 5c-2c-2)', async () => {
    const m = await member();
    const towel = await product({ name: 'Towel L', frequency: 'month', amount: '5.00', type: 'service' });
    const locker = await product({ name: 'Locker L', frequency: 'month', amount: '12.00', type: 'service' });
    const first = (await auth(request.post(base(m))).send({ product_id: towel })).body.product_set_id as number;
    await auth(request.post(base(m))).send({ product_id: locker });
    const sp = await auth(request.post(`${mset(first)}/save-and-pay`)).send({});
    expect((await pay(sp.body.payment_request_id)).status).toBe(200);
    const activeLines = await openLines(first);
    expect(activeLines).toHaveLength(2);

    // The Draft holds the very same lines (same ids), and an unchanged Draft owes nothing.
    const draftId = (await auth(request.post('/product-sets/draft')).send({ member_id: m })).body.id as number;
    expect((await openLines(draftId)).map((l: any) => l.id)).toEqual(activeLines.map((l: any) => l.id));
    const untouched = await auth(request.get(`${mset(draftId)}/review`));
    expect(untouched.body.changes).toEqual([]);

    // Changing one line copies that line for the Draft; the other stays shared, the active set is untouched.
    expect((await auth(request.put(`${mset(draftId)}/services/${activeLines[0].id}`)).send({ quantity: 2 })).status).toBe(200);
    const draftLines = await openLines(draftId);
    expect(draftLines).toHaveLength(2);
    const changed = draftLines.find((l: any) => Number(l.product_id) === Number(activeLines[0].product_id));
    const kept = draftLines.find((l: any) => Number(l.product_id) === Number(activeLines[1].product_id));
    expect(changed.id).not.toBe(activeLines[0].id);
    expect(Number(changed.quantity)).toBe(2);
    expect(kept.id).toBe(activeLines[1].id);
    expect((await openLines(first)).map((l: any) => [l.id, Number(l.quantity)]))
      .toEqual(activeLines.map((l: any) => [l.id, Number(l.quantity)]));
    const review = await auth(request.get(`${mset(draftId)}/review`));
    expect(review.body.changes).toHaveLength(1);
  });

  it('is not available for an active version, and not across tenants', async () => {
    const m = await member();
    const activeId = await activePlan(m);
    expect((await auth(request.get(`${mset(activeId)}/review`))).status).toBe(409);
    const other = await createTestGym('Recurring Draft Review Other');
    await createTestMembership(other, 'admin');
    const res = await request.get(`${mset(activeId)}/review`).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', other);
    expect(res.status).toBe(404);
  });
});

describe('cancellation and payment lifecycle (#1537)', () => {
  it('cancelling the Draft restores the Active configuration, or the empty state', async () => {
    const m = await member();
    const activeId = await activePlan(m);
    const towel = await product({ name: 'Towel C', frequency: 'month', amount: '5.00', type: 'service' });
    const buy = await auth(request.post(base(m))).send({ product_id: towel });
    const draftId = buy.body.product_set_id as number;
    expect((await auth(request.delete(mset(draftId)))).status).toBe(204);
    expect((await auth(request.get(mset(draftId)))).status).toBe(404);
    expect((await auth(request.get(mset(activeId)))).body.status).toBe('active');

    // A member who never had a configuration returns to the empty state.
    const empty = await member();
    const d = await auth(request.post('/product-sets/draft')).send({ member_id: empty });
    expect((await auth(request.delete(mset(d.body.id)))).status).toBe(204);
    const list = await auth(request.get('/product-sets')).query({ member_id: empty });
    expect(list.body).toEqual([]);
  });

  it('an uncertain payment keeps the version pending: no second Draft, no new charge, no activation', async () => {
    const m = await member();
    const activeId = await activePlan(m);
    const towel = await product({ name: 'Towel P', frequency: 'month', amount: '5.00', type: 'service' });
    const buy = await auth(request.post(base(m))).send({ product_id: towel });
    const draftId = buy.body.product_set_id as number;
    const sp = await auth(request.post(`${mset(draftId)}/save-and-pay`)).send({});
    expect(sp.status).toBe(201);

    // The Draft is now pending: it is not activated, the Active one is intact…
    expect((await auth(request.get(mset(draftId)))).body.status).toBe('pending_payment');
    expect((await auth(request.get(mset(activeId)))).body.status).toBe('active');
    // …a further edit or "ensure draft" answers in_flight, never a second Draft…
    const again = await auth(request.post('/product-sets/draft')).send({ member_id: m });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: 'in_flight', product_set_id: draftId, status: 'pending_payment' });
    const edit = await auth(request.put(`${mset(draftId)}/services/1`)).send({ quantity: 2 });
    expect(edit.status).toBe(409);
    // …and a repeated Save & Pay reuses the same payment request.
    const retry = await auth(request.post(`${mset(draftId)}/save-and-pay`)).send({});
    expect(retry.status).toBe(201);
    expect(retry.body.billing_event_id).toBe(sp.body.billing_event_id);
    const { rows } = await db.query<any>('SELECT COUNT(*) AS n FROM billing_events WHERE gym_id = ? AND product_set_id = ? AND event_type = ?', [gymId, draftId, 'payment_recorded']);
    expect(Number(rows[0].n)).toBe(1);
  });

  it('a successful payment activates the Draft and moves the previous version to superseded', async () => {
    const m = await member();
    const activeId = await activePlan(m);
    const towel = await product({ name: 'Towel S', frequency: 'month', amount: '5.00', type: 'service' });
    const buy = await auth(request.post(base(m))).send({ product_id: towel });
    const draftId = buy.body.product_set_id as number;
    const sp = await auth(request.post(`${mset(draftId)}/save-and-pay`)).send({});
    expect((await pay(sp.body.payment_request_id)).status).toBe(200);
    expect((await auth(request.get(mset(draftId)))).body.status).toBe('active');
    expect((await auth(request.get(mset(activeId)))).body.status).toBe('superseded');
  });
});

describe('a recurring Product added mid-cycle (#1867 stage 4)', () => {
  it('is charged a prorated first stretch up to the plan schedule, shown in the simulation', async () => {
    const m = await member();
    const anchor = day(-10);
    await activePlan(m, 40, anchor);
    // The plan schedule is anchored on the billing calendar (#2125 M5c): monthly bills on the 1st,
    // so the next schedule date after today is the 1st of next month, whatever the plan's start.
    const next = advanceBillingDate(`${TODAY.slice(0, 8)}01`, 1, 'month');
    const days = Math.min(daysBetween(TODAY, next), 31);
    if (TODAY.endsWith('-01')) return; // a line starting on a schedule date is not prorated
    const trainer = await product({ name: 'Trainer Pro', frequency: 'month', amount: '31.00', type: 'service' });
    const buy = await auth(request.post(base(m))).send({ product_id: trainer });
    const draftId = buy.body.product_set_id as number;

    const review = await auth(request.get(`${mset(draftId)}/review`));
    expect(review.status).toBe(200);
    expect(Number(review.body.amount_due)).toBe(days);

    const sim = await auth(request.get(`${mset(draftId)}/billing-event-simulation`));
    expect(sim.status).toBe(200);
    const initial = sim.body.dates.find((d: any) => d.kind === 'initial_payment');
    const line = initial.lines.find((l: any) => l.label === 'Trainer Pro');
    expect(line.proration).toEqual({ prorated_days: days, period_days: 31 });
    expect(line.actual_charge).toBe(days);
    expect(line.regular_price).toBe(31);
    // Aligned to the plan: the next charge is on the schedule date, at full price.
    const aligned = sim.body.dates.find((d: any) => d.date === next);
    expect(aligned.lines.find((l: any) => l.label === 'Trainer Pro').actual_charge).toBe(31);
  });
});

// #2126 stage 3s — the Draft line writers lock the legacy line and decide from
// its synced `product_periodical_snapshots` row.
describe('Draft line writers read the Product snapshot (#2126 stage 3s)', () => {
  it('changes the quantity and removes a line, deciding from the snapshot', async () => {
    const m = await member();
    await activePlan(m);
    const towel = await product({ name: 'Towel S', frequency: 'month', amount: '5.00', type: 'service' });
    const d = await auth(request.post(base(m))).send({ product_id: towel });
    const draftId = d.body.product_set_id as number;
    const [line] = await openLines(draftId);

    expect((await auth(request.put(`${mset(draftId)}/services/${line.id}`)).send({ quantity: 3 })).status).toBe(200);
    const { rows: snap } = await db.query<any>(
      'SELECT quantity FROM product_periodical_snapshots WHERE source_id = ?', [line.id]);
    expect(Number(snap[0].quantity)).toBe(3);

    expect((await auth(request.delete(`${mset(draftId)}/services/${line.id}`))).status).toBe(200);
    expect(await openLines(draftId)).toHaveLength(0);
    const { rows: gone } = await db.query<any>(
      'SELECT id FROM product_periodical_snapshots WHERE source_id = ?', [line.id]);
    expect(gone).toHaveLength(0);
  });

  it('answers 404 for a line whose snapshot says it has ended, leaving the legacy line alone', async () => {
    const m = await member();
    await activePlan(m);
    const towel = await product({ name: 'Towel T', frequency: 'month', amount: '5.00', type: 'service' });
    const d = await auth(request.post(base(m))).send({ product_id: towel });
    const draftId = d.body.product_set_id as number;
    const [line] = await openLines(draftId);
    await db.query('UPDATE product_periodical_snapshots SET ends_at = ? WHERE source_id = ?', [TODAY, line.id]);

    expect((await auth(request.put(`${mset(draftId)}/services/${line.id}`)).send({ quantity: 2 })).status).toBe(404);
    const { rows } = await db.query<any>(`SELECT quantity FROM ${TEST_RECURRING_LINES} AS legacy WHERE id = ?`, [line.id]);
    expect(Number(rows[0].quantity)).toBe(1);
  });

  it('refuses to remove a line its snapshot says was already removed', async () => {
    const m = await member();
    await activePlan(m);
    const towel = await product({ name: 'Towel U', frequency: 'month', amount: '5.00', type: 'service' });
    const d = await auth(request.post(base(m))).send({ product_id: towel });
    const draftId = d.body.product_set_id as number;
    const [line] = await openLines(draftId);
    await db.query('UPDATE product_periodical_snapshots SET ends_at = ? WHERE source_id = ?', [TODAY, line.id]);

    expect((await auth(request.delete(`${mset(draftId)}/services/${line.id}`))).status).toBe(409);
    // The line was not deleted, and keeps the end its snapshot already had.
    const { rows: kept } = await db.query<any>(
      `SELECT DATE_FORMAT(ends_at, '%Y-%m-%d') AS ends_at FROM ${TEST_RECURRING_LINES} AS legacy WHERE id = ?`, [line.id]);
    expect(kept).toHaveLength(1);
    expect(kept[0].ends_at).toBe(TODAY);
  });
});

// #2126 stage 3t — schedule allocation reads a version's recurring lines from
// `product_periodical_snapshots` (synced first) and writes the legacy line.
describe('Schedule allocation reads the Product snapshot (#2126 stage 3t)', () => {
  it('gives a newly added recurring line a schedule on its snapshot', async () => {
    const m = await member();
    await activePlan(m);
    const locker = await product({ name: 'Locker Y', frequency: 'year', amount: '60.00', type: 'service' });
    const d = await auth(request.post(base(m))).send({ product_id: locker });
    expect(d.status).toBeLessThan(300);
    const draftId = d.body.product_set_id as number;
    const [line] = await openLines(draftId);

    const { rows: legacy } = await db.query<any>(
      `SELECT schedule_id FROM ${TEST_RECURRING_LINES} AS legacy WHERE id = ?`, [line.id]);
    const { rows: snap } = await db.query<any>(
      'SELECT schedule_id FROM product_periodical_snapshots WHERE source_id = ?', [line.id]);
    expect(legacy[0].schedule_id).not.toBeNull();
    expect(Number(snap[0].schedule_id)).toBe(Number(legacy[0].schedule_id));
    const { rows: sched } = await db.query<any>(
      'SELECT cadence_unit FROM product_set_schedules WHERE id = ?', [legacy[0].schedule_id]);
    expect(sched[0].cadence_unit).toBe('year');
  });
});
