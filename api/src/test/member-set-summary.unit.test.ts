// #2496 stage 5 — the Members App's Summary and Save & Pay decide nothing about
// money: which action commits the Draft, what is contracted or cancelled and
// what a line was discounted by are all read off the server's review.
import { describe, expect, it } from 'vitest';
import {
  reviewFrequencyKey, reviewLineDiscount, reviewSections, setCommitAction, setCommitErrorKey,
  type MemberSetReview, type MemberSetReviewItem,
} from '../../../apps/member/src/lib/memberProducts';

const item = (state: MemberSetReviewItem['state'], name = 'Locker'): MemberSetReviewItem => ({
  state, type: 'product', name, quantity: 1, billing_frequency: 'month', regular_price: 10,
  promotions: [], initial_amount: null, final_price: 10,
});

const review = (over: Partial<MemberSetReview> = {}): MemberSetReview => ({
  product_set_id: 7, status: 'draft', summary_items: [item('active', 'Old'), item('draft')],
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
    const line = { item_name: 'Locker', quantity: 2, amount: 15, regular_unit_price: 10, promotion_name: 'Half',
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
