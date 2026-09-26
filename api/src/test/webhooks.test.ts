import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym, request } from './helpers';

const MONEI_WEBHOOK_SECRET = 'test-webhook-secret';

beforeAll(() => {
  // POST /webhooks/payment needs a real provider configured to verify
  // signatures — getPaymentProvider() throws (mapped to a generic 400
  // elsewhere) without these.
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = MONEI_WEBHOOK_SECRET;
});

afterAll(async () => {
  delete process.env.MONEI_API_KEY;
  delete process.env.MONEI_WEBHOOK_SECRET;
  await cleanupTestGyms();
  await db.end();
});

describe('GET /webhooks/payment', () => {
  it('returns 200 so Monei can preflight the URL when registering the webhook', async () => {
    const res = await request.get('/webhooks/payment');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('POST /webhooks/payment', () => {
  it('returns 400 when the Monei signature header is missing', async () => {
    const res = await request.post('/webhooks/payment').send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid signature' });
  });
});

// ─── Local fixtures for the completion-flow regression tests ─────────────────

async function createMember(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Webhook Test Member', ?)`,
    [gymId, `webhook-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`],
  );
  return insertId;
}

async function createMembershipPlan(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'staff_only')`,
    [gymId, `Webhook-Plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`],
  );
  return insertId;
}

async function createUserMembership(gymId: string, memberId: number, planId: number): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, base_price)
     VALUES (?, ?, ?, 'active', CURDATE(), '5.00')`,
    [gymId, memberId, planId],
  );
  return insertId;
}

async function getChargeTypeId(): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM charge_types WHERE code = 'membership_fee'`,
  );
  return rows[0].id;
}

async function insertPendingPaymentRequest(
  gymId: string,
  userMembershipId: number,
  memberId: number,
  chargeTypeId: number,
  providerOrder: string,
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO payment_requests
       (gym_id, user_membership_id, member_id, amount, currency, charge_type_id,
        status, provider, provider_order, page_token, page_token_expires, initiated_by, source)
     VALUES (?, ?, ?, '5.00', 'EUR', ?, 'pending', 'monei',
             ?, UUID(), DATE_ADD(NOW(), INTERVAL 10 MINUTE), 'test-user-id', 'admin')`,
    [gymId, userMembershipId, memberId, chargeTypeId, providerOrder],
  );
  return insertId;
}

/** #788: a card verification request — zero amount, no charge type. */
async function insertPendingCardUpdate(
  gymId: string,
  userMembershipId: number,
  memberId: number,
  providerOrder: string,
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO payment_requests
       (gym_id, user_membership_id, member_id, amount, currency, charge_type_id,
        status, provider, provider_order, page_token, page_token_expires, consent_given_at, source)
     VALUES (?, ?, ?, '0.00', 'EUR', NULL, 'pending', 'monei',
             ?, UUID(), DATE_ADD(NOW(), INTERVAL 10 MINUTE), UTC_TIMESTAMP(), 'card_update')`,
    [gymId, userMembershipId, memberId, providerOrder],
  );
  return insertId;
}

function buildMoneiEnvelope(orderId: string, status: string, chargeId: string) {
  return {
    id: `evt_${chargeId}`,
    type: `charge.${status.toLowerCase()}`,
    accountId: 'acc_test',
    livemode: false,
    objectId: chargeId,
    objectType: 'charge',
    createdAt: Math.floor(Date.now() / 1000),
    object: {
      id: chargeId,
      orderId,
      status,
    },
  };
}

/** The same envelope with the token pair a tokenising charge returns. */
function buildTokenisedEnvelope(
  orderId: string,
  status: string,
  chargeId: string,
  token: { paymentToken: string; sequenceId: string; last4: string; brand: string },
) {
  const envelope = buildMoneiEnvelope(orderId, status, chargeId) as any;
  envelope.object.paymentToken = token.paymentToken;
  envelope.object.sequenceId = token.sequenceId;
  envelope.object.paymentMethod = { card: { last4: token.last4, brand: token.brand } };
  return envelope;
}

function signedHeaders(body: string, secret: string, timestamp = String(Math.floor(Date.now() / 1000))) {
  const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return { 'monei-signature': `t=${timestamp},v1=${sig}` };
}

async function postWebhook(payload: unknown) {
  const raw = JSON.stringify(payload);
  return request
    .post('/webhooks/payment')
    .set(signedHeaders(raw, MONEI_WEBHOOK_SECRET))
    .set('Content-Type', 'application/json')
    .send(raw);
}

describe('POST /webhooks/payment — completion flow', () => {
  let gymId: string;
  let userMembershipId: number;
  let memberId: number;
  let chargeTypeId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Webhook Completion Gym');
    memberId = await createMember(gymId);
    const planId = await createMembershipPlan(gymId);
    userMembershipId = await createUserMembership(gymId, memberId, planId);
    chargeTypeId = await getChargeTypeId();
  });

  it('an intermediate status (e.g. AUTHORIZED) does not strand the row — a later completed webhook still completes it', async () => {
    const orderId = crypto.randomUUID();
    const chargeId = crypto.randomBytes(20).toString('hex');
    const prId = await insertPendingPaymentRequest(gymId, userMembershipId, memberId, chargeTypeId, orderId);

    // Regression: this used to fall into the catch-all branch and mark the
    // row 'expired', which then made the real completed webhook below get
    // skipped by the "already processed" guard.
    const intermediateRes = await postWebhook(buildMoneiEnvelope(orderId, 'AUTHORIZED', chargeId));
    expect(intermediateRes.status).toBe(200);

    const { rows: afterIntermediate } = await db.query<{ status: string }>(
      'SELECT status FROM payment_requests WHERE id = ?',
      [prId],
    );
    expect(afterIntermediate[0].status).toBe('pending');

    const completedRes = await postWebhook(buildMoneiEnvelope(orderId, 'SUCCEEDED', chargeId));
    expect(completedRes.status).toBe(200);

    const { rows: afterCompleted } = await db.query<{ status: string; completed_at: string | null }>(
      'SELECT status, completed_at FROM payment_requests WHERE id = ?',
      [prId],
    );
    expect(afterCompleted[0].status).toBe('completed');
    expect(afterCompleted[0].completed_at).not.toBeNull();

    const { rows: billingEvents } = await db.query(
      `SELECT id FROM billing_events WHERE user_membership_id = ? AND event_type = 'payment_recorded'`,
      [userMembershipId],
    );
    expect(billingEvents.length).toBe(1);
  });

  it('a terminal EXPIRED status marks the payment_request as expired directly', async () => {
    const orderId = crypto.randomUUID();
    const chargeId = crypto.randomBytes(20).toString('hex');
    const prId = await insertPendingPaymentRequest(gymId, userMembershipId, memberId, chargeTypeId, orderId);

    const res = await postWebhook(buildMoneiEnvelope(orderId, 'EXPIRED', chargeId));
    expect(res.status).toBe(200);

    const { rows } = await db.query<{ status: string }>(
      'SELECT status FROM payment_requests WHERE id = ?',
      [prId],
    );
    expect(rows[0].status).toBe('expired');
  });

  // #785: the member paying their checkout link is the third money-arrival path,
  // beside the nightly run's own success branch and the two staff actions. It
  // settles the very cycle a rejection is counted against, so it has to clear the
  // run's dunning state too — otherwise a member who was one rejection away, paid
  // the link, and declined on the *next* cycle would be paused an attempt short.
  //
  // Its own membership, so the `payment_recorded` row it writes cannot disturb the
  // event count the test above asserts on the shared one.
  it('clears the nightly run\u2019s dunning state when a payment completes (#785)', async () => {
    const ownMemberId = await createMember(gymId);
    const ownPlanId = await createMembershipPlan(gymId);
    const ownMembershipId = await createUserMembership(gymId, ownMemberId, ownPlanId);
    await db.query(
      'UPDATE user_memberships SET failed_attempts = 1, last_failed_at = UTC_TIMESTAMP() WHERE id = ?',
      [ownMembershipId],
    );

    const orderId = crypto.randomUUID();
    const chargeId = crypto.randomBytes(20).toString('hex');
    await insertPendingPaymentRequest(gymId, ownMembershipId, ownMemberId, chargeTypeId, orderId);

    expect((await postWebhook(buildMoneiEnvelope(orderId, 'SUCCEEDED', chargeId))).status).toBe(200);

    const { rows } = await db.query<{ failed_attempts: number; last_failed_at: Date | null }>(
      'SELECT failed_attempts, last_failed_at FROM user_memberships WHERE id = ?',
      [ownMembershipId],
    );
    expect(Number(rows[0].failed_attempts)).toBe(0);
    expect(rows[0].last_failed_at).toBeNull();
  });
});

// #788: a card replacement is a zero-amount verification. It hands the webhook a
// new token and nothing else — no money arrived, so nothing may be recorded as
// if it had.
describe('POST /webhooks/payment — card update (#788)', () => {
  let gymId: string;
  let memberId: number;
  let userMembershipId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Webhook Card Update Gym');
    memberId = await createMember(gymId);
    const planId = await createMembershipPlan(gymId);
    userMembershipId = await createUserMembership(gymId, memberId, planId);
  });

  async function storedCard() {
    const { rows } = await db.query<{
      payment_token: string; sequence_id: string; card_last4: string | null;
      card_brand: string | null; updated_at: Date | null;
    }>(
      'SELECT payment_token, sequence_id, card_last4, card_brand, updated_at FROM payment_methods WHERE gym_id = ? AND member_id = ?',
      [gymId, memberId],
    );
    return rows[0] ?? null;
  }

  it('stores the new token and records no payment at all', async () => {
    await db.query(
      `INSERT INTO payment_methods (gym_id, member_id, provider, payment_token, sequence_id, card_last4, card_brand)
       VALUES (?, ?, 'monei', 'tok_old', 'seq_old', '1111', 'visa')`,
      [gymId, memberId],
    );

    const orderId = crypto.randomUUID();
    const chargeId = crypto.randomBytes(20).toString('hex');
    const prId = await insertPendingCardUpdate(gymId, userMembershipId, memberId, orderId);

    const res = await postWebhook(buildTokenisedEnvelope(orderId, 'SUCCEEDED', chargeId, {
      paymentToken: 'tok_new', sequenceId: 'seq_new', last4: '4242', brand: 'mastercard',
    }));
    expect(res.status).toBe(200);

    const card = await storedCard();
    expect(card).toMatchObject({
      payment_token: 'tok_new', sequence_id: 'seq_new', card_last4: '4242', card_brand: 'mastercard',
    });
    // Migration 195: the upsert dates the card on file, so "stored since" does
    // not keep reporting the first payment's timestamp.
    expect(card!.updated_at).not.toBeNull();

    const { rows: request_row } = await db.query<{ status: string; completed_at: Date | null }>(
      'SELECT status, completed_at FROM payment_requests WHERE id = ?',
      [prId],
    );
    expect(request_row[0].status).toBe('completed');
    expect(request_row[0].completed_at).not.toBeNull();

    // No Billing Event of any kind: the ledger records money, and none moved.
    const { rows: events } = await db.query(
      'SELECT id, event_type FROM billing_events WHERE user_membership_id = ?',
      [userMembershipId],
    );
    expect(events).toEqual([]);

    // And no billing schedule was invented for a member who has not paid yet.
    const { rows: um } = await db.query<{ next_billing_date: Date | null }>(
      'SELECT next_billing_date FROM user_memberships WHERE id = ?',
      [userMembershipId],
    );
    expect(um[0].next_billing_date).toBeNull();
  });

  it('leaves the nightly run\u2019s dunning state alone \u2014 the rejected cycle is still owed', async () => {
    const ownMemberId = await createMember(gymId);
    const ownPlanId = await createMembershipPlan(gymId);
    const ownMembershipId = await createUserMembership(gymId, ownMemberId, ownPlanId);
    await db.query(
      'UPDATE user_memberships SET failed_attempts = 1, last_failed_at = UTC_TIMESTAMP() WHERE id = ?',
      [ownMembershipId],
    );

    const orderId = crypto.randomUUID();
    const chargeId = crypto.randomBytes(20).toString('hex');
    await insertPendingCardUpdate(gymId, ownMembershipId, ownMemberId, orderId);

    expect((await postWebhook(buildTokenisedEnvelope(orderId, 'SUCCEEDED', chargeId, {
      paymentToken: 'tok_dunning', sequenceId: 'seq_dunning', last4: '4242', brand: 'visa',
    }))).status).toBe(200);

    // Replacing a card is not paying: #785's counter clears when a cycle is
    // settled, waived or reactivated, and a verification does none of those.
    const { rows } = await db.query<{ failed_attempts: number; last_failed_at: Date | null }>(
      'SELECT failed_attempts, last_failed_at FROM user_memberships WHERE id = ?',
      [ownMembershipId],
    );
    expect(Number(rows[0].failed_attempts)).toBe(1);
    expect(rows[0].last_failed_at).not.toBeNull();
  });

  it('a rejected verification leaves the previous card in place', async () => {
    const ownMemberId = await createMember(gymId);
    const ownPlanId = await createMembershipPlan(gymId);
    const ownMembershipId = await createUserMembership(gymId, ownMemberId, ownPlanId);
    await db.query(
      `INSERT INTO payment_methods (gym_id, member_id, provider, payment_token, sequence_id, card_last4, card_brand)
       VALUES (?, ?, 'monei', 'tok_keep', 'seq_keep', '9999', 'visa')`,
      [gymId, ownMemberId],
    );

    const orderId = crypto.randomUUID();
    const chargeId = crypto.randomBytes(20).toString('hex');
    const prId = await insertPendingCardUpdate(gymId, ownMembershipId, ownMemberId, orderId);

    expect((await postWebhook(buildMoneiEnvelope(orderId, 'FAILED', chargeId))).status).toBe(200);

    const { rows } = await db.query<{ payment_token: string; card_last4: string | null }>(
      'SELECT payment_token, card_last4 FROM payment_methods WHERE gym_id = ? AND member_id = ?',
      [gymId, ownMemberId],
    );
    expect(rows[0]).toMatchObject({ payment_token: 'tok_keep', card_last4: '9999' });

    const { rows: request_row } = await db.query<{ status: string }>(
      'SELECT status FROM payment_requests WHERE id = ?',
      [prId],
    );
    expect(request_row[0].status).toBe('failed');
  });

  it('a verification that completes without a token keeps the card that is there', async () => {
    const ownMemberId = await createMember(gymId);
    const ownPlanId = await createMembershipPlan(gymId);
    const ownMembershipId = await createUserMembership(gymId, ownMemberId, ownPlanId);
    await db.query(
      `INSERT INTO payment_methods (gym_id, member_id, provider, payment_token, sequence_id, card_last4, card_brand)
       VALUES (?, ?, 'monei', 'tok_still_here', 'seq_still_here', '4444', 'visa')`,
      [gymId, ownMemberId],
    );

    const orderId = crypto.randomUUID();
    const chargeId = crypto.randomBytes(20).toString('hex');
    const prId = await insertPendingCardUpdate(gymId, ownMembershipId, ownMemberId, orderId);

    expect((await postWebhook(buildMoneiEnvelope(orderId, 'SUCCEEDED', chargeId))).status).toBe(200);

    const { rows } = await db.query<{ payment_token: string }>(
      'SELECT payment_token FROM payment_methods WHERE gym_id = ? AND member_id = ?',
      [gymId, ownMemberId],
    );
    expect(rows[0].payment_token).toBe('tok_still_here');

    const { rows: request_row } = await db.query<{ status: string }>(
      'SELECT status FROM payment_requests WHERE id = ?',
      [prId],
    );
    expect(request_row[0].status).toBe('completed');
  });
});
