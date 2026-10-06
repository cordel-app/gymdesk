import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  billingFrequencyDurationKey,
  billingFrequencyDurationLabel,
} from '@/lib/billingFrequency';

// #1135 — how long N periods of a frequency is, which is what a Periodic
// Promotion's Duration means. Pure module, no React and no next-intl: `tFreq` is
// a translator the caller passes in, so the behaviour is assertable without a
// provider and the locale messages are checked against the real files below.

const LOCALES = ['en', 'es', 'ca'] as const;

function messages(code: string): any {
  return JSON.parse(readFileSync(
    join(__dirname, '..', '..', 'locales', 'base', `${code}.json`), 'utf-8',
  ));
}

/** Resolves against the real `billing_frequency` namespace, ICU and all. */
function translator(code: string) {
  const ns = messages(code).billing_frequency;
  return (key: string, values?: Record<string, number>): string => {
    const raw: string = ns[key];
    if (raw == null) return `billing_frequency.${key}`;
    const count = values?.count ?? 0;
    return raw.replace(
      /\{count, plural, one \{([^}]*)\} other \{([^}]*)\}\}/,
      (_m, one: string, other: string) => (count === 1 ? one : other).replace('#', String(count)),
    ).replace('{count}', String(count));
  };
}

describe('billingFrequencyDurationKey', () => {
  it('names a key for every frequency that is a period', () => {
    expect(billingFrequencyDurationKey('month')).toBe('duration_month');
    expect(billingFrequencyDurationKey('four_weeks')).toBe('duration_four_weeks');
    expect(billingFrequencyDurationKey('year')).toBe('duration_year');
    // Retired from the Product dropdown (#821) and still stored, so still displayed.
    expect(billingFrequencyDurationKey('week')).toBe('duration_week');
  });

  it('names none for a value that is not a period', () => {
    // There is no such thing as three `Once`s, and `per_session` is not a period
    // either (#945). `null` is what makes a caller show the bare number.
    expect(billingFrequencyDurationKey('once')).toBeNull();
    expect(billingFrequencyDurationKey('per_session')).toBeNull();
    expect(billingFrequencyDurationKey(null)).toBeNull();
    expect(billingFrequencyDurationKey(undefined)).toBeNull();
    expect(billingFrequencyDurationKey('fortnight')).toBeNull();
  });
});

describe('billingFrequencyDurationLabel', () => {
  const t = translator('en');

  it('reads the ticket’s own example: 3 + Monthly is 3 months', () => {
    expect(billingFrequencyDurationLabel('month', 3, t)).toBe('3 months');
  });

  it('handles the singular', () => {
    expect(billingFrequencyDurationLabel('month', 1, t)).toBe('1 month');
    expect(billingFrequencyDurationLabel('year', 1, t)).toBe('1 year');
    expect(billingFrequencyDurationLabel('year', 2, t)).toBe('2 years');
  });

  it('counts 4-week periods the way a Plan’s duration already does', () => {
    // `2 × 4 Weeks` (#892 §9) — "3 every 4 weeks" is not a sentence.
    expect(billingFrequencyDurationLabel('four_weeks', 3, t)).toBe('3 × 4 weeks');
  });

  it('says nothing for a frequency that names no period', () => {
    expect(billingFrequencyDurationLabel('once', 3, t)).toBeNull();
    expect(billingFrequencyDurationLabel(null, 3, t)).toBeNull();
  });

  it('says nothing for a count that is not a positive whole number', () => {
    // A draft row mid-typing, or a column read back as something unexpected: the
    // caller falls back to the stored number rather than printing `0 months`.
    expect(billingFrequencyDurationLabel('month', 0, t)).toBeNull();
    expect(billingFrequencyDurationLabel('month', -2, t)).toBeNull();
    expect(billingFrequencyDurationLabel('month', 1.5, t)).toBeNull();
    expect(billingFrequencyDurationLabel('month', Number.NaN, t)).toBeNull();
  });

  it('is translated in every locale, and never falls through to the key', () => {
    for (const code of LOCALES) {
      const tl = translator(code);
      for (const freq of ['month', 'four_weeks', 'year', 'week']) {
        const label = billingFrequencyDurationLabel(freq, 3, tl);
        expect(label, `${code} ${freq}`).toBeTruthy();
        expect(label, `${code} ${freq} printed the key`).not.toContain('billing_frequency.');
        expect(label, `${code} ${freq} dropped the count`).toContain('3');
      }
    }
  });
});
