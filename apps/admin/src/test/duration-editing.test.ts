import { describe, expect, it } from 'vitest';
import {
  billingDurationPayload, directDiscountPayload, durationFormError, type DurationFormValues,
} from '../lib/durationEditing';

const form = (over: Partial<DurationFormValues> = {}): DurationFormValues => ({
  free_periods: '1', paid_periods: '11', pay_beforehand_periods: '', bonus_periods: '0',
  recurring_billing_interval: '1', recurring_billing_unit: 'month', direct_discount_percent: '', ...over,
});

describe('durationEditing (#2093 stage 3)', () => {
  it('accepts a valid form, blanks included', () => {
    expect(durationFormError(form())).toBeNull();
  });
  it('refuses a discount out of range or a bad duration before anything is sent', () => {
    expect(durationFormError(form({ direct_discount_percent: '101' }))).toBe('direct_discount_invalid');
    expect(durationFormError(form({ direct_discount_percent: 'abc' }))).toBe('direct_discount_invalid');
    expect(durationFormError(form({ free_periods: '-1' }))).toBe('duration_invalid');
    expect(durationFormError(form({ paid_periods: '1.5' }))).toBe('duration_invalid');
  });
  it('sends blank as null and keeps a typed zero', () => {
    expect(billingDurationPayload(form())).toMatchObject({ pay_beforehand_periods: null, bonus_periods: 0 });
  });
  it('maps the discount to the Personal Membership Fee Benefit', () => {
    expect(directDiscountPayload(form({ direct_discount_percent: '15' }))).toEqual({ action: 'percentage_discount', value: 15 });
    expect(directDiscountPayload(form({ direct_discount_percent: '0' }))).toEqual({ action: 'no_benefit', value: null });
  });
});
