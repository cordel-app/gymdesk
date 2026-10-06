import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_PLAN_BILLING_FREQUENCY,
  PLAN_BILLING_FREQUENCIES,
  PLAN_BILLING_FREQUENCY_OPTIONS,
  legacyBillingFrequencyText,
  planBillingFrequencyCadence,
  planBillingFrequencyOf,
  planBillingPolicyBody,
} from '@/app/[locale]/plans/planProfile';

// #820 — Billing Frequency is a single dropdown of two options.
//
//   Before:  Billing Frequency  [ 4 ] [ week ▼ ]   (the whole unit ENUM)
//   After:   Billing Frequency  [ 4 Weeks ▼ ]
//
// The number box is gone and the unit list with it; what is *stored* is
// unchanged — the same `recurring_billing_interval` + `recurring_billing_unit`
// pair, derived from the choice, because that pair is what every assignment
// snapshots and what the nightly run steps. The API enforces the same two pairs
// (`api/src/domain/planBillingFrequency.ts`, exercised by
// `membership-plans.test.ts`), so this file covers the declaration and the two
// places the page renders it.
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so the
// page is pinned by scanning its source the way plans-expanded-read-only.test.ts
// does, while the declaration's pure parts are exercised directly.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const PLANS_DIR = join(__dirname, '..', 'app', '[locale]', 'plans');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const pageSrc = stripComments(readFileSync(join(PLANS_DIR, 'page.tsx'), 'utf-8'));
const detailSrc = stripComments(readFileSync(join(PLANS_DIR, 'PlanDetailModal.tsx'), 'utf-8'));

function plansNamespace(code: string): Record<string, string> {
  const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
  return (messages.plans ?? {}) as Record<string, string>;
}

describe('the declaration: two options, one stored pair each', () => {
  it('offers exactly Month and 4 Weeks, in that order', () => {
    expect(PLAN_BILLING_FREQUENCIES).toEqual(['month', 'four_weeks']);
  });

  it('maps each option onto the pair the API stores', () => {
    expect(planBillingFrequencyCadence('month')).toEqual({ interval: 1, unit: 'month' });
    expect(planBillingFrequencyCadence('four_weeks')).toEqual({ interval: 4, unit: 'week' });
  });

  it('defaults a new plan to Month', () => {
    expect(DEFAULT_PLAN_BILLING_FREQUENCY).toBe('month');
  });

  it('builds the billing-policy body both writers send', () => {
    expect(planBillingPolicyBody('month', true)).toEqual({
      recurring_billing_interval: 1, recurring_billing_unit: 'month', auto_renew: true,
    });
    expect(planBillingPolicyBody('four_weeks', false)).toEqual({
      recurring_billing_interval: 4, recurring_billing_unit: 'week', auto_renew: false,
    });
  });

  it('reads a stored pair back to its option', () => {
    expect(planBillingFrequencyOf(1, 'month')).toBe('month');
    expect(planBillingFrequencyOf(4, 'week')).toBe('four_weeks');
    expect(planBillingFrequencyOf('4', 'week')).toBe('four_weeks');
  });

  it('answers null for a cadence configured before the rule, rather than relabelling it', () => {
    expect(planBillingFrequencyOf(2, 'month')).toBeNull();
    expect(planBillingFrequencyOf(1, 'week')).toBeNull();
    expect(planBillingFrequencyOf(null, undefined)).toBeNull();
  });

  it('keeps the pre-#820 wording for such a cadence', () => {
    expect(legacyBillingFrequencyText(2, 'month')).toBe('Every 2 months');
    expect(legacyBillingFrequencyText(1, 'week')).toBe('Every week');
  });
});

describe('the editor renders one dropdown and no numeric input (#820)', () => {
  it('drops the interval number box and the unit list', () => {
    expect(pageSrc).not.toContain('BILLING_UNITS');
    expect(pageSrc).not.toContain('plan-${plan.id}-billing-interval');
    expect(pageSrc).not.toContain('durationForm.recurring_billing_interval');
    expect(pageSrc).not.toContain('durationForm.recurring_billing_unit');
  });

  it('builds the options from the declaration, so the list cannot drift', () => {
    expect(pageSrc).toContain('PLAN_BILLING_FREQUENCIES.map((freq) => (');
    expect(pageSrc).toContain('PLAN_BILLING_FREQUENCY_OPTIONS[freq].labelKey');
    expect(pageSrc).toContain('billing_frequency: e.target.value as PlanBillingFrequency');
  });

  it('labels the control, as the inline form must (#800)', () => {
    expect(pageSrc).toContain('htmlFor={`plan-${plan.id}-billing-frequency`}');
    expect(pageSrc).toContain('id={`plan-${plan.id}-billing-frequency`}');
  });

  it('still submits the interval/unit pair the API expects, from the shared builder', () => {
    expect(pageSrc).toContain('planBillingPolicyBody(durationForm.billing_frequency, durationForm.auto_renew)');
    // The default policy a new Plan is created with comes from the same builder,
    // so the two writers cannot disagree about the pair.
    expect(pageSrc).toContain('planBillingPolicyBody(DEFAULT_PLAN_BILLING_FREQUENCY, true)');
  });

  it('seeds the choice from the saved policy and never coerces a legacy one', () => {
    expect(pageSrc).toContain('billing_frequency: (bp && planBillingFrequencyOf(bp.recurring_billing_interval, bp.recurring_billing_unit))');
    expect(pageSrc).toContain('legacy_cadence: bp && !planBillingFrequencyOf(bp.recurring_billing_interval, bp.recurring_billing_unit)');
    expect(pageSrc).toContain("t('plans.billing_frequency_legacy_notice'");
  });
});

describe('the read-only halves name the cadence the same way', () => {
  it('renders the Billing frequency row through the shared helper', () => {
    // #879 turned the read-only row into an item of the shared compact
    // summary, so the call is an object property rather than a JSX prop — what
    // this pins is the call itself, never the syntax around it.
    expect(pageSrc).toContain('billingFrequencyText(plan.billing_policy.recurring_billing_interval, plan.billing_policy.recurring_billing_unit)');
    expect(pageSrc).toMatch(/const billingFrequencyText = [\s\S]{0,400}legacyBillingFrequencyText\(interval, unit\)/);
  });

  it('gives the Details modal the same labels instead of its own formatter', () => {
    expect(detailSrc).not.toContain('function fmtBillingInterval');
    expect(detailSrc).toContain('planBillingFrequencyOf(plan.billing_policy.recurring_billing_interval, plan.billing_policy.recurring_billing_unit)');
    expect(detailSrc).toContain('PLAN_BILLING_FREQUENCY_OPTIONS[billingFrequency].labelKey');
  });

  it('describes a new plan\'s default cadence with the option label', () => {
    expect(pageSrc).toContain('billing: tFreq(PLAN_BILLING_FREQUENCY_OPTIONS[DEFAULT_PLAN_BILLING_FREQUENCY].labelKey)');
  });
});

describe('translations', () => {
  // #1128: the frequency's own label left the `plans` namespace for the one
  // `billing_frequency` namespace every surface reads it from — asserted, in all
  // three locales, by `api/src/test/billing-frequency-labels.unit.test.ts`. What
  // stays here is what is still the Plan's own: the period noun a duration is
  // counted in, and the legacy-cadence notice.
  it.each(LOCALE_CODES)('%s names one period of each option, plus the legacy notice', (code) => {
    const plans = plansNamespace(code);
    for (const freq of PLAN_BILLING_FREQUENCIES) {
      const key = PLAN_BILLING_FREQUENCY_OPTIONS[freq].periodLabelKey;
      expect(plans[key], `${code}.plans.${key}`).toBeTruthy();
      // The frequency label is not duplicated back into this namespace.
      expect(plans[PLAN_BILLING_FREQUENCY_OPTIONS[freq].labelKey]).toBeUndefined();
    }
    expect(plans.billing_frequency_legacy_notice, `${code}.plans.billing_frequency_legacy_notice`).toContain('{current}');
  });

  it('counts a duration in "Month" and "4 Weeks", as #892 §9 writes them', () => {
    const plans = plansNamespace('en');
    expect(plans.period_unit_month).toBe('Month');
    expect(plans.period_unit_four_weeks).toBe('4 Weeks');
  });
});
