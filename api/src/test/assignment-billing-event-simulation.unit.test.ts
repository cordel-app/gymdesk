// Unit tests for `computeAssignmentBillingEventSimulation` (#924 stage 4) — the
// Assigned Plan card's Billing Event Forecast. A pure projection over the
// Billing Simulation engine, so no DB, no HTTP and no test gym (CLAUDE.md:
// unit tests vs integration tests).
//
// What the ticket asks of it, and what is asserted below: events grouped by
// their actual billing date (§8), different frequencies staying independent and
// coinciding dates sharing a group (§9), a `Once` item appearing once (§10), two
// complete cycles of every recurring frequency present (§10), and — the one rule
// that is this stage's own rather than the Plan preview's — a contract that
// started in the past forecasting from *today* while still counting its periods
// from `starts_at`.

import { describe, expect, it } from 'vitest';
import {
  SimulationAssignment,
  SimulationGrant,
  SimulationPlanBenefit,
  SimulationPromotion,
  SimulationService,
} from '../domain/billingSimulation';
import { computeAssignmentBillingEventSimulation } from '../domain/assignmentBillingEventSimulation';
import { SIMULATED_CYCLES } from '../domain/billingEventSimulation';
import { toPlanDuration } from '../domain/planDuration';
import {
  NO_SELLABLE_ITEM_BENEFIT,
  toSellableItemBenefit,
} from '../domain/sellableItemBenefitActions';
import { NO_PERSONAL_FEE_BENEFIT } from '../domain/personalFeeBenefit';

const MONTHLY = { interval: 1, unit: 'month' as const };
const TODAY = '2026-09-30';

function assignment(over: Partial<SimulationAssignment> = {}): SimulationAssignment {
  return {
    userMembershipId: 7,
    planName: 'Gold',
    startsAt: TODAY,
    endsAt: null,
    membershipFeePrice: 70,
    recurringInterval: MONTHLY.interval,
    recurringUnit: MONTHLY.unit,
    promotions: [],
    services: [],
    planBenefits: [],
    planDuration: toPlanDuration(null, null, null, null, MONTHLY),
    personalFeeBenefit: NO_PERSONAL_FEE_BENEFIT,
    ...over,
  };
}

function benefit(over: Partial<SimulationPlanBenefit> = {}): SimulationPlanBenefit {
  return {
    gymChargeId: 1,
    name: 'Item',
    category: 'periodical',
    billingFrequency: 'month',
    unitPrice: 20,
    quantity: 1,
    sessionFrequency: null,
    benefit: NO_SELLABLE_ITEM_BENEFIT,
    ...over,
  };
}

function service(over: Partial<SimulationService> = {}): SimulationService {
  return {
    id: 3,
    gymChargeId: 9,
    name: 'Locker rental',
    billingFrequency: 'month',
    unitPrice: 15,
    quantity: 1,
    startsOn: TODAY,
    endsOn: null,
    ...over,
  };
}

function promotion(grants: SimulationGrant[], over: Partial<SimulationPromotion> = {}): SimulationPromotion {
  return {
    name: 'Welcome',
    appliedAt: TODAY,
    revokedAt: null,
    freeMonths: 0,
    paidMonths: 0,
    payBeforehandMonths: 0,
    bonusMonths: 0,
    membershipFeeBenefits: [],
    grants,
    ...over,
  };
}

const run = (over: Partial<SimulationAssignment> = {}, today = TODAY) =>
  computeAssignmentBillingEventSimulation({ assignment: assignment(over), today });

const dateOf = (result: ReturnType<typeof run>) => result.dates.map((d) => d.date);
const labelsOn = (result: ReturnType<typeof run>, date: string) =>
  (result.dates.find((d) => d.date === date)?.lines ?? []).map((l) => l.label);

describe('#924 stage 4 — the Assigned Plan Billing Event Forecast', () => {
  it('groups every line that falls on a date under that date, chronologically', () => {
    const result = run({
      planBenefits: [benefit({ gymChargeId: 2, name: 'Registration Fee', category: 'oneoff', billingFrequency: 'once', unitPrice: 100 })],
      services: [service()],
    });

    expect(result.available).toBe(true);
    expect(dateOf(result)).toEqual([...dateOf(result)].sort());
    expect(labelsOn(result, TODAY)).toEqual(expect.arrayContaining(['Registration Fee', 'Gold', 'Locker rental']));
    // §8's example: the first date's total is the sum of its own lines.
    const first = result.dates[0];
    expect(first.total).toBe(100 + 70 + 15);
  });

  it('runs two complete cycles of every recurring frequency present (§10)', () => {
    const yearly = run({ planBenefits: [benefit({ billingFrequency: 'year', unitPrice: 50 })] });
    // A yearly item stretches the horizon to two years and drags the monthly
    // fee along with it — the length comes from the frequencies, not a month count.
    expect(yearly.horizon_date).toBe('2028-09-30');
    expect(SIMULATED_CYCLES).toBe(2);
    expect(yearly.dates.filter((d) => d.lines.some((l) => l.label === 'Item'))).toHaveLength(3);
  });

  it('keeps frequencies independent and lets coinciding dates share one group (§9)', () => {
    const result = run({
      planBenefits: [benefit({ gymChargeId: 4, name: 'Insurance Fee', billingFrequency: 'year', unitPrice: 20 })],
    });
    // The yearly item recurs yearly and the fee monthly, each on its own
    // schedule: they share a group only on the dates they actually coincide on,
    // and nothing is converted to a common cadence to make them meet.
    expect(labelsOn(result, TODAY)).toEqual(expect.arrayContaining(['Gold', 'Insurance Fee']));
    expect(labelsOn(result, '2026-10-30')).toEqual(['Gold']);
    expect(labelsOn(result, '2027-09-30')).toEqual(['Insurance Fee']);
  });

  it('shows a `Once` item exactly once (§10)', () => {
    const result = run({
      planBenefits: [benefit({ gymChargeId: 5, name: 'Joining Fee', category: 'oneoff', billingFrequency: 'once', unitPrice: 100 })],
    });
    const occurrences = result.dates.flatMap((d) => d.lines).filter((l) => l.label === 'Joining Fee');
    expect(occurrences).toHaveLength(1);
    expect(result.dates[0].date).toBe(TODAY);
  });

  it('forecasts from today for a contract that started in the past, counting its periods from starts_at', () => {
    const result = run({ startsAt: '2024-03-15' }, TODAY);

    expect(result.anchor_date).toBe(TODAY);
    // Nothing before today: what was charged already is the card's Billing
    // Events ledger, not this section.
    expect(result.dates.every((d) => d.date >= TODAY)).toBe(true);
    // The dates are still the contract's own — the 15th, stepped from
    // `starts_at`, never re-anchored on today. Two cycles of wall-clock time
    // from today (to 2026-11-30) contain exactly these two charges; the Plan
    // preview shows three because its stream starts on the anchor itself, so
    // one charge lands on the horizon.
    expect(result.dates[0].date).toBe('2026-10-15');
    expect(dateOf(result)).toEqual(['2026-10-15', '2026-11-15']);
    expect(result.horizon_date).toBe('2026-11-30');
  });

  it('keeps a Free Period waiving the fee it waives, counted from starts_at', () => {
    // Two free periods from 2026-09-30: the first two cycles are free, the
    // third charges. The classification is the engine's, from `starts_at`.
    const result = run({ planDuration: toPlanDuration(2, 0, 0, 0, MONTHLY) });
    const feeOn = (date: string) =>
      result.dates.find((d) => d.date === date)?.lines.find((l) => l.kind === 'membership_fee');

    expect(feeOn(TODAY)?.actual_charge).toBe(0);
    expect(feeOn('2026-10-30')?.actual_charge).toBe(0);
    expect(feeOn('2026-11-30')?.actual_charge).toBe(70);
    // A waived line is still a billing event, shown at €0 beside its regular price.
    expect(feeOn(TODAY)?.regular_price).toBe(70);
  });

  it('prices a standing Promotion grant from the grant itself and still shows the line', () => {
    const result = run({
      promotions: [promotion([{
        gymChargeId: 6,
        name: 'Towel service',
        category: 'periodical',
        billingFrequency: 'month',
        unitPrice: 10,
        quantity: 2,
        benefit: toSellableItemBenefit('promotion', 'waive', null),
      }])],
    });
    const towel = result.dates[0].lines.find((l) => l.label === 'Towel service');
    expect(towel?.actual_charge).toBe(0);
    expect(towel?.regular_price).toBe(10);
    expect(towel?.benefits.map((b) => b.action)).toContain('waive');
  });

  it('reports the forecast as unavailable when the assignment has no cadence or price', () => {
    expect(run({ recurringInterval: null, recurringUnit: null }).available).toBe(false);
    expect(run({ membershipFeePrice: null, recurringInterval: null, recurringUnit: null }).reason)
      .toMatch(/no price or billing frequency/i);
  });

  it('reports no further billing events when the assignment has already ended', () => {
    const result = run({ startsAt: '2024-01-31', endsAt: '2025-01-31' });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/no further billing events/i);
    expect(result.dates).toEqual([]);
  });

  it('starts at the contract itself for an assignment that has not started yet', () => {
    const result = run({ startsAt: '2026-12-01' }, TODAY);
    expect(result.anchor_date).toBe('2026-12-01');
    expect(result.dates[0].date).toBe('2026-12-01');
  });

  it('reports every amount as tax-inclusive and never labels a line Mandatory', () => {
    // The gross-up is the loader's (`assigned-plan-billing-forecast.ts`) and the
    // projection only declares it; `mandatory` is a property of the gym's
    // current catalogue, not of what this member was agreed, so no line claims it.
    const result = run({ planBenefits: [benefit()] });
    expect(result.tax_included).toBe(true);
    expect(result.currency).toBe('EUR');
    expect(result.dates.flatMap((d) => d.lines).every((l) => l.mandatory === false)).toBe(true);
  });

  it('totals each date and the whole forecast from the engine amounts alone', () => {
    const result = run({ planBenefits: [benefit({ unitPrice: 20, quantity: 2 })] });
    for (const group of result.dates) {
      expect(group.total).toBe(group.lines.reduce((sum, l) => sum + l.actual_charge, 0));
    }
    expect(result.total).toBe(result.dates.reduce((sum, g) => sum + g.total, 0));
  });
});
