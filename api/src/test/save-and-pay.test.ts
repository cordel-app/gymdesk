// #1108 stage 2 — **Save & Pay → Pending Payment → Active**, over the real
// Express + MySQL path.
//
// What the unit gate beside this file cannot see is the behaviour: that a
// committed configuration really stops moving, that a provider failure leaves a
// Draft a Draft, that nothing is cancelled until the money arrives, and that the
// webhook is what turns a locked assignment into the member's plan. Only the
// provider's `createPaymentRequest` is stubbed — the webhook still verifies a
// real Monei signature.

import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

const MONEI_WEBHOOK_SECRET = 'test-1108-webhook-secret';

const provider = vi.hoisted(() => ({
  calls: [] as Array<{ orderId: string; amount: number; currency: string }>,
  /** Set to make the next provider call throw, as an outage would. */
  fail: false,
}));
vi.mock('../payments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../payments')>();
  return {
    ...actual,
    getPaymentProvider: () => {
      const real = actual.getPaymentProvider();
      return {
        parseWebhook: real.parseWebhook.bind(real),
        createPaymentRequest: async (params: { orderId: string; amount: number; currency: string }) => {
          if (provider.fail) throw new Error('provider unreachable');
          provider.calls.push(params);
          return { providerOrderId: `monei-${params.orderId}` };
        },
      };
    },
  };
});

let gymId: string;

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = MONEI_WEBHOOK_SECRET;
  gymId = await createTestGym('Save And Pay Gym');
  await createTestMembership(gymId, 'admin');
});

afterAll(async () => {
  delete process.env.MONEI_API_KEY;
  delete process.env.MONEI_WEBHOOK_SECRET;
  await cleanupTestGyms();
  await db.end();
});

// ── fixtures ─────────────────────────────────────────────────────────────────

let seq = 0;
const uniq = () => `${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2, 6)}`;

const api = (method: 'get' | 'post' | 'put' | 'delete', path: string, gym = gymId) =>
  (request as any)[method](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gym);

async function createMember(gym = gymId): Promise<number> {
  const { insertId } = await db.query(
    'INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)',
    [gym, 'Save And Pay Member', `sap-${uniq()}@test.com`],
  );
  return insertId;
}

/**
 * A monthly Plan at €40. `freePeriods` is what makes the first cycle owe nothing,
 * which is the branch that commits without a payment at all.
 */
async function createPlan(
  opts: { gym?: string; price?: number; freePeriods?: number } = {},
): Promise<number> {
  const gym = opts.gym ?? gymId;
  const { insertId } = await db.query(
    `INSERT INTO membership_plans
       (gym_id, name, lifecycle_status, enrollment_status, member_limit, free_periods)
     VALUES (?, ?, 'active', 'public', '1', ?)`,
    [gym, `SAP Plan ${uniq()}`, opts.freePeriods ?? 0],
  );
  await db.query(
    `INSERT INTO membership_plan_prices (gym_id, membership_plan_id, price, valid_from, status)
     VALUES (?, ?, ?, '2025-01-01', 'active')`,
    [gym, insertId, opts.price ?? 40],
  );
  await db.query(
    // `auto_renew` pinned off: nothing here is about the cycle starting again.
    `INSERT INTO billing_policies
       (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit, auto_renew)
     VALUES (?, ?, 1, 'month', 0)`,
    [gym, insertId],
  );
  return insertId;
}

/** Assign the plan the way the admin does, which creates a Draft (#1108 stage 1). */
async function assignPlan(
  memberId: number, planId: number, startsAt = '2026-01-01', gym = gymId,
): Promise<number> {
  const res = await api('post', '/user-memberships', gym).send({
    member_id: memberId, membership_plan_id: planId, starts_at: startsAt,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body.status).toBe('draft');
  return res.body.id;
}

async function readStatus(id: number): Promise<string> {
  const { rows } = await db.query<{ status: string }>(
    'SELECT status FROM user_memberships WHERE id = ?', [id],
  );
  return rows[0].status;
}

async function feeRequests(id: number) {
  const { rows } = await db.query<{ id: number; status: string; amount: string; source: string }>(
    `SELECT id, status, amount, source FROM payment_requests
      WHERE user_membership_id = ? ORDER BY id`,
    [id],
  );
  return rows;
}

async function statusChanges(id: number) {
  const { rows } = await db.query<{ previous_status: string | null; new_status: string }>(
    `SELECT previous_status, new_status FROM billing_events
      WHERE user_membership_id = ? AND event_type = 'status_changed' ORDER BY id`,
    [id],
  );
  return rows;
}

function signedHeaders(body: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', MONEI_WEBHOOK_SECRET).update(`${ts}.${body}`).digest('hex');
  return { 'monei-signature': `t=${ts},v1=${sig}` };
}

/** The member opens the checkout link and pays: a tokenising CIT charge succeeds. */
async function payCheckout(orderId: string) {
  const chargeId = crypto.randomBytes(20).toString('hex');
  const raw = JSON.stringify({
    id: `evt_${chargeId}`,
    type: 'charge.succeeded',
    accountId: 'acc_test',
    livemode: false,
    objectId: chargeId,
    objectType: 'charge',
    createdAt: Math.floor(Date.now() / 1000),
    object: {
      id: chargeId,
      orderId,
      status: 'SUCCEEDED',
      paymentToken: `tok_${uniq()}`,
      sequenceId: `seq_${uniq()}`,
      paymentMethod: { card: { last4: '4242', brand: 'visa' } },
    },
  });
  const res = await request
    .post('/webhooks/payment')
    .set(signedHeaders(raw))
    .set('Content-Type', 'application/json')
    .send(raw);
  expect(res.status).toBe(200);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /user-memberships/:id/save-and-pay', () => {
  it('commits the Draft, raises the charge and locks the configuration', async () => {
    const memberId = await createMember();
    const draft = await assignPlan(memberId, await createPlan());

    const res = await api('post', `/user-memberships/${draft}/save-and-pay`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.activated).toBe(false);
    expect(res.body.payment.checkoutUrl).toContain('token=');
    expect(Number(res.body.payment.amount)).toBeGreaterThan(0);

    expect(await readStatus(draft)).toBe('pending_payment');
    const requests = await feeRequests(draft);
    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBe('pending');
    expect(requests[0].source).toBe('admin');

    // The provider is told the amount in minor units (CLAUDE.md's rule).
    const call = provider.calls.find((c) => c.amount > 0);
    expect(call).toBeDefined();
    expect(Number.isInteger(call!.amount)).toBe(true);

    // The lock is a real transition and says so in the ledger.
    expect(await statusChanges(draft)).toEqual([
      { previous_status: 'draft', new_status: 'pending_payment' },
    ]);
  });

  it('commits outright, with no payment at all, when the first cycle owes nothing', async () => {
    const memberId = await createMember();
    // A Free Period of 12 months means the cycle this would be charged for is
    // waived, so there is nothing to pay and nothing to wait for.
    const draft = await assignPlan(memberId, await createPlan({ freePeriods: 12 }), '2026-01-01');

    const res = await api('post', `/user-memberships/${draft}/save-and-pay`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.activated).toBe(true);
    expect(res.body.payment).toBeNull();
    expect(await readStatus(draft)).toBe('active');
    expect(await feeRequests(draft)).toHaveLength(0);
    expect(await statusChanges(draft)).toEqual([
      { previous_status: 'draft', new_status: 'active' },
    ]);
  });

  it('leaves the Draft untouched when the provider cannot be reached', async () => {
    const memberId = await createMember();
    const draft = await assignPlan(memberId, await createPlan());

    provider.fail = true;
    try {
      const res = await api('post', `/user-memberships/${draft}/save-and-pay`).send({});
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      provider.fail = false;
    }
    // Nothing written: no charge, no lock. The provider call deliberately happens
    // before either write.
    expect(await readStatus(draft)).toBe('draft');
    expect(await feeRequests(draft)).toHaveLength(0);
  });

  it('answers 404 for another gym\'s assignment', async () => {
    const otherGym = await createTestGym('Save And Pay Other Gym');
    await createTestMembership(otherGym, 'admin');
    const memberId = await createMember(otherGym);
    const draft = await assignPlan(
      memberId, await createPlan({ gym: otherGym }), '2026-01-01', otherGym,
    );

    const res = await api('post', `/user-memberships/${draft}/save-and-pay`).send({});
    expect(res.status).toBe(404);
    expect(await readStatus(draft)).toBe('draft');
  });

  it('rejects an unauthenticated call', async () => {
    const res = await request.post('/user-memberships/1/save-and-pay').send({});
    expect(res.status).toBe(401);
  });

  it('refuses a caller whose role has no PAYMENTS access', async () => {
    // The role comes from the caller's own `gym_memberships` row, so the gym is
    // what differs: in this one the test user is a `member`, for whom PAYMENTS is
    // NONE in the permission matrix.
    const memberGym = await createTestGym('Save And Pay Member Role Gym');
    await createTestMembership(memberGym, 'member');
    const res = await api('post', '/user-memberships/1/save-and-pay', memberGym).send({});
    expect(res.status).toBe(403);
  });

  it('refuses anything that is not waiting to be committed', async () => {
    const memberId = await createMember();
    const draft = await assignPlan(memberId, await createPlan({ freePeriods: 12 }));
    expect((await api('post', `/user-memberships/${draft}/save-and-pay`).send({})).status).toBe(200);

    const again = await api('post', `/user-memberships/${draft}/save-and-pay`).send({});
    expect(again.status).toBe(400);
    expect(String(again.body.error)).toContain('active');
  });
});

describe('#956\'s replacement is confirmed at Save & Pay and acted on at the commit', () => {
  it('409s for an unconfirmed replacement and cancels nothing on confirm', async () => {
    const memberId = await createMember();
    const live = await assignPlan(memberId, await createPlan({ freePeriods: 12 }), '2026-01-01');
    expect((await api('post', `/user-memberships/${live}/save-and-pay`).send({})).status).toBe(200);
    expect(await readStatus(live)).toBe('active');

    const draft = await assignPlan(memberId, await createPlan(), '2026-09-01');
    const refused = await api('post', `/user-memberships/${draft}/save-and-pay`).send({});
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('active_plan_exists');
    expect(refused.body.current_plan.id).toBe(live);
    expect(await readStatus(draft)).toBe('draft');
    expect(await feeRequests(draft)).toHaveLength(0);

    const confirmed = await api('post', `/user-memberships/${draft}/save-and-pay`)
      .send({ confirm: true });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(await readStatus(draft)).toBe('pending_payment');
    // The point of the staging: confirming lets the charge be raised, and the
    // member's current plan is still exactly as it was. A member who abandons the
    // checkout page loses nothing.
    expect(await readStatus(live)).toBe('active');

    // …and the webhook is what supersedes it, in the transaction that records the
    // payment.
    const requests = await feeRequests(draft);
    const { rows: order } = await db.query<{ provider_order: string }>(
      'SELECT provider_order FROM payment_requests WHERE id = ?', [requests[0].id],
    );
    await payCheckout(order[0].provider_order);
    expect(await readStatus(draft)).toBe('active');
    expect(await readStatus(live)).toBe('cancelled');
    expect(await statusChanges(draft)).toEqual([
      { previous_status: 'draft', new_status: 'pending_payment' },
      { previous_status: 'pending_payment', new_status: 'active' },
    ]);
  });

  it('refuses a Draft that starts before the plan it would replace', async () => {
    const memberId = await createMember();
    const live = await assignPlan(memberId, await createPlan({ freePeriods: 12 }), '2026-05-01');
    expect((await api('post', `/user-memberships/${live}/save-and-pay`).send({})).status).toBe(200);

    const draft = await assignPlan(memberId, await createPlan(), '2026-01-01');
    const res = await api('post', `/user-memberships/${draft}/save-and-pay`)
      .send({ confirm: true });
    expect(res.status).toBe(400);
    expect(await readStatus(draft)).toBe('draft');
    expect(await readStatus(live)).toBe('active');
  });
});

describe('the payment webhook activates what it paid for', () => {
  it('moves pending_payment -> active and stamps the first billing date', async () => {
    const memberId = await createMember();
    const draft = await assignPlan(memberId, await createPlan(), '2026-01-01');
    const res = await api('post', `/user-memberships/${draft}/save-and-pay`).send({});
    expect(res.status).toBe(200);

    const { rows } = await db.query<{ provider_order: string }>(
      'SELECT provider_order FROM payment_requests WHERE user_membership_id = ?', [draft],
    );
    await payCheckout(rows[0].provider_order);

    expect(await readStatus(draft)).toBe('active');
    const { rows: um } = await db.query<{ next_billing_date: string | null }>(
      'SELECT next_billing_date FROM user_memberships WHERE id = ?', [draft],
    );
    expect(um[0].next_billing_date).not.toBeNull();
    // And the money is in the ledger, as it was before this ticket.
    const { rows: events } = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM billing_events
        WHERE user_membership_id = ? AND event_type = 'payment_recorded'`,
      [draft],
    );
    expect(Number(events[0].n)).toBe(1);
  });
});

describe('a Pending Payment configuration is locked', () => {
  let locked: number;
  let memberId: number;

  beforeAll(async () => {
    memberId = await createMember();
    locked = await assignPlan(memberId, await createPlan(), '2026-01-01');
    expect((await api('post', `/user-memberships/${locked}/save-and-pay`).send({})).status).toBe(200);
  });

  it('refuses PUT /:id with 409 and names the way out', async () => {
    const res = await api('put', `/user-memberships/${locked}`).send({ starts_at: '2026-02-01' });
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/locked/i);
    const { rows } = await db.query<{ starts_at: string }>(
      `SELECT DATE_FORMAT(starts_at, '%Y-%m-%d') AS starts_at FROM user_memberships WHERE id = ?`,
      [locked],
    );
    expect(rows[0].starts_at).toBe('2026-01-01');
  });

  it('refuses a snapshot section edit', async () => {
    const res = await api('put', `/user-memberships/${locked}/session-benefits`).send({ items: [] });
    expect([400, 409]).toContain(res.status);
    expect(String(res.body.error)).toMatch(/locked|pending_payment/i);
  });

  it('refuses attaching an Additional Product', async () => {
    const { insertId: productId } = await db.query(
      `INSERT INTO products
         (gym_id, name, type, amount, currency, billing_frequency, status, availability, is_system)
       VALUES (?, ?, 'fee', 10, 'EUR', 'month', 'active', 'available', 0)`,
      [gymId, `SAP Product ${uniq()}`],
    );
    const res = await api('post', `/user-memberships/${locked}/services`)
      .send({ product_id: productId });
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/locked/i);
  });

  it('is still closeable, which is the one way out of one nobody pays for', async () => {
    const other = await createMember();
    const discarded = await assignPlan(other, await createPlan(), '2026-01-01');
    expect((await api('post', `/user-memberships/${discarded}/save-and-pay`).send({})).status).toBe(200);

    const res = await api('post', `/user-memberships/${discarded}/close`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await readStatus(discarded)).toBe('cancelled');
  });

  it('re-raises the charge without a second lock, expiring the previous request', async () => {
    const res = await api('post', `/user-memberships/${locked}/save-and-pay`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.activated).toBe(false);
    expect(await readStatus(locked)).toBe('pending_payment');

    const requests = await feeRequests(locked);
    expect(requests).toHaveLength(2);
    expect(requests[0].status).toBe('expired');
    expect(requests[1].status).toBe('pending');
    // One transition, not two: the row was already where it belongs.
    expect(await statusChanges(locked)).toEqual([
      { previous_status: 'draft', new_status: 'pending_payment' },
    ]);
  });
});

describe('GET /user-memberships/member/:memberId/save-and-pay', () => {
  it('answers nothing for a member with nothing waiting to be committed', async () => {
    const memberId = await createMember();
    const res = await api('get', `/user-memberships/member/${memberId}/save-and-pay`);
    expect(res.status).toBe(200);
    expect(res.body.assignment).toBeNull();
  });

  it('describes the Draft and what committing it will charge', async () => {
    const memberId = await createMember();
    const draft = await assignPlan(memberId, await createPlan(), '2026-01-01');

    const res = await api('get', `/user-memberships/member/${memberId}/save-and-pay`);
    expect(res.status).toBe(200);
    expect(res.body.assignment.id).toBe(draft);
    expect(res.body.assignment.status).toBe('draft');
    expect(Number(res.body.assignment.amount_due)).toBeGreaterThan(0);
    expect(res.body.payment).toBeNull();
  });

  it('describes the outstanding charge of a locked assignment, with its link', async () => {
    const memberId = await createMember();
    const draft = await assignPlan(memberId, await createPlan(), '2026-01-01');
    expect((await api('post', `/user-memberships/${draft}/save-and-pay`).send({})).status).toBe(200);

    const res = await api('get', `/user-memberships/member/${memberId}/save-and-pay`);
    expect(res.status).toBe(200);
    expect(res.body.assignment.status).toBe('pending_payment');
    expect(res.body.payment.status).toBe('pending');
    expect(res.body.payment.checkout_url).toContain('token=');
  });

  it('withholds a link whose token can no longer be opened', async () => {
    const memberId = await createMember();
    const draft = await assignPlan(memberId, await createPlan(), '2026-01-01');
    expect((await api('post', `/user-memberships/${draft}/save-and-pay`).send({})).status).toBe(200);
    // What #789's cleanup and the hosted page itself both produce.
    await db.query(
      `UPDATE payment_requests SET page_token_expires = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE)
        WHERE user_membership_id = ?`,
      [draft],
    );

    const res = await api('get', `/user-memberships/member/${memberId}/save-and-pay`);
    expect(res.body.payment.checkout_url).toBeNull();
  });

  it('answers nothing for another gym\'s member', async () => {
    const otherGym = await createTestGym('Save And Pay Read Other Gym');
    await createTestMembership(otherGym, 'admin');
    const memberId = await createMember(otherGym);
    await assignPlan(memberId, await createPlan({ gym: otherGym }), '2026-01-01', otherGym);

    const res = await api('get', `/user-memberships/member/${memberId}/save-and-pay`);
    expect(res.status).toBe(200);
    expect(res.body.assignment).toBeNull();
  });
});
