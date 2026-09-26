// #640: Billing Event Details, Retry Payment and Manual payment.
//
// Integration tests — the provider is the only thing mocked, so the whole
// Express + MySQL path (guards, transaction rows, membership pause, schedule
// advance) is exercised for real.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

// Mutable so each test picks the provider outcome it needs.
let executeRecurring = vi.fn();

vi.mock('../payments', () => ({
  getPaymentProvider: () => ({
    executeRecurring: (...args: unknown[]) => executeRecurring(...args),
  }),
}));

let gymId: string;
let otherGymId: string;

beforeAll(async () => {
  gymId = await createTestGym('BE Actions Gym');
  otherGymId = await createTestGym('BE Actions Other Gym');
  await createTestMembership(gymId, 'admin');
  await createTestMembership(otherGymId, 'admin');
});

beforeEach(() => {
  executeRecurring = vi.fn().mockResolvedValue({
    success: true, providerRef: 'pay_ok', errorCode: null, errorMessage: null,
  });
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const today = () => new Date().toISOString().slice(0, 10);

async function chargeTypeId(): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    "SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1",
  );
  return rows[0].id;
}

async function createMember(gym: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Actions Member', ?)`,
    [gym, `be-actions-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`],
  );
  return insertId;
}

async function createPlanWithPolicy(gym: string): Promise<number> {
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'staff_only')`,
    [gym, `BE-Actions-Plan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`],
  );
  await db.query(
    `INSERT INTO billing_policies
       (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`,
    [gym, planId],
  );
  return planId;
}

interface Fixture {
  memberId: number;
  membershipId: number;
  billingEventId: number;
}

/**
 * A membership that is due today and whose last charge was rejected — the
 * exact state the two payment actions exist for.
 */
async function createFailedEvent(
  gym: string,
  opts: { withPaymentMethod?: boolean; eventType?: string; withTransaction?: boolean } = {},
): Promise<Fixture> {
  const { withPaymentMethod = true, eventType = 'failed_billing', withTransaction = true } = opts;
  const memberId = await createMember(gym);
  const planId = await createPlanWithPolicy(gym);
  const ct = await chargeTypeId();

  const { insertId: membershipId } = await db.query(
    `INSERT INTO user_memberships
       (gym_id, member_id, membership_plan_id, status, starts_at, membership_fee_price, next_billing_date)
     VALUES (?, ?, ?, 'active', '2000-01-01', '40.00', ?)`,
    [gym, memberId, planId, today()],
  );
  await db.query(
    `INSERT INTO user_membership_members (gym_id, user_membership_id, member_id, is_owner)
     VALUES (?, ?, ?, 1)`,
    [gym, membershipId, memberId],
  );

  if (withPaymentMethod) {
    await db.query(
      `INSERT INTO payment_methods (gym_id, member_id, provider, payment_token, sequence_id)
       VALUES (?, ?, 'monei', 'tok_test', 'seq_test')`,
      [gym, memberId],
    );
  }

  const { insertId: billingEventId } = await db.query(
    `INSERT INTO billing_events
       (gym_id, user_membership_id, member_id, event_type, amount, charge_type_id, source, actor_user_id, notes)
     VALUES (?, ?, ?, ?, '40.00', ?, 'system', NULL, 'E999: card declined')`,
    [gym, membershipId, memberId, eventType, ct],
  );

  if (withTransaction) {
    await db.query(
      `INSERT INTO payment_requests
         (gym_id, user_membership_id, member_id, amount, currency, charge_type_id,
          billing_event_id, status, provider, provider_order, source, created_at,
          failure_code, failure_message)
       VALUES (?, ?, ?, '40.00', 'EUR', ?, ?, 'failed', 'monei', UUID(), 'billing_run',
               UTC_TIMESTAMP(), 'E999', 'card declined')`,
      [gym, membershipId, memberId, ct, billingEventId],
    );
  }

  return { memberId, membershipId, billingEventId };
}

function asAdmin(gym: string) {
  return { auth: TEST_AUTH_HEADER, gym };
}

async function transactionsOf(billingEventId: number) {
  const { rows } = await db.query<any>(
    'SELECT * FROM payment_requests WHERE billing_event_id = ? ORDER BY id ASC',
    [billingEventId],
  );
  return rows;
}

// ── GET /payments/billing-events/:id ─────────────────────────────────────────

describe('GET /payments/billing-events/:id', () => {
  it('returns 401 without auth', async () => {
    const f = await createFailedEvent(gymId);
    const res = await request.get(`/payments/billing-events/${f.billingEventId}`).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 404 for an event belonging to another gym (tenant isolation)', async () => {
    const f = await createFailedEvent(gymId);
    const res = await request
      .get(`/payments/billing-events/${f.billingEventId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId);
    expect(res.status).toBe(404);
  });

  it('returns the full details shape with the failure reason and action flags', async () => {
    const f = await createFailedEvent(gymId);
    const res = await request
      .get(`/payments/billing-events/${f.billingEventId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(f.billingEventId);
    expect(res.body.member_id).toBe(f.memberId);
    expect(res.body.user_membership_id).toBe(f.membershipId);
    expect(res.body.currency).toBe('EUR');
    expect(res.body.status).toBe('failed');
    expect(res.body.charge_type_code).toBe('membership_fee');
    expect(res.body.next_payment_date).toBe(today());
    // The transaction-level reason wins over the ledger row's notes.
    expect(res.body.failure_reason).toBe('E999: card declined');
    expect(res.body.can_retry).toBe(true);
    expect(res.body.can_record_manual_payment).toBe(true);
    // Nothing has touched it yet.
    expect(res.body.modified_at).toBeNull();
    expect(res.body.modified_by).toBeNull();
  });

  it('reports a settled event as paid and withdraws both actions', async () => {
    const f = await createFailedEvent(gymId);
    await request
      .post(`/payments/billing-events/${f.billingEventId}/manual-payment`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({});

    const res = await request
      .get(`/payments/billing-events/${f.billingEventId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.body.status).toBe('paid');
    expect(res.body.can_retry).toBe(false);
    expect(res.body.can_record_manual_payment).toBe(false);
  });
});

// ── POST /payments/billing-events/:id/retry ──────────────────────────────────

describe('POST /payments/billing-events/:id/retry', () => {
  it('returns 401 without auth', async () => {
    const f = await createFailedEvent(gymId);
    const res = await request.post(`/payments/billing-events/${f.billingEventId}/retry`).set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 for a read-only PAYMENTS role', async () => {
    const roGymId = await createTestGym('BE Actions RO Gym');
    await createTestMembership(roGymId, 'accountant');
    const f = await createFailedEvent(roGymId);
    const res = await request
      .post(`/payments/billing-events/${f.billingEventId}/retry`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', roGymId);
    expect(res.status).toBe(403);
  });

  it('returns 404 for an event belonging to another gym', async () => {
    const f = await createFailedEvent(gymId);
    const res = await request
      .post(`/payments/billing-events/${f.billingEventId}/retry`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId);
    expect(res.status).toBe(404);
  });

  it('adds a transaction to the same billing event and never a second event', async () => {
    const f = await createFailedEvent(gymId);
    const { rows: before } = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM billing_events WHERE user_membership_id = ?', [f.membershipId],
    );

    const res = await request
      .post(`/payments/billing-events/${f.billingEventId}/retry`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(200);
    expect(res.body.new_status).toBe('paid');
    expect(res.body.attempts).toHaveLength(1);
    expect(res.body.membership_paused).toBe(false);

    const tx = await transactionsOf(f.billingEventId);
    expect(tx).toHaveLength(2); // the original failure + the retry
    expect(tx[1].source).toBe('retry');
    expect(tx[1].status).toBe('completed');
    expect(tx[1].provider_ref).toBe('pay_ok');
    expect(tx[1].completed_at).not.toBeNull();

    const { rows: after } = await db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM billing_events WHERE user_membership_id = ?', [f.membershipId],
    );
    expect(Number(after[0].n)).toBe(Number(before[0].n));
  });

  it('advances the membership schedule when the retry succeeds', async () => {
    const f = await createFailedEvent(gymId);
    await request
      .post(`/payments/billing-events/${f.billingEventId}/retry`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    // The 40.00 € event is retried as a 4000-cent MIT — minor units, like the
    // nightly run and the customer checkout. `40` here would be forty cents.
    expect(executeRecurring).toHaveBeenCalledTimes(1);
    expect(executeRecurring.mock.calls[0][0]).toMatchObject({ amount: 4000, currency: 'EUR' });

    const { rows } = await db.query<any>(
      'SELECT next_billing_date, last_billed_at FROM user_memberships WHERE id = ?', [f.membershipId],
    );
    const next = new Date(rows[0].next_billing_date).toISOString().slice(0, 10);
    expect(next > today()).toBe(true);
    expect(rows[0].last_billed_at).not.toBeNull();
  });

  it('retries once more and pauses the assigned plan when both attempts fail', async () => {
    executeRecurring = vi.fn().mockResolvedValue({
      success: false, providerRef: 'pay_ko', errorCode: 'E999', errorMessage: 'card declined',
    });
    const f = await createFailedEvent(gymId);

    const res = await request
      .post(`/payments/billing-events/${f.billingEventId}/retry`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(200);
    expect(res.body.new_status).toBe('failed');
    expect(res.body.attempts).toHaveLength(2);
    expect(res.body.membership_paused).toBe(true);
    expect(executeRecurring).toHaveBeenCalledTimes(2);

    const { rows } = await db.query<any>('SELECT status FROM user_memberships WHERE id = ?', [f.membershipId]);
    expect(rows[0].status).toBe('paused');

    // The pause is explicable from the ledger, like every other transition.
    const { rows: statusRows } = await db.query<any>(
      `SELECT new_status FROM billing_events
        WHERE user_membership_id = ? AND event_type = 'status_changed'`,
      [f.membershipId],
    );
    expect(statusRows.map((r: any) => r.new_status)).toContain('paused');

    // Both attempts are recorded with their rejection reason.
    const tx = await transactionsOf(f.billingEventId);
    const retries = tx.filter((r: any) => r.source === 'retry');
    expect(retries).toHaveLength(2);
    expect(retries.map((r: any) => r.attempt)).toEqual([2, 3]);
    expect(retries.every((r: any) => r.status === 'failed' && r.failure_code === 'E999')).toBe(true);
  });

  it('leaves the schedule alone when the retry fails', async () => {
    executeRecurring = vi.fn().mockResolvedValue({
      success: false, providerRef: null, errorCode: 'E999', errorMessage: 'card declined',
    });
    const f = await createFailedEvent(gymId);
    await request
      .post(`/payments/billing-events/${f.billingEventId}/retry`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    const { rows } = await db.query<any>(
      'SELECT next_billing_date FROM user_memberships WHERE id = ?', [f.membershipId],
    );
    expect(new Date(rows[0].next_billing_date).toISOString().slice(0, 10)).toBe(today());
  });

  it('records a provider transport error as a failed attempt rather than a 500', async () => {
    executeRecurring = vi.fn().mockRejectedValue(new Error('connection reset'));
    const f = await createFailedEvent(gymId);

    const res = await request
      .post(`/payments/billing-events/${f.billingEventId}/retry`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    expect(res.status).toBe(200);
    expect(res.body.new_status).toBe('failed');
    const tx = await transactionsOf(f.billingEventId);
    expect(tx.some((r: any) => r.failure_code === 'provider_error')).toBe(true);
  });

  it('returns 400 when the member has no stored payment method', async () => {
    const f = await createFailedEvent(gymId, { withPaymentMethod: false });
    const res = await request
      .post(`/payments/billing-events/${f.billingEventId}/retry`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/payment method/i);
    expect(executeRecurring).not.toHaveBeenCalled();
  });

  it('returns 400 for an event that is not in a failed state', async () => {
    const f = await createFailedEvent(gymId, { eventType: 'recurring_payment', withTransaction: false });
    const res = await request
      .post(`/payments/billing-events/${f.billingEventId}/retry`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(400);
  });

  it('returns 409 for an event that has already been settled', async () => {
    const f = await createFailedEvent(gymId);
    await request
      .post(`/payments/billing-events/${f.billingEventId}/retry`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);

    const res = await request
      .post(`/payments/billing-events/${f.billingEventId}/retry`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(409);
  });
});

// ── POST /payments/billing-events/:id/manual-payment ─────────────────────────

describe('POST /payments/billing-events/:id/manual-payment', () => {
  it('returns 401 without auth', async () => {
    const f = await createFailedEvent(gymId);
    const res = await request
      .post(`/payments/billing-events/${f.billingEventId}/manual-payment`)
      .set('x-gym-id', gymId)
      .send({});
    expect(res.status).toBe(401);
  });

  it('returns 403 for a read-only PAYMENTS role', async () => {
    const roGymId = await createTestGym('BE Manual RO Gym');
    await createTestMembership(roGymId, 'accountant');
    const f = await createFailedEvent(roGymId);
    const res = await request
      .post(`/payments/billing-events/${f.billingEventId}/manual-payment`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', roGymId)
      .send({});
    expect(res.status).toBe(403);
  });

  it('returns 404 for an event belonging to another gym', async () => {
    const f = await createFailedEvent(gymId);
    const res = await request
      .post(`/payments/billing-events/${f.billingEventId}/manual-payment`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId)
      .send({});
    expect(res.status).toBe(404);
  });

  it('records a completed transaction without calling the provider', async () => {
    const f = await createFailedEvent(gymId);
    const res = await request
      .post(`/payments/billing-events/${f.billingEventId}/manual-payment`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ notes: 'Cash at front desk' });

    expect(res.status).toBe(201);
    expect(res.body.new_status).toBe('paid');
    expect(res.body.previous_status).toBe('failed');
    expect(res.body.amount).toBe('40.00');
    expect(executeRecurring).not.toHaveBeenCalled();

    const tx = await transactionsOf(f.billingEventId);
    const manual = tx.find((r: any) => r.source === 'manual');
    expect(manual).toBeDefined();
    expect(manual.status).toBe('completed');
    expect(manual.notes).toBe('Cash at front desk');
    expect(manual.completed_at).not.toBeNull();
  });

  it('stamps Modified At / Modified By on the billing event', async () => {
    const f = await createFailedEvent(gymId);
    await request
      .post(`/payments/billing-events/${f.billingEventId}/manual-payment`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({});

    const { rows } = await db.query<any>(
      'SELECT modified_at, modified_by_user_id FROM billing_events WHERE id = ?', [f.billingEventId],
    );
    expect(rows[0].modified_at).not.toBeNull();
    expect(rows[0].modified_by_user_id).toBe('test-user-id');
  });

  it('accepts an explicit amount and rejects a non-positive one', async () => {
    const f = await createFailedEvent(gymId);
    const bad = await request
      .post(`/payments/billing-events/${f.billingEventId}/manual-payment`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ amount: '0' });
    expect(bad.status).toBe(400);

    const ok = await request
      .post(`/payments/billing-events/${f.billingEventId}/manual-payment`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ amount: '25.50' });
    expect(ok.status).toBe(201);
    expect(ok.body.amount).toBe('25.50');
  });

  it('returns 409 on a second manual payment for the same event', async () => {
    const f = await createFailedEvent(gymId);
    await request
      .post(`/payments/billing-events/${f.billingEventId}/manual-payment`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({});

    const res = await request
      .post(`/payments/billing-events/${f.billingEventId}/manual-payment`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({});
    expect(res.status).toBe(409);

    // The schedule must not advance twice for one charge.
    const { rows } = await db.query<any>(
      'SELECT next_billing_date FROM user_memberships WHERE id = ?', [f.membershipId],
    );
    const expected = new Date(`${today()}T00:00:00Z`);
    expected.setUTCMonth(expected.getUTCMonth() + 1);
    expect(new Date(rows[0].next_billing_date).toISOString().slice(0, 10))
      .toBe(expected.toISOString().slice(0, 10));
  });

  it('works for a failed event that never produced a transaction', async () => {
    // e.g. the nightly run's "no payment method" branch — no payment_requests
    // row exists, so the status comes from the event type alone.
    const f = await createFailedEvent(gymId, { withPaymentMethod: false, withTransaction: false });
    const res = await request
      .post(`/payments/billing-events/${f.billingEventId}/manual-payment`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.new_status).toBe('paid');
  });
});

// ── Derived status on the list + the member's payment status ─────────────────

describe('payment actions and the derived statuses', () => {
  it('flips the list row to paid and offers no further action', async () => {
    const f = await createFailedEvent(gymId);

    const before = await request
      .get(`/payments/billing-events?member_id=${f.memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    const beforeRow = before.body.items.find((i: any) => i.id === f.billingEventId);
    expect(beforeRow.status).toBe('failed');
    expect(beforeRow.payment_actions_available).toBe(true);

    await request
      .post(`/payments/billing-events/${f.billingEventId}/manual-payment`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({});

    const after = await request
      .get(`/payments/billing-events?member_id=${f.memberId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    const afterRow = after.body.items.find((i: any) => i.id === f.billingEventId);
    expect(afterRow.status).toBe('paid');
    expect(afterRow.payment_actions_available).toBe(false);
  });

  it('moves the payment status of every member covered by the plan', async () => {
    // A two-person / family Membership bills once, against its owner. The
    // covered member must follow that transaction, not only their own.
    const f = await createFailedEvent(gymId);
    const partnerId = await createMember(gymId);
    await db.query(
      `INSERT INTO user_membership_members (gym_id, user_membership_id, member_id, is_owner)
       VALUES (?, ?, ?, 0)`,
      [gymId, f.membershipId, partnerId],
    );

    const failed = await request
      .get('/members?payment_status=failed')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(failed.body.map((m: any) => m.id)).toContain(partnerId);

    await request
      .post(`/payments/billing-events/${f.billingEventId}/manual-payment`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({});

    const completed = await request
      .get('/members?payment_status=completed')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(completed.body.map((m: any) => m.id)).toContain(partnerId);
  });
});
