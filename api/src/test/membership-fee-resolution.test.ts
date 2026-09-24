import { describe, expect, it } from 'vitest';
import {
  MembershipFeeContext,
  SimulationPromotion,
  resolveMembershipFee,
} from '../domain/billingSimulation';
import { toPlanDuration } from '../domain/planDuration';

/**
 * #635 stage 11 — the Membership Fee owed on one date.
 *
 * `resolveMembershipFee` was internal to the Billing Simulation engine until
 * the nightly run started pricing each cycle through it, so these cases pin the
 * contract the run now depends on: which period waives the fee, which one
 * merely reports it, and the precedence between the Plan's own Billing &
 * Duration and an applied Promotion's timeline (the thread's Q2 answer — "in
 * case of conflict, prioritize the promotion").
 *
 * Pure: no DB, no HTTP, no `createTestGym` (CLAUDE.md's unit-test rules).
 */

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
    promotions: [],
    ...over,
  };
}

describe('resolveMembershipFee — the Plan\'s own Billing & Duration', () => {
  it('charges the regular fee when nothing is configured', () => {
    const charge = resolveMembershipFee(REGULAR, '2026-03-01', context());
    expect(charge.amount).toBe(REGULAR);
    expect(charge.benefits).toEqual([]);
    expect(charge.promotional).toBe(false);
  });

  it('waives the fee inside the Free Period, naming the period on the benefit', () => {
    const charge = resolveMembershipFee(REGULAR, '2026-01-15', context({
      planDuration: toPlanDuration(1, 2, 0),
    }));
    expect(charge.amount).toBe(0);
    expect(charge.benefits).toEqual([
      { source: 'membership_plan', name: null, action: 'waive', value: null, period_status: 'free_plan' },
    ]);
  });

  it('charges the regular fee inside the Paid Duration', () => {
    const charge = resolveMembershipFee(REGULAR, '2026-02-15', context({
      planDuration: toPlanDuration(1, 2, 0),
    }));
    expect(charge.amount).toBe(REGULAR);
    expect(charge.benefits).toEqual([]);
  });

  it('waives the fee inside the Bonus Duration', () => {
    const charge = resolveMembershipFee(REGULAR, '2026-04-15', context({
      planDuration: toPlanDuration(1, 2, 2),
    }));
    expect(charge.amount).toBe(0);
    expect(charge.benefits[0].period_status).toBe('bonus_plan');
  });

  it('charges the regular fee once every configured period has run out', () => {
    const charge = resolveMembershipFee(REGULAR, '2026-07-01', context({
      planDuration: toPlanDuration(1, 2, 2),
    }));
    expect(charge.amount).toBe(REGULAR);
  });

  // The periods are counted from the assignment's own start date, so a date
  // before it belongs to no period at all.
  it('charges the regular fee for a date before the assignment starts', () => {
    const charge = resolveMembershipFee(REGULAR, '2025-12-01', context({
      planDuration: toPlanDuration(1, 0, 0),
    }));
    expect(charge.amount).toBe(REGULAR);
  });
});

describe('resolveMembershipFee — an applied Promotion outranks the Plan', () => {
  it('waives the fee in the Promotion\'s own free month', () => {
    const charge = resolveMembershipFee(REGULAR, '2026-01-15', context({
      promotions: [promotion({ freeMonths: 1, paidMonths: 3 })],
    }));
    expect(charge.amount).toBe(0);
    expect(charge.benefits[0]).toMatchObject({ source: 'promotion', period_status: 'free_promotion' });
  });

  // The Q2 answer, in the direction that actually costs money: the Plan's Free
  // Period must NOT waive a month the Promotion charges for.
  it('charges the Promotion\'s paid month even where the Plan\'s Free Period covers it', () => {
    const charge = resolveMembershipFee(REGULAR, '2026-01-15', context({
      planDuration: toPlanDuration(6, 0, 0),
      promotions: [promotion({ paidMonths: 3 })],
    }));
    expect(charge.amount).toBe(REGULAR);
    expect(charge.benefits.every((b) => b.source === 'promotion')).toBe(true);
  });

  // A Membership Fee Benefit applies inside the Promotion's *paid* months —
  // the free and bonus ones already cost nothing, and #625 caps the benefit at
  // the Promotion's own duration so it can never reach the regular period.
  it('applies the Promotion\'s Membership Fee Benefit inside a paid promotional month', () => {
    const charge = resolveMembershipFee(REGULAR, '2026-02-01', context({
      promotions: [promotion({
        paidMonths: 3,
        membershipFeeBenefits: [{ action: 'fixed_discount', value: 15, enabled: true, durationMonths: 3 }],
      })],
    }));
    expect(charge.amount).toBe(25);
    expect(charge.benefits[0]).toMatchObject({ source: 'promotion', action: 'fixed_discount', value: 15 });
  });

  // §16, and why `final_price` — one number with no date attached — cannot be
  // the whole answer: the benefit stops once the Promotion's own months are up.
  it('stops applying the benefit once the Promotion\'s months have run out', () => {
    const charge = resolveMembershipFee(REGULAR, '2026-05-01', context({
      promotions: [promotion({
        paidMonths: 3,
        membershipFeeBenefits: [{ action: 'fixed_discount', value: 15, enabled: true, durationMonths: 3 }],
      })],
    }));
    expect(charge.amount).toBe(REGULAR);
    expect(charge.benefits).toEqual([]);
  });

  it('ignores a Promotion for a date outside its application window', () => {
    const charge = resolveMembershipFee(REGULAR, '2026-06-01', context({
      promotions: [promotion({
        freeMonths: 12,
        appliedAt: '2026-01-01',
        revokedAt: '2026-03-01',
      })],
    }));
    expect(charge.amount).toBe(REGULAR);
  });
});
