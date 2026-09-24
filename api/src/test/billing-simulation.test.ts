// Unit tests for domain/billingSimulation.ts (#629 stage 1) — the Billing
// Simulation engine is a pure projection with no DB or HTTP dependency, so
// per CLAUDE.md these are unit tests: no createTestGym, no cleanupTestGyms,
// no db.end().

import { describe, expect, it } from 'vitest';
import {
  BillingSimulationResult,
  SimulationAssignment,
  SimulationGrant,
  SimulationPlanBenefit,
  SimulationPromotion,
  SimulationService,
  computeBillingSimulation,
} from '../domain/billingSimulation';

const START = '2026-09-01';

function assignment(over: Partial<SimulationAssignment> = {}): SimulationAssignment {
  return {
    userMembershipId: 1,
    planName: 'Standard',
    startsAt: START,
    endsAt: null,
    membershipFeePrice: 100,
    recurringInterval: 1,
    recurringUnit: 'month',
    promotions: [],
    services: [],
    planBenefits: [],
    ...over,
  };
}

// #631 — an Additional Periodic Service attached to the assignment.
function service(over: Partial<SimulationService> = {}): SimulationService {
  return {
    id: 1,
    gymChargeId: 42,
    name: 'Locker Rental',
    billingFrequency: 'month',
    unitPrice: 20,
    quantity: 1,
    startsOn: START,
    endsOn: null,
    ...over,
  };
}

function promotion(over: Partial<SimulationPromotion> = {}): SimulationPromotion {
  return {
    name: 'October Promotion',
    appliedAt: START,
    revokedAt: null,
    freeMonths: 0,
    paidMonths: 0,
    payBeforehandMonths: 0,
    bonusMonths: 0,
    membershipFeeBenefits: [],
    grants: [],
    ...over,
  };
}

function grant(over: Partial<SimulationGrant> = {}): SimulationGrant {
  return {
    gymChargeId: 7,
    name: 'Locker Rental',
    category: 'periodical',
    billingFrequency: 'four_weeks',
    unitPrice: 20,
    quantity: 2,
    ...over,
  };
}

// #635 — a benefit the Assigned Plan carries in its own right (charged), as
// opposed to a Promotion grant (free for as long as it covers the item).
function planBenefit(over: Partial<SimulationPlanBenefit> = {}): SimulationPlanBenefit {
  return {
    gymChargeId: 7,
    name: 'Locker Rental',
    category: 'periodical',
    billingFrequency: 'month',
    unitPrice: 20,
    quantity: 1,
    ...over,
  };
}

function section(result: BillingSimulationResult, name: string) {
  return result.sections.find((s) => s.section === name);
}

describe('computeBillingSimulation — nothing to simulate', () => {
  it('reports no active plans when the Member has no assignments', () => {
    const result = computeBillingSimulation({ assignments: [] });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/no active membership plans/i);
    expect(result.sections).toEqual([]);
  });

  it('reports a missing price/frequency rather than an empty simulation', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({ membershipFeePrice: null, recurringInterval: null, recurringUnit: null })],
    });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/billing frequency/i);
  });
});

describe('computeBillingSimulation — membership fee, no promotion', () => {
  it('stops after one regular charge', () => {
    const result = computeBillingSimulation({ assignments: [assignment()] });
    expect(result.available).toBe(true);
    expect(result.start_date).toBe(START);
    expect(result.horizon_date).toBe(START);
    expect(result.truncated).toBe(false);

    const monthly = section(result, 'month')!;
    expect(monthly.events).toHaveLength(1);
    expect(monthly.events[0].date).toBe(START);
    expect(monthly.events[0].lines[0]).toMatchObject({
      kind: 'membership_fee',
      label: 'Standard',
      regular_price: 100,
      actual_charge: 100,
      benefits: [],
      price_may_change: false,
    });
    expect(result.total).toBe(100);
  });

  it('bills a monthly plan on its own start date, not a month later', () => {
    const result = computeBillingSimulation({ assignments: [assignment({ startsAt: '2026-10-15' })] });
    expect(section(result, 'month')!.events[0].date).toBe('2026-10-15');
  });
});

describe('computeBillingSimulation — promotion periods (#629 §5)', () => {
  it('waives free months and continues to the first regular charge', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({ promotions: [promotion({ freeMonths: 2 })] })],
    });
    const events = section(result, 'month')!.events;
    expect(events.map((e) => e.date)).toEqual(['2026-09-01', '2026-10-01', '2026-11-01']);
    expect(events.map((e) => e.total)).toEqual([0, 0, 100]);
    expect(events[0].lines[0].benefits[0]).toMatchObject({
      source: 'promotion', name: 'October Promotion', action: 'waive', period_status: 'free_promotion',
    });
    expect(events[2].lines[0].benefits).toEqual([]);
    expect(result.horizon_date).toBe('2026-11-01');
  });

  it('applies the Membership Fee Benefit to paid promotional periods only', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({
        membershipFeePrice: 120,
        promotions: [promotion({
          paidMonths: 2,
          membershipFeeBenefits: [{ action: 'fixed_price', value: 100, enabled: true, durationMonths: null }],
        })],
      })],
    });
    const events = section(result, 'month')!.events;
    expect(events.map((e) => e.total)).toEqual([100, 100, 120]);
    expect(events[0].lines[0].benefits[0]).toMatchObject({
      action: 'fixed_price', value: 100, period_status: 'pay_promotion',
    });
    expect(events[0].lines[0].regular_price).toBe(120);
  });

  it('marks prepaid periods as prepaid while still showing their definitive amount', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({
        promotions: [promotion({
          paidMonths: 2, payBeforehandMonths: 1,
          membershipFeeBenefits: [{ action: 'percentage_discount', value: 50, enabled: true, durationMonths: null }],
        })],
      })],
    });
    const events = section(result, 'month')!.events;
    expect(events[0].lines[0].benefits[0].period_status).toBe('prepaid_promotion');
    expect(events[0].total).toBe(50);
    expect(events[1].lines[0].benefits[0].period_status).toBe('pay_promotion');
  });

  it('waives bonus months and charges the regular price afterwards', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({ promotions: [promotion({ paidMonths: 1, bonusMonths: 1 })] })],
    });
    const events = section(result, 'month')!.events;
    expect(events.map((e) => e.total)).toEqual([100, 0, 100]);
    expect(events[1].lines[0].benefits[0].period_status).toBe('bonus_promotion');
  });

  it('ignores a promotion revoked before the projected charge', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({
        promotions: [promotion({ freeMonths: 6, revokedAt: '2026-09-15' })],
      })],
    });
    const events = section(result, 'month')!.events;
    expect(events.map((e) => e.total)).toEqual([0, 100]);
  });
});

describe('computeBillingSimulation — sellable items granted by a promotion', () => {
  it('projects a 4-week item with concrete period dates, free for the granted periods', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({ promotions: [promotion({ grants: [grant()] })] })],
    });
    const fourWeeks = section(result, 'four_weeks')!;
    expect(fourWeeks.events.map((e) => [e.date, e.period_end])).toEqual([
      ['2026-09-01', '2026-09-28'],
      ['2026-09-29', '2026-10-26'],
      ['2026-10-27', '2026-11-23'],
    ]);
    expect(fourWeeks.events.map((e) => e.total)).toEqual([0, 0, 20]);
    expect(fourWeeks.events[0].lines[0]).toMatchObject({
      kind: 'sellable_item', label: 'Locker Rental', gym_charge_id: 7, regular_price: 20, actual_charge: 0,
    });
    expect(fourWeeks.events[0].lines[0].benefits[0].action).toBe('included');
  });

  it('counts the granted periods from when the promotion was applied, not the plan start', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({
        promotions: [promotion({ appliedAt: '2026-09-29', grants: [grant({ quantity: 1 })] })],
      })],
    });
    const fourWeeks = section(result, 'four_weeks')!;
    // Billed from the plan start, but the first period predates the promotion.
    expect(fourWeeks.events.map((e) => e.total)).toEqual([20, 0, 20]);
    expect(fourWeeks.events[1].date).toBe('2026-09-29');
  });

  it('shows a session grant as one line covering the granted sessions', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({
        promotions: [promotion({
          grants: [grant({ name: 'Personal Training Class', category: 'session', billingFrequency: 'per_session', unitPrice: 30, quantity: 4 })],
        })],
      })],
    });
    const sessions = section(result, 'session')!;
    expect(sessions.events).toHaveLength(1);
    expect(sessions.events[0].lines[0]).toMatchObject({
      label: 'Personal Training Class', quantity: 4, unit_price: 30, regular_price: 120, actual_charge: 0,
    });
  });

  it('shows a one-off grant in the one-off section on the start date', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({
        promotions: [promotion({
          grants: [grant({ name: 'Registration Fee', category: 'oneoff', billingFrequency: 'once', unitPrice: 50, quantity: 1 })],
        })],
      })],
    });
    const oneOff = section(result, 'one_off')!;
    expect(oneOff.events).toHaveLength(1);
    expect(oneOff.events[0].date).toBe(START);
    expect(oneOff.events[0].lines[0].regular_price).toBe(50);
    expect(oneOff.events[0].lines[0].actual_charge).toBe(0);
  });

  it('orders the sections one-off, year, monthly, 4-week (#629 §3)', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({
        promotions: [promotion({
          grants: [
            grant({ gymChargeId: 1, name: 'Registration Fee', category: 'oneoff', billingFrequency: 'once', unitPrice: 50, quantity: 1 }),
            grant({ gymChargeId: 2, name: 'Annual Insurance', category: 'periodical', billingFrequency: 'year', unitPrice: 120, quantity: 1 }),
            grant({ gymChargeId: 3, name: 'Training Service', category: 'periodical', billingFrequency: 'four_weeks', unitPrice: 40, quantity: 1 }),
          ],
        })],
      })],
    });
    expect(result.sections.map((s) => s.section)).toEqual(['one_off', 'year', 'month', 'four_weeks']);
  });
});

describe('computeBillingSimulation — horizon across mixed frequencies (#629 §6)', () => {
  it('extends every item until the longest one reaches its regular price', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({
        promotions: [promotion({
          grants: [grant({ gymChargeId: 9, name: 'Annual Insurance', billingFrequency: 'year', unitPrice: 120, quantity: 1 })],
        })],
      })],
    });
    // The annual item is free for its first year, so its first regular charge
    // is a year out — and the monthly membership fee runs all the way there.
    expect(result.horizon_date).toBe('2027-09-01');
    expect(section(result, 'month')!.events).toHaveLength(13);
    expect(section(result, 'year')!.events.map((e) => e.total)).toEqual([0, 120]);
  });

  it('marks charges a year or more after the start as subject to a price revision', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({
        promotions: [promotion({
          grants: [grant({ gymChargeId: 9, name: 'Annual Insurance', billingFrequency: 'year', unitPrice: 120, quantity: 1 })],
        })],
      })],
    });
    const monthly = section(result, 'month')!.events;
    expect(monthly[0].lines[0].price_may_change).toBe(false);
    expect(monthly[11].lines[0].price_may_change).toBe(false); // 2027-08-01
    expect(monthly[12].lines[0].price_may_change).toBe(true); // 2027-09-01
  });

  // #635 stage 5: a Membership Fee Benefit always belongs to a promotional
  // period (#625 — it can never outlast the Promotion), so "benefited for
  // longer than the horizon" is a Promotion whose paid duration outruns
  // `maxMonths`. Before stage 5 the same case could also be written as a
  // Charge Benefit, which applied with no promotional period at all; that
  // table is gone (migration 179).
  it('caps an item benefited past the horizon and reports it as truncated', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({
        promotions: [promotion({
          paidMonths: 24,
          membershipFeeBenefits: [{ action: 'percentage_discount', value: 10, enabled: true, durationMonths: null }],
        })],
      })],
      maxMonths: 6,
    });
    expect(result.truncated).toBe(true);
    expect(result.horizon_date).toBe('2027-03-01');
    expect(section(result, 'month')!.events.every((e) => e.total === 90)).toBe(true);
  });

  it('stops at the assignment end date', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({ endsAt: '2026-10-15', promotions: [promotion({ freeMonths: 6 })] })],
    });
    expect(section(result, 'month')!.events.map((e) => e.date)).toEqual(['2026-09-01', '2026-10-01']);
  });
});

describe('computeBillingSimulation — consolidation across plans (#634 §6)', () => {
  it('groups same-day charges from every active plan into one event with a total', () => {
    const result = computeBillingSimulation({
      assignments: [
        assignment({ userMembershipId: 1, planName: 'Standard', membershipFeePrice: 75 }),
        assignment({ userMembershipId: 2, planName: 'Premium', membershipFeePrice: 100 }),
      ],
    });
    const monthly = section(result, 'month')!;
    expect(monthly.events).toHaveLength(1);
    expect(monthly.events[0].lines.map((l) => [l.plan_name, l.actual_charge])).toEqual([
      ['Standard', 75], ['Premium', 100],
    ]);
    expect(monthly.events[0].total).toBe(175);
    expect(result.total).toBe(175);
  });

  it('keeps plans that start on different dates as separate events', () => {
    const result = computeBillingSimulation({
      assignments: [
        assignment({ userMembershipId: 1, startsAt: '2026-09-01' }),
        assignment({ userMembershipId: 2, startsAt: '2026-09-10' }),
      ],
    });
    expect(section(result, 'month')!.events.map((e) => e.date)).toEqual(['2026-09-01', '2026-09-10']);
    expect(result.start_date).toBe('2026-09-01');
  });
});

describe('computeBillingSimulation — cadences', () => {
  it('projects a yearly membership fee in the year section', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({ recurringInterval: 1, recurringUnit: 'year' })],
    });
    expect(result.sections.map((s) => s.section)).toEqual(['year']);
  });

  it('treats a 4-week plan cadence as 28 days, never as a month', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({
        recurringInterval: 4, recurringUnit: 'week',
        promotions: [promotion({ freeMonths: 1 })],
      })],
    });
    const events = section(result, 'four_weeks')!.events;
    expect(events[0]).toMatchObject({ date: '2026-09-01', period_end: '2026-09-28' });
    expect(events[1].date).toBe('2026-09-29');
  });

  it('falls back to the other section for an unusual cadence', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({ recurringInterval: 10, recurringUnit: 'day' })],
    });
    expect(result.sections.map((s) => s.section)).toEqual(['other']);
  });
});

describe('computeBillingSimulation — additional periodic services (#631)', () => {
  it('bills a service alongside the membership fee, in the section of its own frequency', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({ services: [service()] })],
    });
    const monthly = section(result, 'month')!;
    expect(monthly.events).toHaveLength(1);
    expect(monthly.events[0].lines.map((l) => [l.kind, l.label, l.actual_charge])).toEqual([
      ['membership_fee', 'Standard', 100],
      ['sellable_item', 'Locker Rental', 20],
    ]);
    expect(monthly.events[0].total).toBe(120);
    expect(result.total).toBe(120);
  });

  it('multiplies the charge by the quantity', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({ services: [service({ quantity: 3 })] })],
    });
    const line = section(result, 'month')!.events[0].lines[1];
    expect(line).toMatchObject({ quantity: 3, unit_price: 20, regular_price: 60, actual_charge: 60 });
  });

  it('bills a 4-week service in its own section with concrete period dates', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({ services: [service({ name: 'Training Service', billingFrequency: 'four_weeks', unitPrice: 40 })] })],
    });
    const events = section(result, 'four_weeks')!.events;
    expect(events[0]).toMatchObject({ date: '2026-09-01', period_end: '2026-09-28', total: 40 });
  });

  it('bills a service added after the plan started from its own effective date (#631 §5)', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({
        promotions: [promotion({ freeMonths: 3 })],
        services: [service({ startsOn: '2026-11-01' })],
      })],
    });
    const events = section(result, 'month')!.events;
    expect(events.map((e) => [e.date, e.total])).toEqual([
      ['2026-09-01', 0], ['2026-10-01', 0], ['2026-11-01', 20], ['2026-12-01', 120],
    ]);
  });

  it('stops a removed service after its effective removal date, keeping earlier charges (#631 §3)', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({
        promotions: [promotion({ freeMonths: 4 })],
        services: [service({ endsOn: '2026-10-15' })],
      })],
    });
    const events = section(result, 'month')!.events;
    expect(events.map((e) => [e.date, e.total])).toEqual([
      ['2026-09-01', 20], ['2026-10-01', 20], ['2026-11-01', 0], ['2026-12-01', 0], ['2027-01-01', 100],
    ]);
  });

  it('charges the regular price during a promotional period — services are not promotion benefits (#631 §7)', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({
        promotions: [promotion({ freeMonths: 1, grants: [grant({ gymChargeId: 42, billingFrequency: 'month' })] })],
        services: [service()],
      })],
    });
    const first = section(result, 'month')!.events[0];
    const serviceLine = first.lines.find((l) => l.kind === 'sellable_item' && l.benefits.length === 0)!;
    expect(serviceLine).toMatchObject({ label: 'Locker Rental', actual_charge: 20, benefits: [] });
    // The membership fee is waived by the free month; the service still bills.
    expect(first.lines.find((l) => l.kind === 'membership_fee')!.actual_charge).toBe(0);
  });

  it('extends the horizon so a service starting later still shows its first charge', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({ services: [service({ billingFrequency: 'year', startsOn: '2027-03-01' })] })],
    });
    expect(result.horizon_date).toBe('2027-03-01');
    expect(section(result, 'year')!.events.map((e) => e.date)).toEqual(['2027-03-01']);
    expect(section(result, 'month')!.events).toHaveLength(7); // 2026-09 → 2027-03
  });

  it('ignores a service whose window closes before the assignment starts', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({ services: [service({ startsOn: '2026-06-01', endsOn: '2026-07-01' })] })],
    });
    expect(section(result, 'month')!.events[0].lines).toHaveLength(1);
  });

  it('ignores a service whose Sellable Item has no recurring frequency', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({ services: [service({ billingFrequency: 'once' }), service({ id: 2, billingFrequency: null })] })],
    });
    expect(section(result, 'month')!.events[0].lines).toHaveLength(1);
    expect(section(result, 'one_off')).toBeUndefined();
  });
});

// ─── #635 stage 3 — the Plan's own benefit sections ──────────────────────────

describe('computeBillingSimulation — Membership Plan benefits (#635)', () => {
  it('bills a Period Benefit alongside the membership fee, at the frozen price', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({ planBenefits: [planBenefit()] })],
    });
    const monthly = section(result, 'month')!;
    expect(monthly.events[0].lines.map((l) => [l.label, l.actual_charge])).toEqual([
      ['Standard', 100],
      ['Locker Rental', 20],
    ]);
    expect(monthly.events[0].total).toBe(120);
  });

  it('multiplies a Period Benefit by its quantity', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({ planBenefits: [planBenefit({ quantity: 3 })] })],
    });
    const line = section(result, 'month')!.events[0].lines[1];
    expect(line).toMatchObject({ quantity: 3, unit_price: 20, regular_price: 60, actual_charge: 60 });
  });

  it('charges a One-off Benefit and a Session Benefit in full — they are not free', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({
        planBenefits: [
          planBenefit({ gymChargeId: 11, name: 'Registration Fee', category: 'oneoff', billingFrequency: 'once', unitPrice: 50 }),
          planBenefit({ gymChargeId: 12, name: 'Personal Training', category: 'session', billingFrequency: 'per_session', unitPrice: 30, quantity: 10 }),
        ],
      })],
    });
    expect(section(result, 'one_off')!.events[0].lines[0]).toMatchObject({
      label: 'Registration Fee', regular_price: 50, actual_charge: 50, benefits: [],
    });
    expect(section(result, 'session')!.events[0].lines[0]).toMatchObject({
      label: 'Personal Training', quantity: 10, regular_price: 300, actual_charge: 300,
    });
  });

  it('merges a Promotion grant of the same item into one stream instead of billing it twice', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({
        planBenefits: [planBenefit()],
        promotions: [promotion({ grants: [grant({ gymChargeId: 7, billingFrequency: 'month', quantity: 2 })] })],
      })],
    });
    const monthly = section(result, 'month')!;
    // One locker line per event, free for the two granted months.
    expect(monthly.events.map((e) => e.lines.filter((l) => l.gym_charge_id === 7).length)).toEqual([1, 1, 1]);
    expect(monthly.events.map((e) => e.lines.find((l) => l.gym_charge_id === 7)!.actual_charge)).toEqual([0, 0, 20]);
    expect(monthly.events[0].lines[1].benefits[0]).toMatchObject({ action: 'included', name: 'October Promotion' });
  });

  it('charges the units a Promotion does not cover on a session benefit', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({
        planBenefits: [planBenefit({ gymChargeId: 12, name: 'Personal Training', category: 'session', billingFrequency: 'per_session', unitPrice: 30, quantity: 10 })],
        promotions: [promotion({
          grants: [grant({ gymChargeId: 12, name: 'Personal Training', category: 'session', billingFrequency: 'per_session', unitPrice: 30, quantity: 4 })],
        })],
      })],
    });
    const line = section(result, 'session')!.events[0].lines[0];
    expect(line).toMatchObject({ quantity: 10, regular_price: 300, actual_charge: 180 });
    expect(line.benefits[0].action).toBe('included');
  });

  it('never charges a negative amount when the grant exceeds the Plan quantity', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({
        planBenefits: [planBenefit({ gymChargeId: 12, category: 'oneoff', billingFrequency: 'once', unitPrice: 50, quantity: 1 })],
        promotions: [promotion({
          grants: [grant({ gymChargeId: 12, category: 'oneoff', billingFrequency: 'once', unitPrice: 50, quantity: 5 })],
        })],
      })],
    });
    expect(section(result, 'one_off')!.events[0].lines[0].actual_charge).toBe(0);
  });

  it('keeps a Plan item with no projectable frequency out of the simulation', () => {
    const result = computeBillingSimulation({
      assignments: [assignment({ planBenefits: [planBenefit({ billingFrequency: null })] })],
    });
    expect(section(result, 'month')!.events[0].lines).toHaveLength(1);
  });
});
