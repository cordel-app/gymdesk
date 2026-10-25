import crypto from 'crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';

// #2087: the hosted page's callback and the cleanup settle a payment from
// MONEI's own answer (`getPaymentStatus()`), through the same function the
// webhook uses. MONEI is stubbed: `monei.payments` is what a lookup answers,
// keyed by the MONEI payment id (our `provider_ref`); `monei.down` makes every
// lookup throw. The webhook's signature check stays real.
const monei = vi.hoisted(() => ({
  payments: new Map<string, { orderId: string; status: string }>(),
  lookups: [] as string[],
  down: false,
}));

vi.mock('../payments', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../payments')>();
  const { chargePayload } = await import('../payments/providers/monei/webhook');
  return {
    ...mod,
    getPaymentProvider: () => {
      const real = mod.getPaymentProvider();
      return Object.assign(Object.create(real), {
        createPaymentRequest: async (p: { orderId: string }) => ({
          providerOrderId: `pay_${p.orderId.replace(/-/g, '')}`, checkoutUrl: 'https://pay.test/x',
        }),
        getPaymentStatus: async (id: string) => {
          monei.lookups.push(id);
          if (monei.down) throw new Error('Monei API error 503');
          const p = monei.payments.get(id);
          if (!p) throw new Error('Monei API error 404');
          return chargePayload({ id, orderId: p.orderId, status: p.status });
        },
      });
    },
  };
});

import { cleanupTestGyms, createTestGym, createTestMembership, request, TEST_AUTH_HEADER } from './helpers';

const WEBHOOK_SECRET = 'test-payment-confirm-webhook';
const BILLING_SECRET = 'test-payment-confirm-billing';
let gymId: string;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const today = () => new Date().toISOString().slice(0, 10);
const auth = (r: any) => r.set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.BILLING_INTERNAL_SECRET = BILLING_SECRET;
  gymId = await createTestGym('Payment Confirm Gym');
  await createTestMembership(gymId, 'admin');
});

afterEach(() => {
  monei.payments.clear();
  monei.lookups = [];
  monei.down = false;
});

afterAll(async () => {
  delete process.env.MONEI_API_KEY;
  delete process.env.MONEI_WEBHOOK_SECRET;
  delete process.env.BILLING_INTERNAL_SECRET;
  await db.query('DELETE FROM payment_requests WHERE gym_id = ?', [gymId]);
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

async function member(): Promise<number> {
  const { insertId } = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'Confirm Member', `confirm-${uniq()}@test.com`]);
  return insertId;
}

async function plan(price: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit,
        free_periods, paid_periods, bonus_periods, pay_beforehand_periods)
     VALUES (?, ?, 'active', 'public', '1', NULL, NULL, 0, 0)`, [gymId, `Confirm-Plan-${uniq()}`]);
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, ?, DATE_SUB(CURDATE(), INTERVAL 1 YEAR), 'active')`, [gymId, insertId, price]);
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`, [gymId, insertId]);
  return insertId;
}

interface Checkout {
  setId: number;
  requestId: number;
  paymentId: string;
  orderId: string;
}

/** A first payment through the real Save & Pay: a Pending Payment set with its initial event. */
async function checkout(): Promise<Checkout> {
  const created = await auth(request.post('/product-sets'))
    .send({ member_id: await member(), membership_plan_id: await plan(30), starts_at: today() });
  expect(created.status).toBe(201);
  const pay = await auth(request.post(`/product-sets/${created.body.id}/save-and-pay`)).send({});
  expect(pay.status).toBe(201);
  const { rows } = await db.query<{ provider_ref: string; provider_order: string }>(
    'SELECT provider_ref, provider_order FROM payment_requests WHERE id = ?', [pay.body.payment_request_id]);
  return {
    setId: created.body.id, requestId: pay.body.payment_request_id,
    paymentId: rows[0].provider_ref, orderId: rows[0].provider_order,
  };
}

async function requestRow(id: number) {
  const { rows } = await db.query<{ status: string; provider_status: string | null; billing_event_id: number | null }>(
    'SELECT status, provider_status, billing_event_id FROM payment_requests WHERE id = ?', [id]);
  return rows[0];
}

async function setStatus(id: number): Promise<string> {
  const { rows } = await db.query<{ status: string }>('SELECT status FROM product_sets WHERE id = ?', [id]);
  return rows[0].status;
}

async function eventCount(setId: number): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM billing_events be JOIN product_sets ps ON ps.id = be.product_set_id
      WHERE ps.root_product_set_id = (SELECT root_product_set_id FROM product_sets WHERE id = ?)`, [setId]);
  return Number(rows[0].n);
}

function confirm(paymentId: string, body: unknown = {}) {
  return request.post(`/payment-page/payments/${paymentId}/confirm`).send(body as object);
}

function webhook(c: { paymentId: string; orderId: string }, status: string) {
  const raw = JSON.stringify({ id: c.paymentId, orderId: c.orderId, status });
  const t = String(Math.floor(Date.now() / 1000));
  const v1 = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${raw}`).digest('hex');
  return request.post('/webhooks/payment').set({ 'monei-signature': `t=${t},v1=${v1}` })
    .set('Content-Type', 'application/json').send(raw);
}

describe('POST /payment-page/payments/:paymentId/confirm', () => {
  it('settles a first payment from MONEI\'s answer, with no webhook at all', async () => {
    const c = await checkout();
    monei.payments.set(c.paymentId, { orderId: c.orderId, status: 'SUCCEEDED' });

    const res = await confirm(c.paymentId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'completed' });
    expect(monei.lookups).toEqual([c.paymentId]);

    expect(await requestRow(c.requestId)).toMatchObject({ status: 'completed', provider_status: 'SUCCEEDED' });
    expect(await setStatus(c.setId)).toBe('active');
  });

  it('a webhook arriving after the confirmation changes nothing', async () => {
    const c = await checkout();
    monei.payments.set(c.paymentId, { orderId: c.orderId, status: 'SUCCEEDED' });
    expect((await confirm(c.paymentId)).body.status).toBe('completed');
    const events = await eventCount(c.setId);

    expect((await webhook(c, 'SUCCEEDED')).status).toBe(200);

    expect(await eventCount(c.setId)).toBe(events);
    expect(await setStatus(c.setId)).toBe('active');
  });

  it('a confirmation after the webhook answers completed without asking MONEI', async () => {
    const c = await checkout();
    expect((await webhook(c, 'SUCCEEDED')).status).toBe(200);
    const events = await eventCount(c.setId);

    const res = await confirm(c.paymentId);
    expect(res.body).toEqual({ status: 'completed' });
    expect(monei.lookups).toEqual([]);
    expect(await eventCount(c.setId)).toBe(events);
  });

  it('a confirmation and a webhook landing together settle once', async () => {
    const c = await checkout();
    monei.payments.set(c.paymentId, { orderId: c.orderId, status: 'SUCCEEDED' });

    const [confirmed, hooked] = await Promise.all([confirm(c.paymentId), webhook(c, 'SUCCEEDED')]);
    expect(confirmed.status).toBe(200);
    expect(hooked.status).toBe(200);

    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM payment_requests WHERE id = ? AND status = 'completed'`, [c.requestId]);
    expect(Number(rows[0].n)).toBe(1);
    expect(await setStatus(c.setId)).toBe('active');
  });

  it('never settles from what the browser sends', async () => {
    const c = await checkout();
    monei.payments.set(c.paymentId, { orderId: c.orderId, status: 'PENDING' });

    const res = await confirm(c.paymentId, { status: 'SUCCEEDED', amount: 0 });
    expect(res.body).toEqual({ status: 'pending' });
    expect(await requestRow(c.requestId)).toMatchObject({ status: 'pending' });
    expect(await setStatus(c.setId)).toBe('pending_payment');
  });

  it('records a failure MONEI reports', async () => {
    const c = await checkout();
    monei.payments.set(c.paymentId, { orderId: c.orderId, status: 'FAILED' });

    expect((await confirm(c.paymentId)).body).toEqual({ status: 'failed' });
    expect(await requestRow(c.requestId)).toMatchObject({ status: 'failed', provider_status: 'FAILED' });
    expect(await setStatus(c.setId)).toBe('pending_payment');
  });

  it('writes nothing for a status MONEI is still processing, which the adapter alone would read as failed', async () => {
    const c = await checkout();
    monei.payments.set(c.paymentId, { orderId: c.orderId, status: 'PENDING_PROCESSING' });

    expect((await confirm(c.paymentId)).body).toEqual({ status: 'pending' });
    expect(await requestRow(c.requestId)).toMatchObject({ status: 'pending' });
  });

  it('answers 404 for an unknown or malformed payment id', async () => {
    expect((await confirm('pay_doesnotexist')).status).toBe(404);
    expect((await confirm('bad%20id!')).status).toBe(404);
    expect(monei.lookups).toEqual([]);
  });

  it('refuses a MONEI payment that belongs to another order, and writes nothing', async () => {
    const c = await checkout();
    monei.payments.set(c.paymentId, { orderId: crypto.randomUUID(), status: 'SUCCEEDED' });

    expect((await confirm(c.paymentId)).status).toBe(409);
    expect(await requestRow(c.requestId)).toMatchObject({ status: 'pending' });
  });

  it('answers 502 and writes nothing when MONEI cannot be reached', async () => {
    const c = await checkout();
    monei.down = true;

    const res = await confirm(c.paymentId);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ status: 'unknown' });
    expect(await requestRow(c.requestId)).toMatchObject({ status: 'pending' });
  });
});

describe('POST /webhooks/payment — two deliveries at once', () => {
  // Regression for the lock: the row used to be read outside the transaction,
  // so two concurrent deliveries could both pass the `settleable` check and the
  // branch that records a request with no Billing Event wrote two of them.
  it('records one Billing Event for a request that had none', async () => {
    // A member with an Active set (paid through the real flow), then a legacy
    // request with no Billing Event of its own, which the webhook records
    // against that set.
    const c = await checkout();
    expect((await webhook(c, 'SUCCEEDED')).status).toBe(200);
    const { rows: ct } = await db.query<{ id: number }>("SELECT id FROM charge_types WHERE code = 'membership_fee'");
    const orderId = crypto.randomUUID();
    const paymentId = `pay_${uniq().replace(/-/g, '')}`;
    const { rows: owner } = await db.query<{ member_id: number }>('SELECT owner_member_id AS member_id FROM product_sets WHERE id = ?', [c.setId]);
    const { insertId: requestId } = await db.query(
      `INSERT INTO payment_requests (gym_id, member_id, amount, currency, charge_type_id, status, provider,
          provider_order, provider_ref, page_token, page_token_expires, source)
       VALUES (?, ?, '9.00', 'EUR', ?, 'pending', 'monei', ?, ?, NULL, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE), 'customer')`,
      [gymId, owner[0].member_id, ct[0].id, orderId, paymentId]);

    const [a, b] = await Promise.all([webhook({ paymentId, orderId }, 'SUCCEEDED'), webhook({ paymentId, orderId }, 'SUCCEEDED')]);
    expect([a.status, b.status]).toEqual([200, 200]);

    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM billing_events WHERE gym_id = ? AND member_id = ? AND event_type = 'payment_recorded' AND amount = 9`,
      [gymId, owner[0].member_id]);
    expect(Number(rows[0].n)).toBe(1);
    expect((await requestRow(requestId)).status).toBe('completed');
  });
});

describe('POST /billing/cleanup — asks MONEI before writing a payment off', () => {
  async function abandon(requestId: number) {
    await db.query(
      `UPDATE payment_requests SET page_token = NULL,
          page_token_expires = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 HOUR) WHERE id = ?`, [requestId]);
  }
  const cleanup = () => request.post('/billing/cleanup').set('x-internal-secret', BILLING_SECRET);

  it('settles a payment MONEI took whose webhook never arrived, instead of expiring it', async () => {
    const c = await checkout();
    await abandon(c.requestId);
    monei.payments.set(c.paymentId, { orderId: c.orderId, status: 'SUCCEEDED' });

    const res = await cleanup();
    expect(res.status).toBe(200);
    expect(res.body.reconciled).toBeGreaterThanOrEqual(1);

    expect(await requestRow(c.requestId)).toMatchObject({ status: 'completed', provider_status: 'SUCCEEDED' });
    // Before #2087 the request was expired and the set returned to Draft,
    // deleting the record of a payment the member had made.
    expect(await setStatus(c.setId)).toBe('active');
  });

  it('expires a request MONEI still reports with no outcome, as before', async () => {
    const c = await checkout();
    await abandon(c.requestId);
    monei.payments.set(c.paymentId, { orderId: c.orderId, status: 'PENDING' });

    expect((await cleanup()).status).toBe(200);
    // Expired, then returned to Draft by the same run, which deletes the attempt.
    const row = await requestRow(c.requestId);
    expect(row === undefined || row.status === 'expired').toBe(true);
    expect(await setStatus(c.setId)).toBe('draft');
  });

  it('leaves the request pending when MONEI cannot be asked', async () => {
    const c = await checkout();
    await abandon(c.requestId);
    monei.down = true;

    expect((await cleanup()).status).toBe(200);
    expect(await requestRow(c.requestId)).toMatchObject({ status: 'pending' });
    expect(await setStatus(c.setId)).toBe('pending_payment');
  });
});
