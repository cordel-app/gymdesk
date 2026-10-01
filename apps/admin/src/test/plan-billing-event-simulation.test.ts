import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  PLAN_SECTION_ORDER,
  PlanSimulationBenefit,
  PlanSimulationLine,
  planSimulationPriceLabelKey,
} from '@/app/[locale]/plans/planProfile';

// #915 — the Membership Plan card's Billing Event Simulation.
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so the
// rendering is pinned by scanning the sources the way plan-example-timeline.test.ts
// does, while the declaration's pure part (the price label mapping) is exercised
// directly. The point of the file is the two properties a future edit could break
// silently: the section is declared rather than placed by the JSX, and every label
// the component asks for exists in all three locales.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const PLANS_PAGE = join(__dirname, '..', 'app', '[locale]', 'plans', 'page.tsx');
// #922: one component for both cards that render the section.
const COMPONENT = join(__dirname, '..', 'components', 'BillingEventSimulation.tsx');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const plansSrc = stripComments(readFileSync(PLANS_PAGE, 'utf-8'));
const componentSrc = stripComments(readFileSync(COMPONENT, 'utf-8'));

const plansLocales = Object.fromEntries(
  LOCALE_CODES.map((code) => [
    code,
    JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8')).plans ?? {},
  ]),
) as Record<(typeof LOCALE_CODES)[number], Record<string, string>>;

function line(over: Partial<PlanSimulationLine> = {}): PlanSimulationLine {
  return {
    kind: 'sellable_item',
    label: 'Locker Rental',
    gym_charge_id: 4,
    mandatory: false,
    quantity: 1,
    unit_price: 15,
    regular_price: 15,
    actual_charge: 15,
    benefits: [],
    ...over,
  };
}

const benefit = (over: Partial<PlanSimulationBenefit>): PlanSimulationBenefit => ({
  source: 'membership_plan', name: null, action: 'no_benefit', value: null, period_status: null, ...over,
});

describe('Plans: Billing Event Simulation', () => {
  it('is a declared section, last, after the Example Timeline', () => {
    expect(PLAN_SECTION_ORDER).toContain('section_billing_event_simulation');
    expect(PLAN_SECTION_ORDER.indexOf('section_billing_event_simulation'))
      .toBeGreaterThan(PLAN_SECTION_ORDER.indexOf('section_example_timeline'));
    // The two projections answer different questions and both stay on the card.
    expect(PLAN_SECTION_ORDER).toContain('section_example_timeline');
  });

  it('renders through the shared component, from the server-embedded field', () => {
    expect(plansSrc).toContain('<BillingEventSimulation');
    expect(plansSrc).toContain('plan.billing_event_simulation');
    expect(plansSrc).toContain("t('plans.section_billing_event_simulation')");
  });

  // The amounts and the dates are the server's: the component may format money
  // and dates, but it must not derive a price, a tax split or a next date.
  it('does no billing or tax arithmetic of its own', () => {
    expect(componentSrc).not.toMatch(/tax_rate|rate_percent|amount_excl_tax/);
    expect(componentSrc).not.toMatch(/setMonth|addMonths|advanceBilling/);
    // The only arithmetic allowed is the € formatter's own toFixed.
    expect(componentSrc.match(/toFixed\(/g) ?? []).toHaveLength(1);
  });

  it('maps every benefit action to a label, defaulting to the regular price', () => {
    expect(planSimulationPriceLabelKey(undefined)).toBe('simulation_price_regular');
    expect(planSimulationPriceLabelKey(benefit({ action: 'no_benefit' }))).toBe('simulation_price_regular');
    expect(planSimulationPriceLabelKey(benefit({ action: 'waive' }))).toBe('simulation_price_waived');
    // The pre-#896 spelling of "the grant made it free" reads the same way.
    expect(planSimulationPriceLabelKey(benefit({ action: 'included' }))).toBe('simulation_price_waived');
    expect(planSimulationPriceLabelKey(benefit({ action: 'percentage_discount', value: 20 })))
      .toBe('simulation_price_percentage');
    expect(planSimulationPriceLabelKey(benefit({ action: 'fixed_discount', value: 5 })))
      .toBe('simulation_price_fixed_discount');
    expect(planSimulationPriceLabelKey(benefit({ action: 'fixed_price', value: 5 })))
      .toBe('simulation_price_fixed_price');
  });

  it('has every label the section asks for in en, es and ca', () => {
    const keys = [
      'section_billing_event_simulation',
      'simulation_example_note',
      'simulation_unavailable',
      'simulation_mandatory',
      'simulation_total',
      'simulation_regular_was',
      'simulation_price_regular',
      'simulation_price_waived',
      'simulation_price_percentage',
      'simulation_price_fixed_discount',
      'simulation_price_fixed_price',
      'simulation_disclaimer',
      'simulation_truncated',
      // Reused rather than restated — the Example Timeline already says it.
      'tax_included_suffix',
    ];
    for (const code of LOCALE_CODES) {
      for (const key of keys) {
        expect(plansLocales[code][key], `${code}.plans.${key}`).toBeTruthy();
      }
    }
  });

  it('keeps the interpolations the labels declare', () => {
    for (const code of LOCALE_CODES) {
      expect(plansLocales[code].simulation_example_note).toContain('{date}');
      expect(plansLocales[code].simulation_regular_was).toContain('{amount}');
      expect(plansLocales[code].simulation_price_percentage).toContain('{value}');
      expect(plansLocales[code].simulation_price_fixed_discount).toContain('{amount}');
      expect(plansLocales[code].simulation_price_fixed_price).toContain('{amount}');
    }
  });

  // A line is a value object here only so the shape stays asserted somewhere: a
  // waived line keeps its regular price, which is what the card shows beside €0.
  it('keeps a waived line’s regular price alongside its €0 charge', () => {
    const waived = line({ actual_charge: 0, benefits: [benefit({ action: 'waive' })] });
    expect(waived.regular_price).toBe(15);
    expect(waived.actual_charge).toBe(0);
    expect(waived.actual_charge).not.toBe(waived.regular_price);
  });
});
