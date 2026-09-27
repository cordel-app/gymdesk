// Unit tests for domain/assignedPlanBillingEvents.ts — pure functions, no DB
// dependency (#511 stage 3). See CLAUDE.md's unit-vs-integration test
// guidance: no createTestGym, no cleanupTestGyms, no db.end().

import { describe, expect, it } from 'vitest';
import {
  addCalendarMonths,
  computeRangeEnd,
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

describe('selectPersistedBillingEventsInRange (#511 Q2)', () => {
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
