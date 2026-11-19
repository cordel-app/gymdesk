// #3075 — a Product a plan includes on another cadence than the plan's bills on its own cadence's
// calendar grid: a prorated first stretch to the next grid date, then the full price on the grid.
// Derived from the ticket's rules (monthly → the 1st, 4-weekly → the standard 28-day grid), with an
// enrolment on 2026-11-19 (grid: 1 Nov / 1 Dec monthly, 2 Nov / 30 Nov 4-weekly).

import { describe, expect, it } from 'vitest';
import { SimulationAssignment } from '../domain/billingSimulation';
import { computeAssignmentBillingEventSimulation } from '../domain/assignmentBillingEventSimulation';
import { NO_PERSONAL_FEE_BENEFIT } from '../domain/personalFeeBenefit';
import { NO_PLAN_DURATION } from '../domain/planDuration';
import { calendarAnchorOnOrBefore } from '../domain/calendarSchedule';

const START = '2026-11-19';
const included = (billingFrequency: string, name: string, unitPrice: number) => ({
  productId: Math.round(unitPrice), name, category: 'periodical' as const, billingFrequency, unitPrice, quantity: 1,
  sessionFrequency: null, benefit: { action: 'no_benefit', value: null }, directDiscountPercent: null, assignedMemberId: null,
});

const forecast = (interval: number, unit: 'month' | 'week') => {
  const a = {
    userMembershipId: 1, planName: 'P', startsAt: START, endsAt: null, membershipFeePrice: 70,
    recurringInterval: interval, recurringUnit: unit, promotions: [], services: [],
    planBenefits: [included('month', 'Monthly', 31), included('four_weeks', 'FourWeekly', 28), included('year', 'Yearly', 120)],
    planDuration: NO_PLAN_DURATION, personalFeeBenefit: NO_PERSONAL_FEE_BENEFIT,
    alignTo: calendarAnchorOnOrBefore({ interval, unit }, START),
  } as unknown as SimulationAssignment;
  const r = computeAssignmentBillingEventSimulation({ assignment: a, from: START });
  return (label: string) => r.dates.flatMap((g) => g.lines.filter((l) => l.label === label).map((l) => ({ date: g.date, l })));
};

describe('a plan-included Product on another cadence than the plan', () => {
  it('4-weekly line of a monthly plan: prorated to the 28-day grid, then the grid', () => {
    const rows = forecast(1, 'month')('FourWeekly');
    expect(rows[0].date).toBe(START);
    expect(rows[0].l.proration).toEqual({ prorated_days: 11, period_days: 28 });
    expect(rows[0].l.actual_charge).toBe(11);
    expect(rows[1].date).toBe('2026-11-30');
    expect(rows[1].l.actual_charge).toBe(28);
    expect(rows[2].date).toBe('2026-12-28');
  });

  it('monthly line of a 4-weekly plan: prorated to the 1st, then the 1st of each month', () => {
    const rows = forecast(4, 'week')('Monthly');
    expect(rows[0].l.proration).toEqual({ prorated_days: 12, period_days: 31 });
    expect(rows[0].l.actual_charge).toBe(12);
    expect(rows[1].date).toBe('2026-12-01');
    expect(rows[1].l.actual_charge).toBe(31);
  });

  it('yearly line: full price on the start date, never prorated', () => {
    for (const rows of [forecast(1, 'month')('Yearly'), forecast(4, 'week')('Yearly')]) {
      expect(rows[0].date).toBe(START);
      expect(rows[0].l.actual_charge).toBe(120);
      expect(rows[0].l.proration ?? null).toBeNull();
    }
  });
});
