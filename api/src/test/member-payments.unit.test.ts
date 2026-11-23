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
  billingEventHasDetails,
  billingEventIssuedDate,
  billingEventLineAmount,
  billingEventLineRegularAmount,
  showsRegularPrice,
  paymentDocumentFileName,
  paymentDocumentRows,
} from '../../../apps/member/src/lib/memberPayments';
import { DEFAULT_GYM_FORMAT } from '../../../apps/member/src/lib/gymFormat';

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

describe('#2937 — each Past Billing Event is its own row', () => {
  const stored = (over: Partial<NonNullable<MemberBillingEvent['lines']>[number]> = {}) => ({
    id: 1, kind: 'membership_fee', item_name: 'Premium', quantity: 1,
    regular_unit_price: '70.00', promotion_name: null, amount: '70.00', ...over,
  });

  it('is headed by the day the event was issued', () => {
    expect(billingEventIssuedDate(event({ created_at: '2026-09-15T08:00:05.000Z' }))).toBe('2026-09-15');
  });

  it('reads a stored line’s amount, and a malformed one as no amount', () => {
    expect(billingEventLineAmount(stored({ amount: '12.50' }))).toBe(12.5);
    expect(billingEventLineAmount(stored({ amount: 'n/a' }))).toBeNull();
  });

  it('shows the regular price only where it differs from what was charged', () => {
    expect(billingEventLineRegularAmount(stored())).toBeNull();
    expect(billingEventLineRegularAmount(stored({ quantity: 2, regular_unit_price: '10.00', amount: '15.00' }))).toBe(20);
    expect(billingEventLineRegularAmount(stored({ regular_unit_price: null }))).toBeNull();
    expect(billingEventLineRegularAmount(stored({ regular_unit_price: '0.10', quantity: 3, amount: '0.30' }))).toBeNull();
  });

  it('is expandable only when it has something to show', () => {
    expect(billingEventHasDetails(event({}))).toBe(false);
    expect(billingEventHasDetails(event({ lines: [stored()] }))).toBe(true);
    expect(billingEventHasDetails(event({ payment_method_name: 'Card' }))).toBe(true);
    // #3242 — documents are listed in their own section, so they no longer open a row.
    expect(billingEventHasDetails(event({ documents: [{ kind: 'receipt', id: 1, number: 'R-1' }] }))).toBe(false);
    expect(billingEventHasDetails(event({ notes: 'Manual' }))).toBe(true);
  });

  it('reads a malformed event amount as no amount rather than NaN', () => {
    expect(billingEventAmount(event({ amount: 'n/a' }))).toBeNull();
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
    expect(formatPaymentAmount(150, 'EUR', DEFAULT_GYM_FORMAT)).toContain('150,00');
    expect(formatPaymentAmount(150, 'EUR', DEFAULT_GYM_FORMAT)).toContain('€');
  });

  it('falls back to two decimals rather than failing on an unusable currency', () => {
    expect(formatPaymentAmount(150, 'not-a-currency', DEFAULT_GYM_FORMAT)).toBe('150.00');
  });

  it('answers null for an absent or unusable amount', () => {
    expect(formatPaymentAmount(null, 'EUR', DEFAULT_GYM_FORMAT)).toBeNull();
    expect(formatPaymentAmount(Number.NaN, 'EUR', DEFAULT_GYM_FORMAT)).toBeNull();
  });

  // The date a charge falls on is compared in SQL and must not shift by a
  // timezone, so both shapes are read as UTC.
  it('reads a date-only value and a timestamp as the same UTC day', () => {
    expect(formatPaymentDate('2026-10-15', DEFAULT_GYM_FORMAT)).toBe(formatPaymentDate('2026-10-15T23:30:00.000Z', DEFAULT_GYM_FORMAT));
    expect(formatPaymentDate('2026-10-15', DEFAULT_GYM_FORMAT)).toContain('2026');
  });

  it('falls back to the stored day for an unparseable value', () => {
    expect(formatPaymentDate('not-a-date', DEFAULT_GYM_FORMAT)).toBe('not-a-date');
  });
});

describe('#3242 — the Documents section', () => {
  it('lists every document of every payment once, newest first, dated by its own issue time', () => {
    const rows = paymentDocumentRows([
      event({
        id: 1, created_at: '2026-09-15T08:00:00.000Z',
        documents: [
          { kind: 'receipt', id: 1, number: '2026-0001', issued_at: '2026-09-15T08:01:00.000Z' },
          { kind: 'refund_receipt', id: 4, number: 'R-2026-0001', issued_at: '2026-10-20T10:00:00.000Z' },
        ],
      }),
      event({
        id: 2, created_at: '2026-10-01T08:00:00.000Z',
        documents: [{ kind: 'simplified_invoice', id: 7, number: 'S-2026-0002', issued_at: null }],
      }),
      event({ id: 3, documents: [] }),
    ]);
    expect(rows.map((r) => [r.key, r.date])).toEqual([
      ['refund_receipt:4', '2026-10-20T10:00:00.000Z'],
      // No recorded issue time: the payment's own date, never an invented one.
      ['simplified_invoice:7', '2026-10-01T08:00:00.000Z'],
      ['receipt:1', '2026-09-15T08:01:00.000Z'],
    ]);
  });

  it('lists nothing when no payment has a stored document', () => {
    expect(paymentDocumentRows([event({}), event({ id: 2, documents: [] })])).toEqual([]);
  });

  it('names the saved file after the document kind and number', () => {
    expect(paymentDocumentFileName({ kind: 'simplified_invoice', id: 7, number: 'S-2026/0002' }))
      .toBe('simplified-invoice-S-2026-0002.pdf');
    expect(paymentDocumentFileName({ kind: 'receipt', id: 9, number: '' })).toBe('receipt-9.pdf');
  });
});
