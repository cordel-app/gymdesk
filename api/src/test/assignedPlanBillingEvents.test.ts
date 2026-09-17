// Unit tests for domain/assignedPlanBillingEvents.ts — pure functions, no DB
// dependency (#511 stage 3). See CLAUDE.md's unit-vs-integration test
// guidance: no createTestGym, no cleanupTestGyms, no db.end().

import { describe, expect, it } from 'vitest';
import {
  AppliedPromotionForBilling,
  addCalendarMonths,
  computeMembershipFeePriceAt,
  computeRangeEnd,
  projectDraftBillingEvents,
  promotionCoversDate,
  selectPersistedBillingEventsInRange,
} from '../domain/assignedPlanBillingEvents';

describe('addCalendarMonths', () => {
  it('adds whole calendar months', () => {
    expect(addCalendarMonths('2026-01-15', 2)).toBe('2026-03-15');
  });

  it('rolls over into the next year', () => {
    expect(addCalendarMonths('2026-11-01', 3)).toBe('2027-02-01');
  });
});

describe('promotionCoversDate', () => {
  it('covers a date on or after appliedAt with no revokedAt (still applied)', () => {
    const w = { appliedAt: '2026-01-01', revokedAt: null };
    expect(promotionCoversDate(w, '2026-01-01')).toBe(true);
    expect(promotionCoversDate(w, '2027-01-01')).toBe(true);
  });

  it('does not cover a date before appliedAt', () => {
    expect(promotionCoversDate({ appliedAt: '2026-03-01', revokedAt: null }, '2026-02-01')).toBe(false);
  });

  it('does not cover a date after revokedAt', () => {
    const w = { appliedAt: '2026-01-01', revokedAt: '2026-02-01' };
    expect(promotionCoversDate(w, '2026-02-01')).toBe(true);
    expect(promotionCoversDate(w, '2026-02-02')).toBe(false);
  });
});

describe('computeRangeEnd (#511 Q2)', () => {
  it('extends 2 calendar months from the billing start when there are no promotion-affected dates', () => {
    expect(computeRangeEnd([], '2026-01-01', null)).toBe('2026-03-01');
  });

  it('extends 2 calendar months from the latest promotion-affected date', () => {
    expect(computeRangeEnd(['2026-04-01', '2026-02-01'], '2026-01-01', null)).toBe('2026-06-01');
  });

  it('clamps to endsAt when the plan ends before the full range', () => {
    expect(computeRangeEnd([], '2026-01-01', '2026-01-20')).toBe('2026-01-20');
  });

  it('does not clamp when endsAt is after the computed range', () => {
    expect(computeRangeEnd([], '2026-01-01', '2026-12-31')).toBe('2026-03-01');
  });
});

describe('computeMembershipFeePriceAt', () => {
  const chargeBenefitPromo: AppliedPromotionForBilling = {
    appliedAt: '2026-01-01',
    revokedAt: null,
    membershipFeeBenefits: [{ kind: 'charge', action: 'percentage_discount', value: 50 }],
  };

  it('returns the base price unaffected when no promotion covers the date', () => {
    const { price, promotionAffected } = computeMembershipFeePriceAt(40, '2025-12-01', [chargeBenefitPromo]);
    expect(price).toBe(40);
    expect(promotionAffected).toBe(false);
  });

  it('applies a charge benefit for as long as the promotion is applied', () => {
    const { price, promotionAffected } = computeMembershipFeePriceAt(40, '2026-06-01', [chargeBenefitPromo]);
    expect(price).toBe(20);
    expect(promotionAffected).toBe(true);
  });

  it('expires a period benefit after its duration_months window from appliedAt', () => {
    const promo: AppliedPromotionForBilling = {
      appliedAt: '2026-01-01',
      revokedAt: null,
      membershipFeeBenefits: [{ kind: 'period', action: 'fixed_discount', value: 10, enabled: true, durationMonths: 3 }],
    };
    const inside = computeMembershipFeePriceAt(40, '2026-03-01', [promo]);
    expect(inside.price).toBe(30);
    expect(inside.promotionAffected).toBe(true);

    const after = computeMembershipFeePriceAt(40, '2026-04-01', [promo]);
    expect(after.price).toBe(40);
    expect(after.promotionAffected).toBe(false);
  });

  it('ignores a disabled period benefit', () => {
    const promo: AppliedPromotionForBilling = {
      appliedAt: '2026-01-01',
      revokedAt: null,
      membershipFeeBenefits: [{ kind: 'period', action: 'waive', value: null, enabled: false, durationMonths: null }],
    };
    const { price, promotionAffected } = computeMembershipFeePriceAt(40, '2026-02-01', [promo]);
    expect(price).toBe(40);
    expect(promotionAffected).toBe(false);
  });

  it('stacks multiple applied promotions', () => {
    const promoA: AppliedPromotionForBilling = {
      appliedAt: '2026-01-01', revokedAt: null,
      membershipFeeBenefits: [{ kind: 'charge', action: 'fixed_discount', value: 5 }],
    };
    const promoB: AppliedPromotionForBilling = {
      appliedAt: '2026-01-01', revokedAt: null,
      membershipFeeBenefits: [{ kind: 'charge', action: 'fixed_discount', value: 3 }],
    };
    const { price } = computeMembershipFeePriceAt(40, '2026-02-01', [promoA, promoB]);
    expect(price).toBe(32);
  });
});

describe('projectDraftBillingEvents (#511 Q2 — draft preview)', () => {
  it('reports unavailable without a recurring billing frequency', () => {
    const result = projectDraftBillingEvents({
      billingStart: '2026-01-01', endsAt: null, basePrice: 40,
      recurringInterval: null, recurringUnit: null, promotions: [],
    });
    expect(result.available).toBe(false);
    expect(result.events).toEqual([]);
  });

  it('covers the next 2 calendar months from the billing start with no promotions', () => {
    const result = projectDraftBillingEvents({
      billingStart: '2026-01-01', endsAt: null, basePrice: 40,
      recurringInterval: 1, recurringUnit: 'month', promotions: [],
    });
    expect(result.available).toBe(true);
    expect(result.projected).toBe(true);
    expect(result.range_start).toBe('2026-01-01');
    expect(result.range_end).toBe('2026-03-01');
    expect(result.events.map((e) => e.date)).toEqual(['2026-02-01', '2026-03-01']);
    expect(result.events.every((e) => e.amount === 40 && !e.promotion_affected)).toBe(true);
  });

  it('extends the range 2 months past the last event affected by a finite-duration promotion', () => {
    const promo: AppliedPromotionForBilling = {
      appliedAt: '2026-01-01', revokedAt: null,
      membershipFeeBenefits: [{ kind: 'period', action: 'fixed_discount', value: 10, enabled: true, durationMonths: 2 }],
    };
    const result = projectDraftBillingEvents({
      billingStart: '2026-01-01', endsAt: null, basePrice: 40,
      recurringInterval: 1, recurringUnit: 'month', promotions: [promo],
    });
    // Promotion covers 2026-02-01 (< 2026-03-01 expiry) but not 2026-03-01 onward.
    expect(result.range_end).toBe('2026-04-01');
    expect(result.events.map((e) => e.date)).toEqual(['2026-02-01', '2026-03-01', '2026-04-01']);
    expect(result.events[0]).toMatchObject({ amount: 30, promotion_affected: true });
    expect(result.events[1]).toMatchObject({ amount: 40, promotion_affected: false });
    expect(result.events[2]).toMatchObject({ amount: 40, promotion_affected: false });
  });

  it('caps an indefinite (no duration_months, never revoked) promotion at the projection safety horizon', () => {
    const promo: AppliedPromotionForBilling = {
      appliedAt: '2026-01-01', revokedAt: null,
      membershipFeeBenefits: [{ kind: 'charge', action: 'waive', value: null }],
    };
    const result = projectDraftBillingEvents({
      billingStart: '2026-01-01', endsAt: null, basePrice: 40,
      recurringInterval: 1, recurringUnit: 'month', promotions: [promo],
    });
    // Every cycle is promotion-affected, so the "2 months after the last one"
    // boundary keeps advancing forever — bounded by the 36-month safety cap:
    // exactly 36 monthly cycles are generated (2026-02-01 .. 2029-01-01),
    // with range_end 2 months past the last one.
    expect(result.events).toHaveLength(36);
    expect(result.events[result.events.length - 1].date).toBe('2029-01-01');
    expect(result.range_end).toBe('2029-03-01');
    expect(result.events.every((e) => e.promotion_affected && e.amount === 0)).toBe(true);
  });

  it('returns fewer events when the plan ends before the full range', () => {
    const result = projectDraftBillingEvents({
      billingStart: '2026-01-01', endsAt: '2026-01-25', basePrice: 40,
      recurringInterval: 1, recurringUnit: 'month', promotions: [],
    });
    expect(result.events).toEqual([]);
    expect(result.range_end).toBe('2026-01-25');
  });
});

describe('selectPersistedBillingEventsInRange (#511 Q2 — submitted plans)', () => {
  it('tags events that fall inside an applied-promotion window and orders chronologically', () => {
    const result = selectPersistedBillingEventsInRange({
      billingStart: '2026-01-01',
      endsAt: null,
      promotionWindows: [{ appliedAt: '2026-02-01', revokedAt: '2026-02-15' }],
      events: [
        { id: 3, date: '2026-03-01' },
        { id: 1, date: '2026-01-01' },
        { id: 2, date: '2026-02-10' },
      ],
    });
    expect(result.projected).toBe(false);
    expect(result.events.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(result.events.find((e) => e.id === 2)!.promotion_affected).toBe(true);
    expect(result.events.find((e) => e.id === 1)!.promotion_affected).toBe(false);
  });

  it('extends the range 2 months past the last promotion-affected event and excludes later unaffected events outside it', () => {
    const result = selectPersistedBillingEventsInRange({
      billingStart: '2026-01-01',
      endsAt: null,
      promotionWindows: [{ appliedAt: '2026-01-01', revokedAt: '2026-01-01' }],
      events: [
        { id: 1, date: '2026-01-01' },  // promotion-affected -> range_end = 2026-03-01
        { id: 2, date: '2026-02-15' },  // inside range
        { id: 3, date: '2026-04-01' },  // outside range
      ],
    });
    expect(result.range_end).toBe('2026-03-01');
    expect(result.events.map((e) => e.id)).toEqual([1, 2]);
  });

  it('falls back to 2 months after the billing start when no promotions ever applied', () => {
    const result = selectPersistedBillingEventsInRange({
      billingStart: '2026-01-01',
      endsAt: null,
      promotionWindows: [],
      events: [
        { id: 1, date: '2026-01-15' },
        { id: 2, date: '2026-04-01' },
      ],
    });
    expect(result.range_end).toBe('2026-03-01');
    expect(result.events.map((e) => e.id)).toEqual([1]);
  });

  it('clamps the range to endsAt', () => {
    const result = selectPersistedBillingEventsInRange({
      billingStart: '2026-01-01',
      endsAt: '2026-01-10',
      promotionWindows: [],
      events: [{ id: 1, date: '2026-01-05' }, { id: 2, date: '2026-01-20' }],
    });
    expect(result.range_end).toBe('2026-01-10');
    expect(result.events.map((e) => e.id)).toEqual([1]);
  });

  it('preserves the original event fields untouched (historical values)', () => {
    const result = selectPersistedBillingEventsInRange({
      billingStart: '2026-01-01',
      endsAt: null,
      promotionWindows: [],
      events: [{ id: 1, date: '2026-01-05', amount: 29.99, event_type: 'recurring_payment' }],
    });
    expect(result.events[0]).toMatchObject({ id: 1, amount: 29.99, event_type: 'recurring_payment' });
  });
});
