import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';

vi.mock('../payments', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../payments')>();
  return {
    ...mod,
    getPaymentProvider: () => {
      let real: object = {};
      try { real = mod.getPaymentProvider(); } catch { /* none configured */ }
      return Object.assign(Object.create(real), {
        createPaymentRequest: async (p: { orderId: string }) => ({
          providerOrderId: `monei-${p.orderId}`, checkoutUrl: 'https://pay.test/x',
        }),
      });
    },
  };
});

import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';

const SECRET = 'test-bridge-webhook';
let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const day = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const TODAY = day(0);
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Bridge Member', `br-${uniq()}@test.com`]);
  return insertId;
}
async function plan(price: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit, free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', NULL, NULL, 0, 0)`, [gymId, `Br-Plan-${uniq()}`]);
  await db.query(`INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status) VALUES (?, ?, ?, ?, 'active')`,
    [gymId, insertId, price, day(-365)]);
  await db.query(`INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit) VALUES (?, ?, 1, 'month')`,
    [gymId, insertId]);
  return insertId;
}
async function assign(memberId: number, planId: number): Promise<number> {
  const res = await auth(request.post('/user-memberships')).send({ member_id: memberId, membership_plan_id: planId, starts_at: TODAY });
  expect(res.status).toBe(201);
  return res.body.id as number;
}
async function setsOf(memberId: number) {
  const { rows } = await db.query<any>(
    'SELECT id, version, status, user_membership_id FROM product_sets WHERE owner_member_id = ? ORDER BY version', [memberId]);
  return rows;
}
async function um(id: number) {
  const { rows } = await db.query<any>('SELECT status, next_billing_date, personal_fee_benefit_value FROM user_memberships WHERE id = ?', [id]);
  return rows[0];
}
async function scheduled(setId: number) {
  const { rows } = await db.query<any>(
    'SELECT id, billing_date FROM billing_events WHERE product_set_id = ? AND is_scheduled = 1 ORDER BY billing_date', [setId]);
  return rows.map((r: any) => ({
    ...r, billing_date: (r.billing_date instanceof Date ? r.billing_date.toISOString() : String(r.billing_date)).slice(0, 10),
  }));
}

beforeAll(async () => {
  process.env.PRODUCT_SET_BILLING = 'true';
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = SECRET;
  gymId = await createTestGym('Bridge gym');
  await createTestMembership(gymId, 'admin');
});
afterAll(async () => {
  delete process.env.PRODUCT_SET_BILLING;
  delete process.env.MONEI_API_KEY;
  delete process.env.MONEI_WEBHOOK_SECRET;
  await db.query('DELETE FROM payment_requests WHERE gym_id = ?', [gymId]);
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('a committed assignment becomes a ProductSet version (#1325 PR 5)', () => {
  it('imports on commit: set linked, events persisted, off the assignment pass', async () => {
    const memberId = await member();
    const umId = await assign(memberId, await plan(30));
    await auth(request.post(`/user-memberships/${umId}/save-and-pay`)).send({});
    const cash = await auth(request.post(`/user-memberships/${umId}/record-payment`)).send({});
    expect(cash.status).toBe(200);

    const sets = await setsOf(memberId);
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ version: 1, status: 'active' });
    expect(Number(sets[0].user_membership_id)).toBe(umId);
    expect((await um(umId)).next_billing_date).toBeNull();
    expect((await scheduled(sets[0].id)).length).toBeGreaterThan(0);

    // The cash payment covers the first period: it is that period's event and
    // the period is not generated a second time.
    const { rows: ev } = await db.query<any>(
      `SELECT event_type, period_start, is_scheduled FROM billing_events WHERE product_set_id = ? ORDER BY billing_date, id`, [sets[0].id]);
    const firstPeriod = ev.filter((e: any) => (e.period_start instanceof Date ? e.period_start.toISOString() : String(e.period_start)).slice(0, 10) === TODAY);
    expect(firstPeriod).toHaveLength(1);
    expect(firstPeriod[0].event_type).toBe('payment_recorded');
  });

  it('an assignment that owes nothing (a free plan) imports too, with nothing to generate', async () => {
    const memberId = await member();
    const umId = await assign(memberId, await plan(0));
    expect((await auth(request.post(`/user-memberships/${umId}/activate`)).send({})).status).toBe(200);
    const sets = await setsOf(memberId);
    expect(sets).toHaveLength(1);
    expect(Number(sets[0].user_membership_id)).toBe(umId);
  });

  it('a paid plan: the first payment is linked to the first period and never generated twice', async () => {
    const memberId = await member();
    const planId = await plan(40);
    const umId = await assign(memberId, planId);
    const pay = await auth(request.post(`/user-memberships/${umId}/save-and-pay`)).send({});
    expect(pay.status).toBeLessThan(300);

    const { rows: pr } = await db.query<any>(
      'SELECT provider_order FROM payment_requests WHERE user_membership_id = ? ORDER BY id DESC LIMIT 1', [umId]);
    let order = pr[0]?.provider_order as string | undefined;
    if (!order) {
      // Save & Pay of the assignment flow does not raise the request itself: Pay now does.
      const { rows: ct } = await db.query<any>("SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1");
      order = crypto.randomUUID();
      await db.query(
        `INSERT INTO payment_requests (gym_id, user_membership_id, member_id, amount, currency, charge_type_id, status,
           provider, provider_order, page_token, page_token_expires, source)
         VALUES (?, ?, ?, 40, 'EUR', ?, 'pending', 'monei', ?, UUID(), DATE_ADD(NOW(), INTERVAL 10 MINUTE), 'admin')`,
        [gymId, umId, memberId, ct[0].id, order]);
    }
    const raw = JSON.stringify({
      id: 'evt_b', type: 'charge.succeeded', objectId: 'ch_b', objectType: 'charge',
      object: { id: 'ch_b', orderId: order, status: 'SUCCEEDED', paymentToken: 'tok', sequenceId: 'seq',
        paymentMethod: { card: { last4: '4242', brand: 'visa' } } },
    });
    const t = String(Math.floor(Date.now() / 1000));
    const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
    const hook = await request.post('/webhooks/payment')
      .set({ 'monei-signature': `t=${t},v1=${v1}`, 'Content-Type': 'application/json' }).send(raw);
    expect(hook.status).toBe(200);

    const sets = await setsOf(memberId);
    expect(sets).toHaveLength(1);
    // The token stamped a next_billing_date; the import took it off the legacy pass.
    expect((await um(umId)).next_billing_date).toBeNull();
    const { rows: events } = await db.query<any>(
      `SELECT period_start, event_type, is_scheduled FROM billing_events WHERE product_set_id = ?`, [sets[0].id]);
    const periods = events.map((e: any) => (e.period_start instanceof Date ? e.period_start.toISOString() : String(e.period_start)).slice(0, 10));
    expect(new Set(periods).size).toBe(periods.length); // no period twice
  });
});

describe('an edit of a projected assignment is a new version (#1325 PR 5)', () => {
  async function activePlan(price = 0) {
    const memberId = await member();
    const umId = await assign(memberId, await plan(price));
    await auth(request.post(`/user-memberships/${umId}/activate`)).send({});
    return { memberId, umId };
  }

  it('fee-benefit supersedes the set, replaces its future events and re-projects', async () => {
    const { memberId, umId } = await activePlan(0);
    const [v1] = await setsOf(memberId);
    const res = await auth(request.put(`/user-memberships/${umId}/fee-benefit`)).send({ action: 'percentage_discount', value: 20 });
    expect(res.status).toBe(200);

    const sets = await setsOf(memberId);
    expect(sets.map((s: any) => s.status)).toEqual(['superseded', 'active']);
    expect(Number(sets[1].user_membership_id)).toBe(umId);
    expect((await um(umId)).personal_fee_benefit_value).toBe('20.00');
    const futureOfV1 = (await scheduled(v1.id)).filter((e: any) => e.billing_date > TODAY);
    expect(futureOfV1.length).toBe(0);
  });

  it('a refused edit leaves the set and its events exactly as they were', async () => {
    const { memberId, umId } = await activePlan(0);
    const before = await setsOf(memberId);
    const res = await auth(request.put(`/user-memberships/${umId}/fee-benefit`)).send({ action: 'percentage_discount', value: 500 });
    expect(res.status).toBe(400);
    expect(await setsOf(memberId)).toEqual(before);
  });

  it('is locked while a past obligation is unresolved', async () => {
    const { memberId, umId } = await activePlan(0);
    const [v1] = await setsOf(memberId);
    const ev = await db.query(
      `INSERT INTO billing_events (gym_id, member_id, event_type, source, amount, product_set_id, billing_date, is_scheduled)
       VALUES (?, ?, 'failed_billing', 'system', 10, ?, ?, 0)`, [gymId, memberId, v1.id, day(-3)]);
    await db.query(
      `INSERT INTO payment_requests (gym_id, member_id, amount, status, source, billing_event_id, attempt, provider_status)
       VALUES (?, ?, 10, 'failed', 'billing_run', ?, 1, 'FAILED')`, [gymId, memberId, ev.insertId]);
    const res = await auth(request.put(`/user-memberships/${umId}/fee-benefit`)).send({ action: 'no_benefit' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('edit_locked');
    expect((await setsOf(memberId)).length).toBe(1);
  });

  it('closing the plan retires it: an empty version, the assignment closed, nothing left to bill', async () => {
    const { memberId, umId } = await activePlan(0);
    const [v1] = await setsOf(memberId);
    const res = await auth(request.post(`/user-memberships/${umId}/close`)).send({ confirm: true });
    expect(res.status).toBe(200);
    expect((await um(umId)).status).toBe('cancelled');
    const sets = await setsOf(memberId);
    expect(sets.map((s: any) => s.status)).toEqual(['superseded', 'active']);
    const future = (await scheduled(v1.id)).filter((e: any) => e.billing_date > TODAY);
    expect(future.length).toBe(0);
    expect((await scheduled(sets[1].id)).length).toBe(0);
  });
});

describe('the bridge is off unless asked for (#1325 PR 5)', () => {
  it('with the flag off an activation creates no ProductSet', async () => {
    process.env.PRODUCT_SET_BILLING = 'false';
    try {
      const memberId = await member();
      const umId = await assign(memberId, await plan(0));
      await auth(request.post(`/user-memberships/${umId}/activate`)).send({});
      expect(await setsOf(memberId)).toHaveLength(0);
    } finally {
      process.env.PRODUCT_SET_BILLING = 'true';
    }
  });
});
