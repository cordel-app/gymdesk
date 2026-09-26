// #772 — the Assigned Membership Plan's own Personal Membership Fee Benefit.
//
// Two things need pinning, and neither needs a database (CLAUDE.md's
// unit-vs-integration rule): the normalisation of the stored pair, and what
// `resolveMembershipFee` does with it — which is the whole behavioural claim of
// the ticket, since `user_memberships` carries no CHECK for these columns and
// the benefit is applied to every cycle for the life of the assignment.

import { describe, expect, it } from 'vitest';
import {
  NO_PERSONAL_FEE_BENEFIT,
  PERSONAL_FEE_BENEFIT_ACTIONS,
  applyPersonalFeeBenefit,
  isPersonalFeeBenefitAction,
  personalFeeBenefitApplies,
  toPersonalFeeBenefit,
} from '../domain/personalFeeBenefit';
import {
  MembershipFeeContext,
  SimulationPromotion,
  resolveMembershipFee,
} from '../domain/billingSimulation';
import { toPlanDuration } from '../domain/planDuration';

const REGULAR = 40;

function promotion(over: Partial<SimulationPromotion> = {}): SimulationPromotion {
  return {
    name: 'Promo',
    appliedAt: '2026-01-01',
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

function context(over: Partial<MembershipFeeContext> = {}): MembershipFeeContext {
  return {
    startsAt: '2026-01-01',
    planDuration: toPlanDuration(0, 0, 0),
    personalFeeBenefit: NO_PERSONAL_FEE_BENEFIT,
    promotions: [],
    ...over,
  };
}

const tenPercent = { action: 'percentage_discount', value: 10 } as const;

describe('the action vocabulary', () => {
  it('offers exactly the ticket\'s two options', () => {
    expect([...PERSONAL_FEE_BENEFIT_ACTIONS]).toEqual(['no_benefit', 'percentage_discount']);
  });

  it('rejects the Promotion actions that are not on offer here', () => {
    for (const action of ['waive', 'fixed_discount', 'fixed_price', '', 'WAIVE', null, 7]) {
      expect(isPersonalFeeBenefitAction(action)).toBe(false);
    }
    expect(isPersonalFeeBenefitAction('no_benefit')).toBe(true);
    expect(isPersonalFeeBenefitAction('percentage_discount')).toBe(true);
  });
});

describe('toPersonalFeeBenefit — a stored pair the table cannot constrain', () => {
  it('reads a configured discount', () => {
    expect(toPersonalFeeBenefit('percentage_discount', '12.50')).toEqual({ action: 'percentage_discount', value: 12.5 });
  });

  it('reads the default every row carries as no benefit', () => {
    expect(toPersonalFeeBenefit('no_benefit', null)).toEqual(NO_PERSONAL_FEE_BENEFIT);
  });

  it('drops a percentage with no value rather than discounting by 0 silently', () => {
    expect(toPersonalFeeBenefit('percentage_discount', null)).toEqual(NO_PERSONAL_FEE_BENEFIT);
    expect(toPersonalFeeBenefit('percentage_discount', 'abc')).toEqual(NO_PERSONAL_FEE_BENEFIT);
  });

  it('drops an action nothing writes', () => {
    expect(toPersonalFeeBenefit('waive', 100)).toEqual(NO_PERSONAL_FEE_BENEFIT);
    expect(toPersonalFeeBenefit(null, 10)).toEqual(NO_PERSONAL_FEE_BENEFIT);
  });

  it('clamps a percentage outside 0..100, so no row can price a fee negative', () => {
    expect(toPersonalFeeBenefit('percentage_discount', 150).value).toBe(100);
    expect(toPersonalFeeBenefit('percentage_discount', -20).value).toBe(0);
  });
});

describe('applyPersonalFeeBenefit', () => {
  it('leaves the amount alone when there is no benefit', () => {
    expect(personalFeeBenefitApplies(NO_PERSONAL_FEE_BENEFIT)).toBe(false);
    expect(applyPersonalFeeBenefit(40, NO_PERSONAL_FEE_BENEFIT)).toBe(40);
    expect(applyPersonalFeeBenefit(40, null)).toBe(40);
  });

  it('discounts and rounds to cents', () => {
    expect(applyPersonalFeeBenefit(40, tenPercent)).toBe(36);
    expect(applyPersonalFeeBenefit(29.99, { action: 'percentage_discount', value: 33 })).toBe(20.09);
  });
});

describe('resolveMembershipFee — the Personal Membership Fee Benefit', () => {
  it('discounts a cycle nothing else touches', () => {
    const charge = resolveMembershipFee(REGULAR, '2026-06-01', context({ personalFeeBenefit: tenPercent }));
    expect(charge.amount).toBe(36);
    expect(charge.benefits).toEqual([
      { source: 'personal', name: null, action: 'percentage_discount', value: 10, period_status: null },
    ]);
  });

  it('does not make the cycle promotional — it is this contract\'s regular charge', () => {
    // The `promotional` flag is the projection's horizon (#629 §6). A benefit
    // that never ends would push it to MAX_SIMULATION_MONTHS for every
    // discounted assignment if it set the flag.
    const charge = resolveMembershipFee(REGULAR, '2026-06-01', context({ personalFeeBenefit: tenPercent }));
    expect(charge.promotional).toBe(false);
  });

  it('applies on top of an applied Promotion\'s Membership Fee Benefit, not instead of it', () => {
    const charge = resolveMembershipFee(REGULAR, '2026-02-01', context({
      personalFeeBenefit: tenPercent,
      promotions: [promotion({
        paidMonths: 6,
        membershipFeeBenefits: [{ enabled: true, action: 'percentage_discount', value: 50, durationMonths: null }],
      })],
    }));
    // 40 → 20 (the Promotion) → 18 (the personal 10%).
    expect(charge.amount).toBe(18);
    expect(charge.benefits.map((b) => b.source)).toEqual(['promotion', 'personal']);
    expect(charge.promotional).toBe(true);
  });

  it('survives the Promotion it stacked with — the point of the ticket', () => {
    const withPromotion = context({
      personalFeeBenefit: tenPercent,
      promotions: [promotion({
        paidMonths: 2,
        membershipFeeBenefits: [{ enabled: true, action: 'percentage_discount', value: 50, durationMonths: null }],
      })],
    });
    // Inside the Promotion's timeline.
    expect(resolveMembershipFee(REGULAR, '2026-02-01', withPromotion).amount).toBe(18);
    // After it: the Promotion stops discounting, the personal benefit does not.
    const after = resolveMembershipFee(REGULAR, '2026-09-01', withPromotion);
    expect(after.amount).toBe(36);
    expect(after.benefits.map((b) => b.source)).toEqual(['personal']);
  });

  it('changes nothing in a cycle the fee is already waived', () => {
    // 10% of nothing is nothing — a free month stays free, and the waiver is
    // still the benefit that explains the €0 (`periodStatus` reads off it).
    const charge = resolveMembershipFee(REGULAR, '2026-01-15', context({
      personalFeeBenefit: tenPercent,
      planDuration: toPlanDuration(1, 12, 0),
    }));
    expect(charge.amount).toBe(0);
    expect(charge.benefits.map((b) => b.source)).toEqual(['membership_plan', 'personal']);
    expect(charge.benefits.find((b) => b.action === 'waive')?.period_status).toBe('free_plan');
  });

  it('discounts the Paid Duration of the Plan\'s own Billing & Duration', () => {
    const charge = resolveMembershipFee(REGULAR, '2026-03-01', context({
      personalFeeBenefit: tenPercent,
      planDuration: toPlanDuration(1, 12, 0),
    }));
    expect(charge.amount).toBe(36);
  });

  it('a 100% discount prices the cycle at zero without claiming a period waived it', () => {
    const charge = resolveMembershipFee(REGULAR, '2026-06-01', context({
      personalFeeBenefit: { action: 'percentage_discount', value: 100 },
    }));
    expect(charge.amount).toBe(0);
    expect(charge.benefits.some((b) => b.action === 'waive')).toBe(false);
  });
});
