// #892 — a Membership Plan's durations read in the unit they are counted in.
//
// The rule itself is the API's (`api/src/domain/planDuration.ts`); what this
// file pins is the half a gym owner actually sees: the four fields are declared
// once beside the Billing Frequency that gives them their unit, every surface
// renders them through one formatter, the editor's suffix follows the dropdown
// rather than the stored value, and Promotions — explicitly out of scope — keep
// their calendar months.
//
// Source-scan style, like every other apps/admin test: this repo has no
// component-test infra (docs/architecture.md's TL;DR).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  PLAN_DURATION_FIELDS,
  formatPlanDurationPeriods,
  planDurationUnitLabel,
} from '../app/[locale]/plans/planProfile';

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const PLANS_PAGE = join(__dirname, '..', 'app', '[locale]', 'plans', 'page.tsx');
const PLAN_PROFILE = join(__dirname, '..', 'app', '[locale]', 'plans', 'planProfile.ts');
const DETAIL_MODAL = join(__dirname, '..', 'app', '[locale]', 'plans', 'PlanDetailModal.tsx');
const PROMOTIONS_PAGE = join(__dirname, '..', 'app', '[locale]', 'promotions', 'page.tsx');
const ASSIGNED_CONFIG = join(
  __dirname, '..', 'components', 'assignedPlan', 'AssignedPlanConfiguration.tsx',
);
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

type Messages = Record<string, any>;

const locales = Object.fromEntries(
  LOCALE_CODES.map((c) => [c, JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8'))]),
) as Record<(typeof LOCALE_CODES)[number], Messages>;

const read = (p: string) => readFileSync(p, 'utf-8');

/** next-intl's interpolation, close enough for asserting what a label reads. */
function translator(namespace: 'plans' | 'assigned_plans_page', code: (typeof LOCALE_CODES)[number] = 'en') {
  const ns = locales[code][namespace] as Record<string, string>;
  return (key: string, values?: Record<string, unknown>): string => {
    const raw = ns[key];
    if (raw == null) return `${namespace}.${key}`; // what next-intl prints for a missing key
    return raw.replace(/\{(\w+)\}/g, (_m, name) => String(values?.[name] ?? `{${name}}`));
  };
}

const MONTH = { recurring_billing_interval: 1, recurring_billing_unit: 'month' };
const FOUR_WEEKS = { recurring_billing_interval: 4, recurring_billing_unit: 'week' };
const LEGACY = { recurring_billing_interval: 2, recurring_billing_unit: 'month' };

describe('#892: the four duration fields are declared once', () => {
  it('is the Promotion\'s order, renamed for what the numbers count', () => {
    expect(PLAN_DURATION_FIELDS).toEqual([
      'free_periods', 'paid_periods', 'pay_beforehand_periods', 'bonus_periods',
    ]);
  });

  it('the page takes the list from the declaration rather than restating it', () => {
    const src = read(PLANS_PAGE);
    expect(src).toContain('const DURATION_FIELDS = PLAN_DURATION_FIELDS;');
    expect(src).not.toMatch(/const DURATION_FIELDS = \[/);
  });
});

describe('#892: a duration reads in its own unit', () => {
  const t = translator('plans');

  it('says "2 × 4 Weeks" for a 4-weekly Plan (§9)', () => {
    expect(formatPlanDurationPeriods(2, FOUR_WEEKS, t)).toBe('2 × 4 Weeks');
  });

  it('keeps "2 month(s)" for a monthly Plan — a monthly period is a month', () => {
    expect(formatPlanDurationPeriods(2, MONTH, t)).toBe('2 month(s)');
  });

  // "2 × Every 2 months" reads as nonsense, and the Billing Frequency row
  // beside it already names what the Plan bills on.
  it('falls back to the neutral period form for a legacy cadence', () => {
    expect(planDurationUnitLabel(LEGACY, t)).toBeNull();
    expect(formatPlanDurationPeriods(2, LEGACY, t)).toBe('2 period(s)');
  });

  it('does the same for a Plan with no billing policy at all', () => {
    expect(formatPlanDurationPeriods(2, null, t)).toBe('2 period(s)');
  });

  it('reads "Not configured" for an unset field, never 0 (§4)', () => {
    expect(formatPlanDurationPeriods(null, FOUR_WEEKS, t)).toBe('Not configured');
    expect(formatPlanDurationPeriods(undefined, MONTH, t)).toBe('Not configured');
    expect(formatPlanDurationPeriods(0, MONTH, t)).toBe('0 month(s)');
  });

  it('resolves in every locale — no key prints verbatim', () => {
    for (const code of LOCALE_CODES) {
      const tl = translator('plans', code);
      for (const value of [formatPlanDurationPeriods(2, FOUR_WEEKS, tl),
        formatPlanDurationPeriods(2, MONTH, tl),
        formatPlanDurationPeriods(2, null, tl),
        formatPlanDurationPeriods(null, MONTH, tl)]) {
        expect(value, `${code} prints a missing key`).not.toContain('plans.');
        expect(value).not.toContain('{');
      }
    }
  });
});

describe('#892: every Plan surface renders through the one formatter', () => {
  it('the card summary does', () => {
    expect(read(PLANS_PAGE)).toContain('formatPlanDurationPeriods(plan[field], plan.billing_policy, planT)');
  });

  it('the Details modal does', () => {
    const src = read(DETAIL_MODAL);
    expect(src).toContain('formatPlanDurationPeriods(value, plan.billing_policy');
    expect(src).not.toContain("t('months_value'");
  });

  // §3/§6 — the unit beside each input follows the dropdown, so changing the
  // Billing Frequency changes what the number means on screen and never the
  // number itself.
  it('the editor labels each input with the *selected* frequency, not the stored one', () => {
    const src = read(PLANS_PAGE);
    expect(src).toContain("t('plans.periods_unit_suffix', {");
    expect(src).toContain('PLAN_BILLING_FREQUENCY_OPTIONS[durationForm.billing_frequency].labelKey');
    // Saving still sends only the four numbers and the cadence — no conversion.
    expect(src).toMatch(/raw === ''\s*\?\s*null\s*:\s*parseInt\(raw, 10\)/);
  });

  it('the Assigned Plan snapshot says which unit its own durations are in', () => {
    const src = read(ASSIGNED_CONFIG);
    expect(src).toContain('durationText(');
    expect(src).toContain("t('periods_value_plain', { n: value })");
    expect(src).toContain("t('duration_periods_hint')");
  });
});

describe('#892: locale coverage', () => {
  const PLAN_KEYS = [
    'label_free_periods', 'label_paid_periods', 'label_pay_beforehand_periods', 'label_bonus_periods',
    'months_value', 'periods_value', 'periods_value_plain', 'periods_unit_suffix',
    'not_configured', 'desc_billing_duration', 'timeline_duration_disclaimer',
  ];
  const ASSIGNED_KEYS = [
    'label_free_periods', 'label_paid_periods', 'label_pay_beforehand_periods', 'label_bonus_periods',
    'periods_value_plain', 'duration_periods_hint', 'months_value',
  ];

  for (const code of LOCALE_CODES) {
    it(`${code}.json defines every key the two screens render`, () => {
      for (const key of PLAN_KEYS) {
        expect(locales[code].plans, `plans.${key} missing from ${code}`).toHaveProperty(key);
      }
      for (const key of ASSIGNED_KEYS) {
        expect(locales[code].assigned_plans_page, `assigned_plans_page.${key} missing from ${code}`)
          .toHaveProperty(key);
      }
    });

    it(`${code}.json no longer claims the durations are calendar months`, () => {
      const disclaimer = locales[code].plans.timeline_duration_disclaimer as string;
      expect(disclaimer.toLowerCase()).not.toMatch(/calendar month|meses naturales|mesos naturals/);
    });
  }
});

describe('#892 leaves Promotions alone', () => {
  it('the Promotions page still labels and renders its durations in months', () => {
    const src = read(PROMOTIONS_PAGE);
    expect(src).toContain("t('label_free_months')");
    expect(src).not.toContain('free_periods');
    for (const code of LOCALE_CODES) {
      expect(locales[code].promotions).toHaveProperty('label_free_months');
    }
  });

  it('the declaration is the Plan\'s only — nothing exports a Promotion period count', () => {
    expect(read(PLAN_PROFILE)).not.toContain('promotion_periods');
  });
});
