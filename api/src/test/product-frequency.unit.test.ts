// #821 / #945: the Product Billing Frequency rule — four offered
// choices, and the two retired values ('week', 'per_session') readable but
// never configurable. Pure module, no DB and no HTTP.

import { describe, expect, it } from 'vitest';
import {
  LEGACY_PRODUCT_FREQUENCIES,
  OFFERED_PRODUCT_FREQUENCIES,
  STORED_PRODUCT_FREQUENCIES,
  describeOfferedFrequencies,
  isLegacyProductFrequency,
  isOfferedProductFrequency,
  isStoredProductFrequency,
  productFrequencyWriteError,
} from '../domain/productFrequency';

describe('the offered set', () => {
  it('is exactly the four choices, in the order the dropdown lists them', () => {
    expect(OFFERED_PRODUCT_FREQUENCIES).toEqual(['once', 'four_weeks', 'month', 'year']);
  });

  it('does not offer week or per_session', () => {
    expect(isOfferedProductFrequency('week')).toBe(false);
    expect(isOfferedProductFrequency('per_session')).toBe(false);
    expect(OFFERED_PRODUCT_FREQUENCIES).not.toContain('week');
    expect(OFFERED_PRODUCT_FREQUENCIES).not.toContain('per_session');
  });

  it('keeps both retired values as stored ones, so existing rows stay known', () => {
    expect([...LEGACY_PRODUCT_FREQUENCIES].sort()).toEqual(['per_session', 'week']);
    for (const legacy of ['week', 'per_session']) {
      expect(isLegacyProductFrequency(legacy)).toBe(true);
      expect(isStoredProductFrequency(legacy)).toBe(true);
    }
  });

  it('stores the six values migration 123 permits — the CHECK is unchanged', () => {
    expect([...STORED_PRODUCT_FREQUENCIES].sort())
      .toEqual(['four_weeks', 'month', 'once', 'per_session', 'week', 'year']);
  });

  it('rejects anything else', () => {
    for (const junk of ['fortnight', 'day', 'MONTH', '', null, undefined, 3, {}]) {
      expect(isStoredProductFrequency(junk)).toBe(false);
    }
  });

  it('names the offered set for the 400 message', () => {
    expect(describeOfferedFrequencies()).toBe('once, four_weeks, month, year');
  });
});

describe('productFrequencyWriteError', () => {
  it('accepts every offered frequency, on create and on edit', () => {
    for (const f of OFFERED_PRODUCT_FREQUENCIES) {
      expect(productFrequencyWriteError(f, null)).toBeNull();
      expect(productFrequencyWriteError(f, 'month')).toBeNull();
    }
  });

  it('accepts an absent or cleared frequency (the dropdown\'s "—")', () => {
    expect(productFrequencyWriteError(undefined, null)).toBeNull();
    expect(productFrequencyWriteError(null, 'week')).toBeNull();
    expect(productFrequencyWriteError('', 'month')).toBeNull();
  });

  it('refuses a retired frequency on create', () => {
    for (const legacy of ['week', 'per_session']) {
      const err = productFrequencyWriteError(legacy, null);
      expect(err).toContain('no longer offered');
      expect(err).toContain('once, four_weeks, month, year');
    }
  });

  it('refuses moving an item onto a retired frequency', () => {
    expect(productFrequencyWriteError('week', 'month')).toContain('no longer offered');
    expect(productFrequencyWriteError('per_session', 'month')).toContain('no longer offered');
    // Neither retired value is a route onto the other.
    expect(productFrequencyWriteError('per_session', 'week')).toContain('no longer offered');
    expect(productFrequencyWriteError('week', 'per_session')).toContain('no longer offered');
  });

  it('carries a retired frequency through unchanged on an item that already stores it', () => {
    expect(productFrequencyWriteError('week', 'week')).toBeNull();
    expect(productFrequencyWriteError('per_session', 'per_session')).toBeNull();
  });

  it('lets a legacy item move to an offered frequency', () => {
    expect(productFrequencyWriteError('four_weeks', 'week')).toBeNull();
    // #945: the correction a per-session package is expected to make.
    expect(productFrequencyWriteError('once', 'per_session')).toBeNull();
  });

  it('refuses an unknown value with the offered list, whatever the row stores', () => {
    expect(productFrequencyWriteError('fortnight', null))
      .toBe('billing_frequency must be one of: once, four_weeks, month, year');
    expect(productFrequencyWriteError('fortnight', 'per_session'))
      .toBe('billing_frequency must be one of: once, four_weeks, month, year');
  });
});
