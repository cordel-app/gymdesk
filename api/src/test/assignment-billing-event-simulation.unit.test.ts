// Unit tests for `computeAssignmentBillingEventSimulation` (#924 stage 4) — a
// pure projection over the Billing Simulation engine, so no DB, no HTTP and no
// test gym (CLAUDE.md: unit tests vs integration tests).
//
// §8 asks the Assigned Plan card for the Membership Plan card's Billing Event
// Simulation (#915), for a contract that really exists, and forbids the
// shortcut that would make it easy:
//
//   > The simulation must use the same billing and pricing logic as the actual
//   > system. Do not implement a separate simulation engine for Assigned Plans.
//
// So the cases below assert the two things this adapter adds and nothing else:
// the forecast covers the cycles *ahead* of a contract whose `starts_at` may be
// years in the past, and the dates it has already been charged on are not in
// it. Every amount, every date and every period status is the engine's — tested
// in `billing-simulation.test.ts` and `plan-billing-event-simulation.test.ts` —
// and the pricing of the Membership Fee in `membership-fee-resolution.test.ts`.

import { describe, expect, it } from 'vitest';
import {
  SimulationAssignment,
  SimulationGrant,
  SimulationPlanBenefit,
} from '../domain/billingSimulation';
import { computeAssignmentBillingEventSimulation } from '../domain/assignmentBillingEventSimulation';
import { SIMULATED_CYCLES } from '../domain/billingEventSimulation';
import { NO_PERSONAL_FEE_BENEFIT } from '../domain/personalFeeBenefit';
import { NO_PLAN_DURATION, toPlanDuration } from '../domain/planDuration';
import { NO_SELLABLE_ITEM_BENEFIT } from '../domain/sellableItemBenefitActions';

const MONTHLY = { interval: 1, unit: 'month' as const };
const FOUR_WEEKLY = { interval: 4, unit: 'week' as const };

/** "Today" for every case: the forecast's own anchor, pinned. */
const TODAY = '2026-10-02';

function benefit(over: Partial<SimulationPlanBenefit> = {}): SimulationPlanBenefit {
  return {
    gymChargeId: 1,
    name: 'Locker',
    category: 'periodical',
    billingFrequency: 'month',
    unitPrice: 20,
    quantity: 1,
    sessionFrequency: null,
    benefit: NO_SELLABLE_ITEM_BENEFIT,
    ...over,
  };
}

function assignment(over: Partial<SimulationAssignment> = {}): SimulationAssignment {
  return {
    userMembershipId: 42,
    planName: 'Full Access',
    startsAt: '2023-03-15',
    endsAt: null,
    membershipFeePrice: 70,
    recurringInterval: 1,
    recurringUnit: 'month',
    promotions: [],
    services: [],
    planBenefits: [],
    planDuration: NO_PLAN_DURATION,
    personalFeeBenefit: NO_PERSONAL_FEE_BENEFIT,
    ...over,
  };
}

function forecast(over: Partial<SimulationAssignment> = {}, from = TODAY) {
  return computeAssignmentBillingEventSimulation({ assignment: assignment(over), from });
}

const dates = (r: ReturnType<typeof forecast>) => r.dates.map((g) => g.date);
const linesOn = (r: ReturnType<typeof forecast>, date: string) =>
  r.dates.find((g) => g.date === date)!.lines;

describe('computeAssignmentBillingEventSimulation', () => {
  it('forecasts an assignment that started years ago, from today forward', () => {
    // The whole reason this adapter anchors the horizon: both the two-cycle
    // floor and the engine's 36-month safety cap are measured from `starts_at`
    // by default, which for a 2023 contract is already past — the forecast
    // would be empty.
    const result = forecast();
    expect(result.available).toBe(true);
    expect(result.dates.length).toBeGreaterThan(0);
    for (const date of dates(result)) expect(date >= TODAY).toBe(true);
  });

  it('keeps the contract’s own billing dates — the schedule is anchored on starts_at', () => {
    // 15 March 2023, monthly: every charge falls on a 15th, never on "today
    // plus a month". This is what makes the forecast agree with
    // `next_billing_date`, which #790 stamps as the first `starts_at`-anchored
    // boundary after today.
    const result = forecast();
    expect(dates(result)).toEqual(['2026-10-15', '2026-11-15', '2026-12-15']);
  });

  it('spans at least two complete cycles of the recurring frequency, from today', () => {
    const result = forecast({ startsAt: '2026-09-30', recurringInterval: 4, recurringUnit: 'week' });
    // Four-weekly from 30 Sep: the horizon is today + 2 cycles, and because an
    // event lands on the horizon itself the fastest stream shows three charges —
    // #915's own Sep 30 / Oct 28 / Nov 25 shape, shifted to start at today.
    expect(result.dates.length).toBeGreaterThanOrEqual(SIMULATED_CYCLES + 1);
    expect(dates(result)).toContain('2026-10-28');
    expect(dates(result)).toContain('2026-11-25');
  });

  it('drops the dates the assignment has already been charged on', () => {
    // A one-off Registration Fee is charged once, on the start date. For a
    // contract that started in 2023 that date is history — the card's Billing
    // Events ledger is what shows it — so it must not be forecast again.
    const result = forecast({
      planBenefits: [benefit({
        gymChargeId: 9, name: 'Registration Fee', category: 'oneoff',
        billingFrequency: 'once', unitPrice: 50,
      })],
    });
    expect(result.available).toBe(true);
    for (const group of result.dates) {
      for (const line of group.lines) expect(line.label).not.toBe('Registration Fee');
    }
  });

  it('keeps a one-off charge that falls on or after today', () => {
    const result = forecast({
      startsAt: TODAY,
      planBenefits: [benefit({
        gymChargeId: 9, name: 'Registration Fee', category: 'oneoff',
        billingFrequency: 'once', unitPrice: 50,
      })],
    });
    expect(linesOn(result, TODAY).map((l) => l.label)).toContain('Registration Fee');
  });

  it('groups every line that falls on one date, with that date’s total', () => {
    // The Membership Fee and a monthly Period Benefit share the 15th, so they
    // share a group — the frequencies stay independent streams, a common date
    // is what a common group means.
    const result = forecast({ planBenefits: [benefit({ unitPrice: 20 })] });
    const group = result.dates.find((g) => g.date === '2026-10-15')!;
    expect(group.lines.map((l) => l.label).sort()).toEqual(['Full Access', 'Locker']);
    expect(group.total).toBe(90);
  });

  it('reports the dates in chronological order', () => {
    const result = forecast({ planBenefits: [benefit({ billingFrequency: 'year', unitPrice: 120 })] });
    expect(dates(result)).toEqual([...dates(result)].sort());
  });

  it('prices the assignment’s Billing & Duration: a free period bills nothing', () => {
    // 60 free months from March 2023 covers every date in the forecast, so the
    // fee line is a €0 billing event with its regular price beside it — never a
    // dropped line (#915's "a waived line is still a billing event").
    const result = forecast({
      planDuration: toPlanDuration(60, 0, 0, 0, MONTHLY),
    });
    const fee = linesOn(result, '2026-10-15').find((l) => l.kind === 'membership_fee')!;
    expect(fee.actual_charge).toBe(0);
    expect(fee.regular_price).toBe(70);
    expect(fee.benefits.map((b) => b.source)).toContain('membership_plan');
  });

  it('prices an applied Promotion’s grant from the application’s own pair', () => {
    const grant: SimulationGrant = {
      gymChargeId: 1, name: 'Locker', category: 'periodical', billingFrequency: 'month',
      unitPrice: 20, quantity: 6, benefit: { action: 'waive', value: null },
    };
    const result = forecast({
      startsAt: TODAY,
      planBenefits: [benefit({ unitPrice: 20 })],
      promotions: [{
        name: 'Autumn', appliedAt: TODAY, revokedAt: null,
        freeMonths: 0, paidMonths: 0, payBeforehandMonths: 0, bonusMonths: 0,
        membershipFeeBenefits: [], grants: [grant],
      }],
    });
    const locker = linesOn(result, TODAY).find((l) => l.label === 'Locker')!;
    expect(locker.actual_charge).toBe(0);
    expect(locker.regular_price).toBe(20);
    expect(locker.benefits.map((b) => b.action)).toContain('waive');
  });

  it('applies the Personal Membership Fee Benefit to every forecast cycle (#772)', () => {
    const result = forecast({ personalFeeBenefit: { action: 'percentage_discount', value: 10 } });
    for (const group of result.dates) {
      const fee = group.lines.find((l) => l.kind === 'membership_fee');
      if (fee) expect(fee.actual_charge).toBe(63);
    }
  });

  it('bills an Additional Periodic Service of the assignment', () => {
    const result = forecast({
      services: [{
        id: 7, gymChargeId: 5, name: 'Personal Trainer', billingFrequency: 'month',
        unitPrice: 40, quantity: 1, startsOn: '2024-01-10', endsOn: null,
      }],
    });
    expect(result.dates.some((g) => g.lines.some((l) => l.label === 'Personal Trainer'))).toBe(true);
  });

  it('is unavailable, with a reason, for an assignment that bills nothing', () => {
    const result = forecast({ membershipFeePrice: null, recurringInterval: null, recurringUnit: null });
    expect(result.available).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(result.dates).toEqual([]);
  });

  it('is unavailable for an assignment whose every remaining date is behind us', () => {
    // An `ends_at` already passed bounds every stream, so nothing is left to
    // forecast — the card says so rather than rendering an empty table.
    const result = forecast({ endsAt: '2024-06-15' });
    expect(result.available).toBe(false);
    expect(result.dates).toEqual([]);
  });

  it('reports the forecast’s own anchor and quotes VAT-inclusive amounts', () => {
    const result = forecast();
    expect(result.anchor_date).toBe(TODAY);
    expect(result.tax_included).toBe(true);
    expect(result.currency).toBe('EUR');
  });

  it('flags no line as Mandatory — that is a Membership Plan’s question', () => {
    // #832/#893: Mandatory says a catalogue item must be part of every Plan
    // section. An assignment bills what it was agreed with, frozen, so a live
    // flag must not be claimed about a frozen line.
    const result = forecast({ planBenefits: [benefit()] });
    for (const group of result.dates) {
      for (const line of group.lines) expect(line.mandatory).toBe(false);
    }
  });

  it('totals the groups it reports, and only those', () => {
    const result = forecast();
    expect(result.total).toBe(result.dates.reduce((sum, g) => sum + g.total, 0));
  });
});
