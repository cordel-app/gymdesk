import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym, request } from './helpers';

const MONEI_WEBHOOK_SECRET = 'test-webhook-secret';

const BILLING_SECRET = 'test-webhooks-billing-secret';

beforeAll(() => {
  // POST /webhooks/payment needs a real provider configured to verify
  // signatures — getPaymentProvider() throws (mapped to a generic 400
  // elsewhere) without these.
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = MONEI_WEBHOOK_SECRET;
  // #789's race test drives the real `POST /billing/cleanup` between the page
  // load and the webhook, rather than asserting against a hand-written status.
  process.env.BILLING_INTERNAL_SECRET = BILLING_SECRET;
});

afterAll(async () => {
  delete process.env.MONEI_API_KEY;
  delete process.env.MONEI_WEBHOOK_SECRET;
  delete process.env.BILLING_INTERNAL_SECRET;
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

/**
 * `card` is what a real CIT `charge.succeeded` carries when the request asked
 * for `generatePaymentToken` — the token, the sequence id and the card display
 * fields the `payment_methods` upsert reads. Omitted by the cases that only
 * care about the request's own status.
 */
type MoneiCard = {
  paymentToken: string;
  sequenceId: string;
  last4: string;
  brand: string;
};

function buildMoneiEnvelope(orderId: string, status: string, chargeId: string, card?: MoneiCard) {
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
      ...(card
        ? {
            paymentToken: card.paymentToken,
            sequenceId: card.sequenceId,
            paymentMethod: { card: { last4: card.last4, brand: card.brand } },
          }
        : {}),
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

// ─── #789: the completed path, asserted end to end ───────────────────────────
//
// Before this, `webhooks.test.ts` asserted only `payment_requests.status`,
// `completed_at` and the `payment_recorded` event. Everything else the completed
// branch writes — the stored card, the first `next_billing_date`, the
// `billing_event_id` back-link — was untested, which is how the cleanup race
// below stayed invisible: the row it stranded looked fine in the one column
// anybody checked.

/** A plan with a billing policy, so the webhook's cadence join has something to read. */
async function createPlanWithPolicy(gymId: string, interval = 1, unit = 'month'): Promise<number> {
  const planId = await createMembershipPlan(gymId);
  await db.query(
    `INSERT INTO billing_policies
       (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, ?, ?)`,
    [gymId, planId, interval, unit],
  );
  return planId;
}

/** An assignment with a known `starts_at`, which is what the first due date is computed from. */
async function createMembershipStartingOn(
  gymId: string,
  memberId: number,
  planId: number,
  startsAt: string,
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO user_memberships (gym_id, member_id, membership_plan_id, status, starts_at, base_price)
     VALUES (?, ?, ?, 'active', ?, '5.00')`,
    [gymId, memberId, planId, startsAt],
  );
  return insertId;
}

/** mysql2 hands a DATE/DATETIME back as a string or a Date depending on the connection. */
function dateOnly(v: Date | string | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

async function readRequest(id: number) {
  const { rows } = await db.query<{
    status: string;
    billing_event_id: number | null;
    page_token: string | null;
    completed_at: Date | null;
  }>(
    'SELECT status, billing_event_id, page_token, completed_at FROM payment_requests WHERE id = ?',
    [id],
  );
  return rows[0];
}

async function readStoredCard(gymId: string, memberId: number) {
  const { rows } = await db.query<{
    payment_token: string;
    sequence_id: string;
    card_last4: string | null;
    card_brand: string | null;
  }>(
    'SELECT payment_token, sequence_id, card_last4, card_brand FROM payment_methods WHERE gym_id = ? AND member_id = ?',
    [gymId, memberId],
  );
  return rows;
}

async function readNextBillingDate(id: number): Promise<string | null> {
  const { rows } = await db.query<{ next_billing_date: Date | string | null }>(
    'SELECT next_billing_date FROM user_memberships WHERE id = ?',
    [id],
  );
  return dateOnly(rows[0].next_billing_date);
}

function randomCard(): MoneiCard {
  const suffix = crypto.randomBytes(6).toString('hex');
  return {
    paymentToken: `tok_${suffix}`,
    sequenceId: `seq_${suffix}`,
    last4: '4242',
    brand: 'visa',
  };
}

describe('POST /webhooks/payment — what a completed CIT charge writes', () => {
  let gymId: string;
  let chargeTypeId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Webhook Completed Writes Gym');
    chargeTypeId = await getChargeTypeId();
  });

  /** A fresh member + plan + assignment per case, so one test's card cannot be another's. */
  async function fixture(startsAt = '2099-01-15', interval = 1, unit = 'month') {
    const memberId = await createMember(gymId);
    const planId = await createPlanWithPolicy(gymId, interval, unit);
    const userMembershipId = await createMembershipStartingOn(gymId, memberId, planId, startsAt);
    return { memberId, planId, userMembershipId };
  }

  it('upserts payment_methods with the token, sequence id, brand and last4 from the payload', async () => {
    const { memberId, userMembershipId } = await fixture();
    const orderId = crypto.randomUUID();
    const card = randomCard();
    await insertPendingPaymentRequest(gymId, userMembershipId, memberId, chargeTypeId, orderId);

    const res = await postWebhook(
      buildMoneiEnvelope(orderId, 'SUCCEEDED', crypto.randomBytes(20).toString('hex'), card),
    );
    expect(res.status).toBe(200);

    const stored = await readStoredCard(gymId, memberId);
    expect(stored).toHaveLength(1);
    expect(stored[0].payment_token).toBe(card.paymentToken);
    expect(stored[0].sequence_id).toBe(card.sequenceId);
    expect(stored[0].card_last4).toBe(card.last4);
    expect(stored[0].card_brand).toBe(card.brand);
  });

  it('a second completed payment replaces the stored card rather than adding a row', async () => {
    const { memberId, userMembershipId } = await fixture();

    const first = randomCard();
    const firstOrder = crypto.randomUUID();
    await insertPendingPaymentRequest(gymId, userMembershipId, memberId, chargeTypeId, firstOrder);
    expect(
      (await postWebhook(buildMoneiEnvelope(firstOrder, 'SUCCEEDED', crypto.randomBytes(20).toString('hex'), first)))
        .status,
    ).toBe(200);

    const second: MoneiCard = { ...randomCard(), last4: '1881', brand: 'mastercard' };
    const secondOrder = crypto.randomUUID();
    await insertPendingPaymentRequest(gymId, userMembershipId, memberId, chargeTypeId, secondOrder);
    expect(
      (await postWebhook(buildMoneiEnvelope(secondOrder, 'SUCCEEDED', crypto.randomBytes(20).toString('hex'), second)))
        .status,
    ).toBe(200);

    // One row per member and gym — the upsert's ON DUPLICATE KEY.
    const stored = await readStoredCard(gymId, memberId);
    expect(stored).toHaveLength(1);
    expect(stored[0].payment_token).toBe(second.paymentToken);
    expect(stored[0].sequence_id).toBe(second.sequenceId);
    expect(stored[0].card_last4).toBe('1881');
    expect(stored[0].card_brand).toBe('mastercard');
  });

  // Future `starts_at` throughout this file: since #790 a back-dated one stamps
  // the first boundary after *today*, so a fixed past date here would make the
  // expected value depend on the day the suite runs. The back-dated and
  // starts-today cases live in `backdated-first-charge.test.ts`.
  it('stamps the first next_billing_date as starts_at + the assignment cadence', async () => {
    const { memberId, userMembershipId } = await fixture('2099-01-15', 1, 'month');
    expect(await readNextBillingDate(userMembershipId)).toBeNull();

    const orderId = crypto.randomUUID();
    await insertPendingPaymentRequest(gymId, userMembershipId, memberId, chargeTypeId, orderId);

    expect(
      (await postWebhook(buildMoneiEnvelope(orderId, 'SUCCEEDED', crypto.randomBytes(20).toString('hex'), randomCard())))
        .status,
    ).toBe(200);

    expect(await readNextBillingDate(userMembershipId)).toBe('2099-02-15');
  });

  it('takes the cadence from the assignment snapshot, not the Plan, when it has one', async () => {
    const { memberId, userMembershipId } = await fixture('2099-03-01', 1, 'month');
    // #635 stage 3: ASSIGNMENT_CADENCE is COALESCE(um.*, bp.*) — a frozen
    // cadence outranks the Plan's live policy.
    await db.query(
      `UPDATE user_memberships
       SET recurring_billing_interval = 3, recurring_billing_unit = 'month'
       WHERE id = ?`,
      [userMembershipId],
    );

    const orderId = crypto.randomUUID();
    await insertPendingPaymentRequest(gymId, userMembershipId, memberId, chargeTypeId, orderId);
    expect(
      (await postWebhook(buildMoneiEnvelope(orderId, 'SUCCEEDED', crypto.randomBytes(20).toString('hex'), randomCard())))
        .status,
    ).toBe(200);

    expect(await readNextBillingDate(userMembershipId)).toBe('2099-06-01');
  });

  it('leaves next_billing_date alone when it is already set', async () => {
    const { memberId, userMembershipId } = await fixture('2026-01-15', 1, 'month');
    await db.query('UPDATE user_memberships SET next_billing_date = ? WHERE id = ?', ['2026-11-30', userMembershipId]);

    const orderId = crypto.randomUUID();
    await insertPendingPaymentRequest(gymId, userMembershipId, memberId, chargeTypeId, orderId);
    expect(
      (await postWebhook(buildMoneiEnvelope(orderId, 'SUCCEEDED', crypto.randomBytes(20).toString('hex'), randomCard())))
        .status,
    ).toBe(200);

    expect(await readNextBillingDate(userMembershipId)).toBe('2026-11-30');
  });

  it('back-links the payment_request to the billing_events row it wrote', async () => {
    const { memberId, userMembershipId } = await fixture();
    const orderId = crypto.randomUUID();
    const prId = await insertPendingPaymentRequest(gymId, userMembershipId, memberId, chargeTypeId, orderId);

    expect(
      (await postWebhook(buildMoneiEnvelope(orderId, 'SUCCEEDED', crypto.randomBytes(20).toString('hex'))))
        .status,
    ).toBe(200);

    const pr = await readRequest(prId);
    // The `insertId` defect #635 stage 3 fixed: reading it off `rows` left this
    // NULL and rolled the whole transaction back on every real completion.
    expect(pr.billing_event_id).not.toBeNull();
    const { rows: events } = await db.query<{ id: number; event_type: string; amount: string }>(
      'SELECT id, event_type, amount FROM billing_events WHERE id = ?',
      [pr.billing_event_id],
    );
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('payment_recorded');
    expect(Number(events[0].amount)).toBe(5);
  });

  it('stores no card and stamps no date when the provider returned no reusable token', async () => {
    const { memberId, userMembershipId } = await fixture();
    const orderId = crypto.randomUUID();
    const prId = await insertPendingPaymentRequest(gymId, userMembershipId, memberId, chargeTypeId, orderId);

    // No `card` on the envelope — a charge made without `generatePaymentToken`.
    expect(
      (await postWebhook(buildMoneiEnvelope(orderId, 'SUCCEEDED', crypto.randomBytes(20).toString('hex'))))
        .status,
    ).toBe(200);

    // The payment still lands; only the MIT-enabling half is absent.
    expect((await readRequest(prId)).status).toBe('completed');
    expect(await readStoredCard(gymId, memberId)).toHaveLength(0);
    expect(await readNextBillingDate(userMembershipId)).toBeNull();
  });
});

describe('POST /webhooks/payment — cleanup must not lose a payment that was made (#789)', () => {
  let gymId: string;
  let chargeTypeId: number;

  beforeAll(async () => {
    gymId = await createTestGym('Webhook Cleanup Race Gym');
    chargeTypeId = await getChargeTypeId();
  });

  async function fixture() {
    const memberId = await createMember(gymId);
    const planId = await createMembershipPlan(gymId);
    await db.query(
      `INSERT INTO billing_policies
         (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
       VALUES (?, ?, 1, 'month')`,
      [gymId, planId],
    );
    const userMembershipId = await createMembershipStartingOn(gymId, memberId, planId, '2099-01-15');
    return { memberId, userMembershipId };
  }

  /** A request the payment page can actually load: real token, future TTL, provider_ref set. */
  async function insertLoadableRequest(
    userMembershipId: number,
    memberId: number,
    orderId: string,
  ): Promise<{ id: number; token: string }> {
    const token = crypto.randomUUID();
    const { insertId } = await db.query(
      `INSERT INTO payment_requests
         (gym_id, user_membership_id, member_id, amount, currency, charge_type_id,
          status, provider, provider_order, provider_ref, page_token, page_token_expires,
          consent_given_at, source)
       VALUES (?, ?, ?, '5.00', 'EUR', ?, 'pending', 'monei', ?, ?, ?,
               DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE), UTC_TIMESTAMP(), 'customer')`,
      [gymId, userMembershipId, memberId, chargeTypeId, orderId, `monei_${orderId}`, token],
    );
    return { id: insertId, token };
  }

  // The regression, end to end and with no hand-written statuses: the member
  // opens the checkout page (which consumes the token), the ten-minute TTL then
  // passes while they are in the Card Input and 3DS, cleanup runs, and the
  // provider's webhook arrives last. Every one of those is the real code path.
  it('a payment completed after the page was opened and cleanup ran is still recorded in full', async () => {
    const { memberId, userMembershipId } = await fixture();
    const orderId = crypto.randomUUID();
    const { id: prId, token } = await insertLoadableRequest(userMembershipId, memberId, orderId);

    const page = await request.get(`/payment-page/token/${token}`);
    expect(page.status).toBe(200);
    // Consuming the token is what marks the page as opened.
    expect((await readRequest(prId)).page_token).toBeNull();

    // The member is now in the Card Input; the token's ten minutes run out.
    await db.query(
      'UPDATE payment_requests SET page_token_expires = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 MINUTE) WHERE id = ?',
      [prId],
    );

    const cleanup = await request.post('/billing/cleanup').set('x-internal-secret', BILLING_SECRET);
    expect(cleanup.status).toBe(200);
    // Before the fix this read 'expired', and every assertion below failed.
    expect((await readRequest(prId)).status).toBe('pending');

    const card = randomCard();
    expect(
      (await postWebhook(buildMoneiEnvelope(orderId, 'SUCCEEDED', crypto.randomBytes(20).toString('hex'), card)))
        .status,
    ).toBe(200);

    const pr = await readRequest(prId);
    expect(pr.status).toBe('completed');
    expect(pr.completed_at).not.toBeNull();
    expect(pr.billing_event_id).not.toBeNull();

    const stored = await readStoredCard(gymId, memberId);
    expect(stored).toHaveLength(1);
    expect(stored[0].payment_token).toBe(card.paymentToken);

    expect(await readNextBillingDate(userMembershipId)).toBe('2099-02-15');
  });

  // The second half of the fix, and the safety net for every other way a row can
  // reach a terminal status before the money's webhook does — Monei retrying
  // after a 5xx on our side, or the long abandonment window running out on a
  // member who paid at the very end of it.
  it('completes an already-expired request, because the provider is the source of truth about money', async () => {
    const { memberId, userMembershipId } = await fixture();
    const orderId = crypto.randomUUID();
    const { id: prId } = await insertLoadableRequest(userMembershipId, memberId, orderId);
    await db.query(`UPDATE payment_requests SET status = 'expired', page_token = NULL WHERE id = ?`, [prId]);

    const card = randomCard();
    expect(
      (await postWebhook(buildMoneiEnvelope(orderId, 'SUCCEEDED', crypto.randomBytes(20).toString('hex'), card)))
        .status,
    ).toBe(200);

    const pr = await readRequest(prId);
    expect(pr.status).toBe('completed');
    expect(pr.billing_event_id).not.toBeNull();
    expect((await readStoredCard(gymId, memberId))[0].payment_token).toBe(card.paymentToken);
    expect(await readNextBillingDate(userMembershipId)).toBe('2099-02-15');
  });

  it('does not revive an expired request on a failed webhook — only money reopens one', async () => {
    const { memberId, userMembershipId } = await fixture();
    const orderId = crypto.randomUUID();
    const { id: prId } = await insertLoadableRequest(userMembershipId, memberId, orderId);
    await db.query(`UPDATE payment_requests SET status = 'expired', page_token = NULL WHERE id = ?`, [prId]);

    expect(
      (await postWebhook(buildMoneiEnvelope(orderId, 'FAILED', crypto.randomBytes(20).toString('hex'))))
        .status,
    ).toBe(200);

    const pr = await readRequest(prId);
    expect(pr.status).toBe('expired');
    expect(pr.billing_event_id).toBeNull();
    expect(await readStoredCard(gymId, memberId)).toHaveLength(0);
  });

  it('stays idempotent: a retried completed webhook on a completed row writes nothing twice', async () => {
    const { memberId, userMembershipId } = await fixture();
    const orderId = crypto.randomUUID();
    const { id: prId } = await insertLoadableRequest(userMembershipId, memberId, orderId);
    const chargeId = crypto.randomBytes(20).toString('hex');
    const card = randomCard();

    expect((await postWebhook(buildMoneiEnvelope(orderId, 'SUCCEEDED', chargeId, card))).status).toBe(200);
    const firstEventId = (await readRequest(prId)).billing_event_id;

    // Monei retries the very same event.
    expect((await postWebhook(buildMoneiEnvelope(orderId, 'SUCCEEDED', chargeId, card))).status).toBe(200);

    expect((await readRequest(prId)).billing_event_id).toBe(firstEventId);
    const { rows: events } = await db.query(
      `SELECT id FROM billing_events WHERE user_membership_id = ? AND event_type = 'payment_recorded'`,
      [userMembershipId],
    );
    expect(events).toHaveLength(1);
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
