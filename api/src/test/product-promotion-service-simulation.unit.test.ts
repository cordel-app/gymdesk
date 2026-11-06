// Regression for #1923: a Product Promotion's periodical grant on a recurring
// Product held as an Additional Periodic Service must price that service's own
// stream — consecutive covered cycles, then the regular price — and must not
// add a second stream for the same Product.

import { describe, expect, it } from 'vitest';
import { SimulationAssignment, SimulationGrant } from '../domain/billingSimulation';
import { computeAssignmentBillingEventSimulation } from '../domain/assignmentBillingEventSimulation';
import { NO_PERSONAL_FEE_BENEFIT } from '../domain/personalFeeBenefit';
import { NO_PLAN_DURATION } from '../domain/planDuration';

const TODAY = '2026-10-02';

const grant: SimulationGrant = {
  productId: 7, name: 'Locker Rental', category: 'periodical', billingFrequency: 'month',
  unitPrice: 20, quantity: 3,
  benefit: { action: 'waive', value: null },
} as SimulationGrant;

const assignment: SimulationAssignment = {
  userMembershipId: 1, planName: 'Plan', startsAt: TODAY, endsAt: null,
  membershipFeePrice: 0, recurringInterval: 1, recurringUnit: 'month',
  promotions: [{
    name: 'Locker promo', productTarget: true, appliedAt: TODAY, revokedAt: null,
    freeMonths: 0, paidMonths: 0, payBeforehandMonths: 0, bonusMonths: 0,
    membershipFeeBenefits: [], grants: [grant],
  }],
  services: [{
    id: 1, productId: 7, name: 'Locker Rental', billingFrequency: 'month',
    unitPrice: 20, quantity: 1, startsOn: TODAY, endsOn: null,
  }],
  planBenefits: [],
  planDuration: NO_PLAN_DURATION,
  personalFeeBenefit: NO_PERSONAL_FEE_BENEFIT,
};

describe('Product Promotion on a recurring service (#1923)', () => {
  it('bills the Product once per date, discounted for the promoted cycles only', () => {
    const r = computeAssignmentBillingEventSimulation({ assignment, from: TODAY });
    const lockerLines = r.dates.flatMap((g) => g.lines
      .filter((l) => l.label === 'Locker Rental')
      .map((l) => ({ date: g.date, charge: l.actual_charge })));
    // One locker line per date, never two.
    expect(new Set(lockerLines.map((l) => l.date)).size).toBe(lockerLines.length);
    expect(lockerLines.slice(0, 3).map((l) => l.charge)).toEqual([0, 0, 0]);
    for (const l of lockerLines.slice(3)) expect(l.charge).toBe(20);
  });
});

// #2374: the same Promotion also grants another Product the member does not hold
// (optional in the Promotion). It discounts held lines only and bills nothing else.
describe('Product Promotion grant for a Product the member does not hold (#2374)', () => {
  it('adds no line for it', () => {
    const other: SimulationGrant = {
      productId: 8, name: 'Insurance Fee', category: 'periodical', billingFrequency: 'year',
      unitPrice: 20, quantity: 1, benefit: { action: 'percentage_discount', value: 50 },
    } as SimulationGrant;
    const a: SimulationAssignment = {
      ...assignment,
      promotions: [{ ...assignment.promotions[0], grants: [grant, other] }],
    };
    const r = computeAssignmentBillingEventSimulation({ assignment: a, from: TODAY });
    const labels = new Set(r.dates.flatMap((g) => g.lines.map((l) => l.label)));
    expect(labels.has('Insurance Fee')).toBe(false);
    expect(labels.has('Locker Rental')).toBe(true);
  });
});
