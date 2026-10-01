// #821 / #945: the Sellable Item Billing Frequency rule — four offered
// choices, and the two retired values ('week', 'per_session') readable but
// never configurable. Pure module, no DB and no HTTP.

import { describe, expect, it } from 'vitest';
import {
  LEGACY_SELLABLE_ITEM_FREQUENCIES,
  OFFERED_SELLABLE_ITEM_FREQUENCIES,
  STORED_SELLABLE_ITEM_FREQUENCIES,
  describeOfferedFrequencies,
  isLegacySellableItemFrequency,
  isOfferedSellableItemFrequency,
  isStoredSellableItemFrequency,
  sellableItemFrequencyWriteError,
} from '../domain/sellableItemFrequency';

describe('the offered set', () => {
  it('is exactly the four choices, in the order the dropdown lists them', () => {
    expect(OFFERED_SELLABLE_ITEM_FREQUENCIES).toEqual(['once', 'four_weeks', 'month', 'year']);
  });

  it('does not offer week or per_session', () => {
    expect(isOfferedSellableItemFrequency('week')).toBe(false);
    expect(isOfferedSellableItemFrequency('per_session')).toBe(false);
    expect(OFFERED_SELLABLE_ITEM_FREQUENCIES).not.toContain('week');
    expect(OFFERED_SELLABLE_ITEM_FREQUENCIES).not.toContain('per_session');
  });

  it('keeps both retired values as stored ones, so existing rows stay known', () => {
    expect([...LEGACY_SELLABLE_ITEM_FREQUENCIES].sort()).toEqual(['per_session', 'week']);
    for (const legacy of ['week', 'per_session']) {
      expect(isLegacySellableItemFrequency(legacy)).toBe(true);
      expect(isStoredSellableItemFrequency(legacy)).toBe(true);
    }
  });

  it('stores the six values migration 123 permits — the CHECK is unchanged', () => {
    expect([...STORED_SELLABLE_ITEM_FREQUENCIES].sort())
      .toEqual(['four_weeks', 'month', 'once', 'per_session', 'week', 'year']);
  });

  it('rejects anything else', () => {
    for (const junk of ['fortnight', 'day', 'MONTH', '', null, undefined, 3, {}]) {
      expect(isStoredSellableItemFrequency(junk)).toBe(false);
    }
  });

  it('names the offered set for the 400 message', () => {
    expect(describeOfferedFrequencies()).toBe('once, four_weeks, month, year');
  });
});

describe('sellableItemFrequencyWriteError', () => {
  it('accepts every offered frequency, on create and on edit', () => {
    for (const f of OFFERED_SELLABLE_ITEM_FREQUENCIES) {
      expect(sellableItemFrequencyWriteError(f, null)).toBeNull();
      expect(sellableItemFrequencyWriteError(f, 'month')).toBeNull();
    }
  });

  it('accepts an absent or cleared frequency (the dropdown\'s "—")', () => {
    expect(sellableItemFrequencyWriteError(undefined, null)).toBeNull();
    expect(sellableItemFrequencyWriteError(null, 'week')).toBeNull();
    expect(sellableItemFrequencyWriteError('', 'month')).toBeNull();
  });

  it('refuses a retired frequency on create', () => {
    for (const legacy of ['week', 'per_session']) {
      const err = sellableItemFrequencyWriteError(legacy, null);
      expect(err).toContain('no longer offered');
      expect(err).toContain('once, four_weeks, month, year');
    }
  });

  it('refuses moving an item onto a retired frequency', () => {
    expect(sellableItemFrequencyWriteError('week', 'month')).toContain('no longer offered');
    expect(sellableItemFrequencyWriteError('per_session', 'month')).toContain('no longer offered');
    // Neither retired value is a route onto the other.
    expect(sellableItemFrequencyWriteError('per_session', 'week')).toContain('no longer offered');
    expect(sellableItemFrequencyWriteError('week', 'per_session')).toContain('no longer offered');
  });

  it('carries a retired frequency through unchanged on an item that already stores it', () => {
    expect(sellableItemFrequencyWriteError('week', 'week')).toBeNull();
    expect(sellableItemFrequencyWriteError('per_session', 'per_session')).toBeNull();
  });

  it('lets a legacy item move to an offered frequency', () => {
    expect(sellableItemFrequencyWriteError('four_weeks', 'week')).toBeNull();
    // #945: the correction a per-session package is expected to make.
    expect(sellableItemFrequencyWriteError('once', 'per_session')).toBeNull();
  });

  it('refuses an unknown value with the offered list, whatever the row stores', () => {
    expect(sellableItemFrequencyWriteError('fortnight', null))
      .toBe('billing_frequency must be one of: once, four_weeks, month, year');
    expect(sellableItemFrequencyWriteError('fortnight', 'per_session'))
      .toBe('billing_frequency must be one of: once, four_weeks, month, year');
  });
});
