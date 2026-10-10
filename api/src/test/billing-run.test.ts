import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

const SECRET = 'test-billing-secret';

// No payment provider is configured in tests, so the run's charge branches
// were never reachable — which is how the `insertId` defect below survived.
// The stub makes both of them deterministic; the cases that assert a
// membership is *not* selected never reach it.
const providerResult = vi.hoisted(() => ({
  current: { success: true, providerRef: 'test-provider-ref' } as {
    success: boolean; providerRef: string; errorCode?: string; errorMessage?: string;
  },
  calls: [] as Array<{ orderId: string; amount: number; currency: string }>,
}));
vi.mock('../payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../payments')>()),
  getPaymentProvider: () => ({
    executeRecurring: async (params: { orderId: string; amount: number; currency: string }) => {
      providerResult.calls.push(params);
      return providerResult.current;
    },
  }),
}));

beforeAll(() => {
  process.env.BILLING_INTERNAL_SECRET = SECRET;
});

afterEach(async () => {
  // #780: the run log is a history now (migration 193), so clearing it —
  // rather than nulling one singleton's stamp — is what gives the next test a
  // day on which nothing has run yet.
  await db.query('DELETE FROM billing_run_log');
  providerResult.current = { success: true, providerRef: 'test-provider-ref' };
  providerResult.calls = [];
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

// ── helpers ──────────────────────────────────────────────────────────────────

/** The UTC calendar date the run guard counts (#780). */
function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** mysql2 hands a DATE back as a string or a Date depending on the connection. */
function dateOnly(v: Date | string): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

async function createMember(gymId: string): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Billing Test Member', ?)`,
    [gymId, `billing-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`],
  );
  return insertId;
}

async function createPlanWithPolicy(gymId: string): Promise<number> {
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'staff_only')`,
    [gymId, `Billing-Plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`],
  );
  await db.query(
    `INSERT INTO billing_policies
       (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`,
    [gymId, planId],
  );
  return planId;
}

async function createDueMembership(
  gymId: string,
  memberId: number,
  planId: number,
  finalPrice = '29.99',
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO user_memberships
       (gym_id, member_id, membership_plan_id, status, starts_at, base_price)
     VALUES (?, ?, ?, 'active', '2000-01-01', ?)`,
    [gymId, memberId, planId, finalPrice],
  );
  return insertId;
}

/**
 * #1325: an Active ProductSet of the member with one scheduled Billing Event —
 * what the run executes. `card` names the stored card's token (none when null).
 */
async function seedScheduledEvent(
  gymId: string,
  memberId: number,
  opts: { amount: string; card: string | null; daysFromToday?: number },
): Promise<{ setId: number; eventId: number }> {
  const { insertId: setId } = await db.query(
    `INSERT INTO product_sets (gym_id, owner_member_id, status, starts_at) VALUES (?, ?, 'active', '2000-01-01')`,
    [gymId, memberId],
  );
  await db.query('UPDATE product_sets SET root_product_set_id = id WHERE id = ?', [setId]);
  if (opts.card) {
    await db.query(
      `INSERT INTO payment_methods (gym_id, member_id, provider, payment_token, sequence_id)
       VALUES (?, ?, 'monei', ?, ?)`,
      [gymId, memberId, `tok_${opts.card}`, `seq_${opts.card}`],
    );
  }
  const { rows: ct } = await db.query<{ id: number }>("SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1");
  const { insertId: eventId } = await db.query(
    `INSERT INTO billing_events
       (gym_id, member_id, product_set_id, event_type, amount, charge_type_id, source, billing_date, is_scheduled)
     VALUES (?, ?, ?, 'charge_created', ?, ?, 'system', DATE_ADD(UTC_DATE(), INTERVAL ? DAY), 1)`,
    [gymId, memberId, setId, opts.amount, ct[0]?.id ?? null, opts.daysFromToday ?? 0],
  );
  return { setId, eventId };
}

async function insertExpiredPaymentRequest(
  gymId: string,
  userMembershipId: number,
  memberId: number,
): Promise<void> {
  const { rows: ctRows } = await db.query<{ id: number }>(
    "SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1",
  );
  await db.query(
    `INSERT INTO payment_requests
       (gym_id, user_membership_id, member_id, amount, currency, charge_type_id,
        status, provider, provider_order, page_token, page_token_expires, source)
     VALUES (?, ?, ?, '29.99', 'EUR', ?, 'pending', 'monei', UUID(), UUID(),
             DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR), 'admin')`,
    [gymId, userMembershipId, memberId, ctRows[0].id],
  );
}

// ── POST /billing/run ─────────────────────────────────────────────────────────

describe('POST /billing/run', () => {
  it('returns 401 with missing secret', async () => {
    const res = await request.post('/billing/run');
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong secret', async () => {
    const res = await request.post('/billing/run').set('x-internal-secret', 'wrong');
    expect(res.status).toBe(401);
  });

  it('returns 200 with valid secret', async () => {
    const res = await request.post('/billing/run').set('x-internal-secret', SECRET);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('processed');
    expect(res.body).toHaveProperty('succeeded');
    expect(res.body).toHaveProperty('failed');
  });

  // ── #780: one completed run per UTC date ───────────────────────────────
  //
  // The guard used to be "23 hours since the last *start*", which skipped a
  // day whenever a cron ran late and locked the day whenever a run crashed.

  it('records the run in billing_run_log as a completed row for today', async () => {
    await request.post('/billing/run').set('x-internal-secret', SECRET);

    const { rows } = await db.query<{ status: string; run_date: string; finished_at: Date | null }>(
      'SELECT status, run_date, started_at, finished_at FROM billing_run_log',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('completed');
    expect(rows[0].finished_at).not.toBeNull();
    expect(dateOnly(rows[0].run_date)).toBe(utcToday());
  });

  it('answers 200 skipped_reason (not 429) when today\u2019s run already completed', async () => {
    expect((await request.post('/billing/run').set('x-internal-secret', SECRET)).status).toBe(200);

    const res = await request.post('/billing/run').set('x-internal-secret', SECRET);

    // 200, so the second daily attempt (#781) is a green no-op rather than a
    // red workflow every morning, and the counters stay readable for #778's
    // body parse.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      skipped_reason: 'already_completed_today',
      run_date: utcToday(),
      processed: 0, succeeded: 0, failed: 0, waived: 0,
    });
  });

  it('runs again when the only completed run is on an earlier date, 22 hours ago', async () => {
    // Exactly the case that used to be refused: Monday ran late, Tuesday is on
    // time, and the gap is under 23 hours.
    await db.query(
      `INSERT INTO billing_run_log (run_date, status, started_at, finished_at)
       VALUES (DATE_SUB(UTC_DATE(), INTERVAL 1 DAY),
               'completed',
               DATE_SUB(UTC_TIMESTAMP(), INTERVAL 22 HOUR),
               DATE_SUB(UTC_TIMESTAMP(), INTERVAL 22 HOUR))`,
    );

    const res = await request.post('/billing/run').set('x-internal-secret', SECRET);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('skipped_reason');
  });

  it('runs again after a run that failed earlier today', async () => {
    await db.query(
      `INSERT INTO billing_run_log (run_date, status, started_at, finished_at)
       VALUES (UTC_DATE(), 'failed', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    );

    const res = await request.post('/billing/run').set('x-internal-secret', SECRET);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('skipped_reason');
  });

  it('runs again after a run that started today and never finished (crashed)', async () => {
    // Stale: older than STALE_RUN_MINUTES, so the dead row is retired and the
    // new run takes over rather than waiting out the rest of the day.
    await db.query(
      `INSERT INTO billing_run_log (run_date, status, started_at)
       VALUES (UTC_DATE(), 'in_progress', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 HOUR))`,
    );

    const res = await request.post('/billing/run').set('x-internal-secret', SECRET);
    expect(res.status).toBe(200);

    const { rows } = await db.query<{ status: string }>(
      "SELECT status FROM billing_run_log WHERE status = 'failed'",
    );
    expect(rows).toHaveLength(1);
  });

  it('returns 429 while another run is genuinely in progress', async () => {
    await db.query(
      `INSERT INTO billing_run_log (run_date, status, started_at)
       VALUES (UTC_DATE(), 'in_progress', UTC_TIMESTAMP())`,
    );

    const res = await request.post('/billing/run').set('x-internal-secret', SECRET);
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/in progress/i);
  });

  // #1325 PR 3: the run executes a ProductSet's persisted Billing Events and
  // nothing else — there is no assignment pass reading `next_billing_date`.

  it('charges a due scheduled event from its own amount and links the attempt', async () => {
    const gymId = await createTestGym('Billing Settled Gym');
    await createTestMembership(gymId);
    const memberId = await createMember(gymId);
    const { eventId } = await seedScheduledEvent(gymId, memberId, { amount: '29.99', card: 'settled' });

    const res = await request.post('/billing/run').set('x-internal-secret', SECRET);
    expect(res.status).toBe(200);
    expect(res.body.succeeded).toBeGreaterThan(0);
    expect(res.body.processed).toBeGreaterThan(0);

    // The provider takes minor units: a 29.99 € event is a 2999-cent MIT.
    const call = providerResult.calls.find((c) => c.orderId.includes(`-${eventId}-`));
    expect(call).toMatchObject({ amount: 2999, currency: 'EUR' });

    const { rows: events } = await db.query<any>(
      'SELECT event_type, amount, is_scheduled FROM billing_events WHERE id = ?', [eventId]);
    expect(events[0].event_type).toBe('recurring_payment');
    expect(Number(events[0].amount)).toBe(29.99);
    expect(Number(events[0].is_scheduled)).toBe(0);

    const { rows: txs } = await db.query<any>(
      'SELECT status, provider_ref, method, attempt FROM payment_requests WHERE billing_event_id = ?', [eventId]);
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({ status: 'completed', provider_ref: 'test-provider-ref', method: 'provider', attempt: 1 });
  });

  it('records a rejected charge with its reason on the attempt', async () => {
    providerResult.current = {
      success: false, providerRef: 'test-rejected-ref',
      errorCode: 'E101', errorMessage: 'Card declined',
    };
    const gymId = await createTestGym('Billing Rejected Gym');
    await createTestMembership(gymId);
    const memberId = await createMember(gymId);
    const { eventId } = await seedScheduledEvent(gymId, memberId, { amount: '29.99', card: 'rejected' });

    const res = await request.post('/billing/run').set('x-internal-secret', SECRET);
    expect(res.body.failed).toBeGreaterThan(0);

    const { rows: events } = await db.query<any>('SELECT event_type FROM billing_events WHERE id = ?', [eventId]);
    expect(events[0].event_type).toBe('failed_billing');
    const { rows: txs } = await db.query<any>(
      'SELECT status, failure_code, failure_message FROM payment_requests WHERE billing_event_id = ?', [eventId]);
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({ status: 'failed', failure_code: 'E101', failure_message: 'Card declined' });
  });

  it('attempts nothing for a due event with no stored card, and leaves it scheduled', async () => {
    const gymId = await createTestGym('Billing No-PM Gym');
    await createTestMembership(gymId);
    const memberId = await createMember(gymId);
    const { eventId } = await seedScheduledEvent(gymId, memberId, { amount: '29.99', card: null });

    await request.post('/billing/run').set('x-internal-secret', SECRET);

    const { rows } = await db.query<any>('SELECT is_scheduled FROM billing_events WHERE id = ?', [eventId]);
    expect(Number(rows[0].is_scheduled)).toBe(1);
    const { rows: txs } = await db.query('SELECT id FROM payment_requests WHERE billing_event_id = ?', [eventId]);
    expect(txs).toHaveLength(0);
  });

  it('does not execute an event due in the future', async () => {
    const gymId = await createTestGym('Billing Future Gym');
    await createTestMembership(gymId);
    const memberId = await createMember(gymId);
    const { eventId } = await seedScheduledEvent(gymId, memberId, { amount: '29.99', card: 'future', daysFromToday: 30 });

    await request.post('/billing/run').set('x-internal-secret', SECRET);

    expect(providerResult.calls.some((c) => c.orderId.includes(`-${eventId}-`))).toBe(false);
    const { rows } = await db.query<any>('SELECT event_type FROM billing_events WHERE id = ?', [eventId]);
    expect(rows[0].event_type).toBe('charge_created');
  });
});

// ── #787: receipts for the charges the run settles ───────────────────────────

describe('POST /billing/run — receipts (#787)', () => {
  async function eventRow(id: number) {
    const { rows } = await db.query<any>(
      'SELECT event_type, receipt_number, receipt_issued_at FROM billing_events WHERE id = ?', [id]);
    return rows[0];
  }

  it('allocates a receipt number for a charge it settles', async () => {
    const gymId = await createTestGym('Billing Receipt Gym');
    await createTestMembership(gymId);
    const memberId = await createMember(gymId);
    const { eventId } = await seedScheduledEvent(gymId, memberId, { amount: '29.99', card: 'receipt' });

    const res = await request.post('/billing/run').set('x-internal-secret', SECRET);
    expect(res.status).toBe(200);
    expect(res.body.receipts_issued).toBeGreaterThan(0);

    const ev = await eventRow(eventId);
    expect(ev.receipt_number).toMatch(/^\d{4}-\d{4}$/);
    expect(ev.receipt_issued_at).not.toBeNull();
    const { rows: sequence } = await db.query<{ last_seq: number }>(
      'SELECT last_seq FROM receipt_sequences WHERE gym_id = ?', [gymId]);
    expect(sequence[0].last_seq).toBe(1);
  });

  it('issues no receipt for a rejected charge', async () => {
    providerResult.current = {
      success: false, providerRef: 'test-rejected-ref', errorCode: 'E101', errorMessage: 'Card declined',
    };
    const gymId = await createTestGym('Billing Receipt Rejected Gym');
    await createTestMembership(gymId);
    const memberId = await createMember(gymId);
    const { eventId } = await seedScheduledEvent(gymId, memberId, { amount: '29.99', card: 'rej' });

    const res = await request.post('/billing/run').set('x-internal-secret', SECRET);
    expect(res.body.failed).toBeGreaterThan(0);
    expect((await eventRow(eventId)).receipt_number).toBeNull();
    const { rows: sequence } = await db.query('SELECT last_seq FROM receipt_sequences WHERE gym_id = ?', [gymId]);
    expect(sequence).toHaveLength(0);
  });

  it('issues no receipt for a waived (zero) event', async () => {
    const gymId = await createTestGym('Billing Receipt Waived Gym');
    await createTestMembership(gymId);
    const memberId = await createMember(gymId);
    const { eventId } = await seedScheduledEvent(gymId, memberId, { amount: '0.00', card: 'waived' });

    const res = await request.post('/billing/run').set('x-internal-secret', SECRET);
    expect(res.body.waived).toBeGreaterThan(0);
    const ev = await eventRow(eventId);
    expect(ev.event_type).toBe('waived_billing');
    expect(ev.receipt_number).toBeNull();
  });

  it('does not re-issue on a later run, because the event is no longer scheduled', async () => {
    const gymId = await createTestGym('Billing Receipt Once Gym');
    await createTestMembership(gymId);
    const memberId = await createMember(gymId);
    const { eventId } = await seedScheduledEvent(gymId, memberId, { amount: '29.99', card: 'once', daysFromToday: -1 });

    await request.post('/billing/run').set('x-internal-secret', SECRET);
    const first = (await eventRow(eventId)).receipt_number;

    await db.query('DELETE FROM billing_run_log');
    await request.post('/billing/run').set('x-internal-secret', SECRET);

    expect((await eventRow(eventId)).receipt_number).toBe(first);
    const { rows: sequence } = await db.query<{ last_seq: number }>(
      'SELECT last_seq FROM receipt_sequences WHERE gym_id = ?', [gymId]);
    expect(sequence[0].last_seq).toBe(1);
  });
});

// ── POST /billing/cleanup ─────────────────────────────────────────────────────

describe('POST /billing/cleanup', () => {
  it('returns 401 with missing secret', async () => {
    const res = await request.post('/billing/cleanup');
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong secret', async () => {
    const res = await request.post('/billing/cleanup').set('x-internal-secret', 'wrong');
    expect(res.status).toBe(401);
  });

  it('returns 200 with expired count', async () => {
    const res = await request.post('/billing/cleanup').set('x-internal-secret', SECRET);
    expect(res.status).toBe(200);
    expect(typeof res.body.expired).toBe('number');
    expect(res.body.expired).toBeGreaterThanOrEqual(0);
  });

  it('marks expired pending payment_requests as expired', async () => {
    const gymId = await createTestGym('Billing Cleanup Gym');
    await createTestMembership(gymId);
    const memberId = await createMember(gymId);
    const planId = await createPlanWithPolicy(gymId);
    const userMembershipId = await createDueMembership(gymId, memberId, planId);
    await insertExpiredPaymentRequest(gymId, userMembershipId, memberId);

    const res = await request.post('/billing/cleanup').set('x-internal-secret', SECRET);
    expect(res.status).toBe(200);
    expect(res.body.expired).toBeGreaterThanOrEqual(1);

    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM payment_requests
       WHERE member_id = ? AND gym_id = ? AND source = 'admin'
       ORDER BY id DESC LIMIT 1`,
      [memberId, gymId],
    );
    expect(rows[0]?.status).toBe('expired');
  });

  // ── #789: the two deadlines ────────────────────────────────────────────────
  //
  // `page_token_expires` bounds how long the checkout *link* may be opened, not
  // how long the member has to pay through it. Cleanup used it for both, so a
  // member who opened the page at minute 9 and paid at minute 12 got an
  // `expired` row — which the webhook then skipped as already processed.

  /**
   * A request whose checkout page has been opened: `page_token` is NULL, which
   * `GET /payment-page/token/:token` is the only writer to do on a `pending`
   * row. `openedHoursAgo` moves `page_token_expires` back, which is what the
   * abandonment window is measured from.
   */
  async function insertOpenedPaymentRequest(
    gymId: string,
    userMembershipId: number,
    memberId: number,
    openedHoursAgo: number,
  ): Promise<number> {
    const { rows: ctRows } = await db.query<{ id: number }>(
      "SELECT id FROM charge_types WHERE code = 'membership_fee' LIMIT 1",
    );
    const { insertId } = await db.query(
      `INSERT INTO payment_requests
         (gym_id, user_membership_id, member_id, amount, currency, charge_type_id,
          status, provider, provider_order, page_token, page_token_expires, source)
       VALUES (?, ?, ?, '29.99', 'EUR', ?, 'pending', 'monei', UUID(), NULL,
               DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? HOUR), 'customer')`,
      [gymId, userMembershipId, memberId, ctRows[0].id, openedHoursAgo],
    );
    return insertId;
  }

  async function statusOf(id: number): Promise<string> {
    const { rows } = await db.query<{ status: string }>(
      'SELECT status FROM payment_requests WHERE id = ?',
      [id],
    );
    return rows[0].status;
  }

  async function cleanupFixture(name: string) {
    const gymId = await createTestGym(name);
    const memberId = await createMember(gymId);
    const planId = await createPlanWithPolicy(gymId);
    const userMembershipId = await createDueMembership(gymId, memberId, planId);
    return { gymId, memberId, userMembershipId };
  }

  it('leaves a request pending when its page was opened and the abandonment window has not passed', async () => {
    const { gymId, memberId, userMembershipId } = await cleanupFixture('Cleanup Opened Gym');
    // One hour past the ten-minute token TTL — the old query expired this row.
    const prId = await insertOpenedPaymentRequest(gymId, userMembershipId, memberId, 1);

    const res = await request.post('/billing/cleanup').set('x-internal-secret', SECRET);
    expect(res.status).toBe(200);

    expect(await statusOf(prId)).toBe('pending');
  });

  it('expires a request whose page was opened once the abandonment window has passed', async () => {
    const { gymId, memberId, userMembershipId } = await cleanupFixture('Cleanup Abandoned Gym');
    const prId = await insertOpenedPaymentRequest(gymId, userMembershipId, memberId, 25);

    const res = await request.post('/billing/cleanup').set('x-internal-secret', SECRET);
    expect(res.status).toBe(200);

    expect(await statusOf(prId)).toBe('expired');
  });

  it('honours PAYMENT_REQUEST_ABANDONED_HOURS for the opened-page window', async () => {
    const { gymId, memberId, userMembershipId } = await cleanupFixture('Cleanup Window Gym');
    const prId = await insertOpenedPaymentRequest(gymId, userMembershipId, memberId, 3);

    // Inside the default 24 h window, so untouched...
    expect((await request.post('/billing/cleanup').set('x-internal-secret', SECRET)).status).toBe(200);
    expect(await statusOf(prId)).toBe('pending');

    // ...and outside a 2 h one.
    const original = process.env.PAYMENT_REQUEST_ABANDONED_HOURS;
    process.env.PAYMENT_REQUEST_ABANDONED_HOURS = '2';
    try {
      expect((await request.post('/billing/cleanup').set('x-internal-secret', SECRET)).status).toBe(200);
    } finally {
      if (original === undefined) delete process.env.PAYMENT_REQUEST_ABANDONED_HOURS;
      else process.env.PAYMENT_REQUEST_ABANDONED_HOURS = original;
    }
    expect(await statusOf(prId)).toBe('expired');
  });

  // `expired` stays the total because .github/workflows/billing-run.yml parses
  // that field (#778); the breakdown is reported beside it.
  it('reports the two kinds of expiry separately and as one total', async () => {
    const { gymId, memberId, userMembershipId } = await cleanupFixture('Cleanup Counters Gym');
    await insertExpiredPaymentRequest(gymId, userMembershipId, memberId);
    await insertOpenedPaymentRequest(gymId, userMembershipId, memberId, 30);
    // Opened and still inside the window — counted by neither.
    const stillPending = await insertOpenedPaymentRequest(gymId, userMembershipId, memberId, 2);

    const res = await request.post('/billing/cleanup').set('x-internal-secret', SECRET);
    expect(res.status).toBe(200);
    expect(res.body.expired_unopened).toBeGreaterThanOrEqual(1);
    expect(res.body.expired_abandoned).toBeGreaterThanOrEqual(1);
    expect(res.body.expired).toBe(res.body.expired_unopened + res.body.expired_abandoned);

    expect(await statusOf(stillPending)).toBe('pending');
  });

  it('never expires a request that is already completed', async () => {
    const { gymId, memberId, userMembershipId } = await cleanupFixture('Cleanup Completed Gym');
    const prId = await insertOpenedPaymentRequest(gymId, userMembershipId, memberId, 99);
    await db.query(
      `UPDATE payment_requests SET status = 'completed', completed_at = UTC_TIMESTAMP() WHERE id = ?`,
      [prId],
    );

    expect((await request.post('/billing/cleanup').set('x-internal-secret', SECRET)).status).toBe(200);

    expect(await statusOf(prId)).toBe('completed');
  });
});
