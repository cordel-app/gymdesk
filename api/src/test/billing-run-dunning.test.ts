// #785 — the nightly billing run's bounded retry, then pause.
//
// Integration tests: only the payment provider is stubbed, so the real Express
// + MySQL path is exercised — the `failed_billing` ledger rows, the attempt
// counter on `user_memberships`, the `status_changed` row the pause writes, and
// the fact that a paused assignment drops out of the run's own query.
//
// Every test drives the run more than once, one "day" per call: the guard is
// one completed run per UTC date (#780), so `runBilling()` clears the run log
// first, which is what gives the next call a day on which nothing has run yet.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

const SECRET = 'test-billing-secret';

// The stub answers whatever the test needs: a settled charge, a rejection, or a
// thrown transport error (which the run records as `provider_error` — the one
// failure that must NOT count towards the pause).
const provider = vi.hoisted(() => ({
  current: { success: true, providerRef: 'test-provider-ref' } as {
    success: boolean; providerRef: string; errorCode?: string; errorMessage?: string;
  },
  throws: null as string | null,
  calls: [] as Array<{ orderId: string; amount: number }>,
}));
vi.mock('../payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../payments')>()),
  getPaymentProvider: () => ({
    executeRecurring: async (params: { orderId: string; amount: number }) => {
      provider.calls.push(params);
      if (provider.throws) throw new Error(provider.throws);
      return provider.current;
    },
  }),
}));

/** Assignments created by the test that is running, so it can retire them. */
let created: number[] = [];

beforeAll(() => {
  process.env.BILLING_INTERNAL_SECRET = SECRET;
});

afterEach(async () => {
  // Retire this test's assignments: they stay due (a rejection never moves
  // `next_billing_date`), and a later test's run would otherwise pick them up
  // and make its own `paused`/`failed` counters unreadable.
  if (created.length > 0) {
    await db.query(
      `UPDATE user_memberships SET status = 'cancelled' WHERE id IN (${created.map(() => '?').join(',')})`,
      created,
    );
    created = [];
  }
  await db.query('DELETE FROM billing_run_log');
  provider.current = { success: true, providerRef: 'test-provider-ref' };
  provider.throws = null;
  provider.calls = [];
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ── helpers ──────────────────────────────────────────────────────────────────

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/**
 * One run, on the **next day**: the run log is cleared, so #780's one-completed-
 * run-per-UTC-date guard lets this call through, and any rejection already
 * recorded against this test's assignments is back-dated by a day, so the run
 * sees it as yesterday's. Both are needed — the escalation advances per run
 * *day*, not per run (`billingDunning.ts`), so a test that only cleared the log
 * would be asserting the same-day case below by accident.
 */
async function runBilling() {
  if (created.length > 0) {
    await db.query(
      `UPDATE user_memberships
         SET last_failed_at = DATE_SUB(last_failed_at, INTERVAL 1 DAY)
       WHERE last_failed_at IS NOT NULL AND id IN (${created.map(() => '?').join(',')})`,
      created,
    );
  }
  return runBillingSameDay();
}

/**
 * One run on the *same* day as the previous one — what happens when a first run
 * crashed and #781's 10:00 UTC attempt becomes the day's real run. Only the run
 * log is cleared; `last_failed_at` keeps today's date.
 */
async function runBillingSameDay() {
  await db.query('DELETE FROM billing_run_log');
  return request.post('/billing/run').set('x-internal-secret', SECRET);
}

function rejection(code = 'E101', message = 'Card declined') {
  provider.current = { success: false, providerRef: 'test-rejected-ref', errorCode: code, errorMessage: message };
}

interface Fixture {
  gymId: string;
  memberId: number;
  membershipId: number;
}

/**
 * A gym with one active assignment that is due, with a usable stored card —
 * the exact state the run charges.
 */
async function dueAssignment(name: string, opts: {
  status?: string;
  freeMonths?: number | null;
  paymentToken?: string | null;
} = {}): Promise<Fixture> {
  const gymId = await createTestGym(`Dunning ${name} Gym`);
  await createTestMembership(gymId);

  const { insertId: memberId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Dunning Member', ?)`,
    [gymId, `dunning-${uniq()}@test.com`],
  );
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'staff_only')`,
    [gymId, `Dunning-Plan-${uniq()}`],
  );
  await db.query(
    `INSERT INTO billing_policies
       (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`,
    [gymId, planId],
  );
  const { insertId: membershipId } = await db.query(
    `INSERT INTO user_memberships
       (gym_id, member_id, membership_plan_id, status, starts_at, base_price,
        next_billing_date, free_months, membership_fee_price)
     VALUES (?, ?, ?, ?, '2000-01-01', '29.99', '2000-01-01', ?, '29.99')`,
    [gymId, memberId, planId, opts.status ?? 'active', opts.freeMonths ?? null],
  );
  created.push(membershipId);

  // `payment_token`/`sequence_id` NULL is the "no usable card" case: the row
  // exists (the run INNER JOINs it) but nothing can be charged.
  await db.query(
    `INSERT INTO payment_methods (gym_id, member_id, provider, payment_token, sequence_id)
     VALUES (?, ?, 'monei', ?, ?)`,
    [
      gymId, memberId,
      opts.paymentToken === undefined ? `tok_${uniq()}` : opts.paymentToken,
      opts.paymentToken === null ? null : `seq_${uniq()}`,
    ],
  );

  return { gymId, memberId, membershipId };
}

async function dunningState(id: number): Promise<{
  status: string; failed_attempts: number; last_failed_at: Date | null; next_billing_date: string;
}> {
  const { rows } = await db.query<{
    status: string; failed_attempts: number; last_failed_at: Date | null; next_billing_date: Date | string;
  }>(
    'SELECT status, failed_attempts, last_failed_at, next_billing_date FROM user_memberships WHERE id = ?',
    [id],
  );
  const row = rows[0];
  return {
    status: row.status,
    failed_attempts: Number(row.failed_attempts),
    last_failed_at: row.last_failed_at,
    next_billing_date: row.next_billing_date instanceof Date
      ? row.next_billing_date.toISOString().slice(0, 10)
      : String(row.next_billing_date).slice(0, 10),
  };
}

async function events(membershipId: number): Promise<Array<{
  event_type: string; notes: string | null; previous_status: string | null; new_status: string | null; source: string;
}>> {
  const { rows } = await db.query<{
    event_type: string; notes: string | null; previous_status: string | null; new_status: string | null; source: string;
  }>(
    `SELECT event_type, notes, previous_status, new_status, source
       FROM billing_events WHERE user_membership_id = ? ORDER BY id`,
    [membershipId],
  );
  return rows;
}

// ── the rule ─────────────────────────────────────────────────────────────────

describe('POST /billing/run — bounded retry then pause (#785)', () => {
  it('records the first rejection and leaves the assignment active', async () => {
    rejection();
    const fx = await dueAssignment('First');

    const res = await runBilling();
    expect(res.status).toBe(200);
    expect(res.body.failed).toBe(1);
    expect(res.body.paused).toBe(0);

    const state = await dunningState(fx.membershipId);
    // Active, still due, one rejection behind it: the retry is the next run day
    // precisely because `next_billing_date` did not move.
    expect(state).toMatchObject({ status: 'active', failed_attempts: 1, next_billing_date: '2000-01-01' });
    expect(state.last_failed_at).not.toBeNull();

    expect(await events(fx.membershipId)).toEqual([
      expect.objectContaining({ event_type: 'failed_billing', notes: 'E101: Card declined' }),
    ]);
  });

  it('pauses the assignment on the second consecutive rejection', async () => {
    rejection();
    const fx = await dueAssignment('Second');

    await runBilling();
    const res = await runBilling();

    expect(res.body.failed).toBe(1);
    expect(res.body.paused).toBe(1);

    const state = await dunningState(fx.membershipId);
    expect(state).toMatchObject({ status: 'paused', failed_attempts: 2 });

    // Both rejections are in the ledger, and the pause explains itself through
    // the same append-only `status_changed` row every other transition writes.
    const ledger = await events(fx.membershipId);
    expect(ledger.filter((e) => e.event_type === 'failed_billing')).toHaveLength(2);
    expect(ledger.at(-1)).toMatchObject({
      event_type: 'status_changed',
      previous_status: 'active',
      new_status: 'paused',
      source: 'system',
    });
  });

  it('does not pause on a second rejection the same day', async () => {
    rejection();
    const fx = await dueAssignment('SameDay');

    await runBilling();
    // The first run crashed and #781's second daily attempt is now the day's
    // real run: the same card is declined again four hours later. That is not
    // the "next run day" the rule is about, so it records itself and stops.
    const res = await runBillingSameDay();

    expect(res.body.failed).toBe(1);
    expect(res.body.paused).toBe(0);
    expect(await dunningState(fx.membershipId)).toMatchObject({
      status: 'active', failed_attempts: 1,
    });
    // Both rejections are still in the ledger — only the count is unmoved.
    expect((await events(fx.membershipId)).filter((e) => e.event_type === 'failed_billing')).toHaveLength(2);

    // …and the next day's rejection is the second one, which pauses.
    const next = await runBilling();
    expect(next.body.paused).toBe(1);
    expect(await dunningState(fx.membershipId)).toMatchObject({
      status: 'paused', failed_attempts: 2,
    });
  });

  it('stops charging a paused assignment on the following run', async () => {
    rejection();
    const fx = await dueAssignment('NoThirdCharge');

    await runBilling();
    await runBilling();
    expect((await dunningState(fx.membershipId)).status).toBe('paused');

    const callsBefore = provider.calls.length;
    const res = await runBilling();

    // The pause is what makes the escalation effective: `WHERE status = 'active'`
    // no longer selects the row, so there is no third fee and no third ledger row.
    expect(provider.calls.length).toBe(callsBefore);
    expect(res.body.failed).toBe(0);
    expect((await events(fx.membershipId)).filter((e) => e.event_type === 'failed_billing')).toHaveLength(2);
  });

  it('never charges an assignment that was already paused', async () => {
    rejection();
    const fx = await dueAssignment('AlreadyPaused', { status: 'paused' });

    await runBilling();

    expect(provider.calls).toHaveLength(0);
    expect(await events(fx.membershipId)).toHaveLength(0);
  });

  it('resets the count when a charge settles between two rejections', async () => {
    rejection();
    const fx = await dueAssignment('Reset');

    await runBilling();
    expect((await dunningState(fx.membershipId)).failed_attempts).toBe(1);

    provider.current = { success: true, providerRef: 'test-provider-ref' };
    await runBilling();

    const settled = await dunningState(fx.membershipId);
    expect(settled).toMatchObject({
      status: 'active', failed_attempts: 0, next_billing_date: '2000-02-01',
    });
    expect(settled.last_failed_at).toBeNull();

    // And the next decline is a *first* rejection again, not the second of a run
    // of two — a member who paid must not stay one decline from being paused.
    rejection();
    await runBilling();
    expect(await dunningState(fx.membershipId)).toMatchObject({
      status: 'active', failed_attempts: 1,
    });
  });

  it('resets the count when the next cycle is waived', async () => {
    // A cycle inside the Free Period charges nothing, so the rejections the
    // previous cycle collected are spent: `failed_attempts` counts consecutive
    // rejections of the cycle `next_billing_date` names, and this is a new one.
    const fx = await dueAssignment('Waived', { freeMonths: 12 });
    await db.query(
      'UPDATE user_memberships SET failed_attempts = 1, last_failed_at = UTC_TIMESTAMP() WHERE id = ?',
      [fx.membershipId],
    );

    const res = await runBilling();
    expect(res.body.waived).toBe(1);

    const state = await dunningState(fx.membershipId);
    expect(state).toMatchObject({ failed_attempts: 0, next_billing_date: '2000-02-01' });
    expect(state.last_failed_at).toBeNull();
    expect(provider.calls).toHaveLength(0);
  });

  it('does not count a provider exception towards the pause', async () => {
    provider.throws = 'ECONNRESET';
    const fx = await dueAssignment('ProviderError');

    await runBilling();
    const res = await runBilling();

    // Two nights of "we could not reach the provider" is our outage, not the
    // member's decline — the charge's outcome is unknown, so nothing escalates.
    expect(res.body.failed).toBe(1);
    expect(res.body.paused).toBe(0);
    expect(await dunningState(fx.membershipId)).toMatchObject({
      status: 'active', failed_attempts: 0,
    });

    const ledger = await events(fx.membershipId);
    expect(ledger).toHaveLength(2);
    expect(ledger.every((e) => e.event_type === 'failed_billing' && e.notes === 'provider_error')).toBe(true);
  });

  it('leaves a provider exception between two rejections out of the count', async () => {
    rejection();
    const fx = await dueAssignment('Interleaved');
    await runBilling();
    expect((await dunningState(fx.membershipId)).failed_attempts).toBe(1);

    // An exception neither counts nor clears: the one rejection behind this
    // assignment is still the one rejection behind it.
    provider.throws = 'ETIMEDOUT';
    await runBilling();
    expect(await dunningState(fx.membershipId)).toMatchObject({
      status: 'active', failed_attempts: 1,
    });

    // …so the next genuine rejection is the second, and it pauses.
    provider.throws = null;
    rejection();
    const res = await runBilling();
    expect(res.body.paused).toBe(1);
    expect(await dunningState(fx.membershipId)).toMatchObject({
      status: 'paused', failed_attempts: 2,
    });
  });

  it('does not count a missing stored card towards the pause', async () => {
    const fx = await dueAssignment('NoCard', { paymentToken: null });

    await runBilling();
    const res = await runBilling();

    // Nothing was attempted, so there is no decline to escalate — and pausing
    // the member is not what gets a new card entered.
    expect(res.body.failed).toBe(1);
    expect(res.body.paused).toBe(0);
    expect(provider.calls).toHaveLength(0);
    expect(await dunningState(fx.membershipId)).toMatchObject({
      status: 'active', failed_attempts: 0,
    });

    const ledger = await events(fx.membershipId);
    expect(ledger).toHaveLength(2);
    expect(ledger.every((e) => e.notes === 'no_payment_method')).toBe(true);
  });

  it('gives a reactivated assignment the full two attempts again', async () => {
    rejection();
    const fx = await dueAssignment('Reactivated');
    await runBilling();
    await runBilling();
    expect(await dunningState(fx.membershipId)).toMatchObject({ status: 'paused', failed_attempts: 2 });

    // Reactivating means "bill this again". Leaving the count at 2 would give the
    // resumed assignment one attempt instead of the documented two — the very next
    // rejection would pause it immediately — which is why the transition clears it.
    const res = await request
      .post(`/user-memberships/${fx.membershipId}/reactivate`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', fx.gymId);
    expect(res.status).toBe(200);
    expect(await dunningState(fx.membershipId)).toMatchObject({
      status: 'active', failed_attempts: 0,
    });

    // So the next night is a first rejection, not the one that pauses.
    const next = await runBilling();
    expect(next.body.paused).toBe(0);
    expect(await dunningState(fx.membershipId)).toMatchObject({
      status: 'active', failed_attempts: 1,
    });
  });

  it('does not leak a pause across gyms', async () => {
    rejection();
    const mine = await dueAssignment('TenantA');
    const theirs = await dueAssignment('TenantB');

    await runBilling();
    // Only A has a rejection behind it: B is charged for the first time on the
    // second run, so the run that pauses A must leave B active.
    await db.query(
      'UPDATE user_memberships SET failed_attempts = 0, last_failed_at = NULL WHERE id = ?',
      [theirs.membershipId],
    );

    const res = await runBilling();
    expect(res.body.paused).toBe(1);
    expect((await dunningState(mine.membershipId)).status).toBe('paused');
    expect(await dunningState(theirs.membershipId)).toMatchObject({
      status: 'active', failed_attempts: 1,
    });
  });
});
