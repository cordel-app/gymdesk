// Unit tests for `computeAssignmentExampleTimeline` (#924 stage 3) — a pure
// projection, so no DB, no HTTP and no test gym.
//
// The ticket's §7 asks the Assigned Plan card for a **Membership Fee
// Simulation** "using the same simulation logic and presentation as Membership
// Plans", with the same dates, frequencies, pricing, benefits, promotions, tax
// and recurrence rules as the actual billing logic, and spells out the rule
// these tests exist to pin:
//
//   > The simulation should not implement a separate calculation engine.
//
// So every case below is really one assertion: the row says what
// `resolveMembershipFee()` says for that date — the very call
// `priceMembershipFeeOn()`, and through it the nightly run, prices a cycle
// with. What this module adds is the walk (which periods exist, where it
// starts and where it stops), and that is what is tested here directly.
//
// The Membership Plan side of the same walk is `plan-example-timeline.test.ts`.

import { describe, expect, it } from 'vitest';
import { computeAssignmentExampleTimeline } from '../domain/assignmentExampleTimeline';
import { MAX_TIMELINE_PERIODS, TRAILING_REGULAR_PERIODS } from '../domain/exampleTimeline';
import { MembershipFeeContext } from '../domain/billingSimulation';
import { AppliedPromotionForBilling } from '../domain/promotionApplication';
import { toPlanDuration } from '../domain/planDuration';
import { PlanDurationCadence } from '../domain/planDuration';

const MONTHLY: PlanDurationCadence = { interval: 1, unit: 'month' };
const FOUR_WEEKLY: PlanDurationCadence = { interval: 4, unit: 'week' };

const NO_PERSONAL_BENEFIT = { action: 'no_benefit' as const, value: null };

function context(opts: {
  startsAt: string;
  cadence?: PlanDurationCadence;
  free?: number;
  paid?: number;
  bonus?: number;
  prepaid?: number;
  personal?: { action: 'no_benefit' | 'percentage_discount'; value: number | null };
  promotions?: AppliedPromotionForBilling[];
}): MembershipFeeContext {
  return {
    startsAt: opts.startsAt,
    planDuration: toPlanDuration(
      opts.free ?? 0, opts.paid ?? 0, opts.bonus ?? 0, opts.prepaid ?? 0, opts.cadence ?? MONTHLY,
    ),
    personalFeeBenefit: opts.personal ?? NO_PERSONAL_BENEFIT,
    promotions: opts.promotions ?? [],
  };
}

function run(opts: {
  startsAt: string;
  today: string;
  cadence?: PlanDurationCadence | null;
  fee?: number | null;
  feeAfterLapse?: { on: string; amount: number | null };
  free?: number;
  paid?: number;
  bonus?: number;
  prepaid?: number;
  personal?: { action: 'no_benefit' | 'percentage_discount'; value: number | null };
  promotions?: AppliedPromotionForBilling[];
}) {
  const fee = opts.fee === undefined ? 70 : opts.fee;
  return computeAssignmentExampleTimeline({
    context: context(opts),
    cadence: opts.cadence === undefined ? MONTHLY : opts.cadence,
    regularFeeOn: (date) => (
      opts.feeAfterLapse && opts.feeAfterLapse.on < date ? opts.feeAfterLapse.amount : fee
    ),
    today: opts.today,
  });
}

/** A Promotion standing on the assignment since `appliedAt`, never revoked. */
function promotion(opts: Partial<AppliedPromotionForBilling> & { appliedAt: string }): AppliedPromotionForBilling {
  return {
    name: 'Spring',
    appliedAt: opts.appliedAt,
    revokedAt: opts.revokedAt ?? null,
    freeMonths: opts.freeMonths ?? 0,
    paidMonths: opts.paidMonths ?? 0,
    payBeforehandMonths: opts.payBeforehandMonths ?? 0,
    bonusMonths: opts.bonusMonths ?? 0,
    membershipFeeBenefits: opts.membershipFeeBenefits ?? [],
  };
}

describe('computeAssignmentExampleTimeline', () => {
  it('projects the trailing regular periods for a contract with no durations', () => {
    const t = run({ startsAt: '2026-01-10', today: '2026-01-10' });
    expect(t.available).toBe(true);
    expect(t.anchorDate).toBe('2026-01-10');
    expect(t.periods).toHaveLength(TRAILING_REGULAR_PERIODS);
    expect(t.periods.map((p) => p.startsOn)).toEqual(['2026-01-10', '2026-02-10']);
    expect(t.periods.every((p) => p.status === 'pay_regular')).toBe(true);
    expect(t.periods.every((p) => p.amount === 70)).toBe(true);
    // The last period is open-ended: billing does not stop where the table does.
    expect(t.periods[0].endsOn).toBe('2026-02-09');
    expect(t.periods[1].endsOn).toBeNull();
  });

  it('shows the assignment’s own Free Period as waived, then the regular charge', () => {
    const t = run({ startsAt: '2026-01-10', today: '2026-01-10', free: 2 });
    expect(t.periods.map((p) => p.status)).toEqual([
      'free_plan', 'free_plan', 'pay_regular', 'pay_regular',
    ]);
    expect(t.periods.slice(0, 2).every((p) => p.waived && p.amount === null)).toBe(true);
    expect(t.periods[2].amount).toBe(70);
  });

  it('counts those durations in the assignment’s own cadence, not in months (#892)', () => {
    const t = run({ startsAt: '2026-01-10', today: '2026-01-10', cadence: FOUR_WEEKLY, free: 2 });
    // Exactly two free rows — the third 4-week period still starts inside two
    // free calendar months, and counting it free is the drift #892 removed.
    expect(t.periods.filter((p) => p.status === 'free_plan')).toHaveLength(2);
    expect(t.periods.map((p) => p.startsOn)).toEqual([
      '2026-01-10', '2026-02-07', '2026-03-07', '2026-04-04',
    ]);
  });

  it('charges the whole Pre-paid Duration on the first of its periods (#946)', () => {
    const t = run({ startsAt: '2026-01-10', today: '2026-01-10', paid: 6, prepaid: 3 });
    const prepaid = t.periods.filter((p) => p.status === 'prepaid_plan');
    expect(prepaid).toHaveLength(3);
    // €70 x 3, and never "No charge" for the date the Billing Event Simulation
    // beside it bills €210.
    expect(prepaid[0]).toMatchObject({ amount: 210, waived: false, prepaidPeriods: 3 });
    expect(prepaid.slice(1).every((p) => p.waived && p.prepaidPeriods === null)).toBe(true);
  });

  it('lets an applied Promotion decide the period, and says so in the status', () => {
    const t = run({
      startsAt: '2026-01-10',
      today: '2026-01-10',
      // The Plan's own Free Period would waive period 1 too, but the Promotion
      // governs the date and decides the fee alone (#635's Q2 answer) — which
      // is also why the status must name the Promotion's period, not the Plan's.
      free: 1,
      promotions: [promotion({ appliedAt: '2026-01-10', freeMonths: 2, paidMonths: 4 })],
    });
    expect(t.periods.slice(0, 2).map((p) => p.status)).toEqual(['free_promotion', 'free_promotion']);
    expect(t.periods.slice(0, 2).every((p) => p.waived)).toBe(true);
    expect(t.periods.map((p) => p.status)).toContain('pay_promotion');
    // It runs on past the Promotion to the contract's own regular charge.
    expect(t.periods[t.periods.length - 1].status).toBe('pay_regular');
    expect(t.periods[t.periods.length - 1].amount).toBe(70);
  });

  it('prices a Promotion’s Membership Fee Benefit, and ends it with the Promotion', () => {
    const t = run({
      startsAt: '2026-01-10',
      today: '2026-01-10',
      promotions: [promotion({
        appliedAt: '2026-01-10',
        paidMonths: 2,
        membershipFeeBenefits: [{ action: 'percentage_discount', value: 50, enabled: true, durationMonths: null }],
      })],
    });
    expect(t.periods[0].amount).toBe(35);
    expect(t.periods[1].amount).toBe(35);
    // The benefit lives inside the Promotion's own timeline and ends with it.
    expect(t.periods[2].amount).toBe(70);
    expect(t.periods[2].status).toBe('pay_regular');
  });

  it('applies the Personal Membership Fee Benefit to every period, for ever (#772)', () => {
    const t = run({
      startsAt: '2026-01-10',
      today: '2026-01-10',
      personal: { action: 'percentage_discount', value: 10 },
    });
    expect(t.periods.every((p) => p.amount === 63)).toBe(true);
    // It never ends, so it is this contract's regular charge and must not push
    // the projection to its cap.
    expect(t.periods).toHaveLength(TRAILING_REGULAR_PERIODS);
    expect(t.periods.every((p) => p.status === 'pay_regular')).toBe(true);
  });

  it('stacks the personal benefit on top of a Promotion’s, as billing does', () => {
    const t = run({
      startsAt: '2026-01-10',
      today: '2026-01-10',
      personal: { action: 'percentage_discount', value: 10 },
      promotions: [promotion({
        appliedAt: '2026-01-10',
        paidMonths: 1,
        membershipFeeBenefits: [{ action: 'percentage_discount', value: 50, enabled: true, durationMonths: null }],
      })],
    });
    expect(t.periods[0].amount).toBe(31.5);
    expect(t.periods[1].amount).toBe(63);
  });

  it('waives a period priced to zero by the benefits alone', () => {
    const t = run({
      startsAt: '2026-01-10',
      today: '2026-01-10',
      personal: { action: 'percentage_discount', value: 100 },
    });
    expect(t.periods[0]).toMatchObject({ waived: true, amount: null });
  });

  it('starts at the period containing today, numbered from the start date', () => {
    const t = run({ startsAt: '2026-01-10', today: '2026-04-20' });
    // Elapsed cycles answer nothing: the section is about what will be charged.
    expect(t.periods[0].startsOn).toBe('2026-04-10');
    expect(t.periods[0].period).toBe(4);
    // The anchor stays the contract's own start date — it is what the Billing &
    // Duration counts from.
    expect(t.anchorDate).toBe('2026-01-10');
  });

  it('starts at period 1 for an assignment that has not started yet', () => {
    const t = run({ startsAt: '2026-06-01', today: '2026-04-20' });
    expect(t.periods[0]).toMatchObject({ period: 1, startsOn: '2026-06-01' });
  });

  it('follows a negotiated fee that lapses back to the catalogue price', () => {
    const t = run({
      startsAt: '2026-01-10',
      today: '2026-01-10',
      fee: 50,
      feeAfterLapse: { on: '2026-01-31', amount: 70 },
    });
    expect(t.periods[0].amount).toBe(50);
    expect(t.periods[1].amount).toBe(70);
  });

  it('reads as the empty value, never €0.00, when there is no fee to quote', () => {
    const t = run({ startsAt: '2026-01-10', today: '2026-01-10', fee: null });
    expect(t.periods[0]).toMatchObject({ amount: null, waived: false });
  });

  it('is unavailable, with a reason, when the assignment has no billing frequency', () => {
    const t = run({ startsAt: '2026-01-10', today: '2026-01-10', cadence: null });
    expect(t.available).toBe(false);
    expect(t.reason).toBeTruthy();
    expect(t.periods).toEqual([]);
  });

  it('caps the table rather than rendering a duration configured in the hundreds', () => {
    const t = run({ startsAt: '2026-01-10', today: '2026-01-10', free: 500 });
    expect(t.periods).toHaveLength(MAX_TIMELINE_PERIODS);
    // The budget ran out inside the Free Period, so the final row is not
    // open-ended: "Free, from 10 Dec onwards" would be a lie.
    expect(t.periods[t.periods.length - 1].endsOn).not.toBeNull();
  });
});
