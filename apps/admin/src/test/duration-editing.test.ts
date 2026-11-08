import { describe, expect, it } from 'vitest';
import {
  billingDurationPayload, durationFormError, type DurationFormValues,
} from '../lib/durationEditing';

const form = (over: Partial<DurationFormValues> = {}): DurationFormValues => ({
  free_periods: '1', paid_periods: '11', pay_beforehand_periods: '', bonus_periods: '0',
  recurring_billing_interval: '1', recurring_billing_unit: 'month', ...over,
});

describe('durationEditing (#2093 stage 3)', () => {
  it('accepts a valid form, blanks included', () => {
    expect(durationFormError(form())).toBeNull();
  });
  it('refuses a bad duration before anything is sent', () => {
    expect(durationFormError(form({ free_periods: '-1' }))).toBe('duration_invalid');
    expect(durationFormError(form({ paid_periods: '1.5' }))).toBe('duration_invalid');
  });
  it('sends blank as null and keeps a typed zero', () => {
    expect(billingDurationPayload(form())).toMatchObject({ pay_beforehand_periods: null, bonus_periods: 0 });
  });
});
