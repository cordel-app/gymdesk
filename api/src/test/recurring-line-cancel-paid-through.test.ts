// #3508 — cancelling a recurring Product keeps it through the period already paid for, whatever
// that period is: a prorated first stretch paid by the initial payment (the defect: the line ended
// on the cancellation day), a whole period, several paid in advance, a 4-weekly or yearly cadence;
// with nothing paid it ends today. The confirmation's preview names the very date the removal saves.
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

import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';

const SECRET = 'test-3508-webhook';
let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const TODAY = new Date().toISOString().slice(0, 10);
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Paid Through Member', `pc-${uniq()}@test.com`]);
  return insertId;
}

async function product(name: string, frequency: string, amount: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO products
       (gym_id, name, type, billing_frequency, status, enrollment_status, is_system, currency, amount, tax_behavior)
     VALUES (?, ?, 'service', ?, 'active', 'public', 0, 'EUR', ?, 'inclusive')`,
    [gymId, `${name} ${uniq()}`, frequency, amount]);
  return insertId;
}

async function plan(price: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', NULL, NULL, 0, 0)`, [gymId, `PC-Plan-${uniq()}`]);
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status) VALUES (?, ?, ?, '2025-01-01', 'active')`,
    [gymId, insertId, price]);
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
  const res = await webhook({
    id: `evt_${id}`, type: 'charge.succeeded', objectId: id, objectType: 'charge',
    object: { id, orderId: rows[0].provider_order, status: 'SUCCEEDED' },
  });
  expect(res.status).toBe(200);
}

async function saveAndPay(setId: number) {
  const sp = await auth(request.post(`/product-sets/${setId}/save-and-pay`)).send({});
  expect(sp.status).toBe(201);
  await pay(sp.body.payment_request_id);
}

/** A set's recurring lines (its links), running or ended. */
const linesOf = async (setId: number) => (await db.query<any>(
  `SELECT s.id AS snapshot_id, s.source_id, s.product_id, s.ends_at FROM product_set_periodical_snapshots lnk
     JOIN product_periodical_snapshots s ON s.id = lnk.product_periodical_snapshot_id
    WHERE lnk.product_set_id = ? ORDER BY s.id`, [setId])).rows;
const setStatus = async (setId: number) => (await db.query<any>(
  'SELECT status FROM product_sets WHERE id = ?', [setId])).rows[0]?.status ?? null;
async function openDraft(m: number): Promise<number> {
  const d = await auth(request.post('/product-sets/draft')).send({ member_id: m });
  expect([200, 201]).toContain(d.status);
  return d.body.id as number;
}

const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10);
};
/** The last day of the month `offset` months after today's (UTC). */
const monthEnd = (offset = 0) => {
  const t = new Date(`${TODAY}T00:00:00Z`);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1 + offset, 0)).toISOString().slice(0, 10);
};
/** The day before the next date of the 28-day grid (from Monday 2026-11-02, #2125 M5c). */
const fourWeekPeriodEnd = () => {
  const days = Math.round((Date.parse(`${TODAY}T00:00:00Z`) - Date.parse('2026-11-02T00:00:00Z')) / 86_400_000);
  const mod = ((days % 28) + 28) % 28;
  return addDays(TODAY, 28 - mod - 1);
};
const yearEnd = () => {
  const t = new Date(`${TODAY}T00:00:00Z`);
  return addDays(new Date(Date.UTC(t.getUTCFullYear() + 1, t.getUTCMonth(), t.getUTCDate())).toISOString().slice(0, 10), -1);
};

/** An Active set holding one recurring line of `frequency` (beside a plan, when asked), paid today. */
async function activeWithLine(frequency: string, withPlan: boolean) {
  const m = await member();
  const towel = await product('Towel', frequency, '12.00');
  if (withPlan) {
    const created = await auth(request.post('/product-sets')).send({ member_id: m, membership_plan_id: await plan(40), starts_at: TODAY });
    expect(created.status).toBe(201);
    await saveAndPay(created.body.id);
  }
  const add = await auth(request.post(`/members/${m}/product-purchases`)).send({ product_id: towel });
  expect(add.status).toBe(201);
  const setId = add.body.product_set_id as number;
  await saveAndPay(setId);
  expect(await setStatus(setId)).toBe('active');
  const [line] = await linesOf(setId);
  return { m, towel, activeId: setId, line };
}

/** The preview, then the removal from the member's Draft: both answer the same end date. */
async function cancel(m: number, sourceId: number): Promise<string> {
  const preview = await auth(request.get(`/members/${m}/product-purchases/recurring/${sourceId}/cancellation-preview`));
  expect(preview.status).toBe(200);
  const draftId = await openDraft(m);
  const del = await auth(request.delete(`/product-sets/${draftId}/services/${sourceId}`));
  expect(del.status).toBe(200);
  expect(del.body.ends_at).toBe(preview.body.ends_on);
  return del.body.ends_at as string;
}

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = SECRET;
  gymId = await createTestGym('Recurring Paid Through Gym');
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

describe.each([
  // Beside a plan, the line joins the plan's schedule; the plan's own initial event then holds a
  // prorated stretch too, which ends after its prorated days, never one cadence later.
  ['standalone', false],
  ['beside a Membership Plan', true],
])('a monthly recurring Product %s, paid by its initial payment', (_label, withPlan) => {
  it('ends on the last day of the period that payment covered, never on the cancellation day', async () => {
    const { m, line } = await activeWithLine('month', withPlan);
    // The first stretch (prorated to the 1st unless today is the 1st) runs to the month's end.
    expect(await cancel(m, Number(line.source_id))).toBe(monthEnd(0));
  });
});

describe('the paid-through period', () => {
  it('includes a later period already paid in advance', async () => {
    const { m, towel, line } = await activeWithLine('month', false);
    const { rows } = await db.query<any>(
      `SELECT be.id, be.amount FROM billing_events be JOIN billing_event_lines l ON l.billing_event_id = be.id
        WHERE be.member_id = ? AND be.is_scheduled = 1 AND l.product_id = ? ORDER BY be.billing_date LIMIT 1`,
      [m, towel]);
    expect(rows[0]).toBeDefined();
    await db.query(
      `INSERT INTO payment_requests
         (gym_id, member_id, amount, currency, billing_event_id, status, provider, provider_order, source, method, created_at)
       VALUES (?, ?, ?, 'EUR', ?, 'completed', 'monei', UUID(), 'billing_run', 'cash', UTC_TIMESTAMP())`,
      [gymId, m, rows[0].amount, rows[0].id]);
    expect(await cancel(m, Number(line.source_id))).toBe(monthEnd(1));
  });

  it('is the period boundary of a 4-weekly Product', async () => {
    const { m, line } = await activeWithLine('four_weeks', false);
    expect(await cancel(m, Number(line.source_id))).toBe(fourWeekPeriodEnd());
  });

  it('is the period boundary of a yearly Product', async () => {
    const { m, line } = await activeWithLine('year', false);
    expect(await cancel(m, Number(line.source_id))).toBe(yearEnd());
  });

  it('with nothing paid, the line ends on the cancellation day', async () => {
    const { m, activeId, line } = await activeWithLine('month', false);
    // The initial payment did not settle after all: no paid period is left.
    await db.query(
      `UPDATE payment_requests pr JOIN billing_events be ON be.id = pr.billing_event_id
          SET pr.status = 'failed'
        WHERE be.product_set_id = ? AND pr.status = 'completed'`, [activeId]);
    expect(await cancel(m, Number(line.source_id))).toBe(TODAY);
  });

  it('cancelling writes no charge and no refund', async () => {
    const { m, line } = await activeWithLine('month', false);
    const count = async () => Number((await db.query<any>(
      'SELECT COUNT(*) AS n FROM payment_requests WHERE member_id = ?', [m])).rows[0].n);
    const before = await count();
    await cancel(m, Number(line.source_id));
    expect(await count()).toBe(before);
  });
});

describe('GET /members/:id/product-purchases/recurring/:lineId/cancellation-preview', () => {
  it("is 404 for another member's line", async () => {
    const { line } = await activeWithLine('month', false);
    const other = await member();
    const res = await auth(request.get(`/members/${other}/product-purchases/recurring/${line.source_id}/cancellation-preview`));
    expect(res.status).toBe(404);
  });
});
