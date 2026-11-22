import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #635 stage 11 — the nightly billing run records a `waived_billing` event for
// a cycle nothing was owed on (a Free Period, a Bonus Duration, or an applied
// Promotion's own free month). Every surface that names a billing event type
// therefore has to know the new one (#3241 removed the Member card's own
// ledger, so the memberships ledger is the surface left here), or a member's free month reads as a raw
// `waived_billing` string — or, on a `t()` call with no key behind it, as a
// missing-message error.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LEDGER_MODAL = join(__dirname, '..', 'app', '[locale]', 'memberships', 'MembershipLedgerModal.tsx');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function loadLocale(code: string): Record<string, any> {
  return JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('waived_billing — admin labels', () => {
  it.each(LOCALE_CODES)('%s has the ledger label alongside the other event types', (code) => {
    const events = loadLocale(code)?.memberships?.event;
    expect(Object.keys(events)).toContain('waived_billing');
    expect(typeof events.waived_billing).toBe('string');
  });

  it('accepts the type in the ledger modal\'s event union', () => {
    const src = stripComments(readFileSync(LEDGER_MODAL, 'utf-8'));
    expect(src).toMatch(/event_type:[^;]*'waived_billing'/);
  });

  // It is written by the billing run only — the manual "record a payment" form
  // must not offer it as something staff can create.
  it('is not offered as a manually recordable event type', () => {
    const src = stripComments(readFileSync(LEDGER_MODAL, 'utf-8'));
    expect(src).not.toMatch(/<option value="waived_billing"/);
  });
});
