// #2834 — the Membership Fee scope's pure rules and the engine's one multiplication.
import { describe, expect, it } from 'vitest';
import {
  membershipFeeUnits, parseMembershipFeeScopeInput, toMembershipFeeScope,
} from '../domain/membershipFeeScope';
import { computeBillingSimulation, type SimulationAssignment } from '../domain/billingSimulation';
import { toPlanDuration } from '../domain/planDuration';
import { NO_PERSONAL_FEE_BENEFIT } from '../domain/personalFeeBenefit';

describe('membershipFeeUnits', () => {
  it('per_family is one fee whatever the beneficiaries', () => {
    expect(membershipFeeUnits('per_family', 0)).toBe(1);
    expect(membershipFeeUnits('per_family', 3)).toBe(1);
  });
  it('per_member is one fee per beneficiary, never fewer than one', () => {
    expect(membershipFeeUnits('per_member', 0)).toBe(1);
    expect(membershipFeeUnits('per_member', 1)).toBe(1);
    expect(membershipFeeUnits('per_member', 3)).toBe(3);
  });
});

describe('parseMembershipFeeScopeInput', () => {
  it('absent keeps, a known value sets, anything else is an error', () => {
    expect(parseMembershipFeeScopeInput({})).toEqual({ kind: 'absent' });
    expect(parseMembershipFeeScopeInput({ membership_fee_scope: 'per_member' }))
      .toEqual({ kind: 'value', value: 'per_member' });
    expect(parseMembershipFeeScopeInput({ membership_fee_scope: null }).kind).toBe('error');
    expect(parseMembershipFeeScopeInput({ membership_fee_scope: 'PER_MEMBER' }).kind).toBe('error');
  });
  it('an unknown stored value reads as per_family', () => {
    expect(toMembershipFeeScope('x')).toBe('per_family');
    expect(toMembershipFeeScope(null)).toBe('per_family');
  });
});

function assignment(units: number, personalPercent = 0, over: Partial<SimulationAssignment> = {}): SimulationAssignment {
  return {
    userMembershipId: 1, planName: 'Family', startsAt: '2027-01-01', endsAt: null,
    membershipFeePrice: 40, recurringInterval: 1, recurringUnit: 'month',
    promotions: [], services: [], planBenefits: [],
    planDuration: toPlanDuration(null, null, null, null, { interval: 1, unit: 'month' }, false),
    personalFeeBenefit: personalPercent > 0
      ? { action: 'percentage_discount', value: personalPercent } : NO_PERSONAL_FEE_BENEFIT,
    membershipFeeUnits: units,
    ...over,
  };
}

function firstFee(a: SimulationAssignment) {
  const result = computeBillingSimulation({ assignments: [a] });
  const lines = result.sections.flatMap((s) => s.events).flatMap((e) => e.lines)
    .filter((l) => l.kind === 'membership_fee');
  return lines[0];
}

describe('the engine multiplies the Membership Fee line by its units', () => {
  it('one unit is the fee as before', () => {
    const line = firstFee(assignment(1));
    expect(line.actual_charge).toBe(40);
    expect(line.quantity).toBe(1);
  });
  it('three units charge three fees, the unit price unchanged', () => {
    const line = firstFee(assignment(3));
    expect(line.actual_charge).toBe(120);
    expect(line.quantity).toBe(3);
    expect(line.unit_price).toBe(40);
    expect(line.regular_price).toBe(120);
  });
  it('a discount applies to each fee (25% off 40 × 2 = 60)', () => {
    expect(firstFee(assignment(2, 25)).actual_charge).toBe(60);
  });
});

// #2883 — a Pre-paid Duration collected up front: the fee quantity and the prepaid periods are two
// different numbers, and the line carries the cadence the periods are counted in.
describe('a prepaid Membership Fee keeps the fee count apart from the periods it covers', () => {
  const prepaid = (units: number, interval: number, unit: string) => assignment(units, 0, {
    membershipFeePrice: 70, recurringInterval: interval, recurringUnit: unit,
    planDuration: toPlanDuration(0, 2, 0, 2, { interval, unit } as any, false),
  });

  it('a per-family plan with 2 prepaid months: one fee of €140 covering 2 months', () => {
    const line = firstFee(prepaid(1, 1, 'month'));
    expect(line).toMatchObject({
      quantity: 1, unit_price: 140, regular_price: 140, actual_charge: 140,
      prepaid_periods: 2, prepaid_cadence: { interval: 1, unit: 'month' },
    });
  });

  it('a per-member plan for two: two fees, each covering the same 2 months', () => {
    const line = firstFee(prepaid(2, 1, 'month'));
    expect(line).toMatchObject({
      quantity: 2, unit_price: 140, regular_price: 280, actual_charge: 280, prepaid_periods: 2,
    });
  });

  it('a 4-weekly plan reports its own cadence', () => {
    const line = firstFee(prepaid(1, 4, 'week'));
    expect(line.prepaid_cadence).toEqual({ interval: 4, unit: 'week' });
    expect(line.prepaid_periods).toBe(2);
  });

  it('an ordinary cycle carries no prepaid label data', () => {
    const line = firstFee(assignment(1));
    expect(line.prepaid_periods).toBeNull();
    expect(line.prepaid_cadence).toBeNull();
  });
});
