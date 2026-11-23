// #3279 — an independently contracted monthly recurring Product prorates its first stretch over the
// actual length of the month its own start date falls in (28/29/30/31), start inclusive, next
// billing date exclusive. Figures from the ticket's table; the plan's own fee, a Plan-included
// Product and the other cadences keep their existing denominators.

import { describe, expect, it } from 'vitest';
import { SimulationAssignment, SimulationService } from '../domain/billingSimulation';
import { computeAssignmentBillingEventSimulation } from '../domain/assignmentBillingEventSimulation';
import { lineFromSimulation } from '../domain/billingEventLines';
import { lineProration } from '../domain/checkoutSummary';
import { NO_PERSONAL_FEE_BENEFIT } from '../domain/personalFeeBenefit';
import { NO_PLAN_DURATION } from '../domain/planDuration';
import { daysInMonthOf, prorate } from '../domain/proration';

const service = (over: Partial<SimulationService>): SimulationService => ({
  id: 1, productId: 5, name: 'Locker', billingFrequency: 'month',
  unitPrice: 60, quantity: 1, startsOn: '2026-11-23', endsOn: null, alignTo: '2020-01-01', ...over,
});

const forecast = (svc: SimulationService, plan: Partial<SimulationAssignment> = {}) => {
  const a: SimulationAssignment = {
    userMembershipId: 1, planName: 'Plan', startsAt: '2020-01-01', endsAt: null,
    membershipFeePrice: 70, recurringInterval: 1, recurringUnit: 'month',
    promotions: [], services: [svc], planBenefits: [], planDuration: NO_PLAN_DURATION,
    personalFeeBenefit: NO_PERSONAL_FEE_BENEFIT, ...plan,
  };
  const r = computeAssignmentBillingEventSimulation({ assignment: a, from: svc.startsOn ?? a.startsAt });
  return r.dates.flatMap((g) => g.lines.filter((l) => l.label === svc.name).map((l) => ({ date: g.date, l })));
};

describe('daysInMonthOf', () => {
  it.each([
    ['2026-11-23', 30], ['2026-10-24', 31], ['2026-04-24', 30], ['2026-02-21', 28], ['2024-02-21', 29],
  ])('%s → %i', (d, n) => expect(daysInMonthOf(d)).toBe(n));
});

describe('a monthly recurring Product on its own calendar (#3279)', () => {
  it.each([
    ['2026-11-23', '2026-12-01', 8, 30],
    ['2026-10-24', '2026-11-01', 8, 31],
    ['2026-04-24', '2026-05-01', 7, 30],
    ['2026-02-21', '2026-03-01', 8, 28],
    ['2024-02-21', '2024-03-01', 9, 29],
  ])('starting %s: prorated %i… to %s', (start, next, days, period) => {
    const rows = forecast(service({ startsOn: start }));
    expect(rows[0].date).toBe(start);
    expect(rows[0].l.proration).toEqual({ prorated_days: days, period_days: period });
    expect(rows[0].l.actual_charge).toBe(Math.round((60 * days / period) * 100) / 100);
    expect(rows[1].date).toBe(next);
    expect(rows[1].l.actual_charge).toBe(60);
    expect(rows[1].l.proration ?? null).toBeNull();
  });

  it('the persisted line and the Initial Payment label carry the same 8 of 30 days and amount', () => {
    const first = forecast(service({}))[0].l;
    const persisted = lineFromSimulation(first, 0);
    expect(persisted.prorated_days).toBe(8);
    expect(persisted.period_days).toBe(30);
    expect(persisted.amount).toBe(16);
    expect(lineProration(persisted)).toEqual({ days: 8, period_days: 30 });
  });

  it('a start on the billing boundary is a full charge with no proration', () => {
    const rows = forecast(service({ startsOn: '2026-12-01' }));
    expect(rows[0].l.proration ?? null).toBeNull();
    expect(rows[0].l.actual_charge).toBe(60);
  });
});

describe('a monthly recurring Product joining a compatible schedule (#3279)', () => {
  it('uses its own start month, not the next billing date\'s month', () => {
    // Schedule bills on the 5th; start 20 Nov → 15 days to 5 Dec, over November's 30.
    const rows = forecast(service({ startsOn: '2026-11-20', alignTo: '2020-01-05' }));
    expect(rows[0].l.proration).toEqual({ prorated_days: 15, period_days: 30 });
    expect(rows[0].l.actual_charge).toBe(30);
    expect(rows[1].date).toBe('2026-12-05');
  });
});

describe('unchanged denominators (#3279 regression)', () => {
  it('prorate() without the option keeps decision D\'s 31', () => {
    expect(prorate(1, { interval: 1, unit: 'month' }, '2026-11-23', '2026-12-01').periodDays).toBe(31);
  });
  it('the calendar-month option leaves weekly, 4-weekly and yearly cadences alone', () => {
    const opt = { calendarMonth: true };
    expect(prorate(1, { interval: 1, unit: 'week' }, '2026-11-23', '2026-11-30', opt).periodDays).toBe(7);
    expect(prorate(1, { interval: 4, unit: 'week' }, '2026-11-23', '2026-11-30', opt).periodDays).toBe(28);
    expect(prorate(1, { interval: 1, unit: 'year' }, '2026-11-23', '2026-12-01', opt).periodDays).toBe(372);
  });
  it('a 4-weekly Product still prorates over 28 days', () => {
    const rows = forecast(service({ billingFrequency: 'four_weeks', startsOn: '2026-11-23', alignTo: '2026-11-02' }));
    expect(rows[0].l.proration).toEqual({ prorated_days: 7, period_days: 28 });
  });
  it('a yearly Product is charged in full on its start date', () => {
    const rows = forecast(service({ billingFrequency: 'year' }));
    expect(rows[0].l.proration ?? null).toBeNull();
    expect(rows[0].l.actual_charge).toBe(60);
  });
  it('a Membership Fee joining the calendar mid-month divides by its own month too (#3280)', () => {
    const a: SimulationAssignment = {
      userMembershipId: 1, planName: 'Plan', startsAt: '2026-11-23', endsAt: null,
      membershipFeePrice: 62, recurringInterval: 1, recurringUnit: 'month',
      promotions: [], services: [], planBenefits: [], planDuration: NO_PLAN_DURATION,
      personalFeeBenefit: NO_PERSONAL_FEE_BENEFIT, alignTo: '2026-11-01',
    } as SimulationAssignment;
    const r = computeAssignmentBillingEventSimulation({ assignment: a, from: a.startsAt });
    const fee = r.dates[0].lines.find((l) => l.kind === 'membership_fee')!;
    expect(fee.proration).toEqual({ prorated_days: 8, period_days: 30 });
    expect(fee.actual_charge).toBe(16.53);
  });
});
