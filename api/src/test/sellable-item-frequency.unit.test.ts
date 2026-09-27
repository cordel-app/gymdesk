// #821: the Sellable Item Billing Frequency rule — five offered choices, and
// 'week' readable but never configurable. Pure module, no DB and no HTTP.

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
  it('is exactly the five choices, in the order the dropdown lists them', () => {
    expect(OFFERED_SELLABLE_ITEM_FREQUENCIES).toEqual(['once', 'per_session', 'four_weeks', 'month', 'year']);
  });

  it('does not offer week', () => {
    expect(isOfferedSellableItemFrequency('week')).toBe(false);
    expect(OFFERED_SELLABLE_ITEM_FREQUENCIES).not.toContain('week');
  });

  it('keeps week as a stored value, so existing rows stay known', () => {
    expect(LEGACY_SELLABLE_ITEM_FREQUENCIES).toEqual(['week']);
    expect(isLegacySellableItemFrequency('week')).toBe(true);
    expect(isStoredSellableItemFrequency('week')).toBe(true);
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
    expect(describeOfferedFrequencies()).toBe('once, per_session, four_weeks, month, year');
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

  it('refuses week on create', () => {
    const err = sellableItemFrequencyWriteError('week', null);
    expect(err).toContain('no longer offered');
    expect(err).toContain('once, per_session, four_weeks, month, year');
  });

  it('refuses moving an item onto week', () => {
    expect(sellableItemFrequencyWriteError('week', 'month')).toContain('no longer offered');
  });

  it('carries week through unchanged on an item that already stores it', () => {
    expect(sellableItemFrequencyWriteError('week', 'week')).toBeNull();
  });

  it('lets a weekly item move to an offered frequency', () => {
    expect(sellableItemFrequencyWriteError('four_weeks', 'week')).toBeNull();
  });

  it('refuses an unknown value with the offered list, whatever the row stores', () => {
    expect(sellableItemFrequencyWriteError('fortnight', null))
      .toBe('billing_frequency must be one of: once, per_session, four_weeks, month, year');
    expect(sellableItemFrequencyWriteError('fortnight', 'week'))
      .toBe('billing_frequency must be one of: once, per_session, four_weeks, month, year');
  });
});
