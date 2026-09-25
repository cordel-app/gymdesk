import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { invalidateFeatureFlagsCache } from '../infra/featureFlags';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

/**
 * #635 stage 12 — a Promotion's Membership Fee Benefit ends with the Promotion's
 * own Free/Paid/Bonus timeline, for real money too.
 *
 * `user_memberships.final_price` is one number with no date in it, so the nightly
 * run kept charging a Promotion's discount long after the promotional months it
 * was agreed for had elapsed. Stage 12 prices each cycle through
 * `resolveMembershipFee` — the resolver the Billing Simulation and My Membership
 * already use — so the three can no longer disagree.
 *
 * Because that correction *raises* a real charge it ships switchable and off
 * (`billing.date_aware_membership_fee`, migration 186). These cases pin both
 * sides of the switch and the report that surfaces the impact before it is
 * flipped: with the flag off nothing about the charge changes and the difference
 * is reported; with it on the resolved price is charged.
 */

const SECRET = 'test-billing-secret';
const FLAG = 'billing.date_aware_membership_fee';

// Same provider stub as billing-run.test.ts / billing-run-waived.test.ts: no
// provider is configured in tests, so the charge branch is otherwise unreachable.
const executeRecurring = vi.hoisted(() => vi.fn(async () => ({ success: true, providerRef: 'test-provider-ref' })));
vi.mock('../payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../payments')>()),
  getPaymentProvider: () => ({ executeRecurring }),
}));

let gymId: string;
let otherGymId: string;

beforeAll(async () => {
  process.env.BILLING_INTERNAL_SECRET = SECRET;
  gymId = await createTestGym('Date Aware Fee Gym');
  await createTestMembership(gymId);
  otherGymId = await createTestGym('Date Aware Fee Other Gym');
  await createTestMembership(otherGymId);
});

beforeEach(async () => {
  // The run is rate-limited to one call per 23 hours and the log is a global
  // singleton — reset it before each case so a run left behind elsewhere cannot
  // turn the first case here into a 429.
  await db.query('UPDATE billing_run_log SET last_run_at = NULL WHERE id = 1');
  executeRecurring.mockClear();
});

afterEach(async () => {
  await setFlag(false);
});

afterAll(async () => {
  await setFlag(false);
  await cleanupTestGyms();
  await db.end();
});

/* ── setup helpers ───────────────────────────────────────────────────────── */

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

/**
 * An UPDATE would be a silent no-op on a database where migration 186 has not
 * run — and a missing key reads as *enabled*, so the "flag off" cases would fail
 * looking like a pricing bug. Upserting makes the row's absence unobservable.
 */
async function setFlag(enabled: boolean) {
  await db.query(
    `INSERT INTO feature_flags (feature_key, enabled, updated_at)
     VALUES (?, ?, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), updated_at = UTC_TIMESTAMP()`,
    [FLAG, enabled ? 1 : 0],
  );
  invalidateFeatureFlagsCache();
}

async function createMember(gym = gymId): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO members (gym_id, name, email) VALUES (?, 'Date Aware Member', ?)`,
    [gym, `date-aware-${uniq()}@test.com`],
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
    [gym, `DateAware-Plan-${uniq()}`],
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
 * An assignment frozen with a €50 regular fee and the €40 `final_price` a 20%-off
 * Promotion left behind when it was applied.
 */
async function createAssignment(
  memberId: number, planId: number, nextBillingDate: string, gym = gymId,
  over: { finalPrice?: number; fee?: number; startsAt?: string } = {},
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO user_memberships
       (gym_id, member_id, membership_plan_id, status, starts_at, base_price, final_price,
        next_billing_date, membership_fee_price, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, ?, 'active', ?, 0, ?, ?, ?, 1, 'month')`,
    [
      gym, memberId, planId, over.startsAt ?? '2000-01-01',
      over.finalPrice ?? 40, nextBillingDate, over.fee ?? 50,
    ],
  );
  return insertId;
}

/** A standing application, frozen with its own months and Membership Fee Benefit. */
async function applyPromotion(umId: number, opts: {
  gym?: string;
  paidMonths?: number;
  freeMonths?: number;
  bonusMonths?: number;
  action?: string;
  value?: number | null;
  durationMonths?: number | null;
  appliedAt?: string;
}): Promise<number> {
  const gym = opts.gym ?? gymId;
  const { insertId: promotionId } = await db.query(
    `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status,
                             free_months, paid_months, bonus_months)
     VALUES (?, ?, '2000-01-01', '2100-01-01', 'active', ?, ?, ?)`,
    [gym, `DateAware-Promo-${uniq()}`, opts.freeMonths ?? 0, opts.paidMonths ?? 0, opts.bonusMonths ?? 0],
  );
  await db.query(
    `INSERT INTO user_membership_promotions
       (gym_id, user_membership_id, promotion_id, applied_by, status, applied_at, snapshot)
     VALUES (?, ?, ?, 'test-actor', 'applied', ?, ?)`,
    [gym, umId, promotionId, opts.appliedAt ?? '2000-01-01 00:00:00', JSON.stringify({
      name: 'Date Aware Promo',
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

const driftReport = (gym = gymId) => request
  .get('/user-memberships/reports/membership-fee-drift')
  .set('Authorization', TEST_AUTH_HEADER)
  .set('x-gym-id', gym);

async function chargeFor(umId: number) {
  const { rows } = await db.query(
    'SELECT event_type, amount, notes FROM billing_events WHERE user_membership_id = ? ORDER BY id ASC',
    [umId],
  );
  return rows;
}

/* ── the run, on both sides of the switch ────────────────────────────────── */

describe('POST /billing/run — the Membership Fee of a lapsed Promotion (#635 stage 12)', () => {
  it('charges the stored discount and only reports the difference while the flag is off', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    // 3 promotional months from 2000-01-01, so the June cycle is regular.
    const umId = await createAssignment(memberId, planId, '2000-06-15');
    await applyPromotion(umId, { paidMonths: 3, action: 'percentage_discount', value: 20 });

    const res = await runBilling();
    expect(res.status).toBe(200);
    expect(res.body.drift).toBeGreaterThan(0);

    // Unchanged behaviour: the member is still charged the stored `final_price`.
    expect(await chargeFor(umId)).toEqual([
      { event_type: 'recurring_payment', amount: '40.00', notes: null },
    ]);
  });

  it('charges the resolved regular fee once the flag is on', async () => {
    await setFlag(true);
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createAssignment(memberId, planId, '2000-06-15');
    await applyPromotion(umId, { paidMonths: 3, action: 'percentage_discount', value: 20 });

    const res = await runBilling();
    expect(res.status).toBe(200);
    // Once it is live the two rules agree by construction, so nothing drifts.
    expect(res.body.drift).toBe(0);

    expect(await chargeFor(umId)).toEqual([
      { event_type: 'recurring_payment', amount: '50.00', notes: null },
    ]);
    const { rows: txs } = await db.query(
      'SELECT status, amount FROM payment_requests WHERE user_membership_id = ?', [umId],
    );
    expect(txs).toEqual([expect.objectContaining({ status: 'completed', amount: '50.00' })]);
  });

  it('still applies the benefit to a cycle inside the promotional months', async () => {
    await setFlag(true);
    const memberId = await createMember();
    const planId = await createPlan();
    // The second of three promotional months — the discount was agreed for it.
    const umId = await createAssignment(memberId, planId, '2000-02-15');
    await applyPromotion(umId, { paidMonths: 3, action: 'percentage_discount', value: 20 });

    await runBilling();

    expect((await chargeFor(umId))[0]).toMatchObject({ event_type: 'recurring_payment', amount: '40.00' });
  });

  it('never applies the benefit of a Promotion configured with no Free/Paid/Bonus months', async () => {
    await setFlag(true);
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createAssignment(memberId, planId, '2000-06-15');
    await applyPromotion(umId, { action: 'percentage_discount', value: 20 });

    await runBilling();

    expect((await chargeFor(umId))[0]).toMatchObject({ event_type: 'recurring_payment', amount: '50.00' });
  });

  it('never raises a charge a human agreed to discount', async () => {
    await setFlag(true);
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createAssignment(memberId, planId, '2000-06-15', gymId, { finalPrice: 30 });
    await db.query(
      "UPDATE user_memberships SET discount_reason = 'Loyalty', discount_expires_at = NULL WHERE id = ?",
      [umId],
    );
    await applyPromotion(umId, { paidMonths: 3, action: 'percentage_discount', value: 20 });

    await runBilling();

    // The staff-agreed €30 stands — the correction is about Promotions, and must
    // not quietly undo a discount someone granted.
    expect((await chargeFor(umId))[0]).toMatchObject({ event_type: 'recurring_payment', amount: '30.00' });
  });

  it('still waives a cycle the assignment\'s own Free Period covers', async () => {
    await setFlag(true);
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createAssignment(memberId, planId, '2000-01-15');
    await db.query('UPDATE user_memberships SET free_months = 1, paid_months = 12 WHERE id = ?', [umId]);

    await runBilling();

    expect(await chargeFor(umId)).toEqual([
      { event_type: 'waived_billing', amount: '0.00', notes: 'free_plan' },
    ]);
  });
});

/* ── the impact report ───────────────────────────────────────────────────── */

describe('GET /user-memberships/reports/membership-fee-drift (#635 stage 12)', () => {
  it('reports the stored price, the promotion timeline, the benefit end date and the difference', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createAssignment(memberId, planId, '2000-06-15');
    const promotionId = await applyPromotion(umId, { paidMonths: 3, action: 'percentage_discount', value: 20 });

    const res = await driftReport();
    expect(res.status).toBe(200);
    expect(res.body.date_aware_pricing_enabled).toBe(false);
    const item = res.body.items.find((i: any) => i.user_membership_id === umId);
    expect(item).toMatchObject({
      member_id: memberId,
      billing_date: '2000-06-15',
      stored_final_price: 40,
      regular_fee: 50,
      charged_amount: 40,
      resolved_amount: 50,
      difference: 10,
    });
    expect(item.promotions).toEqual([expect.objectContaining({
      promotion_id: promotionId,
      applied_at: '2000-01-01',
      paid_months: 3,
      // 3 promotional months from 2000-01-01 — the benefit stops after March.
      benefit_ends_on: '2000-03-31',
      has_membership_fee_benefit: true,
    })]);
  });

  it('leaves out an assignment whose cycle both rules price the same', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    // Inside the promotional months: the stored price is the resolved one.
    const umId = await createAssignment(memberId, planId, '2000-02-15');
    await applyPromotion(umId, { paidMonths: 3, action: 'percentage_discount', value: 20 });

    const res = await driftReport();
    expect(res.body.items.map((i: any) => i.user_membership_id)).not.toContain(umId);
    expect(res.body.examined).toBeGreaterThan(0);
  });

  it('reports nothing once the corrected pricing is live', async () => {
    await setFlag(true);
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createAssignment(memberId, planId, '2000-06-15');
    await applyPromotion(umId, { paidMonths: 3, action: 'percentage_discount', value: 20 });

    const res = await driftReport();
    expect(res.body.date_aware_pricing_enabled).toBe(true);
    expect(res.body.items.map((i: any) => i.user_membership_id)).not.toContain(umId);
  });

  it('never reports another gym\'s assignments', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createAssignment(memberId, planId, '2000-06-15');
    await applyPromotion(umId, { paidMonths: 3, action: 'percentage_discount', value: 20 });

    const res = await driftReport(otherGymId);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.user_membership_id)).not.toContain(umId);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request
      .get('/user-memberships/reports/membership-fee-drift')
      .set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });
});

/* ── final_price itself ──────────────────────────────────────────────────── */

describe('final_price is resolved on a date once the flag is on (#635 stage 12)', () => {
  /** Applies `promotionId` through the API, which is what recomputes final_price. */
  async function applyViaApi(umId: number, promotionId: number) {
    return request
      .post(`/user-memberships/${umId}/promotions`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ promotion_id: promotionId });
  }

  async function createPromotionFor(
    planId: number, paidMonths: number,
    opts: { stackable?: boolean; benefit?: boolean } = {},
  ): Promise<number> {
    const { insertId: promotionId } = await db.query(
      `INSERT INTO promotions (gym_id, name, starts_at, ends_at, lifecycle_status, stackable,
                               free_months, paid_months, bonus_months, only_applicable_for_new_members)
       VALUES (?, ?, '2000-01-01', '2100-01-01', 'active', ?, 0, ?, 0, 0)`,
      [gymId, `DateAware-Api-Promo-${uniq()}`, opts.stackable ? 1 : 0, paidMonths],
    );
    await db.query(
      'INSERT INTO promotion_membership_plans (gym_id, promotion_id, membership_plan_id) VALUES (?, ?, ?)',
      [gymId, promotionId, planId],
    );
    if (opts.benefit !== false) {
      await db.query(
        `INSERT INTO promotion_membership_fee_benefits
           (gym_id, promotion_id, quantity, frequency_interval, frequency_unit, enabled, action, value)
         VALUES (?, ?, 1, 1, 'month', 1, 'percentage_discount', 20)`,
        [gymId, promotionId],
      );
    }
    return promotionId;
  }

  async function finalPriceOf(umId: number): Promise<number> {
    const { rows } = await db.query('SELECT final_price FROM user_memberships WHERE id = ?', [umId]);
    return Number(rows[0].final_price);
  }

  it('discounts the cycle being billed while the Promotion still covers it', async () => {
    await setFlag(true);
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createAssignment(memberId, planId, '2000-02-15', gymId, { finalPrice: 50 });
    const promotionId = await createPromotionFor(planId, 3);

    expect((await applyViaApi(umId, promotionId)).status).toBe(201);
    expect(await finalPriceOf(umId)).toBe(40);
  });

  it('drops the discount of an application whose promotional months are over', async () => {
    await setFlag(true);
    const memberId = await createMember();
    const planId = await createPlan();
    // €40 is what a 20%-off Promotion left behind when it was applied in 2000.
    const umId = await createAssignment(memberId, planId, '2000-06-15', gymId, { finalPrice: 40 });
    const lapsed = await applyPromotion(umId, {
      paidMonths: 3, action: 'percentage_discount', value: 20, appliedAt: '2000-01-01 00:00:00',
    });
    await db.query('UPDATE promotions SET stackable = 1 WHERE id = ?', [lapsed]);
    // Any apply/revoke recomputes `final_price`; a second, benefit-less Promotion
    // is the cheapest way to trigger one without changing what is owed.
    const trigger = await createPromotionFor(planId, 0, { stackable: true, benefit: false });

    expect((await applyViaApi(umId, trigger)).status).toBe(201);
    // The 2000 promotional months are long over, so the regular fee stands.
    expect(await finalPriceOf(umId)).toBe(50);
  });

  it('never applies the benefit of a Promotion configured with no months', async () => {
    await setFlag(true);
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createAssignment(memberId, planId, '2000-06-15', gymId, { finalPrice: 50 });
    const promotionId = await createPromotionFor(planId, 0);

    expect((await applyViaApi(umId, promotionId)).status).toBe(201);
    expect(await finalPriceOf(umId)).toBe(50);
  });

  it('keeps the pre-stage-12 behaviour while the flag is off', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createAssignment(memberId, planId, '2000-06-15', gymId, { finalPrice: 50 });
    const promotionId = await createPromotionFor(planId, 0);

    expect((await applyViaApi(umId, promotionId)).status).toBe(201);
    // The legacy rule discounts from `base_price` (0 for an API-created row) and
    // ignores the timeline entirely — the behaviour the report exists to quantify.
    expect(await finalPriceOf(umId)).toBe(0);
  });
});
