import { describe, expect, it } from 'vitest';
import {
  MembershipFeeContext,
  SimulationPromotion,
  resolveMembershipFee,
} from '../domain/billingSimulation';
import { NO_PERSONAL_FEE_BENEFIT } from '../domain/personalFeeBenefit';
import { toPlanDuration } from '../domain/planDuration';
import { computeMembershipFeePriceAt } from '../domain/assignedPlanBillingEvents';
import { promotionTimelineEndsOn } from '../domain/promotionTimeline';
import { computeUpcomingPayments } from '../api/me';

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
    personalFeeBenefit: NO_PERSONAL_FEE_BENEFIT,
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

/**
 * #635 stage 12 — one rule, every path.
 *
 * The stage's premise was that three code paths answered different prices for
 * the same cycle: `final_price` (what the nightly run charged) and the Billing
 * Events projection both discounted for ever, while the Billing Simulation and My
 * Membership stopped the benefit at the end of the Promotion's own timeline. The
 * thread chose the timeline — answer (a) — so these cases pin the chosen rule and
 * then assert that the paths which can be exercised purely agree on it, cycle by
 * cycle. The DB-backed ones (apply/revoke, `POST /billing/run`) are pinned
 * against the same numbers in `billing-run-date-aware-fee.test.ts`.
 */
describe('#635 stage 12 — a Promotion\'s Membership Fee Benefit ends with its timeline', () => {
  // The thread's table, row 1: applied 2026-01-01, Paid Duration 3, "20% off",
  // the benefit itself carrying no duration.
  const boundedTo3Months = promotion({
    paidMonths: 3,
    membershipFeeBenefits: [{ action: 'percentage_discount', value: 20, enabled: true, durationMonths: null }],
  });

  it('discounts the promotional months and charges the regular fee afterwards', () => {
    const at = (date: string) => resolveMembershipFee(REGULAR, date, context({ promotions: [boundedTo3Months] }));
    expect(at('2026-01-01').amount).toBe(32);
    expect(at('2026-02-01').amount).toBe(32);
    expect(at('2026-03-01').amount).toBe(32);
    // The fourth cycle is the first regular one — the Promotion is over.
    expect(at('2026-04-01').amount).toBe(REGULAR);
    expect(at('2026-04-01').benefits).toEqual([]);
  });

  // The thread's table, row 2. Left to itself an application that stands for ever
  // would discount for ever, which is exactly what a stored `final_price` did.
  it('never applies the benefit of a Promotion configured with no Free/Paid/Bonus months', () => {
    const unbounded = promotion({
      membershipFeeBenefits: [{ action: 'percentage_discount', value: 20, enabled: true, durationMonths: null }],
    });
    const charge = resolveMembershipFee(REGULAR, '2026-06-01', context({ promotions: [unbounded] }));
    expect(charge.amount).toBe(REGULAR);
    expect(charge.benefits).toEqual([]);
  });

  it('caps a benefit whose own Duration outlasts the Promotion at the Promotion', () => {
    const overlong = promotion({
      paidMonths: 2,
      membershipFeeBenefits: [{ action: 'waive', value: null, enabled: true, durationMonths: 24 }],
    });
    expect(resolveMembershipFee(REGULAR, '2026-02-01', context({ promotions: [overlong] })).amount).toBe(0);
    expect(resolveMembershipFee(REGULAR, '2026-03-01', context({ promotions: [overlong] })).amount).toBe(REGULAR);
  });

  it('reports the same end date as the timeline the report shows staff', () => {
    expect(promotionTimelineEndsOn({
      freeMonths: 0, paidMonths: 3, payBeforehandMonths: 0, bonusMonths: 0,
    }, '2026-01-01')).toBe('2026-03-31');
    // No months — no promotional window, so there is nothing to end and the
    // benefit never applies.
    expect(promotionTimelineEndsOn({
      freeMonths: 0, paidMonths: 0, payBeforehandMonths: 0, bonusMonths: 0,
    }, '2026-01-01')).toBe(null);
  });

  it('prices every cycle identically in the simulation, the Billing Events projection and My Membership', () => {
    const ctx = context({
      planDuration: toPlanDuration(1, 12, 1),
      promotions: [boundedTo3Months],
    });
    const dates = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-12-01', '2027-02-01'];

    const simulated = dates.map((d) => resolveMembershipFee(REGULAR, d, ctx).amount);
    const projected = dates.map((d) => computeMembershipFeePriceAt(REGULAR, d, ctx.promotions, {
      startsAt: ctx.startsAt, planDuration: ctx.planDuration,
    }).price);
    expect(projected).toEqual(simulated);

    // My Membership's next two charges, resolved on their own dates: the last
    // promotional cycle and then the first regular one. `computeUpcomingPayments`
    // only ever reports dates in the future, so this leg anchors far enough ahead
    // to stay one regardless of when the suite runs.
    const future = context({
      startsAt: '2099-01-01',
      promotions: [promotion({
        appliedAt: '2099-01-01',
        paidMonths: 2,
        membershipFeeBenefits: [{ action: 'percentage_discount', value: 20, enabled: true, durationMonths: null }],
      })],
    });
    const upcoming = computeUpcomingPayments(
      '2099-02-01', 1, 'month',
      (date) => resolveMembershipFee(REGULAR, date, future).amount,
    );
    expect(upcoming.map((p) => `${p.date}:${p.amount}`)).toEqual(['2099-02-01:32.00', '2099-03-01:40.00']);
    // …and the same numbers the other two paths give for those dates.
    expect(upcoming.map((p) => Number(p.amount))).toEqual(
      ['2099-02-01', '2099-03-01'].map((d) => computeMembershipFeePriceAt(REGULAR, d, future.promotions, {
        startsAt: future.startsAt, planDuration: future.planDuration,
      }).price),
    );
  });

  it('still lets the assignment\'s own Free Period waive a cycle no Promotion governs', () => {
    const ctx = context({
      startsAt: '2026-01-01',
      planDuration: toPlanDuration(1, 12, 0),
      // Revoked before the Plan's free month would be billed, so the Promotion
      // no longer governs the date and the contract's own period decides it.
      promotions: [promotion({ paidMonths: 3, appliedAt: '2026-01-01', revokedAt: '2026-01-05' })],
    });
    const charge = resolveMembershipFee(REGULAR, '2026-01-20', ctx);
    expect(charge.amount).toBe(0);
    expect(charge.benefits[0]).toMatchObject({ source: 'membership_plan', period_status: 'free_plan' });
    expect(computeMembershipFeePriceAt(REGULAR, '2026-01-20', ctx.promotions, {
      startsAt: ctx.startsAt, planDuration: ctx.planDuration,
    })).toEqual({ price: 0, promotionAffected: false });
  });
});
