import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';

// The real provider verifies the webhook signature; only the call that would
// reach Monei is stubbed.
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

const SECRET = 'test-productset-webhook';
let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const day = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const TODAY = day(0);

const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'PS Member', `ps-${uniq()}@test.com`]);
  return insertId;
}
async function plan(price: number, free: number | null = null): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', ?, NULL, 0, 0)`, [gymId, `PS-Plan-${uniq()}`, free]);
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status) VALUES (?, ?, ?, ?, 'active')`,
    [gymId, insertId, price, day(-365)]);
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit) VALUES (?, ?, 1, 'month')`,
    [gymId, insertId]);
  return insertId;
}
function signed(payload: unknown) {
  const raw = JSON.stringify(payload);
  const t = String(Math.floor(Date.now() / 1000));
  const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
  return request.post('/webhooks/payment').set({ 'monei-signature': `t=${t},v1=${v1}` })
    .set('Content-Type', 'application/json').send(raw);
}

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = SECRET;
  gymId = await createTestGym('PS api gym');
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

describe('/product-sets — Save & Pay to Active (#1325 PR 2d)', () => {
  it('Draft → Pending Payment → paid webhook → Active with its future events', async () => {
    const memberId = await member();
    const planId = await plan(40);

    const created = await auth(request.post('/product-sets')).send({ member_id: memberId, membership_plan_id: planId, starts_at: TODAY });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('draft');
    const id = created.body.id;

    // A second in-flight version is refused.
    const again = await auth(request.post('/product-sets')).send({ member_id: memberId, membership_plan_id: planId, starts_at: TODAY });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('in_flight');

    const pay = await auth(request.post(`/product-sets/${id}/save-and-pay`)).send({});
    expect(pay.status).toBe(201);
    expect(pay.body.status).toBe('pending_payment');
    expect(pay.body.amount).toBe(40);
    expect(pay.body.checkout_url).toContain('/checkout?token=');

    // Nothing is active and no future event exists until the money is confirmed.
    const before = await auth(request.get(`/product-sets/${id}`));
    expect(before.body.status).toBe('pending_payment');
    expect(before.body.billing_events.filter((e: any) => Number(e.is_scheduled) === 1).length).toBe(0);

    const { rows: pr } = await db.query<any>('SELECT provider_order FROM payment_requests WHERE id = ?', [pay.body.payment_request_id]);
    const chargeId = crypto.randomBytes(12).toString('hex');
    const hook = await signed({
      id: `evt_${chargeId}`, type: 'charge.succeeded', objectId: chargeId, objectType: 'charge',
      object: { id: chargeId, orderId: pr[0].provider_order, status: 'SUCCEEDED' },
    });
    expect(hook.status).toBe(200);

    const after = await auth(request.get(`/product-sets/${id}`));
    expect(after.body.status).toBe('active');
    expect(after.body.billing_events.some((e: any) => Number(e.is_scheduled) === 1)).toBe(true);
    const { rows: req } = await db.query<any>('SELECT provider_status, status FROM payment_requests WHERE id = ?', [pay.body.payment_request_id]);
    expect(req[0]).toMatchObject({ status: 'completed', provider_status: 'SUCCEEDED' });

    // A duplicate delivery changes nothing.
    const dup = await signed({
      id: `evt_${chargeId}`, type: 'charge.succeeded', objectId: chargeId, objectType: 'charge',
      object: { id: chargeId, orderId: pr[0].provider_order, status: 'SUCCEEDED' },
    });
    expect(dup.status).toBe(200);
    const { rows: n } = await db.query<any>(
      `SELECT COUNT(*) AS n FROM product_sets WHERE owner_member_id = ? AND status = 'active'`, [memberId]);
    expect(Number(n[0].n)).toBe(1);
  });

  it('a free plan is activated directly, and a payment is refused there', async () => {
    const memberId = await member();
    const free = await plan(0);
    const c = await auth(request.post('/product-sets')).send({ member_id: memberId, membership_plan_id: free, starts_at: TODAY });
    expect(c.status).toBe(201);
    const paid = await auth(request.post(`/product-sets/${c.body.id}/save-and-pay`)).send({});
    expect(paid.status).toBe(409);
    expect(paid.body.error).toBe('nothing_to_pay');
    const act = await auth(request.post(`/product-sets/${c.body.id}/activate`)).send({});
    expect(act.status).toBe(200);
    expect(act.body.status).toBe('active');
  });

  it('refuses a new version while a past obligation is unresolved, and says which', async () => {
    const memberId = await member();
    const free = await plan(0);
    const c = await auth(request.post('/product-sets')).send({ member_id: memberId, membership_plan_id: free, starts_at: TODAY });
    await auth(request.post(`/product-sets/${c.body.id}/activate`)).send({});
    const ev = await db.query(
      `INSERT INTO billing_events (gym_id, member_id, event_type, source, amount, product_set_id, billing_date, is_scheduled)
       VALUES (?, ?, 'failed_billing', 'system', 10, ?, ?, 0)`, [gymId, memberId, c.body.id, day(-3)]);
    await db.query(
      `INSERT INTO payment_requests (gym_id, member_id, amount, status, source, billing_event_id, attempt, provider_status)
       VALUES (?, ?, 10, 'failed', 'billing_run', ?, 1, 'FAILED')`, [gymId, memberId, ev.insertId]);

    const check = await auth(request.get(`/product-sets/edit-check?member_id=${memberId}`));
    expect(check.body.editable).toBe(false);
    expect(check.body.blocking[0]).toMatchObject({ id: ev.insertId, reason: 'unsuccessful', providerStatus: 'FAILED' });

    const blocked = await auth(request.post('/product-sets')).send({ member_id: memberId, membership_plan_id: free, starts_at: TODAY });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('edit_locked');

    // A refund is not a failure: the same event, refunded, no longer blocks.
    await db.query(`UPDATE payment_requests SET provider_status = 'REFUNDED', status = 'completed' WHERE billing_event_id = ?`, [ev.insertId]);
    const ok = await auth(request.get(`/product-sets/edit-check?member_id=${memberId}`));
    expect(ok.body.editable).toBe(true);
  });

  it('cancelling a Draft deletes only the Draft; the Active version stays', async () => {
    const memberId = await member();
    const free = await plan(0);
    const v1 = await auth(request.post('/product-sets')).send({ member_id: memberId, membership_plan_id: free, starts_at: TODAY });
    await auth(request.post(`/product-sets/${v1.body.id}/activate`)).send({});
    const v2 = await auth(request.post('/product-sets')).send({ member_id: memberId, membership_plan_id: free, starts_at: TODAY });
    expect(v2.status).toBe(201);
    expect(v2.body.version).toBe(2);
    const del = await auth(request.delete(`/product-sets/${v2.body.id}`));
    expect(del.status).toBe(204);
    const list = await auth(request.get(`/product-sets?member_id=${memberId}`));
    expect(list.body.map((s: any) => s.status)).toEqual(['active']);
  });

  it('is tenant scoped', async () => {
    const memberId = await member();
    const free = await plan(0);
    const c = await auth(request.post('/product-sets')).send({ member_id: memberId, membership_plan_id: free, starts_at: TODAY });
    const otherGym = await createTestGym('PS other gym');
    await createTestMembership(otherGym, 'admin');
    const res = await request.get(`/product-sets/${c.body.id}`)
      .set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', otherGym);
    expect(res.status).toBe(404);
  });

  it('requires authentication', async () => {
    const res = await request.get('/product-sets?member_id=1');
    expect(res.status).toBe(401);
  });

  it('a cash payment settles the initial event and activates the version', async () => {
    const memberId = await member();
    const planId = await plan(25);
    const c = await auth(request.post('/product-sets')).send({ member_id: memberId, membership_plan_id: planId, starts_at: TODAY });
    expect(c.status).toBe(201);

    // The Member card reads the in-flight version beside the assignments.
    const cfg1 = await auth(request.get(`/user-memberships/member/${memberId}/configuration`));
    expect(cfg1.status).toBe(200);
    expect(cfg1.body.product_sets).toEqual([expect.objectContaining({ id: c.body.id, status: 'draft', expired: false })]);

    const pay = await auth(request.post(`/product-sets/${c.body.id}/save-and-pay`)).send({});
    expect(pay.status).toBe(201);
    const cfg2 = await auth(request.get(`/user-memberships/member/${memberId}/configuration`));
    expect(cfg2.body.product_sets[0]).toMatchObject({ status: 'pending_payment', amount_due: 25 });

    const cash = await auth(request.post(`/product-sets/${c.body.id}/record-payment`)).send({});
    expect(cash.status).toBe(200);
    expect(cash.body.status).toBe('active');
    const { rows: attempts } = await db.query<any>(
      'SELECT method, status, provider_status FROM payment_requests WHERE billing_event_id = ? ORDER BY attempt', [pay.body.billing_event_id]);
    expect(attempts[attempts.length - 1]).toMatchObject({ method: 'cash', status: 'completed', provider_status: null });

    // The operational assignment is now projected, and the version is no longer in flight.
    const cfg3 = await auth(request.get(`/user-memberships/member/${memberId}/configuration`));
    expect(cfg3.body.product_sets).toEqual([]);
    expect(cfg3.body.plans.map((p: any) => p.membership_plan_id)).toEqual([planId]);
    expect(cfg3.body.plans[0].is_live).toBe(true);

    // A second cash payment finds nothing pending.
    const again = await auth(request.post(`/product-sets/${c.body.id}/record-payment`)).send({});
    expect(again.status).toBe(409);
  });

  it('refuses a plan for a Member already on one (#956) and offers no confirmation', async () => {
    const memberId = await member();
    const planId = await plan(0);
    const { insertId } = await db.query(
      `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at) VALUES (?, ?, ?, 'active', ?)`,
      [gymId, memberId, planId, TODAY]);
    const res = await auth(request.post('/product-sets')).send({
      member_id: memberId, membership_plan_id: planId, starts_at: TODAY, confirm: true,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('active_plan_exists');
    expect(res.body.current_plan.id).toBe(insertId);
    const { rows } = await db.query('SELECT id FROM product_sets WHERE owner_member_id = ?', [memberId]);
    expect(rows.length).toBe(0);
  });

  it('a new version of the owner\'s own plan is not a conflict with its own projection', async () => {
    const memberId = await member();
    const free = await plan(0);
    const v1 = await auth(request.post('/product-sets')).send({ member_id: memberId, membership_plan_id: free, starts_at: TODAY });
    await auth(request.post(`/product-sets/${v1.body.id}/activate`)).send({});
    const v2 = await auth(request.post('/product-sets')).send({ member_id: memberId, membership_plan_id: free, starts_at: TODAY });
    expect(v2.status).toBe(201);
    expect(v2.body.version).toBe(2);
  });
});
