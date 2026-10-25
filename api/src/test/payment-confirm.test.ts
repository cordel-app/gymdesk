import crypto from 'crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { getPaymentProvider } from '../payments';
import type { WebhookPayload } from '../payments/types';
import {
  cleanupTestGyms,
  createTestGym,
  ensureTestProductSet,
  legacyAssignmentQuery,
  request,
} from './helpers';

// #2087: a payment is settled from the provider's own answer, whether it
// arrives as the webhook, as the hosted page's confirmation (which makes the
// API ask the provider) or through the cleanup reconciliation. The provider
// lookup is the only thing stubbed.

const WEBHOOK_SECRET = 'test-2087-webhook-secret';
const BILLING_SECRET = 'test-2087-billing-secret';

let gymId: string;
let memberId: number;
let userMembershipId: number;

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.BILLING_INTERNAL_SECRET = BILLING_SECRET;
  gymId = await createTestGym();
  const m = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Confirm Member', ?)`,
    [gymId, `confirm-${uniq()}@test.com`],
  );
  memberId = m.insertId;
  const plan = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'staff_only')`,
    [gymId, `Confirm-Plan-${uniq()}`],
  );
  const um = await legacyAssignmentQuery(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, base_price)
     VALUES (?, ?, ?, 'active', CURDATE(), '5.00')`,
    [gymId, memberId, plan.insertId],
  );
  userMembershipId = um.insertId;
  await ensureTestProductSet(gymId, memberId, userMembershipId);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  delete process.env.MONEI_API_KEY;
  delete process.env.MONEI_WEBHOOK_SECRET;
  delete process.env.BILLING_INTERNAL_SECRET;
  await cleanupTestGyms();
  await db.end();
});

/** A card-verification request (the simplest settle branch), already opened. */
async function insertRequest(opts: { opened?: boolean; hoursOld?: number } = {}) {
  const order = `ord-${uniq()}`;
  const ref = `pay-${uniq()}`;
  const { insertId } = await db.query(
    `INSERT INTO payment_requests
       (gym_id, user_membership_id, member_id, amount, currency, charge_type_id,
        status, provider, provider_order, provider_ref, page_token, page_token_expires,
        consent_given_at, source)
     VALUES (?, ?, ?, '0.00', 'EUR', NULL, 'pending', 'monei', ?, ?, ?,
             DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR), UTC_TIMESTAMP(), 'card_update')`,
    [gymId, userMembershipId, memberId, order, ref, opts.opened ? null : 'tok-' + uniq(), opts.hoursOld ?? 0],
  );
  return { id: insertId, order, ref };
}

function providerSays(order: string, ref: string, providerStatus: string, status: WebhookPayload['status']): WebhookPayload {
  return {
    orderId: order,
    providerRef: ref,
    status,
    providerStatus,
    paymentToken: `token-${ref}`,
    sequenceId: `seq-${ref}`,
    cardLast4: '4242',
    cardBrand: 'visa',
  };
}

function stubLookup(payload: WebhookPayload | Error) {
  return vi.spyOn(getPaymentProvider(), 'getPaymentStatus').mockImplementation(async () => {
    if (payload instanceof Error) throw payload;
    return payload;
  });
}

function signedWebhook(order: string, ref: string) {
  const body = JSON.stringify({ id: ref, orderId: order, status: 'SUCCEEDED', paymentToken: `token-${ref}`, sequenceId: `seq-${ref}` });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${body}`).digest('hex');
  return { body, headers: { 'monei-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' } };
}

async function postWebhook(order: string, ref: string) {
  const w = signedWebhook(order, ref);
  return request.post('/webhooks/payment').set(w.headers).send(w.body);
}

async function rowOf(id: number) {
  const { rows } = await db.query<{ status: string; provider_status: string | null }>(
    'SELECT status, provider_status FROM payment_requests WHERE id = ?',
    [id],
  );
  return rows[0];
}

async function cardCount() {
  const { rows } = await db.query<{ n: number }>(
    'SELECT COUNT(*) AS n FROM payment_methods WHERE gym_id = ? AND member_id = ?',
    [gymId, memberId],
  );
  return Number(rows[0].n);
}

describe('POST /payment-page/payments/:paymentId/confirm', () => {
  it('settles the request from the provider answer, without any webhook', async () => {
    const r = await insertRequest({ opened: true });
    stubLookup(providerSays(r.order, r.ref, 'SUCCEEDED', 'completed'));

    const res = await request.post(`/payment-page/payments/${r.ref}/confirm`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'completed' });
    expect((await rowOf(r.id)).status).toBe('completed');
    expect(await cardCount()).toBe(1);
  });

  it('ignores a forged status in the body', async () => {
    const r = await insertRequest({ opened: true });
    stubLookup(providerSays(r.order, r.ref, 'FAILED', 'failed'));

    const res = await request
      .post(`/payment-page/payments/${r.ref}/confirm`)
      .send({ status: 'SUCCEEDED', amount: 1 });
    expect(res.body).toEqual({ status: 'failed' });
    expect((await rowOf(r.id)).status).toBe('failed');
  });

  it('answers 404 for an unknown payment id without calling the provider', async () => {
    const spy = stubLookup(providerSays('x', 'y', 'SUCCEEDED', 'completed'));
    const res = await request.post(`/payment-page/payments/nope-${uniq()}/confirm`).send({});
    expect(res.status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it('answers 409 and writes nothing when the provider order differs', async () => {
    const r = await insertRequest({ opened: true });
    stubLookup(providerSays('someone-elses-order', r.ref, 'SUCCEEDED', 'completed'));
    const res = await request.post(`/payment-page/payments/${r.ref}/confirm`).send({});
    expect(res.status).toBe(409);
    expect((await rowOf(r.id)).status).toBe('pending');
  });

  it('answers 502 and leaves the row pending when the provider cannot be reached', async () => {
    const r = await insertRequest({ opened: true });
    stubLookup(new Error('network down'));
    const res = await request.post(`/payment-page/payments/${r.ref}/confirm`).send({});
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ status: 'unknown' });
    expect((await rowOf(r.id)).status).toBe('pending');
  });

  it('writes nothing for an intermediate provider status', async () => {
    const r = await insertRequest({ opened: true });
    stubLookup(providerSays(r.order, r.ref, 'PENDING', 'pending'));
    const res = await request.post(`/payment-page/payments/${r.ref}/confirm`).send({});
    expect(res.body).toEqual({ status: 'pending' });
    expect((await rowOf(r.id)).status).toBe('pending');
  });

  it('confirm then webhook settles once; webhook then confirm is a no-op', async () => {
    const a = await insertRequest({ opened: true });
    stubLookup(providerSays(a.order, a.ref, 'SUCCEEDED', 'completed'));
    await request.post(`/payment-page/payments/${a.ref}/confirm`).send({});
    const before = await cardCount();
    const hook = await postWebhook(a.order, a.ref);
    expect(hook.status).toBe(200);
    expect((await rowOf(a.id)).status).toBe('completed');
    expect(await cardCount()).toBe(before);

    const b = await insertRequest({ opened: true });
    stubLookup(providerSays(b.order, b.ref, 'SUCCEEDED', 'completed'));
    expect((await postWebhook(b.order, b.ref)).status).toBe(200);
    const again = await request.post(`/payment-page/payments/${b.ref}/confirm`).send({});
    expect(again.body).toEqual({ status: 'completed' });
  });

  it('settles once when the confirmation and the webhook race', async () => {
    const r = await insertRequest({ opened: true });
    stubLookup(providerSays(r.order, r.ref, 'SUCCEEDED', 'completed'));
    const [c, w] = await Promise.all([
      request.post(`/payment-page/payments/${r.ref}/confirm`).send({}),
      postWebhook(r.order, r.ref),
    ]);
    expect(c.status).toBe(200);
    expect(w.status).toBe(200);
    expect((await rowOf(r.id)).status).toBe('completed');
  });
});

describe('POST /billing/cleanup reconciliation', () => {
  const cleanup = () => request.post('/billing/cleanup').set('x-internal-secret', BILLING_SECRET).send({});

  it('settles an abandoned request the provider reports as succeeded instead of expiring it', async () => {
    const r = await insertRequest({ opened: true, hoursOld: 48 });
    stubLookup(providerSays(r.order, r.ref, 'SUCCEEDED', 'completed'));
    const res = await cleanup();
    expect(res.status).toBe(200);
    expect(res.body.reconciled).toBeGreaterThanOrEqual(1);
    expect((await rowOf(r.id)).status).toBe('completed');
  });

  it('expires one the provider still reports unfinished', async () => {
    const r = await insertRequest({ opened: true, hoursOld: 48 });
    stubLookup(providerSays(r.order, r.ref, 'PENDING', 'pending'));
    await cleanup();
    expect((await rowOf(r.id)).status).toBe('expired');
  });

  it('leaves a request pending when the provider cannot be reached', async () => {
    const r = await insertRequest({ opened: true, hoursOld: 48 });
    stubLookup(new Error('network down'));
    await cleanup();
    expect((await rowOf(r.id)).status).toBe('pending');
  });
});
