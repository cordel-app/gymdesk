// #2883 — a Membership Fee charge that collects a Pre-paid Duration says how many billing periods it
// covers and their unit, in the plan's own cadence: `2 months pre-payment`, `2 × 4 weeks
// pre-payment`. The engine reports the count and the cadence on the line (see
// membership-fee-scope.unit.test.ts and plan-prepaid-first-charge.unit.test.ts); these are the two
// apps' pure halves that pick the sentence, and the sentences themselves.
//
// In the API suite because CI runs `npm test` in `api/` only.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { prepaidPaymentKey as adminKey, prepaidPaymentLabel } from '../../../apps/admin/src/lib/billingFrequency';
import { prepaidPaymentKey as memberKey } from '../../../apps/member/src/lib/memberPayments';

const REPO = join(__dirname, '..', '..', '..');
const LOCALES = ['en', 'es', 'ca'] as const;
const messages = (app: string, code: string) =>
  JSON.parse(readFileSync(join(REPO, 'apps', app, 'locales', 'base', `${code}.json`), 'utf-8'));

const CADENCES: Array<[{ interval: number; unit: string } | null, string]> = [
  [{ interval: 1, unit: 'month' }, 'month'],
  [{ interval: 4, unit: 'week' }, 'four_weeks'],
  [{ interval: 1, unit: 'week' }, 'week'],
  [{ interval: 1, unit: 'year' }, 'year'],
  [{ interval: 2, unit: 'month' }, 'periods'],
  [null, 'periods'],
];

describe('which sentence a prepaid charge takes', () => {
  it('follows the plan\'s cadence, the same answer in both apps', () => {
    for (const [cadence, suffix] of CADENCES) {
      expect(adminKey(cadence)).toBe(`prepaid_${suffix}`);
      expect(memberKey(2, cadence)).toBe(`prepaid_payment_${suffix}`);
    }
  });

  it('says nothing for a charge that is not a pre-payment', () => {
    const t = (key: string) => key;
    for (const count of [null, undefined, 0, -1, 1.5]) {
      expect(prepaidPaymentLabel(count as any, { interval: 1, unit: 'month' }, t)).toBeNull();
      expect(memberKey(count as any, { interval: 1, unit: 'month' })).toBeNull();
    }
  });

  it('hands the translator the count, never a computed amount', () => {
    const seen: Array<[string, unknown]> = [];
    prepaidPaymentLabel(2, { interval: 4, unit: 'week' }, (key, values) => { seen.push([key, values]); return key; });
    expect(seen).toEqual([['prepaid_four_weeks', { count: 2 }]]);
  });
});

describe('the sentences', () => {
  it('read as the issue writes them in English', () => {
    const admin = messages('admin', 'en').billing_frequency;
    expect(admin.prepaid_month).toBe('{count, plural, one {# month} other {# months}} pre-payment');
    expect(admin.prepaid_four_weeks).toBe('{count} × 4 weeks pre-payment');
  });

  it('exist in every locale of both apps, and the two apps say the same thing', () => {
    for (const code of LOCALES) {
      const admin = messages('admin', code).billing_frequency;
      const member = messages('member', code).payments;
      for (const suffix of ['month', 'week', 'year', 'four_weeks', 'periods']) {
        expect(admin[`prepaid_${suffix}`], `${code} admin prepaid_${suffix}`).toBeTruthy();
        expect(member[`prepaid_payment_${suffix}`], `${code} member prepaid_payment_${suffix}`)
          .toBe(admin[`prepaid_${suffix}`]);
      }
    }
  });
});
