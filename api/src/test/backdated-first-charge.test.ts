// #790 — the first charge date of a back-dated assignment, and of one coming
// back from a pause.
//
// Integration tests over the real Express + MySQL path: the payment webhook
// that stamps the first `next_billing_date`, the Reactivate action and the PUT
// status flip that put an assignment back on the run, and `POST /billing/run`
// itself, which is what used to charge one elapsed cycle per night. Only the
// provider's `executeRecurring` is stubbed — the webhook still verifies a real
// Monei signature.
//
// Every expected date is derived from the database's own `UTC_DATE()`, so the
// file means the same thing whatever day it runs.

import crypto from 'crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { advanceBillingDate } from '../domain/billingDate';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, ensureTestProductSet, request } from './helpers';

const MONEI_WEBHOOK_SECRET = 'test-790-webhook-secret';
const BILLING_SECRET = 'test-790-billing-secret';

const provider = vi.hoisted(() => ({
  calls: [] as Array<{ orderId: string; amount: number }>,
}));
vi.mock('../payments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../payments')>();
  return {
    ...actual,
    getPaymentProvider: () => {
      const real = actual.getPaymentProvider();
      return {
        parseWebhook: real.parseWebhook.bind(real),
        executeRecurring: async (params: { orderId: string; amount: number }) => {
          provider.calls.push(params);
          return { success: true, providerRef: 'test-790-ref' };
        },
      };
    },
  };
});

let gymId: string;
let chargeTypeId: number;
let today: string;
/** Assignments this file created, retired after each test so no later run bills them. */
let created: number[] = [];

beforeAll(async () => {
  process.env.MONEI_API_KEY = 'test-api-key';
  process.env.MONEI_WEBHOOK_SECRET = MONEI_WEBHOOK_SECRET;
  process.env.BILLING_INTERNAL_SECRET = BILLING_SECRET;
  gymId = await createTestGym('Backdated First Charge Gym');
  await createTestMembership(gymId, 'admin');
  const { rows: ct } = await db.query<{ id: number }>(`SELECT id FROM charge_types WHERE code = 'membership_fee'`);
  chargeTypeId = ct[0].id;
  const { rows: t } = await db.query<{ today: string }>(`SELECT DATE_FORMAT(UTC_DATE(), '%Y-%m-%d') AS today`);
  today = t[0].today;
});

afterEach(async () => {
  if (created.length > 0) {
    await db.query(
      `UPDATE user_memberships SET status = 'cancelled' WHERE id IN (${created.map(() => '?').join(',')})`,
      created,
    );
    created = [];
  }
  provider.calls = [];
});

afterAll(async () => {
  delete process.env.MONEI_API_KEY;
  delete process.env.MONEI_WEBHOOK_SECRET;
  delete process.env.BILLING_INTERNAL_SECRET;
  await cleanupTestGyms();
  await db.end();
});

// ── fixtures ─────────────────────────────────────────────────────────────────

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/** A member with a stored card, and a monthly Plan: the state the run charges. */
async function assignment(opts: {
  startsAt: string;
  status?: string;
  nextBillingDate?: string | null;
  interval?: number;
  unit?: string;
}): Promise<{ memberId: number; membershipId: number }> {
  const { insertId: memberId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, '790 Member', ?)`,
    [gymId, `m790-${uniq()}@test.com`],
  );
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'staff_only')`,
    [gymId, `790-Plan-${uniq()}`],
  );
  await db.query(
    `INSERT INTO billing_policies (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, ?, ?)`,
    [gymId, planId, opts.interval ?? 1, opts.unit ?? 'month'],
  );
  const { insertId: membershipId } = await db.query(
    `INSERT INTO user_memberships
       (gym_id, member_id, membership_plan_id, status, starts_at, base_price, membership_fee_price, next_billing_date)
     VALUES (?, ?, ?, ?, ?, '29.99', '29.99', ?)`,
    [gymId, memberId, planId, opts.status ?? 'active', opts.startsAt, opts.nextBillingDate ?? null],
  );
  created.push(membershipId);
  // #1325 PR 3b: every money row belongs to a ProductSet.
  await ensureTestProductSet(gymId, memberId, membershipId);
  await db.query(
    `INSERT INTO payment_methods (gym_id, member_id, provider, payment_token, sequence_id)
     VALUES (?, ?, 'monei', ?, ?)`,
    [gymId, memberId, `tok_${uniq()}`, `seq_${uniq()}`],
  );
  return { memberId, membershipId };
}

async function nextBillingDate(id: number): Promise<string | null> {
  const { rows } = await db.query<{ d: string | null }>(
    `SELECT DATE_FORMAT(next_billing_date, '%Y-%m-%d') AS d FROM user_memberships WHERE id = ?`,
    [id],
  );
  return rows[0].d;
}

async function ledger(id: number): Promise<string[]> {
  const { rows } = await db.query<{ event_type: string }>(
    'SELECT event_type FROM billing_events WHERE user_membership_id = ? ORDER BY id',
    [id],
  );
  return rows.map((r) => r.event_type);
}

/** The run's order ids embed the assignment id: `BILLING-<gym8>-<id>-<uuid8>`. */
function chargesFor(id: number) {
  return provider.calls.filter((c) => c.orderId.includes(`-${id}-`));
}

function signedHeaders(body: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', MONEI_WEBHOOK_SECRET).update(`${ts}.${body}`).digest('hex');
  return { 'monei-signature': `t=${ts},v1=${sig}` };
}

/** The member pays the first payment's checkout link: a tokenising CIT charge succeeds. */
async function payFirstPayment(memberId: number, membershipId: number) {
  const orderId = crypto.randomUUID();
  await db.query(
    `INSERT INTO payment_requests
       (gym_id, user_membership_id, member_id, amount, currency, charge_type_id,
        status, provider, provider_order, page_token, page_token_expires, initiated_by, source)
     VALUES (?, ?, ?, '29.99', 'EUR', ?, 'pending', 'monei',
             ?, UUID(), DATE_ADD(NOW(), INTERVAL 10 MINUTE), 'test-user-id', 'admin')`,
    [gymId, membershipId, memberId, chargeTypeId, orderId],
  );
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

/** Tonight's run — the log is cleared so #780's one-completed-run-per-day guard lets it through. */
async function runBilling() {
  await db.query('DELETE FROM billing_run_log');
  const res = await request.post('/billing/run').set('x-internal-secret', BILLING_SECRET);
  expect(res.status).toBe(200);
  return res;
}

const monthsAgo = (n: number) => advanceBillingDate(today, -n, 'month');

// ── the first payment ────────────────────────────────────────────────────────

describe('payment webhook — first next_billing_date of a back-dated assignment (#790)', () => {
  it('stamps the first starts_at-anchored boundary strictly after today, and tonight’s run charges nothing', async () => {
    const startsAt = monthsAgo(3);
    const { memberId, membershipId } = await assignment({ startsAt });

    await payFirstPayment(memberId, membershipId);

    // Walk the schedule by hand: starts_at + 1, + 2, … months, first one after today.
    let expected = advanceBillingDate(startsAt, 1, 'month');
    while (expected <= today) expected = advanceBillingDate(expected, 1, 'month');
    const stamped = await nextBillingDate(membershipId);
    expect(stamped).toBe(expected);
    expect(stamped! > today).toBe(true);
    // …and never the pre-#790 `starts_at + 1 cadence`, two months in the past.
    expect(stamped).not.toBe(advanceBillingDate(startsAt, 1, 'month'));
    // The first boundary after today is at most one cadence away.
    expect(stamped! <= advanceBillingDate(today, 1, 'month')).toBe(true);

    const run = await runBilling();
    expect(run.body.skipped_reason).toBeUndefined();

    // Nothing is due: no provider call, no second ledger row, the date unmoved.
    // Before #790 this run charged `starts_at + 1 month`, the next night
    // `+ 2`, and the third night the very cycle the first payment was priced on.
    expect(chargesFor(membershipId)).toHaveLength(0);
    expect(await ledger(membershipId)).toEqual(['payment_recorded']);
    expect(await nextBillingDate(membershipId)).toBe(expected);
  });

  it('a weekly assignment back-dated five weeks lands on the next weekly boundary after today', async () => {
    const startsAt = advanceBillingDate(today, -35, 'day');
    const { memberId, membershipId } = await assignment({ startsAt, unit: 'week' });

    await payFirstPayment(memberId, membershipId);

    // starts_at + 5 weeks is today itself, which is not "after": one more week.
    expect(await nextBillingDate(membershipId)).toBe(advanceBillingDate(today, 7, 'day'));
  });

  it('an assignment starting today is unchanged: starts_at + one cadence', async () => {
    const { memberId, membershipId } = await assignment({ startsAt: today });

    await payFirstPayment(memberId, membershipId);

    expect(await nextBillingDate(membershipId)).toBe(advanceBillingDate(today, 1, 'month'));
    await runBilling();
    expect(chargesFor(membershipId)).toHaveLength(0);
  });

  it('an assignment starting in the future is unchanged: starts_at + one cadence', async () => {
    const startsAt = advanceBillingDate(today, 10, 'day');
    const { memberId, membershipId } = await assignment({ startsAt });

    await payFirstPayment(memberId, membershipId);

    expect(await nextBillingDate(membershipId)).toBe(advanceBillingDate(startsAt, 1, 'month'));
  });
});

// ── back to active ───────────────────────────────────────────────────────────

describe('reactivation — a pause is not a debt (#790)', () => {
  it('Reactivate walks a stale next_billing_date forward along its own schedule, and the run charges nothing', async () => {
    const stale = monthsAgo(2);
    const { membershipId } = await assignment({ startsAt: monthsAgo(6), status: 'paused', nextBillingDate: stale });

    const res = await request
      .post(`/user-memberships/${membershipId}/reactivate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);

    let expected = advanceBillingDate(stale, 1, 'month');
    while (expected <= today) expected = advanceBillingDate(expected, 1, 'month');
    expect(await nextBillingDate(membershipId)).toBe(expected);
    expect(expected > today).toBe(true);

    const { rows } = await db.query<{ status: string }>(
      'SELECT status FROM user_memberships WHERE id = ?', [membershipId],
    );
    expect(rows[0]).toMatchObject({ status: 'active' });

    await runBilling();
    expect(chargesFor(membershipId)).toHaveLength(0);
    expect(await ledger(membershipId)).toEqual([]);
  });

  it('a date due exactly today also moves — strictly after today', async () => {
    const { membershipId } = await assignment({ startsAt: monthsAgo(4), status: 'paused', nextBillingDate: today });

    const res = await request
      .post(`/user-memberships/${membershipId}/reactivate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);

    expect(await nextBillingDate(membershipId)).toBe(advanceBillingDate(today, 1, 'month'));
  });

  it('a PUT status flip paused → active walks it forward the same way', async () => {
    const stale = monthsAgo(3);
    const { membershipId } = await assignment({ startsAt: monthsAgo(5), status: 'paused', nextBillingDate: stale });

    const res = await request
      .put(`/user-memberships/${membershipId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ status: 'active' });
    expect(res.status).toBe(200);

    let expected = advanceBillingDate(stale, 1, 'month');
    while (expected <= today) expected = advanceBillingDate(expected, 1, 'month');
    expect(await nextBillingDate(membershipId)).toBe(expected);
  });

  it('leaves a next_billing_date still in the future untouched', async () => {
    const future = advanceBillingDate(today, 12, 'day');
    const { membershipId } = await assignment({ startsAt: monthsAgo(1), status: 'paused', nextBillingDate: future });

    const res = await request
      .post(`/user-memberships/${membershipId}/reactivate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);

    expect(await nextBillingDate(membershipId)).toBe(future);
  });

  it('leaves a NULL next_billing_date NULL — the first payment is what stamps one', async () => {
    const { membershipId } = await assignment({ startsAt: monthsAgo(2), status: 'paused', nextBillingDate: null });

    const res = await request
      .post(`/user-memberships/${membershipId}/reactivate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);

    expect(await nextBillingDate(membershipId)).toBeNull();
  });

  it('pausing does not touch the date — only the way back to active does', async () => {
    const stale = monthsAgo(1);
    const { membershipId } = await assignment({ startsAt: monthsAgo(3), nextBillingDate: stale });

    const res = await request
      .post(`/user-memberships/${membershipId}/pause`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);

    expect(await nextBillingDate(membershipId)).toBe(stale);
  });
});
