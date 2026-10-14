import { describe, expect, it } from 'vitest';
import { cancellationEndDate, paidPeriodEnd, paidThroughDate } from '../domain/cancellationEntitlement';

const month = { interval: 1, unit: 'month' as const };

describe('paid-through date (#1196)', () => {
  it('uses the stored period end when the event has one', () => {
    expect(paidPeriodEnd({ periodStart: '2026-10-01', periodEnd: '2026-10-28' }, month)).toBe('2026-10-28');
  });

  it('closes a period with no stored end by the schedule cadence', () => {
    expect(paidPeriodEnd({ periodStart: '2026-10-01', periodEnd: null }, month)).toBe('2026-10-31');
  });

  it('invents nothing when neither a stored end nor a cadence exists', () => {
    expect(paidPeriodEnd({ periodStart: '2026-10-01', periodEnd: null }, null)).toBeNull();
    expect(paidThroughDate([{ periodStart: '2026-10-01', periodEnd: null }], null)).toBeNull();
  });

  it('takes the latest paid period and null when nothing was paid', () => {
    expect(paidThroughDate([
      { periodStart: '2026-09-01', periodEnd: '2026-09-30' },
      { periodStart: '2026-10-01', periodEnd: '2026-10-31' },
    ], month)).toBe('2026-10-31');
    expect(paidThroughDate([], month)).toBeNull();
  });
});

describe('cancellation end date (#1196)', () => {
  const base = { today: '2026-10-13', assignmentStart: '2026-01-01' };

  it('keeps access to the end of a paid period still running', () => {
    expect(cancellationEndDate({ ...base, paidThrough: '2026-10-31' })).toBe('2026-10-31');
  });

  it('ends access now when the paid period is over or nothing was paid', () => {
    expect(cancellationEndDate({ ...base, paidThrough: '2026-09-30' })).toBe('2026-10-12');
    expect(cancellationEndDate({ ...base, paidThrough: null })).toBe('2026-10-12');
  });

  it('never ends before the plan began', () => {
    expect(cancellationEndDate({ today: '2026-10-13', assignmentStart: '2026-10-13', paidThrough: null })).toBe('2026-10-13');
  });
});
