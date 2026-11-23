// #3165 stage 2 — an ad-hoc recurring Product follows its own frequency calendar, never the
// Membership Plan's billing date; the Initial Payment states the proration it applied.
import { describe, expect, it } from 'vitest';
import { allocateSchedule, billsOnOwnCalendar, PLAN_SCHEDULE_KEY, type ExistingSchedule } from '../domain/scheduleAllocation';
import { initialPaymentBreakdown, lineProration } from '../domain/checkoutSummary';

const MONTH = { interval: 1, unit: 'month' as const };
const sched = (key: string, anchorDate: string, cadence = MONTH as ExistingSchedule['cadence']): ExistingSchedule =>
  ({ id: key === PLAN_SCHEDULE_KEY ? 1 : 2, key, anchorDate, cadence });

describe('allocateSchedule with ownCalendar (#3165 stage 2)', () => {
  it('does not join a monthly plan schedule anchored on the 7th: opens one on the 1st', () => {
    const a = allocateSchedule({ cadence: MONTH, purchaseDate: '2026-11-22', schedules: [sched('plan', '2026-10-07')], ownCalendar: true });
    expect(a).toMatchObject({ kind: 'new', anchorDate: '2026-11-01' });
  });

  it('joins a monthly plan schedule that bills on the 1st', () => {
    expect(allocateSchedule({ cadence: MONTH, purchaseDate: '2026-11-22', schedules: [sched('plan', '2026-10-01')], ownCalendar: true }).kind)
      .toBe('plan');
  });

  it('a plan\'s own lines keep joining the plan schedule whatever its anchor (unchanged rule)', () => {
    expect(allocateSchedule({ cadence: MONTH, purchaseDate: '2026-11-22', schedules: [sched('plan', '2026-10-07')] }).kind).toBe('plan');
  });

  it('4 weeks joins only a schedule on the 2026-11-02 grid', () => {
    const fw = { interval: 4, unit: 'week' as const };
    expect(billsOnOwnCalendar(sched('s1', '2026-11-30', fw), fw, '2026-12-05')).toBe(true);
    expect(billsOnOwnCalendar(sched('s1', '2026-11-10', fw), fw, '2026-12-05')).toBe(false);
  });

  it('yearly joins only a schedule on the purchase date\'s own anniversary', () => {
    const y = { interval: 1, unit: 'year' as const };
    expect(billsOnOwnCalendar(sched('plan', '2025-11-22', y), y, '2026-11-22')).toBe(true);
    expect(allocateSchedule({ cadence: y, purchaseDate: '2026-11-22', schedules: [sched('plan', '2026-03-07', y)], ownCalendar: true }))
      .toMatchObject({ kind: 'new', anchorDate: '2026-11-22' });
  });
});

describe('Initial Payment proration label (#3165 stage 2)', () => {
  it('states a partial first period, never a full one or a split Membership Fee', () => {
    expect(lineProration({ prorated_days: 9, period_days: 30 })).toEqual({ days: 9, period_days: 30 });
    expect(lineProration({ prorated_days: 30, period_days: 30 })).toBeNull();
    expect(lineProration({ prorated_days: null, period_days: null })).toBeNull();
    expect(lineProration({ prorated_days: 9, period_days: 30, fee_split: {} as any })).toBeNull();
  });

  it('carries it on the breakdown line', () => {
    const b = initialPaymentBreakdown([{
      item_name: 'Locker Rental', quantity: 1, amount: 9, regular_unit_price: 9, promotion_name: null,
      treatment_action: null, treatment_value: null, tax_rate_percent: null, amount_excl_tax: null,
      prorated_days: 9, period_days: 30,
    }], 9);
    expect(b.lines[0].proration).toEqual({ days: 9, period_days: 30 });
  });
});
