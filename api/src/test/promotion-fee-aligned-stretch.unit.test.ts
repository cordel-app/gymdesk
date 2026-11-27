// #3506 — a plan that joins the billing calendar mid-month bills a prorated first stretch. The
// stretch was priced at the fee of the period it leads into, so a Promotion whose own timeline
// (anchored on the month of its application) discounts the month the plan joins in never reached
// the Billing - Plan Simulation, Save & Pay or the persisted obligations: a one-month 50% Promotion
// vanished entirely. A Promotion governing the stretch's own dates now prices it; the Plan's
// Billing & Duration still counts from the first schedule date.

import { describe, expect, it } from 'vitest';
import { SimulationAssignment, SimulationPromotion } from '../domain/billingSimulation';
import { computeAssignmentBillingEventSimulation } from '../domain/assignmentBillingEventSimulation';
import { NO_PERSONAL_FEE_BENEFIT } from '../domain/personalFeeBenefit';
import { NO_PLAN_DURATION } from '../domain/planDuration';

const half = (durationMonths: number, paidMonths = 2): SimulationPromotion => ({
  name: 'Half', appliedAt: '2026-11-27', revokedAt: null,
  freeMonths: 0, paidMonths, payBeforehandMonths: 0, bonusMonths: 0,
  membershipFeeBenefits: [{ action: 'percentage_discount', value: 50, enabled: true, durationMonths }],
  grants: [],
} as SimulationPromotion);

const feeCharges = (promotions: SimulationPromotion[], alignTo: string | null = '2026-11-01') => {
  const a: SimulationAssignment = {
    userMembershipId: 1, planName: 'Plan', startsAt: '2026-11-27', endsAt: null,
    membershipFeePrice: 70, recurringInterval: 1, recurringUnit: 'month',
    promotions, services: [], planBenefits: [],
    planDuration: NO_PLAN_DURATION, personalFeeBenefit: NO_PERSONAL_FEE_BENEFIT,
    ...(alignTo ? { alignTo } : {}),
  };
  return computeAssignmentBillingEventSimulation({ assignment: a, from: '2026-11-27' }).dates
    .flatMap((g) => g.lines.filter((l) => l.kind === 'membership_fee').map((l) => [g.date, l.actual_charge] as const))
    .slice(0, 4);
};

describe('a Promotion on the prorated stretch of an aligned plan (#3506)', () => {
  it('discounts the stretch when the Promotion covers its month, and only that month', () => {
    expect(feeCharges([half(1)])).toEqual([
      ['2026-11-27', 4.67], // 4/30 × 70 × 50%: November is the Promotion's discounted month
      ['2026-12-01', 70], ['2027-01-01', 70],
    ]);
  });

  it('keeps discounting the schedule dates the Promotion still covers', () => {
    expect(feeCharges([half(2)])).toEqual([
      ['2026-11-27', 4.67], ['2026-12-01', 35], ['2027-01-01', 70],
    ]);
  });

  it('without a Promotion the stretch is unchanged: the lead period’s fee, prorated', () => {
    expect(feeCharges([])[0]).toEqual(['2026-11-27', 9.33]);
  });

  it('an unaligned plan is untouched', () => {
    expect(feeCharges([half(1)], null)[0]).toEqual(['2026-11-27', 35]);
  });
});
