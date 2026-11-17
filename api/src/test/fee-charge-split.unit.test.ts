// #2970 — a Membership Fee's first charge keeps its two parts apart: the prorated stretch (days,
// dates, amount) and the N **full** prepaid periods (coverage, amount). The parts are read off the
// engine's own resolution, sum to the line's charge, and never cover the same day.

import { describe, expect, it } from 'vitest';
import { SimulationAssignment } from '../domain/billingSimulation';
import { computeAssignmentBillingEventSimulation } from '../domain/assignmentBillingEventSimulation';
import { calendarAnchorOnOrBefore } from '../domain/calendarSchedule';
import { NO_PERSONAL_FEE_BENEFIT } from '../domain/personalFeeBenefit';
import { toPlanDuration, toPlanDurationCadence } from '../domain/planDuration';

const START = '2026-11-17';

function plan(over: { prepaid?: number; units?: number } = {}): SimulationAssignment {
  return {
    userMembershipId: 1, planName: 'Monthly', startsAt: START, endsAt: null,
    membershipFeePrice: 31, recurringInterval: 1, recurringUnit: 'month',
    promotions: [], services: [], planBenefits: [],
    planDuration: toPlanDuration(0, 3, 0, over.prepaid ?? 0, toPlanDurationCadence(1, 'month'), false),
    personalFeeBenefit: NO_PERSONAL_FEE_BENEFIT,
    alignTo: calendarAnchorOnOrBefore({ interval: 1, unit: 'month' }, START),
    membershipFeeUnits: over.units ?? 1,
  } as SimulationAssignment;
}

const first = (a: SimulationAssignment) =>
  computeAssignmentBillingEventSimulation({ assignment: a, from: START }).dates[0].lines
    .find((l) => l.kind === 'membership_fee')!;

describe('Membership Fee first charge split', () => {
  it('states the stretch and the full prepaid periods separately, on distinct dates', () => {
    const line = first(plan({ prepaid: 3 }));
    expect(line.fee_split).toEqual({
      prorated: { days: 14, period_days: 31, start: '2026-11-17', end: '2026-11-30', amount: 14 },
      prepaid: { periods: 3, start: '2026-12-01', end: '2027-02-28', amount: 93 },
    });
    expect(line.fee_split!.prorated.amount + line.fee_split!.prepaid!.amount).toBe(line.actual_charge);
  });

  it('has no prepaid part without a Pre-paid Duration', () => {
    const line = first(plan());
    expect(line.fee_split?.prepaid).toBeNull();
    expect(line.fee_split?.prorated.amount).toBe(line.actual_charge);
  });

  it('multiplies both parts by the fee units of a per_member plan', () => {
    const line = first(plan({ prepaid: 2, units: 2 }));
    expect(line.fee_split!.prorated.amount).toBe(28);
    expect(line.fee_split!.prepaid!.amount).toBe(124);
    expect(line.actual_charge).toBe(152);
  });

  it('has no split when the plan starts on a billing date', () => {
    const line = first({ ...plan({ prepaid: 3 }), startsAt: '2026-12-01', alignTo: '2026-12-01' });
    expect(line.fee_split ?? null).toBeNull();
  });
});

import { chargeLineView, initialPaymentBreakdown } from '../domain/checkoutSummary';

describe('Summary carries the split', () => {
  it('reports the split on the Initial Payment line without changing its total', () => {
    const line = first(plan({ prepaid: 3 }));
    const row = chargeLineView({
      item_name: 'Monthly', quantity: 1, amount: line.actual_charge, regular_unit_price: line.regular_price,
      prepaid_periods: line.prepaid_periods, prepaid_cadence: line.prepaid_cadence, fee_split: line.fee_split,
    });
    const payment = initialPaymentBreakdown([row], line.actual_charge);
    expect(payment.total).toBe(107);
    expect(payment.lines[0].fee_split?.prorated.amount).toBe(14);
    expect(payment.lines[0].fee_split?.prepaid?.amount).toBe(93);
  });
});
