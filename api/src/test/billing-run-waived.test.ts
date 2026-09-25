import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

/**
 * #635 stage 11 — the nightly run stops charging a waived cycle.
 *
 * Stage 8 made the Billing Simulation bill from the assignment's own Billing &
 * Duration and stage 10 put the same numbers in front of the Member; the run
 * still charged `final_price` flat, so a Plan sold with a free first month was
 * shown €0 and charged that night. These cases pin the new behaviour end to
 * end: which cycles are waived, which are still charged, and that a waived one
 * still moves the schedule on.
 */

const SECRET = 'test-billing-secret';

// Same provider stub as billing-run.test.ts: no provider is configured in
// tests, so a charge branch would otherwise be unreachable. A waived cycle must
// never reach it at all, which `executeRecurring.mock.calls` is what proves.
const executeRecurring = vi.hoisted(() => vi.fn(async () => ({ success: true, providerRef: 'test-provider-ref' })));
vi.mock('../payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../payments')>()),
  getPaymentProvider: () => ({ executeRecurring }),
}));

let gymId: string;

beforeAll(async () => {
  process.env.BILLING_INTERNAL_SECRET = SECRET;
  gymId = await createTestGym('Billing Waived Gym');
  await createTestMembership(gymId);
});

beforeEach(async () => {
  // The run is rate-limited to one call per 23 hours, and the log is a global
  // singleton — reset it *before* each case, so a run left behind by another
  // test file cannot turn the first case here into a 429.
  await db.query('UPDATE billing_run_log SET last_run_at = NULL WHERE id = 1');
  executeRecurring.mockClear();
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

/* ── setup helpers ───────────────────────────────────────────────────────── */

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

async function createMember(): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Waived Test Member', ?)`,
    [gymId, `waived-${uniq()}@test.com`],
  );
  await db.query(
    `INSERT INTO payment_methods (gym_id, member_id, provider, payment_token, sequence_id)
     VALUES (?, ?, 'monei', ?, ?)`,
    [gymId, insertId, `tok_${insertId}`, `seq_${insertId}`],
  );
  return insertId;
}

/** A monthly Plan, optionally carrying its own Billing & Duration. */
async function createPlan(duration?: { free?: number; paid?: number; bonus?: number }): Promise<number> {
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans
       (gym_id, name, lifecycle_status, enrollment_status, free_months, paid_months, bonus_months)
     VALUES (?, ?, 'active', 'staff_only', ?, ?, ?)`,
    [gymId, `Waived-Plan-${uniq()}`, duration?.free ?? null, duration?.paid ?? null, duration?.bonus ?? null],
  );
  await db.query(
    `INSERT INTO billing_policies
       (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`,
    [gymId, planId],
  );
  return planId;
}

interface AssignmentOptions {
  /** The assignment's own frozen Billing & Duration; omitted = captured nothing. */
  snapshot?: { free?: number | null; paid?: number | null; bonus?: number | null; prepaid?: number | null; fee?: number };
  nextBillingDate: string;
  startsAt?: string;
}

async function createDueAssignment(
  memberId: number, planId: number, opts: AssignmentOptions,
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO user_memberships
       (gym_id, member_id, membership_plan_id, status, starts_at, base_price, final_price,
        next_billing_date, free_months, paid_months, bonus_months, pay_beforehand_months,
        membership_fee_price)
     VALUES (?, ?, ?, 'active', ?, '29.99', '29.99', ?, ?, ?, ?, ?, ?)`,
    [
      gymId, memberId, planId, opts.startsAt ?? '2000-01-01', opts.nextBillingDate,
      opts.snapshot?.free ?? null, opts.snapshot?.paid ?? null, opts.snapshot?.bonus ?? null,
      opts.snapshot?.prepaid ?? null,
      opts.snapshot ? (opts.snapshot.fee ?? 29.99) : null,
    ],
  );
  return insertId;
}

/** A Promotion applied to `umId`, frozen with the months the case needs (§16). */
async function applyPromotion(
  umId: number, snapshot: { free?: number; paid?: number; bonus?: number }, appliedAt: string,
): Promise<number> {
  const { insertId: promotionId } = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status)
     VALUES (?, ?, '2000-01-01', '2100-01-01', 'active')`,
    [gymId, `Waived-Promo-${uniq()}`],
  );
  await db.query(
    `INSERT INTO user_membership_promotions
       (gym_id, user_membership_id, promotion_id, applied_by, status, applied_at, snapshot)
     VALUES (?, ?, ?, 'test-actor', 'applied', ?, ?)`,
    [gymId, umId, promotionId, appliedAt, JSON.stringify({
      name: 'Waived Promo',
      description: null,
      stackable: false,
      starts_at: '2000-01-01',
      ends_at: '2100-01-01',
      free_months: snapshot.free ?? 0,
      paid_months: snapshot.paid ?? 0,
      bonus_months: snapshot.bonus ?? 0,
      membership_fee_benefits: [],
    })],
  );
  return promotionId;
}

async function runBilling() {
  return request.post('/billing/run').set('x-internal-secret', SECRET);
}

async function eventsFor(umId: number) {
  const { rows } = await db.query(
    'SELECT event_type, amount, notes FROM billing_events WHERE user_membership_id = ? ORDER BY id ASC',
    [umId],
  );
  return rows;
}

async function scheduleFor(umId: number) {
  const { rows } = await db.query(
    'SELECT next_billing_date, last_billed_at FROM user_memberships WHERE id = ?', [umId],
  );
  const next = rows[0].next_billing_date;
  return {
    next_billing_date: next instanceof Date ? next.toISOString().slice(0, 10) : String(next).slice(0, 10),
    last_billed_at: rows[0].last_billed_at,
  };
}

/* ── the Plan's own Billing & Duration ───────────────────────────────────── */

describe('POST /billing/run — a waived cycle is recorded, not charged', () => {
  it('waives a cycle inside the assignment\'s Free Period and still advances the schedule', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createDueAssignment(memberId, planId, {
      snapshot: { free: 1, paid: 2 }, nextBillingDate: '2000-01-15',
    });

    const res = await runBilling();
    expect(res.status).toBe(200);
    expect(res.body.waived).toBeGreaterThan(0);

    expect(await eventsFor(umId)).toEqual([
      { event_type: 'waived_billing', amount: '0.00', notes: 'free_plan' },
    ]);
    const { rows: txs } = await db.query(
      'SELECT id FROM payment_requests WHERE user_membership_id = ?', [umId],
    );
    expect(txs).toHaveLength(0);
    // Nothing was billed, so `last_billed_at` stays untouched — but the cycle
    // is spent, so the schedule moves on exactly as a charged one would.
    expect(await scheduleFor(umId)).toMatchObject({
      next_billing_date: '2000-02-15', last_billed_at: null,
    });
  });

  it('waives a cycle inside the Bonus Duration', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createDueAssignment(memberId, planId, {
      snapshot: { free: 0, paid: 1, bonus: 1 }, nextBillingDate: '2000-02-15',
    });

    await runBilling();

    expect(await eventsFor(umId)).toEqual([
      { event_type: 'waived_billing', amount: '0.00', notes: 'bonus_plan' },
    ]);
  });

  // #635 stage 13 — a Pre-paid month is one of the Paid Duration's months that
  // was already paid up front, so the run must charge nothing for it and must
  // not call the provider, exactly as for a free or bonus cycle.
  it('waives a cycle inside the Pre-paid Duration', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createDueAssignment(memberId, planId, {
      snapshot: { free: 0, paid: 3, prepaid: 2 }, nextBillingDate: '2000-01-15',
    });

    await runBilling();

    expect(await eventsFor(umId)).toEqual([
      { event_type: 'waived_billing', amount: '0.00', notes: 'prepaid_plan' },
    ]);
    const { rows: txs } = await db.query(
      'SELECT id FROM payment_requests WHERE user_membership_id = ?', [umId],
    );
    expect(txs).toHaveLength(0);
    expect(await scheduleFor(umId)).toMatchObject({
      next_billing_date: '2000-02-15', last_billed_at: null,
    });
  });

  it('charges a paid cycle the Pre-paid Duration no longer covers', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createDueAssignment(memberId, planId, {
      // Prepaid covers 2000-01-01 .. 2000-02-29; this cycle is the month after.
      snapshot: { free: 0, paid: 3, prepaid: 2 }, nextBillingDate: '2000-03-15',
    });

    await runBilling();

    expect((await eventsFor(umId)).map((e: any) => e.event_type)).not.toContain('waived_billing');
  });

  it('charges the agreed price once the Free Period is over', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createDueAssignment(memberId, planId, {
      snapshot: { free: 1, paid: 0 }, nextBillingDate: '2000-03-01',
    });

    await runBilling();

    const events = await eventsFor(umId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: 'recurring_payment', amount: '29.99' });
    const { rows: txs } = await db.query(
      'SELECT status, amount FROM payment_requests WHERE user_membership_id = ?', [umId],
    );
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({ status: 'completed', amount: '29.99' });
    expect(await scheduleFor(umId)).toMatchObject({ next_billing_date: '2000-04-01' });
  });

  it('charges an assignment whose Plan has no Billing & Duration at all', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createDueAssignment(memberId, planId, { nextBillingDate: '2000-01-15' });

    await runBilling();

    expect((await eventsFor(umId))[0]).toMatchObject({ event_type: 'recurring_payment', amount: '29.99' });
  });

  // The all-or-nothing fallback (§13): an assignment that captured no snapshot
  // reads its Plan's live durations — and only then.
  it('reads the Plan\'s live durations for an assignment that captured no snapshot', async () => {
    const memberId = await createMember();
    const planId = await createPlan({ free: 1 });
    const umId = await createDueAssignment(memberId, planId, { nextBillingDate: '2000-01-15' });

    await runBilling();

    expect((await eventsFor(umId))[0]).toMatchObject({ event_type: 'waived_billing', notes: 'free_plan' });
  });

  it('never reads the Plan\'s durations for an assignment that captured its own', async () => {
    const memberId = await createMember();
    // The Plan gained a Free Period after this member enrolled without one.
    const planId = await createPlan({ free: 12 });
    const umId = await createDueAssignment(memberId, planId, {
      snapshot: { free: null, paid: null, bonus: null, fee: 29.99 }, nextBillingDate: '2000-01-15',
    });

    await runBilling();

    expect((await eventsFor(umId))[0]).toMatchObject({ event_type: 'recurring_payment' });
  });
});

/* ── an applied Promotion outranks the Plan (the thread's Q2 answer) ─────── */

describe('POST /billing/run — an applied Promotion decides the cycle it governs', () => {
  it('waives a cycle inside the Promotion\'s own free month', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createDueAssignment(memberId, planId, {
      snapshot: { free: 0, paid: 6 }, nextBillingDate: '2000-01-15',
    });
    await applyPromotion(umId, { free: 1, paid: 3 }, '2000-01-01 00:00:00');

    await runBilling();

    expect((await eventsFor(umId))[0]).toMatchObject({
      event_type: 'waived_billing', notes: 'free_promotion',
    });
    // The provider is never called for this assignment — every other due
    // assignment in the gym is still processed in the same run, so what proves
    // it is the absence of a transaction here, not the spy's total call count.
    const { rows: txs } = await db.query(
      'SELECT id FROM payment_requests WHERE user_membership_id = ?', [umId],
    );
    expect(txs).toHaveLength(0);
  });

  it('charges a month the Promotion bills for, even where the Plan\'s Free Period covers it', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createDueAssignment(memberId, planId, {
      snapshot: { free: 6, paid: 0 }, nextBillingDate: '2000-01-15',
    });
    await applyPromotion(umId, { paid: 3 }, '2000-01-01 00:00:00');

    await runBilling();

    expect((await eventsFor(umId))[0]).toMatchObject({ event_type: 'recurring_payment', amount: '29.99' });
  });

  it('ignores a revoked application and falls back to the Plan\'s own periods', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createDueAssignment(memberId, planId, {
      snapshot: { free: 1, paid: 2 }, nextBillingDate: '2000-01-15',
    });
    const promotionId = await applyPromotion(umId, { paid: 3 }, '2000-01-01 00:00:00');
    await db.query(
      `UPDATE user_membership_promotions SET status = 'revoked', revoked_at = '2000-01-10'
       WHERE user_membership_id = ? AND promotion_id = ?`,
      [umId, promotionId],
    );

    await runBilling();

    expect((await eventsFor(umId))[0]).toMatchObject({
      event_type: 'waived_billing', notes: 'free_plan',
    });
  });
});
