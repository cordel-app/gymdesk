// #2657 stage 3 (option A) — an Individual Product of a Membership Plan is one line per
// member. The engine must bill those lines exactly as it billed the one merged line they
// replace (a Promotion grant's units are a pool for the Product, sliced across its lines),
// and each line keeps its own Direct Discount. The flow against MySQL is
// `plan-line-per-member.test.ts`.

import { describe, expect, it } from 'vitest';
import {
  BillingSimulationResult,
  SimulationAssignment,
  SimulationPlanBenefit,
  SimulationPromotion,
  computeBillingSimulation,
} from '../domain/billingSimulation';
import { NO_PERSONAL_FEE_BENEFIT } from '../domain/personalFeeBenefit';
import { NO_PRODUCT_BENEFIT } from '../domain/productBenefitActions';
import { NO_PLAN_DURATION } from '../domain/planDuration';
import {
  groupUnitAssignees, parsePlanLineMemberInput, planLineKey, reconcileMandatoryMembers,
} from '../domain/planLineAllocation';
import { effectiveUnitAssignees } from '../domain/planUnitAssignees';

const START = '2026-09-01';

function assignment(over: Partial<SimulationAssignment> = {}): SimulationAssignment {
  return {
    userMembershipId: 1, planName: 'Duo', startsAt: START, endsAt: null, membershipFeePrice: 0,
    recurringInterval: 1, recurringUnit: 'month', promotions: [], services: [], planBenefits: [],
    planDuration: NO_PLAN_DURATION, personalFeeBenefit: NO_PERSONAL_FEE_BENEFIT, ...over,
  };
}

function line(over: Partial<SimulationPlanBenefit> = {}): SimulationPlanBenefit {
  return {
    productId: 7, name: 'Locker', category: 'periodical', billingFrequency: 'month', unitPrice: 20,
    quantity: 1, sessionFrequency: null, benefit: NO_PRODUCT_BENEFIT, directDiscountPercent: null, ...over,
  };
}

function promo(grants: SimulationPromotion['grants']): SimulationPromotion {
  return {
    name: 'Welcome', appliedAt: START, revokedAt: null, freeMonths: 0, paidMonths: 0, payBeforehandMonths: 0,
    bonusMonths: 0, membershipFeeBenefits: [], grants,
  };
}

const productLines = (r: BillingSimulationResult) =>
  r.sections.flatMap((s) => s.events.flatMap((e) => e.lines.map((l) => ({ ...l, date: e.date }))))
    .filter((l) => l.kind === 'product');
const totalOf = (r: BillingSimulationResult) =>
  Math.round(productLines(r).reduce((sum, l) => sum + l.actual_charge, 0) * 100) / 100;
const run = (a: SimulationAssignment) => computeBillingSimulation({ assignments: [a], minimumCycles: 3 });

describe('domain/planLineAllocation', () => {
  it('groups per-unit assignees into one allocation per member, in first-appearance order', () => {
    expect(groupUnitAssignees([5, 6, 5, 7])).toEqual([
      { memberId: 5, quantity: 2 }, { memberId: 6, quantity: 1 }, { memberId: 7, quantity: 1 },
    ]);
    expect(groupUnitAssignees([])).toEqual([]);
  });

  it('reconciles a mandatory Product\'s member lines with the beneficiaries', () => {
    expect(reconcileMandatoryMembers([1, 2], [1, 3])).toEqual({ remove: [2], add: [3] });
    expect(reconcileMandatoryMembers([1], [1])).toEqual({ remove: [], add: [] });
  });

  it('reads a section item\'s member three ways and refuses anything else', () => {
    expect(parsePlanLineMemberInput({ product_id: 1 })).toEqual({ keep: true });
    expect(parsePlanLineMemberInput({ assigned_member_id: null })).toEqual({ keep: false, memberId: null });
    expect(parsePlanLineMemberInput({ assigned_member_id: '9' })).toEqual({ keep: false, memberId: 9 });
    for (const bad of [0, -1, 1.5, true, 'x']) {
      expect(parsePlanLineMemberInput({ assigned_member_id: bad })).toHaveProperty('error');
    }
    expect(planLineKey(4, 9)).toBe('4:9');
    expect(planLineKey(4, null)).toBe('4:');
  });

  it('gives every unit of a split line to its member, whatever is stored', () => {
    expect(effectiveUnitAssignees({
      stored: [1, 2], quantity: 2, sharingType: 'individual', ownerId: 1, beneficiaryIds: [1, 2], eligibleIds: [1, 2],
      assignedMemberId: 2,
    })).toEqual([2, 2]);
  });
});

describe('billing split lines like the merged line', () => {
  it('bills two members\' periodical lines as the one line of two units', () => {
    const merged = run(assignment({ planBenefits: [line({ quantity: 2 })] }));
    const split = run(assignment({
      planBenefits: [line({ assignedMemberId: 10 }), line({ assignedMemberId: 11 })],
    }));
    expect(totalOf(split)).toBe(totalOf(merged));
    const first = productLines(split).filter((l) => l.date === START);
    expect(first.map((l) => l.assigned_member_id).sort()).toEqual([10, 11]);
  });

  it('applies each member\'s own Direct Discount to their line only', () => {
    const r = run(assignment({
      planBenefits: [line({ assignedMemberId: 10, directDiscountPercent: 50 }), line({ assignedMemberId: 11 })],
    }));
    const first = productLines(r).filter((l) => l.date === START);
    expect(first.find((l) => l.assigned_member_id === 10)?.actual_charge).toBe(10);
    expect(first.find((l) => l.assigned_member_id === 11)?.actual_charge).toBe(20);
  });

  it('covers every member\'s line with a periodical grant, as it covered the merged line', () => {
    const grant = { productId: 7, name: 'Locker', category: 'periodical' as const, billingFrequency: 'month' as const,
      unitPrice: 20, quantity: 1, benefit: { action: 'waive' as const, value: null } };
    const merged = run(assignment({ planBenefits: [line({ quantity: 2 })], promotions: [promo([grant])] }));
    const split = run(assignment({
      planBenefits: [line({ assignedMemberId: 10 }), line({ assignedMemberId: 11 })], promotions: [promo([grant])],
    }));
    expect(totalOf(split)).toBe(totalOf(merged));
  });

  it('slices a one-off grant\'s units across the members\' lines without granting them twice', () => {
    const oneoff = (over: Partial<SimulationPlanBenefit>) =>
      line({ category: 'oneoff', billingFrequency: 'once', unitPrice: 30, ...over });
    const grant = { productId: 7, name: 'Locker', category: 'oneoff' as const, billingFrequency: 'once' as const,
      unitPrice: 30, quantity: 3, benefit: { action: 'waive' as const, value: null } };
    const merged = run(assignment({ planBenefits: [oneoff({ quantity: 4 })], promotions: [promo([grant])] }));
    const split = run(assignment({
      planBenefits: [oneoff({ quantity: 2, assignedMemberId: 10 }), oneoff({ quantity: 2, assignedMemberId: 11 })],
      promotions: [promo([grant])],
    }));
    expect(totalOf(merged)).toBe(30);
    expect(totalOf(split)).toBe(30);
    const lines = productLines(split);
    expect(lines.find((l) => l.assigned_member_id === 10)?.actual_charge).toBe(0);
    expect(lines.find((l) => l.assigned_member_id === 11)?.actual_charge).toBe(30);
  });

  it('slices a session grant across the members\' renewing allowances cycle by cycle', () => {
    const session = (over: Partial<SimulationPlanBenefit>) =>
      line({ category: 'session', billingFrequency: 'per_session', unitPrice: 10, sessionFrequency: 'week', ...over });
    const grant = { productId: 7, name: 'PT', category: 'session' as const, billingFrequency: 'per_session' as const,
      unitPrice: 10, quantity: 7, benefit: { action: 'waive' as const, value: null } };
    const merged = run(assignment({ planBenefits: [session({ quantity: 2 })], promotions: [promo([grant])] }));
    const split = run(assignment({
      planBenefits: [session({ quantity: 1, assignedMemberId: 10 }), session({ quantity: 1, assignedMemberId: 11 })],
      promotions: [promo([grant])],
    }));
    expect(totalOf(split)).toBe(totalOf(merged));
    const byDate = (r: BillingSimulationResult) => {
      const m = new Map<string, number>();
      for (const l of productLines(r)) m.set(l.date, Math.round(((m.get(l.date) ?? 0) + l.actual_charge) * 100) / 100);
      return m;
    };
    expect(byDate(split)).toEqual(byDate(merged));
  });
});
