import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request, billingEventsOfAssignment } from './helpers';

/**
 * #635 stages 12 and 15 — one rule decides what the Membership Fee costs on a
 * date, for real money, with nothing stored and no switch.
 *
 * Stage 11 stopped the nightly run charging a waived cycle. Stage 12 closed the
 * other half: `user_memberships.final_price` was one number with no date in it,
 * so the run kept charging a Promotion's discount long after the promotional
 * months it was agreed for had elapsed. Pricing each cycle through
 * `resolveMembershipFee` — the resolver the Billing Simulation and My Membership
 * already used — made the three agree.
 *
 * Because that correction *raises* a real charge, stage 12 shipped it switchable
 * and off (`billing.date_aware_membership_fee`) with an impact report beside it.
 * Stage 15 is the thread's answer to that review: the flag, the report and the
 * stored column are all gone, and pricing a cycle is the only way to know what an
 * assignment owes. These cases pin that — the run's amounts, and that nothing
 * about them depends on a feature flag or a stored price.
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
  gymId = await createTestGym('Date Aware Fee Gym');
  await createTestMembership(gymId);
});

beforeEach(async () => {
  // #780: one completed run per UTC date, and the log is global — clear it
  // before each case so a run left behind elsewhere cannot turn the first case
  // here into an `already_completed_today` no-op.
  await db.query('DELETE FROM billing_run_log');
  executeRecurring.mockClear();
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

/* ── setup helpers ───────────────────────────────────────────────────────── */

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

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
 * An assignment frozen with a €50 regular Membership Fee — since #635 stage 15
 * the one number an assignment stores about its price, and the one every cycle
 * is resolved from.
 */
async function createAssignment(
  memberId: number, planId: number, nextBillingDate: string, gym = gymId,
  over: { fee?: number; startsAt?: string } = {},
): Promise<number> {
  const { insertId } = await db.query(
    `INSERT INTO user_memberships
       (gym_id, member_id, membership_plan_id, status, starts_at, base_price,
        membership_fee_price, recurring_billing_interval, recurring_billing_unit)
     VALUES (?, ?, ?, 'active', ?, 0, ?, 1, 'month')`,
    [gym, memberId, planId, over.startsAt ?? '2000-01-01', over.fee ?? 50],
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
      // #814: the snapshot shape is enabled + action + value + duration_months.
      membership_fee_benefits: opts.action == null ? [] : [{
        enabled: true,
        action: opts.action, value: opts.value ?? null,
        duration_months: opts.durationMonths ?? null,
      }],
    })],
  );
  return promotionId;
}

const runBilling = () => request.post('/billing/run').set('x-internal-secret', SECRET);

async function chargeFor(umId: number) {
  const rows = await billingEventsOfAssignment(gymId, umId, 'event_type, amount, notes');
  return rows;
}

/* ── what the run charges ────────────────────────────────────────────────── */

// #1325 PR 3: the run no longer prices an assignment's cycle (the obligations are
// a ProductSet's persisted events), so the cases that charged through
// `POST /billing/run` are gone; the resolver is pinned by `membership-fee-resolution`.

/* ── the fee an assignment reports ───────────────────────────────────────── */

describe('GET /user-memberships/:id — membership_fee is resolved, never stored (#635 stage 15)', () => {
  const detail = (umId: number) => request
    .get(`/user-memberships/${umId}`)
    .set('Authorization', TEST_AUTH_HEADER)
    .set('x-gym-id', gymId);

  it('reports the discounted fee while the Promotion still covers the cycle', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    // `currentCycleDate` never prices a cycle already past — "what this member
    // pays now" is today at the earliest — so the contract and the application
    // have to start today for today to fall inside the promotional months.
    const today = new Date().toISOString().slice(0, 10);
    const umId = await createAssignment(memberId, planId, today, gymId, { startsAt: today });
    await applyPromotion(umId, {
      paidMonths: 3, action: 'percentage_discount', value: 20, appliedAt: `${today} 00:00:00`,
    });

    const res = await detail(umId);
    expect(res.status).toBe(200);
    expect(Number(res.body.membership_fee)).toBe(40);
    // The regular fee it was discounted from stays visible on the snapshot.
    expect(Number(res.body.snapshot.membership_fee_price)).toBe(50);
  });

  it('reports the regular fee once the promotional months are over', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createAssignment(memberId, planId, '2000-06-15');
    await applyPromotion(umId, { paidMonths: 3, action: 'percentage_discount', value: 20 });

    expect(Number((await detail(umId)).body.membership_fee)).toBe(50);
  });

  it('no longer returns a stored final_price', async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    const umId = await createAssignment(memberId, planId, '2000-06-15');

    expect((await detail(umId)).body).not.toHaveProperty('final_price');
    const { rows } = await db.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'user_memberships'
          AND column_name = 'final_price'`,
    );
    expect(Number(rows[0].n)).toBe(0);
  });
});

/* ── the all-or-nothing rule migration 191 had to respect ────────────────── */

// Writing `membership_fee_price` is not an additive fee change: that column is one
// of the seven disjuncts that *define* "this assignment captured a snapshot", so
// setting it alone turns off the live-catalogue fallback for every other section.
// That is why migration 191's backfill materialises an uncaptured assignment in
// full before writing the fee — otherwise a member inside a free month the Plan
// grants would start being charged for it. This case pins the rule, so a future
// path that writes the fee on its own fails here rather than in a billing run.
describe('a fee written alone captures the snapshot and drops the Plan durations', () => {
  it("stops applying the Plan's Free Period once only the fee is frozen", async () => {
    const memberId = await createMember();
    const planId = await createPlan();
    await db.query('UPDATE membership_plans SET free_periods = 1, paid_periods = 12 WHERE id = ?', [planId]);

    // Uncaptured: no months, no cadence, no fee of its own — so it reads the
    // Plan's Billing & Duration and its first cycle is free.
    const { insertId: umId } = await db.query(
      `INSERT INTO user_memberships
         (gym_id, member_id, membership_plan_id, status, starts_at, base_price)
       VALUES (?, ?, ?, 'active', '2000-01-01', 50)`,
      [gymId, memberId, planId],
    );
    const { loadFeeAssignment, priceMembershipFeeOn } = await import('../api/membership-fee-pricing');

    const uncaptured = await loadFeeAssignment(gymId, umId);
    expect(await priceMembershipFeeOn(uncaptured!, '2000-01-15')).toMatchObject({
      amount: 0, waived: true, periodStatus: 'free_plan',
    });

    // Freeze the fee and nothing else: the assignment now counts as captured, its
    // own (NULL) months mean "no periods", and the same cycle is charged in full.
    await db.query('UPDATE user_memberships SET membership_fee_price = 50 WHERE id = ?', [umId]);
    const captured = await loadFeeAssignment(gymId, umId);
    expect(await priceMembershipFeeOn(captured!, '2000-01-15')).toMatchObject({ amount: 50, waived: false });

    // Materialising the rest — what the migration does first — restores it.
    await db.query(
      `UPDATE user_memberships um JOIN membership_plans p ON p.id = um.membership_plan_id
          SET um.free_periods = p.free_periods, um.paid_periods = p.paid_periods
        WHERE um.id = ?`,
      [umId],
    );
    const materialised = await loadFeeAssignment(gymId, umId);
    expect(await priceMembershipFeeOn(materialised!, '2000-01-15')).toMatchObject({
      amount: 0, waived: true, periodStatus: 'free_plan',
    });
  });
});

/* ── the flag and its report are gone ────────────────────────────────────── */

describe('#635 stage 15 — no feature flag and no drift report', () => {
  it('seeds neither billing.date_aware_membership_fee nor payments.membership_fee_drift', async () => {
    const { rows } = await db.query<{ feature_key: string }>(
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
