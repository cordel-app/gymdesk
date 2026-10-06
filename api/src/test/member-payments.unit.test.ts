// #1123 — `apps/member/src/lib/memberPayments.ts`, the Members App's Payments
// card decisions: which rows belong to which subcard, and how a figure is
// written.
//
// It lives in the **API** suite because CI runs `npm test` in `api/` only
// (#1009's reason, the same one `members-app-theme-consumption.unit.test.ts` and
// `member-goal-cards.unit.test.ts` give). The module is pure TypeScript whose
// only imports are its own types, which is why it is importable here at all.

import { describe, expect, it } from 'vitest';
import {
  type BillingEventForecast,
  type ForecastLine,
  type MemberBillingEvent,
  EMPTY_FORECAST,
  billingEventAmount,
  forecastDatesAfterNext,
  formatPaymentAmount,
  formatPaymentDate,
  lineKindKey,
  lineTreatmentKey,
  lineTreatmentName,
  nextPaymentDate,
  pastBillingEventGroups,
  showsRegularPrice,
} from '../../../apps/member/src/lib/memberPayments';

function line(over: Partial<ForecastLine> = {}): ForecastLine {
  return {
    kind: 'membership_fee',
    label: 'Premium Membership',
    product_id: null,
    mandatory: false,
    quantity: 1,
    unit_price: 70,
    regular_price: 70,
    actual_charge: 70,
    prepaid_periods: null,
    benefits: [],
    ...over,
  };
}

function forecast(dates: { date: string; total: number }[]): BillingEventForecast {
  return {
    ...EMPTY_FORECAST,
    available: true,
    anchor_date: dates[0]?.date ?? null,
    dates: dates.map((d) => ({ date: d.date, total: d.total, lines: [line()] })),
    total: dates.reduce((sum, d) => sum + d.total, 0),
  };
}

function event(over: Partial<MemberBillingEvent> = {}): MemberBillingEvent {
  return {
    id: 1,
    event_type: 'recurring_payment',
    charge_type_code: 'membership_fee',
    previous_status: null,
    new_status: null,
    amount: '70.00',
    notes: null,
    created_at: '2026-09-15T08:00:00.000Z',
    receipt_number: null,
    status: 'paid',
    ...over,
  };
}

describe('Next Payment is the forecast’s first group', () => {
  it('is the next billing event in time', () => {
    const f = forecast([{ date: '2026-10-15', total: 150 }, { date: '2026-11-15', total: 150 }]);
    expect(nextPaymentDate(f)?.date).toBe('2026-10-15');
  });

  it('is null when there is no projection at all', () => {
    expect(nextPaymentDate(null)).toBeNull();
    expect(nextPaymentDate(EMPTY_FORECAST)).toBeNull();
  });

  // `available: false` is a legitimate state (no plan, or one that bills nothing
  // further), and it must not be read as "the next payment is the first group of
  // an empty list".
  it('is null for an unavailable forecast even if it carries dates', () => {
    const f = { ...forecast([{ date: '2026-10-15', total: 150 }]), available: false };
    expect(nextPaymentDate(f)).toBeNull();
  });
});

describe('the Forecast subcard lists everything after the next payment', () => {
  it('excludes the next payment, which is the card above it', () => {
    const f = forecast([
      { date: '2026-10-15', total: 150 },
      { date: '2026-11-15', total: 150 },
      { date: '2026-12-15', total: 150 },
    ]);
    expect(forecastDatesAfterNext(f).map((g) => g.date)).toEqual(['2026-11-15', '2026-12-15']);
  });

  it('is empty when the forecast holds only the next payment', () => {
    expect(forecastDatesAfterNext(forecast([{ date: '2026-10-15', total: 150 }]))).toEqual([]);
    expect(forecastDatesAfterNext(EMPTY_FORECAST)).toEqual([]);
  });
});

describe('Past Billing Events are grouped by date', () => {
  it('groups the events of one day into one card and totals them', () => {
    const groups = pastBillingEventGroups([
      event({ id: 1, created_at: '2026-09-15T08:00:00.000Z', amount: '100.00' }),
      event({ id: 2, created_at: '2026-09-15T08:00:05.000Z', amount: '50.00' }),
      event({ id: 3, created_at: '2026-08-15T08:00:00.000Z', amount: '100.00' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ date: '2026-09-15', total: 150 });
    expect(groups[0].events.map((e) => e.id)).toEqual([1, 2]);
    expect(groups[1]).toMatchObject({ date: '2026-08-15', total: 100 });
  });

  it('keeps the server’s order rather than re-sorting', () => {
    const groups = pastBillingEventGroups([
      event({ id: 1, created_at: '2026-07-15T08:00:00.000Z' }),
      event({ id: 2, created_at: '2026-09-15T08:00:00.000Z' }),
    ]);
    expect(groups.map((g) => g.date)).toEqual(['2026-07-15', '2026-09-15']);
  });

  // A `status_changed` row records no money, so it belongs to the card without
  // contributing to its total.
  it('ignores an event that carries no amount in the total', () => {
    const groups = pastBillingEventGroups([
      event({ id: 1, amount: '70.00' }),
      event({ id: 2, amount: null, event_type: 'status_changed', status: 'recorded' }),
    ]);
    expect(groups[0].total).toBe(70);
    expect(groups[0].events).toHaveLength(2);
  });

  it('adds amounts without floating-point drift', () => {
    const groups = pastBillingEventGroups([
      event({ id: 1, amount: '0.10' }),
      event({ id: 2, amount: '0.20' }),
    ]);
    expect(groups[0].total).toBe(0.3);
  });

  it('reads a malformed amount as no amount rather than NaN', () => {
    expect(billingEventAmount(event({ amount: 'n/a' }))).toBeNull();
    expect(pastBillingEventGroups([event({ amount: 'n/a' })])[0].total).toBe(0);
  });
});

describe('a line’s treatment is the server’s, never an amount comparison', () => {
  it('has no caption at the regular price', () => {
    expect(lineTreatmentKey(line())).toBeNull();
    expect(lineTreatmentKey(line({ benefits: [{ source: 'promotion', name: 'Summer', action: 'no_benefit', value: null, period_status: null }] }))).toBeNull();
  });

  it('names each treatment the engine may report', () => {
    const of = (action: ForecastLine['benefits'][number]['action']) => lineTreatmentKey(line({
      benefits: [{ source: 'promotion', name: null, action, value: 20, period_status: null }],
    }));
    expect(of('waive')).toBe('treatment_waived');
    expect(of('included')).toBe('treatment_waived');
    expect(of('percentage_discount')).toBe('treatment_percentage');
    expect(of('fixed_discount')).toBe('treatment_fixed_discount');
    expect(of('fixed_price')).toBe('treatment_fixed_price');
  });

  // €0.00 is also what an item with no price costs, so a waived line is known by
  // its action and never by its amount (`simulationLineTone()`'s rule).
  it('does not call a zero-priced line waived', () => {
    expect(lineTreatmentKey(line({ regular_price: 0, actual_charge: 0 }))).toBeNull();
  });

  it('reports the name of a named benefit only', () => {
    expect(lineTreatmentName(line({
      benefits: [{ source: 'promotion', name: 'Summer 2026', action: 'waive', value: null, period_status: null }],
    }))).toBe('Summer 2026');
    expect(lineTreatmentName(line({
      benefits: [{ source: 'membership_plan', name: '  ', action: 'waive', value: null, period_status: null }],
    }))).toBeNull();
    expect(lineTreatmentName(line())).toBeNull();
  });

  it('shows the regular price only where it differs from the charge', () => {
    expect(showsRegularPrice(line())).toBe(false);
    expect(showsRegularPrice(line({ regular_price: 70, actual_charge: 56 }))).toBe(true);
    // Rounding, not float equality: 69.999999 and 70 are the same two decimals.
    expect(showsRegularPrice(line({ regular_price: 70, actual_charge: 69.999999 }))).toBe(false);
  });

  it('names what a line is from its kind', () => {
    expect(lineKindKey(line())).toBe('line_kind_membership_fee');
    expect(lineKindKey(line({ kind: 'product' }))).toBe('line_kind_product');
  });
});

describe('formatting', () => {
  it('writes an amount in the currency the server named', () => {
    expect(formatPaymentAmount(150, 'EUR', 'en-GB')).toContain('150.00');
    expect(formatPaymentAmount(150, 'EUR', 'en-GB')).toContain('€');
  });

  it('falls back to two decimals rather than failing on an unusable currency', () => {
    expect(formatPaymentAmount(150, 'not-a-currency', 'en-GB')).toBe('150.00');
  });

  it('answers null for an absent or unusable amount', () => {
    expect(formatPaymentAmount(null, 'EUR', 'en-GB')).toBeNull();
    expect(formatPaymentAmount(Number.NaN, 'EUR', 'en-GB')).toBeNull();
  });

  // The date a charge falls on is compared in SQL and must not shift by a
  // timezone, so both shapes are read as UTC.
  it('reads a date-only value and a timestamp as the same UTC day', () => {
    expect(formatPaymentDate('2026-10-15', 'en-GB')).toBe(formatPaymentDate('2026-10-15T23:30:00.000Z', 'en-GB'));
    expect(formatPaymentDate('2026-10-15', 'en-GB')).toContain('2026');
  });

  it('falls back to the stored day for an unparseable value', () => {
    expect(formatPaymentDate('not-a-date', 'en-GB')).toBe('not-a-date');
  });
});
