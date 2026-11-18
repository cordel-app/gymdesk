// #3024 — a Monthly line joined mid-period bills on the 1st; the prorated stretch always takes the
// promotion, but only a join on the 1st–14th counts it as a promotional cycle (the 15th does not).
// Expected figures derived from the ticket's examples (15.00 monthly, 50% off, 3 cycles).

import { describe, expect, it } from 'vitest';
import { SimulationAssignment, SimulationGrant } from '../domain/billingSimulation';
import { computeAssignmentBillingEventSimulation } from '../domain/assignmentBillingEventSimulation';
import { NO_PERSONAL_FEE_BENEFIT } from '../domain/personalFeeBenefit';
import { NO_PLAN_DURATION } from '../domain/planDuration';
import { promotionCycleShift } from '../domain/proration';

const grant = {
  productId: 7, name: 'Locker', category: 'periodical', billingFrequency: 'month',
  unitPrice: 15, quantity: 3, benefit: { action: 'percentage_discount', value: 50 },
} as SimulationGrant;

const run = (day: string) => {
  const a: SimulationAssignment = {
    userMembershipId: 1, planName: 'Plan', startsAt: '2026-11-01', endsAt: null,
    membershipFeePrice: 0, recurringInterval: 1, recurringUnit: 'month',
    promotions: [{
      name: 'Half', productTarget: true, appliedAt: day, revokedAt: null,
      freeMonths: 0, paidMonths: 0, payBeforehandMonths: 0, bonusMonths: 0,
      membershipFeeBenefits: [], grants: [grant],
    }],
    services: [{
      id: 1, productId: 7, name: 'Locker', billingFrequency: 'month', unitPrice: 15, quantity: 1,
      startsOn: day, endsOn: null, alignTo: '2026-11-01',
    }],
    planBenefits: [], planDuration: NO_PLAN_DURATION, personalFeeBenefit: NO_PERSONAL_FEE_BENEFIT,
  };
  return computeAssignmentBillingEventSimulation({ assignment: a, from: day }).dates
    .flatMap((g) => g.lines.filter((l) => l.label === 'Locker').map((l) => [g.date, l.actual_charge] as const))
    .slice(0, 6);
};

describe('promotion cycle counting for a Monthly line (#3024)', () => {
  it('joined on the 10th: November consumes cycle 1, regular price from 1 Feb', () => {
    expect(run('2026-11-10')).toEqual([
      ['2026-11-10', 5.08], // 21/31 × 15 × 50%
      ['2026-12-01', 7.5], ['2027-01-01', 7.5], ['2027-02-01', 15],
    ]);
  });
  it('joined on the 14th still consumes the current month', () => {
    expect(run('2026-11-14').map(([, c]) => c).slice(1, 5)).toEqual([7.5, 7.5, 15]);
  });
  it('joined on the 15th does not: three full cycles, regular price from 1 Mar', () => {
    const r = run('2026-11-15');
    expect(r[0]).toEqual(['2026-11-15', 3.87]); // 16/31 × 15 × 50%
    expect(r.slice(1, 6)).toEqual([
      ['2026-12-01', 7.5], ['2027-01-01', 7.5], ['2027-02-01', 7.5], ['2027-03-01', 15],
    ]);
  });
  it('joined on the 17th: same as the 15th', () => {
    expect(run('2026-11-17').map(([, c]) => c).slice(1, 6)).toEqual([7.5, 7.5, 7.5, 15]);
  });
  it('the day-of-month rule only applies to a prorated Monthly line', () => {
    const month = { interval: 1, unit: 'month' as const } as never;
    expect(promotionCycleShift(month, '2026-11-14', true)).toBe(0);
    expect(promotionCycleShift(month, '2026-11-15', true)).toBe(1);
    expect(promotionCycleShift(month, '2026-11-30', true)).toBe(1);
    expect(promotionCycleShift(month, '2026-11-20', false)).toBe(0);
    expect(promotionCycleShift({ interval: 4, unit: 'week' } as never, '2026-11-20', true)).toBe(0);
  });
});
