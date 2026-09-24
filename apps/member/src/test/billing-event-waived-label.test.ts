import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #635 stage 11 — My Membership renders each billing event as
// `t('membership.event.<type>')`, so the run's new `waived_billing` type needs
// a label in every locale: without one the member's free month renders as a
// missing-message error instead of saying the fee was waived.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function events(code: string): Record<string, string> {
  return JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8')).membership.event;
}

describe('waived_billing — member label', () => {
  it.each(LOCALE_CODES)('%s labels the waived event', (code) => {
    const label = events(code).waived_billing;
    expect(typeof label).toBe('string');
    expect(label.length).toBeGreaterThan(0);
  });

  it('labels the same set of event types in every locale', () => {
    const en = Object.keys(events('en')).sort();
    for (const code of LOCALE_CODES) {
      expect(Object.keys(events(code)).sort()).toEqual(en);
    }
  });
});
