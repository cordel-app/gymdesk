// #1108 stage 2 — Save & Pay, Pending Payment, and the payment that activates.
//
//   draft ──► pending_payment ──► active
//
// What this file pins down: Save & Pay locks a Draft that owes something as
// `pending_payment` and commits one that owes nothing straight to `active`;
// #956's replacement is confirmed at Save & Pay and performed on activation;
// a locked row refuses the edits a Draft allowed; the provider's `completed`
// webhook and a staff cash payment are the two things that move the row on,
// and each writes the money and the status in one transaction.

import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import {
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
  TEST_AUTH_HEADER,
} from './helpers';

const MONEI_WEBHOOK_SECRET = 'test-webhook-secret';

let gymId: string;
let chargeTypeId: number;
let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;
const api = (method: 'post' | 'put' | 'get' | 'delete', path: string) =>
  (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gymId);

async function createMember(): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gymId, 'SAP Member', `sap-${uniq()}@test.com`],
  );
  return insertId;
}

/** A Plan with a catalogue price, so the first cycle owes something. */
async function createPaidPlan(price = 30): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '1')`,
    [gymId, `SAP Plan ${uniq()}`],
  );
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, ?, '2020-01-01', 'active')`,
    [gymId, insertId, price],
  );
  // A cadence, so the first payment has a schedule to stamp `next_billing_date` on.
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`,
    [gymId, insertId],
  );
  return insertId;
}

async function createFreePlan(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status, member_limit)
     VALUES (?, ?, 'active', 'public', '1')`,
    [gymId, `SAP Free Plan ${uniq()}`],
  );
  return insertId;
}

async function assignDraft(memberId: number, planId: number, startsAt = '2026-03-01'): Promise<number> {
  const res = await api('post', '/user-memberships').send({ member_id: memberId, membership_plan_id: planId, starts_at: startsAt });
  expect(res.status).toBe(201);
  expect(res.body.status).toBe('draft');
  return res.body.id;
}

async function status(umId: number): Promise<string> {
  const { rows } = await db.query<{ status: string }>('SELECT status FROM user_memberships WHERE id = ?', [umId]);
  return rows[0].status;
}

async function statusChanges(umId: number): Promise<Array<{ previous_status: string | null; new_status: string }>> {
  const { rows } = await db.query(
    `SELECT previous_status, new_status FROM billing_events
      WHERE user_membership_id = ? AND event_type = 'status_changed' ORDER BY id ASC`,
    [umId],
  );
  return rows;
}

function signedHeaders(body: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', MONEI_WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex');
  return { 'monei-signature': `t=${timestamp},v1=${sig}` };
}

async function completeThroughWebhook(umId: number, memberId: number): Promise<number> {
  const orderId = crypto.randomUUID();
  const chargeId = crypto.randomBytes(20).toString('hex');
  const { insertId: prId } = await db.query(
    `INSERT INTO payment_requests
       (gym_id, user_membership_id, member_id, amount, currency, charge_type_id,
        status, provider, provider_order, page_token, page_token_expires, initiated_by, source)
     VALUES (?, ?, ?, '30.00', 'EUR', ?, 'pending', 'monei', ?, UUID(), DATE_ADD(NOW(), INTERVAL 10 MINUTE), 'test-user-id', 'admin')`,
    [gymId, umId, memberId, chargeTypeId, orderId],
  );
  const envelope = {
    id: `evt_${chargeId}`, type: 'charge.succeeded', accountId: 'acc_test', livemode: false,
    objectId: chargeId, objectType: 'charge', createdAt: Math.floor(Date.now() / 1000),
    object: {
      id: chargeId, orderId, status: 'SUCCEEDED',
      paymentToken: `tok_${chargeId}`, sequenceId: `seq_${chargeId}`,
      paymentMethod: { card: { last4: '4242', brand: 'visa' } },
    },
  };
  const raw = JSON.stringify(envelope);
  const res = await request.post('/webhooks/payment').set(signedHeaders(raw)).set('Content-Type', 'application/json').send(raw);
  expect(res.status).toBe(200);
  return prId;
}

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = MONEI_WEBHOOK_SECRET;
  gymId = await createTestGym('Save And Pay Gym');
  await createTestMembership(gymId, 'admin');
  const { rows } = await db.query<{ id: number }>(`SELECT id FROM charge_types WHERE code = 'membership_fee'`);
  chargeTypeId = rows[0].id;
});

afterAll(async () => {
  delete process.env.MONEI_API_KEY;
  delete process.env.MONEI_WEBHOOK_SECRET;
  await cleanupTestGyms();
  await db.end();
});

describe('POST /user-memberships/:id/save-and-pay', () => {
  it('moves a Draft that owes something to pending_payment, with a status_changed row', async () => {
    const memberId = await createMember();
    const umId = await assignDraft(memberId, await createPaidPlan());
    const res = await api('post', `/user-memberships/${umId}/save-and-pay`).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending_payment');
    expect(res.body.lifecycle_status).toBe('pending_payment');
    expect(Number(res.body.membership_fee)).toBe(30);
    expect(await statusChanges(umId)).toEqual([
      { previous_status: null, new_status: 'draft' },
      { previous_status: 'draft', new_status: 'pending_payment' },
    ]);
  });

  it('commits a Draft that owes nothing straight to active — there is no payment to wait for', async () => {
    const memberId = await createMember();
    const umId = await assignDraft(memberId, await createFreePlan());
    const res = await api('post', `/user-memberships/${umId}/save-and-pay`).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
  });

  it('only a Draft can be saved and paid', async () => {
    const memberId = await createMember();
    const umId = await assignDraft(memberId, await createPaidPlan());
    await api('post', `/user-memberships/${umId}/save-and-pay`).send({});
    const again = await api('post', `/user-memberships/${umId}/save-and-pay`).send({});
    expect(again.status).toBe(400);
  });

  it('asks the one-plan rule at Save & Pay (409 unless confirmed) and supersedes only on activation', async () => {
    const memberId = await createMember();
    const first = await assignDraft(memberId, await createFreePlan(), '2026-01-01');
    await api('post', `/user-memberships/${first}/activate`).send({});
    expect(await status(first)).toBe('active');

    const second = await assignDraft(memberId, await createPaidPlan(), '2026-06-01');
    const refused = await api('post', `/user-memberships/${second}/save-and-pay`).send({});
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('active_plan_exists');
    expect(await status(second)).toBe('draft');

    const confirmed = await api('post', `/user-memberships/${second}/save-and-pay`).send({ confirm: true });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('pending_payment');
    // Nothing superseded yet: a payment that never arrives must leave the
    // member's current plan exactly as it was.
    expect(await status(first)).toBe('active');

    await api('post', `/user-memberships/${second}/record-payment`).send({});
    expect(await status(second)).toBe('active');
    expect(await status(first)).toBe('cancelled');
  });
});

describe('a Pending Payment row is locked', () => {
  it('refuses the edits a Draft allowed, a PUT to active, and still closes', async () => {
    const memberId = await createMember();
    const umId = await assignDraft(memberId, await createPaidPlan());
    await api('post', `/user-memberships/${umId}/save-and-pay`).send({});

    const fee = await api('put', `/user-memberships/${umId}/fee`).send({ membership_fee_price: 10 });
    expect([400, 404, 409]).toContain(fee.status);
    const flip = await api('put', `/user-memberships/${umId}`).send({ status: 'active' });
    expect(flip.status).toBe(400);
    const toPending = await api('put', `/user-memberships/${umId}`).send({ status: 'pending_payment' });
    expect(toPending.status).toBe(400);
    expect(await status(umId)).toBe('pending_payment');

    const closed = await api('post', `/user-memberships/${umId}/close`).send({});
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('cancelled');
  });

  it('is not the member\'s plan for the enrollment status, and the member\'s own read', async () => {
    const memberId = await createMember();
    const umId = await assignDraft(memberId, await createPaidPlan());
    await api('post', `/user-memberships/${umId}/save-and-pay`).send({});
    const list = await api('get', `/members?search=${encodeURIComponent('SAP Member')}`);
    const row = (list.body.items ?? list.body).find((m: any) => m.id === memberId);
    expect(row?.enrollment_status ?? null).toBeNull();
  });
});

describe('the payment activates', () => {
  it('the provider\'s completed webhook moves pending_payment to active and stamps the first billing date', async () => {
    const memberId = await createMember();
    const umId = await assignDraft(memberId, await createPaidPlan(), '2026-01-01');
    await api('post', `/user-memberships/${umId}/save-and-pay`).send({});
    const prId = await completeThroughWebhook(umId, memberId);

    expect(await status(umId)).toBe('active');
    const { rows: pr } = await db.query('SELECT status FROM payment_requests WHERE id = ?', [prId]);
    expect(pr[0].status).toBe('completed');
    const { rows: um } = await db.query('SELECT next_billing_date FROM user_memberships WHERE id = ?', [umId]);
    expect(um[0].next_billing_date).not.toBeNull();
    const changes = await statusChanges(umId);
    expect(changes[changes.length - 1]).toEqual({ previous_status: 'pending_payment', new_status: 'active' });
  });

  it('a completed webhook on an already-active row changes no status', async () => {
    const memberId = await createMember();
    const umId = await assignDraft(memberId, await createFreePlan());
    await api('post', `/user-memberships/${umId}/activate`).send({});
    const before = (await statusChanges(umId)).length;
    await completeThroughWebhook(umId, memberId);
    expect(await status(umId)).toBe('active');
    expect((await statusChanges(umId)).length).toBe(before);
  });

  it('POST /:id/record-payment writes the cash payment and activates in one go', async () => {
    const memberId = await createMember();
    const umId = await assignDraft(memberId, await createPaidPlan());
    await api('post', `/user-memberships/${umId}/save-and-pay`).send({});
    const res = await api('post', `/user-memberships/${umId}/record-payment`).send({ notes: 'cash at the desk' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    const { rows } = await db.query(
      `SELECT event_type, amount, notes FROM billing_events WHERE user_membership_id = ? AND event_type = 'payment_recorded'`,
      [umId],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount)).toBe(30);
    expect(rows[0].notes).toBe('cash at the desk');
    expect((await api('post', `/user-memberships/${umId}/record-payment`).send({})).status).toBe(400);
  });

  it('a payment_recorded event appended through POST /payments activates a pending row too', async () => {
    const memberId = await createMember();
    const umId = await assignDraft(memberId, await createPaidPlan());
    await api('post', `/user-memberships/${umId}/save-and-pay`).send({});
    const res = await api('post', '/payments').send({
      event_type: 'payment_recorded', user_membership_id: umId, charge_type_id: chargeTypeId, amount: 30,
    });
    expect(res.status).toBe(201);
    expect(await status(umId)).toBe('active');
  });
});
