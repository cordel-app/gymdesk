// #1867 stage 4 — a recurring Product added to a running plan is billed a
// prorated first stretch up to the plan schedule's next date and then follows
// that schedule. Derived from the ticket (§4), not from the engine: the plan
// bills on the 5th, a Product joins on 2026-10-20, so it owes 16/31 of its
// price today (20 Oct → 5 Nov) and the full price from 2026-11-05.

import { describe, expect, it } from 'vitest';
import { SimulationAssignment, SimulationService, nextAlignedDate } from '../domain/billingSimulation';
import { computeAssignmentBillingEventSimulation } from '../domain/assignmentBillingEventSimulation';
import { advanceBillingDate } from '../domain/billingDate';
import { lineFromSimulation } from '../domain/billingEventLines';
import { NO_PERSONAL_FEE_BENEFIT } from '../domain/personalFeeBenefit';
import { NO_PLAN_DURATION } from '../domain/planDuration';

const TODAY = '2026-10-20';

const service = (over: Partial<SimulationService> = {}): SimulationService => ({
  id: 1, productId: 5, name: 'Personal Trainer', billingFrequency: 'month',
  unitPrice: 31, quantity: 1, startsOn: TODAY, endsOn: null, alignTo: '2025-01-05', ...over,
});

const forecast = (svc: SimulationService) => {
  const a: SimulationAssignment = {
    userMembershipId: 1, planName: 'Full', startsAt: '2025-01-05', endsAt: null,
    membershipFeePrice: 70, recurringInterval: 1, recurringUnit: 'month',
    promotions: [], services: [svc], planBenefits: [], planDuration: NO_PLAN_DURATION,
    personalFeeBenefit: NO_PERSONAL_FEE_BENEFIT,
  };
  return computeAssignmentBillingEventSimulation({ assignment: a, from: TODAY });
};

const lines = (r: ReturnType<typeof forecast>) =>
  r.dates.flatMap((g) => g.lines.filter((l) => l.label === 'Personal Trainer').map((l) => ({ date: g.date, l })));

describe('nextAlignedDate', () => {
  const adv = (d: string) => advanceBillingDate(d, 1, 'month');
  it('is the schedule date after the start', () => expect(nextAlignedDate('2025-01-05', TODAY, adv)).toBe('2026-11-05'));
  it('is null when the start is itself a schedule date', () => expect(nextAlignedDate('2025-01-05', '2026-10-05', adv)).toBeNull());
  it('is null when the start precedes the anchor', () => expect(nextAlignedDate('2026-12-05', TODAY, adv)).toBeNull());
});

describe('a recurring Product joining an existing schedule', () => {
  it('is charged a prorated first stretch and then the full price on the schedule', () => {
    const rows = lines(forecast(service()));
    expect(rows[0].date).toBe(TODAY);
    expect(rows[0].l.proration).toEqual({ prorated_days: 16, period_days: 31 });
    expect(rows[0].l.actual_charge).toBe(16);
    expect(rows[0].l.regular_price).toBe(31);
    expect(rows[1].date).toBe('2026-11-05');
    expect(rows[1].l.actual_charge).toBe(31);
    expect(rows[1].l.proration ?? null).toBeNull();
    expect(rows[2].date).toBe('2026-12-05');
  });

  it('is not prorated when it starts on a schedule date', () => {
    const rows = lines(forecast(service({ startsOn: '2026-10-05' })));
    expect(rows.every((r) => r.l.proration == null)).toBe(true);
    expect(rows[0].l.actual_charge).toBe(31);
  });

  it('is not prorated with no schedule (its own cadence, as before)', () => {
    const rows = lines(forecast(service({ alignTo: null })));
    expect(rows[0].l.proration ?? null).toBeNull();
    expect(rows[1].date).toBe('2026-11-20');
  });

  it('applies the quantity before prorating and keeps the persisted line at the prorated amount', () => {
    const rows = lines(forecast(service({ quantity: 2 })));
    expect(rows[0].l.actual_charge).toBe(32);
    const persisted = lineFromSimulation({ ...rows[0].l, user_membership_id: 1, plan_name: null, price_may_change: false } as any);
    expect(persisted.prorated_days).toBe(16);
    expect(persisted.period_days).toBe(31);
    expect(persisted.amount).toBe(32);
  });

  it('never prorates a 4-weekly Product by calendar months', () => {
    const rows = lines(forecast(service({ billingFrequency: 'four_weeks', alignTo: '2026-10-01' })));
    // schedule dates 1 Oct, 29 Oct → joins 20 Oct: 9 of 28 days.
    expect(rows[0].l.proration).toEqual({ prorated_days: 9, period_days: 28 });
    expect(rows[1].date).toBe('2026-10-29');
  });
});
