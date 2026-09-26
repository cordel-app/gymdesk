import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

/**
 * #635 stage 15 — the Membership Fee is computed, never stored.
 *
 * Stage 12 established one rule for what the fee costs on a date: a Promotion's
 * Membership Fee Benefit lives inside the Promotion's own Free/Paid/Bonus timeline
 * and ends with it. Because applying that rule to real billing can *raise* a
 * charge, it shipped behind `billing.date_aware_membership_fee` while
 * `user_memberships.final_price` — one number with no date in it — kept being
 * charged, and a drift report quantified the difference.
 *
 * The #635 thread's answer to that report removed both: the flag and the stored
 * price (migration 191). These cases pin what is left — one rule, resolved per
 * cycle, everywhere:
 *
 *   - the nightly run charges the fee the cycle it is billing actually owes;
 *   - the staff screens and a payment link resolve that same number;
 *   - applying or revoking a Promotion writes no price anywhere, and the
 *     assignment's own regular fee (`membership_fee_price`) is all it stores;
 *   - a cycle that owes nothing is never handed to a payment provider.
 */

const SECRET = 'test-billing-secret';

// Same provider stub as billing-run.test.ts / billing-run-waived.test.ts: no
// provider is configured in tests, so the charge branch is otherwise unreachable.
const executeRecurring = vi.hoisted(() => vi.fn(async () => ({ success: true, providerRef: 'test-provider-ref' })));
vi.mock('../payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../payments')>()),
  getPaymentProvider: () => ({ executeRecurring }),
}));

let gymId: string;

beforeAll(async () => {
  process.env.BILLING_INTERNAL_SECRET = SECRET;
  gymId = await createTestGym('Dynamic Fee Gym');
  await createTestMembership(gymId);
});

beforeEach(async () => {
  // The run is rate-limited to one call per 23 hours and the log is a global
  // singleton — reset it before each case so a run left behind elsewhere cannot
  // turn the first case here into a 429.
  await db.query('UPDATE billing_run_log SET last_run_at = NULL WHERE id = 1');
  executeRecurring.mockClear();
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

/* ── setup helpers ───────────────────────────────────────────────────────── */

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

/** A date N days from today, for a case whose Promotion is applied *now* by the API. */
const dayOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function createMember(gym = gymId): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Dynamic Fee Member', ?)`,
    [gym, `dynamic-fee-${uniq()}@test.com`],
  );
  await db.query(
    `INSERT INTO payment_methods (gym_id, member_id, provider, payment_token, sequence_id)
     VALUES (?, ?, 'monei', ?, ?)`,
    [gym, insertId, `tok_${insertId}`, `seq_${insertId}`],
  );
  return insertId;
}

/** A monthly Plan with no Billing & Duration of its own. */
async function createPlan(gym = gymId): Promise<number> {
  const { insertId: planId } = await db.query(
    `INSERT INTO membership_plans (gym_id, name, lifecycle_status, enrollment_status)
     VALUES (?, ?, 'active', 'staff_only')`,
    [gym, `Dynamic-Fee-Plan-${uniq()}`],
  );
  await db.query(
    `INSERT INTO billing_policies
       (gym_id, membership_plan_id, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, 1, 'month')`,
    [gym, planId],
  );
  return planId;
}

/**
 * An assignment whose own snapshot says its regular Membership Fee is €50. That
 * column is the only fee it stores: what a Promotion makes of it is resolved for
 * whichever cycle is being priced.
 */
async function createAssignment(
  memberId: number, planId: number, nextBillingDate: string,
  over: { fee?: number; startsAt?: string } = {},
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO user_memberships
       (gym_id, member_id, membership_plan_id, status, starts_at, base_price,
        next_billing_date, membership_fee_price, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, ?, 'active', ?, 0, ?, ?, 1, 'month')`,
    [gymId, memberId, planId, over.startsAt ?? '2000-01-01', nextBillingDate, over.fee ?? 50],
  );
  return insertId;
}

/** A standing application, frozen with its own months and Membership Fee Benefit. */
async function applyPromotion(umId: number, opts: {
  paidMonths?: number;
  freeMonths?: number;
  bonusMonths?: number;
  action?: string;
  value?: number | null;
  durationMonths?: number | null;
  appliedAt?: string;
}): Promise<number> {
  const { insertId: promotionId } = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status,
                             free_months, paid_months, bonus_months)
     VALUES (?, ?, '2000-01-01', '2100-01-01', 'active', ?, ?, ?)`,
    [gymId, `Dynamic-Fee-Promo-${uniq()}`, opts.freeMonths ?? 0, opts.paidMonths ?? 0, opts.bonusMonths ?? 0],
  );
  await db.query(
    `INSERT INTO user_membership_promotions
       (gym_id, user_membership_id, promotion_id, applied_by, status, applied_at, snapshot)
     VALUES (?, ?, ?, 'test-actor', 'applied', ?, ?)`,
    [gymId, umId, promotionId, opts.appliedAt ?? '2000-01-01 00:00:00', JSON.stringify({
      name: 'Dynamic Fee Promo',
      description: null,
      stackable: false,
      starts_at: '2000-01-01',
      ends_at: '2100-01-01',
      free_months: opts.freeMonths ?? 0,
      paid_months: opts.paidMonths ?? 0,
      bonus_months: opts.bonusMonths ?? 0,
      membership_fee_benefits: opts.action == null ? [] : [{
        quantity: 1, frequency_interval: 1, frequency_unit: 'month', enabled: true,
        action: opts.action, value: opts.value ?? null,
        duration_months: opts.durationMonths ?? null,
      }],
    })],
  );
  return promotionId;
}

const runBilling = () => request.post('/billing/run').set('x-internal-secret', SECRET);

async function chargeFor(umId: number) {
  const { rows } = await db.query(
    'SELECT event_type, amount, notes FROM billing_events WHERE user_membership_id = ? ORDER BY id ASC',
    [umId],
  );
  return rows;
}

const getAssignment = (umId: number) => request
  .get(`/user-memberships/${umId}`)
  .set('Authorization', TEST_AUTH_HEADER)
  .set('x-gym-id', gymId);

/* ── what the nightly run charges ────────────────────────────────────────── */

describe('POST /billing/run — the fee the cycle being billed owes (#635 stage 15)', () => {
  it('charges the regular fee once the Promotion\'s own months are over', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    // 3 promotional months from 2000-01-01, so the June cycle is a regular one.
    const umId = await createAssignment(memberId, planId, '2000-06-15');
    await applyPromotion(umId, { paidMonths: 3, action: 'percentage_discount', value: 20 });

    expect((await runBilling()).status).toBe(200);

    expect(await chargeFor(umId)).toEqual([
      { event_type: 'recurring_payment', amount: '50.00', notes: null },
    ]);
    const { rows: txs } = await db.query(
      'SELECT status, amount FROM payment_requests WHERE user_membership_id = ?', [umId],
    );
    expect(txs).toEqual([expect.objectContaining({ status: 'completed', amount: '50.00' })]);
  });

  it('applies the benefit to a cycle inside the promotional months', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    // The second of three promotional months — the discount was agreed for it.
    const umId = await createAssignment(memberId, planId, '2000-02-15');
    await applyPromotion(umId, { paidMonths: 3, action: 'percentage_discount', value: 20 });

    await runBilling();

    expect((await chargeFor(umId))[0]).toMatchObject({ event_type: 'recurring_payment', amount: '40.00' });
  });

  it('never applies the benefit of a Promotion configured with no Free/Paid/Bonus months', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createAssignment(memberId, planId, '2000-06-15');
    await applyPromotion(umId, { action: 'percentage_discount', value: 20 });

    await runBilling();

    expect((await chargeFor(umId))[0]).toMatchObject({ event_type: 'recurring_payment', amount: '50.00' });
  });

  it('charges the negotiated fee a human agreed, and discounts a Promotion from it', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    // A negotiated price is the assignment's own regular fee plus a reason (§15) —
    // there is no second number in which a Promotion's effect could hide.
    const umId = await createAssignment(memberId, planId, '2000-02-15', { fee: 30 });
    await db.query(
      "UPDATE user_memberships SET discount_reason = 'Loyalty' WHERE id = ?", [umId],
    );
    await applyPromotion(umId, { paidMonths: 3, action: 'percentage_discount', value: 20 });

    await runBilling();

    // Inside the promotional months: 20% off the €30 that was agreed, never off
    // the Plan's catalogue price.
    expect((await chargeFor(umId))[0]).toMatchObject({ event_type: 'recurring_payment', amount: '24.00' });
  });

  it('stands the negotiated fee on its own once those months are over', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createAssignment(memberId, planId, '2000-06-15', { fee: 30 });
    await db.query(
      "UPDATE user_memberships SET discount_reason = 'Loyalty' WHERE id = ?", [umId],
    );
    await applyPromotion(umId, { paidMonths: 3, action: 'percentage_discount', value: 20 });

    await runBilling();

    expect((await chargeFor(umId))[0]).toMatchObject({ event_type: 'recurring_payment', amount: '30.00' });
  });

  it('still waives a cycle the assignment\'s own Free Period covers', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createAssignment(memberId, planId, '2000-01-15');
    await db.query('UPDATE user_memberships SET free_months = 1, paid_months = 12 WHERE id = ?', [umId]);

    await runBilling();

    expect(await chargeFor(umId)).toEqual([
      { event_type: 'waived_billing', amount: '0.00', notes: 'free_plan' },
    ]);
    expect(executeRecurring).not.toHaveBeenCalled();
  });

  it('reports no drift counter — there are no longer two rules to differ', async () => {
    const res = await runBilling();
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('drift');
    expect(res.body).toMatchObject({
      processed: expect.any(Number),
      succeeded: expect.any(Number),
      failed: expect.any(Number),
      waived: expect.any(Number),
    });
  });
});

/* ── what the staff screens resolve ─────────────────────────────────────── */

describe('GET /user-memberships — the resolved Membership Fee (#635 stage 15)', () => {
  it('resolves the fee the run would charge for the same cycle', async () => {
    const { priceDueMembershipFee } = await import('../api/billing-run-pricing');
    const memberId = await createMember();
    const planId = await createPlan();
    // A future cycle, so the resolved date is the one the run will bill next.
    const umId = await createAssignment(memberId, planId, '2099-02-15', { startsAt: '2099-01-01' });
    await applyPromotion(umId, {
      paidMonths: 3, action: 'percentage_discount', value: 20, appliedAt: '2099-01-01 00:00:00',
    });

    const { body } = await getAssignment(umId);
    expect(Number(body.membership_fee)).toBe(40);
    expect(Number(body.membership_fee_price)).toBe(50);

    const { rows } = await db.query(
      `SELECT um.id, um.starts_at, um.membership_plan_id, um.membership_fee_price, um.base_price,
              um.free_months, um.paid_months, um.bonus_months, um.pay_beforehand_months,
              p.free_months AS plan_free_months, p.paid_months AS plan_paid_months,
              p.bonus_months AS plan_bonus_months,
              p.pay_beforehand_months AS plan_pay_beforehand_months,
              (um.membership_fee_price IS NOT NULL) AS has_billing_snapshot
       FROM user_memberships um
       LEFT JOIN membership_plans p ON p.id = um.membership_plan_id
       WHERE um.id = ?`,
      [umId],
    );
    const priced = await priceDueMembershipFee(rows[0] as any, '2099-02-15', gymId);
    expect(priced.amount).toBe(Number(body.membership_fee));
  });

  it('marks a waived cycle as waived instead of pricing it', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createAssignment(memberId, planId, '2099-01-15', { startsAt: '2099-01-01' });
    await db.query('UPDATE user_memberships SET free_months = 1, paid_months = 12 WHERE id = ?', [umId]);

    const { body } = await getAssignment(umId);
    expect(body.membership_fee).toBe(0);
    expect(body.membership_fee_waived).toBe(true);
    expect(body.membership_fee_period_status).toBe('free_plan');
  });

  it('never exposes the columns the resolution read', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createAssignment(memberId, planId, '2099-01-15');

    const { body } = await getAssignment(umId);
    for (const field of ['final_price', 'has_billing_snapshot', 'plan_free_months', 'plan_paid_months']) {
      expect(body).not.toHaveProperty(field);
    }
  });
});

/* ── applying a Promotion stores no price ───────────────────────────────── */

describe('POST /user-memberships/:id/promotions — nothing is written back (#635 stage 15)', () => {
  async function createTargetedPromotion(planId: number, paidMonths: number): Promise<number> {
    const { insertId: promotionId } = await db.query(
      `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable,
                               free_months, paid_months, bonus_months, only_applicable_for_new_members)
       VALUES (?, ?, '2000-01-01', '2100-01-01', 'active', 1, 0, ?, 0, 0)`,
      [gymId, `Dynamic-Fee-Api-Promo-${uniq()}`, paidMonths],
    );
    await db.query(
      'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
      [gymId, promotionId, planId],
    );
    await db.query(
      `INSERT INTO promotion_membership_fee_benefits
         (gym_id, promotion_id, quantity, frequency_interval, frequency_unit, enabled, action, value)
       VALUES (?, ?, 1, 1, 'month', 1, 'percentage_discount', 20)`,
      [gymId, promotionId],
    );
    return promotionId;
  }

  const apply = (umId: number, promotionId: number) => request
    .post(`/user-memberships/${umId}/promotions`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId)
    .send({ promotion_id: promotionId });

  it('answers with the fee resolved for the next cycle, and leaves the snapshot alone', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    // Applied through the API, so the application's own anchor is today: the cycle
    // priced has to be one the Promotion actually covers.
    const umId = await createAssignment(memberId, planId, dayOffset(45), { startsAt: dayOffset(0) });
    const promotionId = await createTargetedPromotion(planId, 12);

    const res = await apply(umId, promotionId);
    expect(res.status).toBe(201);
    expect(Number(res.body.membership_fee)).toBe(40);

    // The assignment's own regular fee is untouched — the discount lives in the
    // application, and is applied again whenever a cycle is priced.
    const { rows } = await db.query(
      'SELECT membership_fee_price FROM user_memberships WHERE id = ?', [umId],
    );
    expect(Number(rows[0].membership_fee_price)).toBe(50);
  });

  it('records the adjustment the apply made to that cycle', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createAssignment(memberId, planId, dayOffset(45), { startsAt: dayOffset(0) });
    const promotionId = await createTargetedPromotion(planId, 12);

    await apply(umId, promotionId);

    const { rows } = await db.query(
      `SELECT event_type, amount, notes FROM billing_events
        WHERE user_membership_id = ? AND event_type = 'adjustment'`,
      [umId],
    );
    expect(rows).toEqual([expect.objectContaining({ amount: '-10.00', notes: 'Promotion applied' })]);
  });

  it('puts the fee back when the Promotion is revoked', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createAssignment(memberId, planId, dayOffset(45), { startsAt: dayOffset(0) });
    const promotionId = await createTargetedPromotion(planId, 12);
    await apply(umId, promotionId);

    const res = await request
      .delete(`/user-memberships/${umId}/promotions/${promotionId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(Number(res.body.membership_fee)).toBe(50);

    const { rows } = await db.query(
      `SELECT amount, notes FROM billing_events
        WHERE user_membership_id = ? AND event_type = 'adjustment' ORDER BY id ASC`,
      [umId],
    );
    expect(rows.map((r: any) => [r.amount, r.notes])).toEqual([
      ['-10.00', 'Promotion applied'],
      ['10.00', 'Promotion revoked'],
    ]);
  });
});

/* ── a payment link asks for the cycle's own price ──────────────────────── */

describe('POST /payment-requests — the amount is resolved, not stored (#635 stage 15)', () => {
  it('asks for the fee the next cycle owes', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createAssignment(memberId, planId, '2099-02-15', { startsAt: '2099-01-01' });
    await applyPromotion(umId, {
      paidMonths: 3, action: 'percentage_discount', value: 20, appliedAt: '2099-01-01 00:00:00',
    });

    const res = await request
      .post('/payment-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ user_membership_id: umId });
    expect(res.status).toBe(201);

    const { rows } = await db.query(
      'SELECT amount FROM payment_requests WHERE user_membership_id = ? ORDER BY id DESC', [umId],
    );
    expect(Number(rows[0].amount)).toBe(40);
  });

  it('refuses to ask for money for a cycle that owes nothing', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createAssignment(memberId, planId, '2099-01-15', { startsAt: '2099-01-01' });
    await db.query('UPDATE user_memberships SET free_months = 1, paid_months = 12 WHERE id = ?', [umId]);

    const res = await request
      .post('/payment-requests')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ user_membership_id: umId });
    expect(res.status).toBe(400);
    const { rows } = await db.query(
      'SELECT id FROM payment_requests WHERE user_membership_id = ?', [umId],
    );
    expect(rows).toHaveLength(0);
  });
});

/* ── the schema and the flags the correction needed ─────────────────────── */

describe('migration 191 — the stored price and its switch are gone', () => {
  it('drops user_memberships.final_price', async () => {
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'user_memberships'
          AND column_name = 'final_price'`,
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it('keeps membership_fee_price — the only fee an assignment stores', async () => {
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'user_memberships'
          AND column_name = 'membership_fee_price'`,
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it('removes both feature flags the review needed', async () => {
    const { rows } = await db.query(
      `SELECT feature_key FROM feature_flags
        WHERE feature_key IN ('billing.date_aware_membership_fee', 'payments.membership_fee_drift')`,
    );
    expect(rows).toEqual([]);
  });

  it('no longer serves the drift report', async () => {
    const res = await request
      .get('/user-memberships/reports/membership-fee-drift')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(404);
  });
});
