// Unit tests for `computePlanBillingEventSimulation` (#915) — a pure projection
// over the Billing Simulation engine, so no DB, no HTTP and no test gym
// (CLAUDE.md: unit tests vs integration tests).
//
// The ticket's five load-bearing rules are each asserted here: events are grouped
// by their actual billing date, different frequencies stay independent, a `Once`
// item appears once, a waived line is still shown at €0, and the projection's
// length is derived from the frequencies present rather than being a fixed number
// of months.

import { describe, expect, it } from 'vitest';
import {
  PlanSimulationItem,
  SIMULATED_CYCLES,
  computePlanBillingEventSimulation,
} from '../domain/planBillingEventSimulation';
import { toPlanDuration } from '../domain/planDuration';
import { NO_SELLABLE_ITEM_BENEFIT } from '../domain/sellableItemBenefitActions';

const MONTHLY = { interval: 1, unit: 'month' as const };
const FOUR_WEEKLY = { interval: 4, unit: 'week' as const };
const ANCHOR = '2026-09-30';

function item(over: Partial<PlanSimulationItem> = {}): PlanSimulationItem {
  return {
    gymChargeId: 1,
    name: 'Item',
    category: 'periodical',
    billingFrequency: 'month',
    unitPriceInclTax: 20,
    quantity: 1,
    benefit: NO_SELLABLE_ITEM_BENEFIT,
    mandatory: false,
    ...over,
  };
}

function simulate(over: {
  cadence?: { interval: number; unit: 'day' | 'week' | 'month' | 'year' } | null;
  fee?: number | null;
  items?: PlanSimulationItem[];
  duration?: { free?: number; paid?: number; prepaid?: number; bonus?: number };
  anchorDate?: string;
} = {}) {
  const cadence = over.cadence === undefined ? FOUR_WEEKLY : over.cadence;
  const d = over.duration ?? {};
  return computePlanBillingEventSimulation({
    planName: 'Full Access',
    duration: toPlanDuration(
      d.free ?? 0, d.paid ?? 0, d.bonus ?? 0, d.prepaid ?? 0, cadence ?? MONTHLY,
    ),
    cadence,
    membershipFeeInclTax: over.fee === undefined ? 70 : over.fee,
    items: over.items ?? [],
    anchorDate: over.anchorDate ?? ANCHOR,
  });
}

const dates = (r: ReturnType<typeof simulate>) => r.dates.map((g) => g.date);
const labels = (r: ReturnType<typeof simulate>, date: string) =>
  r.dates.find((g) => g.date === date)!.lines.map((l) => l.label);

describe('computePlanBillingEventSimulation', () => {
  it('is unavailable, with a reason, for a Plan with no billing frequency', () => {
    const result = simulate({ cadence: null });
    expect(result.available).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(result.dates).toEqual([]);
  });

  it('is unavailable for a Plan with neither a price nor a benefit', () => {
    const result = simulate({ fee: null, items: [] });
    expect(result.available).toBe(false);
    expect(result.dates).toEqual([]);
  });

  // The ticket's own example: a 4-weekly €70 Membership Fee from 30 Sep 2026.
  it('spans two complete cycles of the only recurring frequency present', () => {
    const result = simulate();
    expect(result.available).toBe(true);
    expect(dates(result)).toEqual(['2026-09-30', '2026-10-28', '2026-11-25']);
    expect(result.dates.map((g) => g.total)).toEqual([70, 70, 70]);
    expect(result.total).toBe(210);
    expect(result.horizon_date).toBe('2026-11-25');
    expect(result.anchor_date).toBe(ANCHOR);
  });

  it('derives its length from the slowest frequency, not from a month count', () => {
    const result = simulate({
      items: [item({ gymChargeId: 9, name: 'Insurance', billingFrequency: 'year', unitPriceInclTax: 20 })],
    });
    // Two complete cycles of the yearly item, so the projection runs two years —
    // and the 4-weekly fee is carried out with it rather than stopping early.
    expect(result.horizon_date).toBe('2028-09-30');
    expect(dates(result).length).toBeGreaterThan(26);
    expect(labels(result, '2027-09-30')).toContain('Insurance');
    expect(labels(result, '2028-09-30')).toContain('Insurance');
    expect(SIMULATED_CYCLES).toBe(2);
  });

  it('groups every line that falls on one date under that date', () => {
    const result = simulate({
      items: [
        item({ gymChargeId: 2, name: 'Registration Fee', category: 'oneoff', billingFrequency: 'once', unitPriceInclTax: 100 }),
        item({ gymChargeId: 3, name: 'Insurance Fee', category: 'oneoff', billingFrequency: 'once', unitPriceInclTax: 20, mandatory: true }),
        item({ gymChargeId: 4, name: 'Locker Rental', billingFrequency: 'month', unitPriceInclTax: 15 }),
      ],
    });
    expect(labels(result, '2026-09-30')).toEqual(
      expect.arrayContaining(['Registration Fee', 'Insurance Fee', 'Full Access', 'Locker Rental']),
    );
    expect(result.dates[0].total).toBe(205);
    // A one-off item is billed once and never repeats.
    expect(labels(result, '2026-10-28')).toEqual(['Full Access']);
    expect(result.dates.filter((g) => g.lines.some((l) => l.label === 'Registration Fee'))).toHaveLength(1);
  });

  it('marks a Mandatory item so the line can say so', () => {
    const result = simulate({
      items: [item({ gymChargeId: 3, name: 'Insurance Fee', category: 'oneoff', billingFrequency: 'once', mandatory: true })],
    });
    const line = result.dates[0].lines.find((l) => l.label === 'Insurance Fee')!;
    expect(line.mandatory).toBe(true);
    expect(result.dates[0].lines.find((l) => l.kind === 'membership_fee')!.mandatory).toBe(false);
  });

  // Different frequencies stay independent — nothing is converted to a common
  // cadence — but two that land on the same day share a group.
  it('keeps frequencies independent while still sharing a coinciding date', () => {
    // Mid-month anchor: `advanceBillingDate` clamps a 30th through February, so a
    // month-end anchor would legitimately drift the monthly stream off the
    // anniversary and hide the point this case is making.
    const result = simulate({
      cadence: MONTHLY,
      anchorDate: '2026-09-15',
      items: [item({ gymChargeId: 5, name: 'Insurance', billingFrequency: 'year', unitPriceInclTax: 20 })],
    });
    expect(labels(result, '2026-09-15').sort()).toEqual(['Full Access', 'Insurance']);
    expect(labels(result, '2026-10-15')).toEqual(['Full Access']);
    // The yearly item recurs on its own anniversary, not on a monthly boundary.
    expect(labels(result, '2027-09-15').sort()).toEqual(['Full Access', 'Insurance']);
    expect(labels(result, '2027-08-15')).toEqual(['Full Access']);
  });

  it('still shows a waived line, at €0, with its reason attached', () => {
    const result = simulate({
      items: [item({
        gymChargeId: 6, name: 'Locker Rental', billingFrequency: 'month',
        unitPriceInclTax: 15, benefit: { action: 'waive', value: null },
      })],
    });
    const line = result.dates[0].lines.find((l) => l.label === 'Locker Rental')!;
    expect(line.regular_price).toBe(15);
    expect(line.actual_charge).toBe(0);
    expect(line.benefits.map((b) => b.action)).toEqual(['waive']);
    expect(result.dates[0].total).toBe(70);
  });

  it('applies a percentage discount to the whole line', () => {
    const result = simulate({
      items: [item({
        gymChargeId: 7, name: 'Towel', billingFrequency: 'month', unitPriceInclTax: 10, quantity: 3,
        benefit: { action: 'percentage_discount', value: 50 },
      })],
    });
    const line = result.dates[0].lines.find((l) => l.label === 'Towel')!;
    expect(line.unit_price).toBe(10);
    expect(line.quantity).toBe(3);
    expect(line.regular_price).toBe(30);
    expect(line.actual_charge).toBe(15);
  });

  // The Plan's Billing & Duration waives the Membership Fee, and the projection
  // still reaches the first period that actually charges it.
  it('waives the fee in a Free Period and runs on to the first charged period', () => {
    const result = simulate({ cadence: MONTHLY, duration: { free: 4, paid: 12 } });
    const fee = (date: string) =>
      result.dates.find((g) => g.date === date)!.lines.find((l) => l.kind === 'membership_fee')!;
    expect(fee('2026-09-30').actual_charge).toBe(0);
    expect(fee('2026-09-30').benefits.map((b) => b.period_status)).toEqual(['free_plan']);
    expect(fee('2027-01-30').actual_charge).toBe(70);
    expect(result.horizon_date).toBe('2027-01-30');
  });

  it('reports the amounts as tax-inclusive and charges nothing', () => {
    const result = simulate();
    expect(result.tax_included).toBe(true);
    expect(result.currency).toBe('EUR');
    expect(result.truncated).toBe(false);
  });
});
