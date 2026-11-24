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
  formatPaymentAmount,
  formatPaymentDate,
  lineKindKey,
  lineTreatmentKey,
  lineTreatmentName,
  billingEventHasDetails,
  billingEventIssuedDate,
  billingEventLineAmount,
  billingEventLineRegularAmount,
  showsRegularPrice,
  paymentDocumentFileName,
  paymentScheduledDate,
  paymentSections,
  paymentTypeKey,
  refundTypeKey,
  isPlannedPayment,
} from '../../../apps/member/src/lib/memberPayments';
import { DEFAULT_GYM_FORMAT } from '../../../apps/member/src/lib/gymFormat';
import { ledgerEventStatus, paymentCoverage, refundCoverage, scheduledExecutionDate } from '../domain/memberPaymentView';

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

describe('#3297 — the Payments tab is grouped by scheduled execution date', () => {
  const TODAY = '2026-10-10';
  const at = (id: number, date: string, status: MemberBillingEvent['status']) =>
    event({ id, scheduled_date: date, status, created_at: '2026-01-01T00:00:00.000Z' });

  it('puts a future date under Planned and a past one under Past, whatever the status', () => {
    const s = paymentSections([
      at(1, '2026-11-15', 'scheduled'),
      at(2, '2026-10-15', 'scheduled'),
      at(3, '2026-09-15', 'paid'),
      // A failed charge of a past date stays Past; its status never moves it.
      at(4, '2026-08-15', 'failed'),
      // A record created today for a later date is Planned, whatever its status.
      at(5, '2026-12-15', 'waived'),
    ], TODAY);
    expect(s.planned.map((e) => e.id)).toEqual([2, 1, 5]);
    expect(s.past.map((e) => e.id)).toEqual([3, 4]);
  });

  it('keeps a payment due today Planned until it has been executed', () => {
    expect(isPlannedPayment(at(1, TODAY, 'scheduled'), TODAY)).toBe(true);
    expect(isPlannedPayment(at(2, TODAY, 'paid'), TODAY)).toBe(false);
  });

  it('falls back to the day a payment was written when the API names no date', () => {
    expect(paymentScheduledDate(event({ created_at: '2026-09-15T08:00:00.000Z' }))).toBe('2026-09-15');
  });

  it('summarises the nearest planned payment and every unresolved one, each once', () => {
    const s = paymentSections([
      at(1, '2026-11-15', 'scheduled'),
      at(2, '2026-10-15', 'scheduled'),
      at(3, '2026-09-15', 'failed'),
      at(4, '2026-10-20', 'pending'),
      at(5, '2026-09-01', 'paid'),
    ], TODAY);
    expect(s.next.map((e) => e.id)).toEqual([2, 3, 4]);
    // The next payment is still listed under Planned.
    expect(s.planned.map((e) => e.id)).toContain(2);
  });

  it('does not repeat a planned payment that is also unresolved', () => {
    const s = paymentSections([at(1, '2026-10-15', 'pending')], TODAY);
    expect(s.next.map((e) => e.id)).toEqual([1]);
  });

  it('has nothing next when nothing is planned or unresolved', () => {
    expect(paymentSections([at(1, '2026-09-01', 'paid')], TODAY).next).toEqual([]);
  });

  it('names the payment-type and refund chips from the server’s answer alone', () => {
    expect(paymentTypeKey(event({ payment_type: 'full' }))).toBe('payment_type_full');
    expect(paymentTypeKey(event({ payment_type: 'partial' }))).toBe('payment_type_partial');
    expect(paymentTypeKey(event({}))).toBeNull();
    expect(refundTypeKey(event({ refund_type: 'partial' }))).toBe('refund_type_partial');
    expect(refundTypeKey(event({ refund_type: null }))).toBeNull();
  });

  it('opens a row that has documents, even with no lines', () => {
    expect(billingEventHasDetails(event({ documents: [{ kind: 'receipt', id: 1, number: '1' }] }))).toBe(true);
  });
});

describe('#3297 — the API’s answers', () => {
  it('reads a persisted, not-yet-executed obligation as scheduled', () => {
    expect(ledgerEventStatus('charge_created', null, false, true)).toBe('scheduled');
    expect(ledgerEventStatus('charge_created', null, false, false)).toBeNull();
    expect(ledgerEventStatus('payment_recorded', 'completed', false, false)).toBe('paid');
  });

  it('dates a payment by its billing date, else the day it was written', () => {
    expect(scheduledExecutionDate('2099-01-01', '2026-01-01T10:00:00.000Z')).toBe('2099-01-01');
    expect(scheduledExecutionDate(null, new Date('2026-03-04T23:30:00.000Z'))).toBe('2026-03-04');
    expect(scheduledExecutionDate(new Date('2026-05-06T00:00:00.000Z'), '2026-01-01')).toBe('2026-05-06');
  });

  it('calls a payment full only when the money collected covers the amount', () => {
    expect(paymentCoverage('40.00', '40.00')).toBe('full');
    expect(paymentCoverage('15.00', '40.00')).toBe('partial');
    expect(paymentCoverage(null, '40.00')).toBeNull();
    expect(paymentCoverage('0.00', '0.00')).toBeNull();
    expect(refundCoverage('full')).toBe('full');
    expect(refundCoverage('none')).toBeNull();
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

describe('#3242 — a downloaded document', () => {
  it('names the saved file after the document kind and number', () => {
    expect(paymentDocumentFileName({ kind: 'simplified_invoice', id: 7, number: 'S-2026/0002' }))
      .toBe('simplified-invoice-S-2026-0002.pdf');
    expect(paymentDocumentFileName({ kind: 'receipt', id: 9, number: '' })).toBe('receipt-9.pdf');
  });
});
