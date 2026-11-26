// #2496 stage 5 — the Members App's Summary and Save & Pay decide nothing about
// money: which action commits the Draft, what is contracted or cancelled and
// what a line was discounted by are all read off the server's review.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  reviewFrequencyKey, reviewLineDiscount, reviewLineProration, reviewLineReasons, reviewSections,
  setCommitAction, setCommitErrorKey,
  type MemberSetReview, type MemberSetReviewItem, type MemberSetReviewLine,
} from '../../../apps/member/src/lib/memberProducts';

const item = (state: MemberSetReviewItem['state'], name = 'Locker'): MemberSetReviewItem => ({
  state, type: 'product', name, quantity: 1, billing_frequency: 'month', regular_price: 10,
  promotions: [], initial_amount: null, final_price: 10,
});

const review = (over: Partial<MemberSetReview> = {}): MemberSetReview => ({
  product_set_id: 7, status: 'in_cart', summary_items: [item('active', 'Old'), item('draft')],
  immediate_lines: [], amount_due: 10, payment_required: true, tax_total: 1.74, currency: 'EUR', error: null, ...over,
});

describe('reviewSections', () => {
  it('lists what the Draft adds as contracted and what it removes as cancelled, never what stays', () => {
    const r = review({ summary_items: [item('active', 'Kept'), item('draft', 'New'), item('cancelling', 'Gone')] });
    const { contracted, cancelled } = reviewSections(r);
    expect(contracted.map((i) => i.name)).toEqual(['New']);
    expect(cancelled.map((i) => i.name)).toEqual(['Gone']);
    expect(reviewSections(null)).toEqual({ contracted: [], cancelled: [] });
  });
});

describe('setCommitAction', () => {
  it('is Save & Pay while something is owed today and the free activation when nothing is', () => {
    expect(setCommitAction(review())).toBe('save_and_pay');
    expect(setCommitAction(review({ amount_due: 0, payment_required: false }))).toBe('activate');
  });
  it('offers nothing when the amount is unknown, the version is not a Draft, or nothing changes', () => {
    expect(setCommitAction(review({ amount_due: null, error: 'amount_unavailable' }))).toBeNull();
    expect(setCommitAction(review({ error: 'edit_locked' }))).toBeNull();
    expect(setCommitAction(review({ status: 'pending_payment' }))).toBeNull();
    expect(setCommitAction(review({ summary_items: [item('active')] }))).toBeNull();
    expect(setCommitAction(null)).toBeNull();
  });
});

describe('reviewLineDiscount', () => {
  it("is the line's regular price minus its charge, and null when nothing was taken off", () => {
    const line = { item_name: 'Locker', quantity: 2, amount: 15, regular_unit_price: 20, promotion_name: 'Half',
      treatment_action: null, treatment_value: null, tax_rate_percent: 21, amount_excl_tax: 12.4 };
    expect(reviewLineDiscount(line)).toBe(5);
    expect(reviewLineDiscount({ ...line, amount: 20 })).toBeNull();
    expect(reviewLineDiscount({ ...line, regular_unit_price: null })).toBeNull();
  });
});

describe('reviewFrequencyKey', () => {
  it("reads a Product's frequency and a plan's cadence through the one frequency map", () => {
    expect(reviewFrequencyKey('month')).toBe('membership.frequency.month');
    expect(reviewFrequencyKey('1_month')).toBe('membership.frequency.month');
    expect(reviewFrequencyKey('4_week')).toBe('membership.frequency.four_weeks');
    expect(reviewFrequencyKey('once')).toBeNull();
    expect(reviewFrequencyKey('2_month')).toBeNull();
    expect(reviewFrequencyKey(null)).toBeNull();
  });
});

describe('setCommitErrorKey', () => {
  it('names the refusal, tells a stale screen to look again, and falls back to the generic key', () => {
    expect(setCommitErrorKey('draft_expired')).toBe('membership.draft_error_expired');
    expect(setCommitErrorKey('edit_locked')).toBe('membership.draft_error_locked');
    expect(setCommitErrorKey('nothing_to_pay')).toBe('membership.summary_error_changed');
    expect(setCommitErrorKey('payment_required')).toBe('membership.summary_error_changed');
    expect(setCommitErrorKey('whatever')).toBe('membership.summary_error_generic');
  });
});

// #3434 — the Initial Payment's lines are structured: Product, Quantity, each Benefit / Discount
// on its own row and the VAT-inclusive amount, all read off the server's line and its reasons.
const line = (over: Partial<MemberSetReviewLine> = {}): MemberSetReviewLine => ({
  item_name: 'Locker Rental', quantity: 1, amount: 15, regular_unit_price: 15, promotion_name: null,
  treatment_action: null, treatment_value: null, tax_rate_percent: 21, amount_excl_tax: 12.4, ...over,
});

describe('reviewLineReasons (#3434)', () => {
  it("states the reported Locker Rental: its Promotion's name and its 50%, beside the proration and the discount", () => {
    const l = line({
      quantity: 2, amount: 3, regular_unit_price: 30, prorated_days: 6, period_days: 30,
      promotion_name: 'Todos los productos al 50%', treatment_action: 'percentage_discount', treatment_value: 50,
      reasons: [{ type: 'discount', source: 'promotion', code: null, action: 'percentage_discount', value: 50, name: 'Todos los productos al 50%' }],
    });
    expect(reviewLineReasons(l)).toEqual([
      { typeKey: 'membership.summary_reason_type_discount', text: 'Todos los productos al 50%', percent: 50 },
    ]);
    expect(reviewLineProration(l)).toEqual({ days: 6, period: 30 });
    expect(reviewLineDiscount(l)).toBe(27);
  });

  it('reads a Promotion with its duration, a Plan benefit, a Direct Discount and the staff waive each as its own entry', () => {
    const l = line({ reasons: [
      { type: 'benefit', source: 'membership_plan', code: null, action: 'waive', value: null, name: null },
      { type: 'discount', source: 'promotion', code: null, action: 'percentage_discount', value: 50, name: 'Spring', duration: { count: 3, unit: 'month' } },
      { type: 'manual_adjustment', source: 'personal', code: 'direct_discount', action: 'percentage_discount', value: 10, name: null },
      { type: 'manual_adjustment', source: 'personal', code: 'initial_payment_waive', action: 'waive', value: null, name: null },
    ] });
    expect(reviewLineReasons(l)).toEqual([
      { typeKey: 'membership.summary_reason_type_benefit', key: 'membership.summary_reason_waive', percent: null },
      { typeKey: 'membership.summary_reason_type_discount', key: 'membership.summary_reason_duration_month', values: { name: 'Spring', count: 3 }, percent: 50 },
      { typeKey: 'membership.summary_reason_type_manual_adjustment', key: 'membership.summary_reason_direct_percent', values: { percent: 10 }, percent: null },
      { typeKey: 'membership.summary_reason_type_initial_payment', key: 'membership.summary_reason_waive', percent: null },
    ]);
  });

  it('keeps each line its own reasons, and a line with no Benefit / Discount has none', () => {
    const lines = [
      line({ item_name: 'Locker Rental', reasons: [{ type: 'discount', source: 'promotion', code: null, action: 'percentage_discount', value: 50, name: 'Half' }] }),
      line({ item_name: 'Towel', reasons: [] }),
    ];
    expect(lines.map((l) => reviewLineReasons(l).map((r) => r.text))).toEqual([['Half'], []]);
    expect(reviewLineDiscount(lines[1])).toBeNull();
  });

  it("falls back to the line's single treatment when the server sent no reasons", () => {
    expect(reviewLineReasons(line({ promotion_name: 'Half', treatment_action: 'percentage_discount', treatment_value: 50 })))
      .toEqual([{ typeKey: 'membership.summary_reason_type_discount', text: 'Half', percent: 50 }]);
    expect(reviewLineReasons(line({ treatment_action: 'waive' })))
      .toEqual([{ typeKey: 'membership.summary_reason_type_benefit', key: 'membership.summary_reason_waive', percent: null }]);
    expect(reviewLineReasons(line())).toEqual([]);
  });

  it('every key the Summary can resolve exists in the three Members App locales', () => {
    const keys = [
      'summary_col_product', 'summary_col_amount', 'summary_line_quantity', 'summary_reason_off', 'summary_total',
      'summary_reason_type_benefit', 'summary_reason_type_discount', 'summary_reason_type_manual_adjustment',
      'summary_reason_type_initial_payment', 'summary_reason_duration_week', 'summary_reason_duration_four_weeks',
      'summary_reason_duration_month', 'summary_reason_duration_year', 'summary_reason_waive', 'summary_reason_percent',
      'summary_reason_direct_percent', 'summary_reason_discount',
    ];
    for (const locale of ['en', 'es', 'ca']) {
      const messages = JSON.parse(readFileSync(join(__dirname, `../../../apps/member/locales/base/${locale}.json`), 'utf8'));
      for (const k of keys) expect(typeof messages.membership[k], `${locale}: membership.${k}`).toBe('string');
    }
  });
});
