import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  BillingEventSimulationBenefit,
  BillingEventSimulationDate,
  BillingEventSimulationLine,
  allExpandedPeriods,
  everyPeriodExpanded,
  initialExpandedPeriods,
  simulationLineTone,
} from '@/lib/billingEventSimulation';

// #955 — the Billing Event Simulation is one **collapsible card per billing
// period**: date, number of lines and that period's total in the header, the
// lines themselves in an Example-Timeline-styled table underneath when the card
// is open, and one global Expand all / Collapse all control over the lot.
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so the
// rendering is pinned by scanning the sources the way its two sibling files do,
// while the pure half — which tone a line reads in, which cards start open and
// what the global control currently says — is exercised directly.
//
// The properties a future edit could break silently are the ticket's own: one
// presentation for every consumer, the Example Timeline's colours rather than a
// second palette, no Total row under the lines, the first period open and the
// rest closed, and no billing arithmetic anywhere in the page.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const COMPONENT = join(__dirname, '..', 'components', 'BillingEventSimulation.tsx');
const TIMELINE = join(__dirname, '..', 'components', 'ExampleTimeline.tsx');
const PLANS_PAGE = join(__dirname, '..', 'app', '[locale]', 'plans', 'page.tsx');
const PROMOTIONS_PAGE = join(__dirname, '..', 'app', '[locale]', 'promotions', 'page.tsx');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;
const NAMESPACES = ['plans', 'promotions'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const componentSrc = stripComments(readFileSync(COMPONENT, 'utf-8'));
const timelineSrc = stripComments(readFileSync(TIMELINE, 'utf-8'));
const plansSrc = stripComments(readFileSync(PLANS_PAGE, 'utf-8'));
const promotionsSrc = stripComments(readFileSync(PROMOTIONS_PAGE, 'utf-8'));

const locales = Object.fromEntries(
  LOCALE_CODES.map((code) => [code, JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'))]),
) as Record<(typeof LOCALE_CODES)[number], Record<string, Record<string, string>>>;

const benefit = (over: Partial<BillingEventSimulationBenefit>): BillingEventSimulationBenefit => ({
  source: 'membership_plan', name: null, action: 'no_benefit', value: null, period_status: null, ...over,
});

function line(over: Partial<BillingEventSimulationLine> = {}): BillingEventSimulationLine {
  return {
    kind: 'sellable_item',
    label: 'Locker Rental',
    gym_charge_id: 4,
    mandatory: false,
    quantity: 1,
    unit_price: 15,
    regular_price: 15,
    actual_charge: 15,
    prepaid_periods: null,
    benefits: [],
    ...over,
  };
}

const group = (date: string, lines = [line()]): BillingEventSimulationDate => ({
  date, lines, total: lines.reduce((sum, l) => sum + l.actual_charge, 0),
});

describe('#955 — a line’s tone is the Example Timeline’s own semantics', () => {
  it('reads an ordinary charge as the regular tone', () => {
    expect(simulationLineTone(line())).toBe('regular');
    expect(simulationLineTone(line({ benefits: [benefit({ action: 'no_benefit' })] }))).toBe('regular');
  });

  it('reads a waived line as free — both spellings of it', () => {
    expect(simulationLineTone(line({ actual_charge: 0, benefits: [benefit({ action: 'waive' })] }))).toBe('free');
    // The pre-#896 spelling of "the grant made it free".
    expect(simulationLineTone(line({ actual_charge: 0, benefits: [benefit({ action: 'included' })] }))).toBe('free');
  });

  it('reads a discounted line, and #946’s prepaid lump, as the promotional tone', () => {
    expect(simulationLineTone(line({
      actual_charge: 12, benefits: [benefit({ action: 'percentage_discount', value: 20 })],
    }))).toBe('benefit');
    expect(simulationLineTone(line({
      actual_charge: 10, benefits: [benefit({ action: 'fixed_price', value: 10 })],
    }))).toBe('benefit');
    expect(simulationLineTone(line({
      kind: 'membership_fee', label: 'Membership Fee', gym_charge_id: null,
      regular_price: 210, actual_charge: 210, prepaid_periods: 3,
    }))).toBe('benefit');
  });

  // A waive beside a discount is still free: the member is charged nothing, and
  // amber would say they were charged something.
  it('lets a waive win over another action on the same line', () => {
    expect(simulationLineTone(line({
      actual_charge: 0,
      benefits: [benefit({ action: 'percentage_discount', value: 20 }), benefit({ action: 'waive' })],
    }))).toBe('free');
  });

  // €0.00 is also what an item with no price costs, so the tone is read off the
  // treatment the server reported and never off the amount.
  it('does not call a €0 line free on the amount alone', () => {
    expect(simulationLineTone(line({ unit_price: 0, regular_price: 0, actual_charge: 0 }))).toBe('regular');
  });
});

describe('#955 — which cards are open', () => {
  const dates = [group('2026-10-01'), group('2026-10-31'), group('2026-11-30')];

  it('opens the first billing period and closes the rest', () => {
    expect(initialExpandedPeriods(dates)).toEqual({
      '2026-10-01': true, '2026-10-31': false, '2026-11-30': false,
    });
  });

  it('keys the state by the period’s own date, so one card toggles alone', () => {
    const expanded: Record<string, boolean> = { ...initialExpandedPeriods(dates), '2026-10-31': true };
    expect(expanded['2026-10-01']).toBe(true);
    expect(expanded['2026-11-30']).toBe(false);
    expect(everyPeriodExpanded(dates, expanded)).toBe(false);
  });

  it('applies the global control to every period', () => {
    expect(everyPeriodExpanded(dates, allExpandedPeriods(dates, true))).toBe(true);
    expect(everyPeriodExpanded(dates, allExpandedPeriods(dates, false))).toBe(false);
    expect(Object.keys(allExpandedPeriods(dates, true))).toHaveLength(dates.length);
  });

  it('is not "all expanded" with no periods at all — the control is not rendered then', () => {
    expect(everyPeriodExpanded([], {})).toBe(false);
    expect(initialExpandedPeriods([])).toEqual({});
  });
});

describe('#955 — the presentation is one component, in the Example Timeline’s language', () => {
  it('is rendered by both consumers, with no second implementation', () => {
    for (const src of [plansSrc, promotionsSrc]) {
      expect(src).toContain("from '@/components/BillingEventSimulation'");
      expect(src).toContain('<BillingEventSimulation');
    }
    // Neither page draws a period card, a toggle or a billing table of its own.
    for (const src of [plansSrc, promotionsSrc]) {
      expect(src).not.toMatch(/BillingPeriodCard|BillingEventTable|simulation_expand_all|simulation_col_/);
    }
  });

  it('builds the card and the table from the shared pieces rather than new ones', () => {
    expect(componentSrc).toContain("from './ExampleTimeline'");
    expect(componentSrc).toContain('TIMELINE_TONE_BACKGROUND');
    expect(componentSrc).toContain('TIMELINE_TONE_TEXT');
    expect(componentSrc).toContain('timelineThStyle');
    expect(componentSrc).toContain('timelineTdStyle');
    // The card and the global control are the application's own chrome (#929).
    expect(componentSrc).toContain('innerCardStyle');
    expect(componentSrc).toContain('secondaryBtnSmall');
  });

  it('introduces no colour of its own for a billing state', () => {
    // The only literals left are the muted greys the section already used; the
    // tones — and every hex that carries a billing meaning — stay the timeline's.
    const timelineHexes = ['#f0fdf4', '#fefce8', '#f9fafb', '#166534', '#854d0e'];
    for (const hex of timelineHexes) {
      expect(timelineSrc).toContain(hex);
      expect(componentSrc).not.toContain(hex);
    }
  });

  it('puts the total in the card header and keeps no Total row under the lines', () => {
    expect(componentSrc).toContain("t('simulation_total')");
    expect(componentSrc).not.toMatch(/totalRow/);
    // The header summary is the ticket's three facts.
    expect(componentSrc).toContain('simulation_items_count');
    expect(componentSrc).toContain('group.lines.length');
    expect(componentSrc).toContain('group.total');
  });

  it('makes the whole header the expand control, operable by keyboard', () => {
    expect(componentSrc).toMatch(/<button[\s\S]*?aria-expanded=\{expanded\}/);
    expect(componentSrc).toContain('aria-hidden="true"');
  });

  it('offers the global control only when more than one period exists', () => {
    expect(componentSrc).toContain('const showGlobalToggle = dates.length > 1;');
    expect(componentSrc).toContain('simulation_collapse_all');
    expect(componentSrc).toContain('simulation_expand_all');
  });

  // The ticket is explicit that this is a presentation refactor: the amounts, the
  // dates and the treatments are the server's, and the component only formats.
  it('does no billing or tax arithmetic of its own', () => {
    expect(componentSrc).not.toMatch(/tax_rate|rate_percent|amount_excl_tax/);
    expect(componentSrc).not.toMatch(/setMonth|addMonths|advanceBilling/);
    expect(componentSrc).not.toMatch(/reduce\(/);
    expect(componentSrc.match(/toFixed\(/g) ?? []).toHaveLength(1);
  });

  it('fetches nothing when a card is expanded', () => {
    expect(componentSrc).not.toMatch(/apiFetch|fetch\(/);
  });
});

describe('#955 — the new labels exist in both namespaces, in all three locales', () => {
  const keys = [
    'simulation_items_count',
    'simulation_expand_all',
    'simulation_collapse_all',
    'simulation_col_date',
    'simulation_col_event',
    'simulation_col_status',
    'simulation_col_amount',
  ];

  it('has every one of them', () => {
    for (const code of LOCALE_CODES) {
      for (const ns of NAMESPACES) {
        for (const key of keys) {
          expect(locales[code][ns][key], `${code}.${ns}.${key}`).toBeTruthy();
        }
      }
    }
  });

  it('pluralises the item count rather than printing a bare number', () => {
    for (const code of LOCALE_CODES) {
      for (const ns of NAMESPACES) {
        expect(locales[code][ns].simulation_items_count).toContain('{count, plural,');
      }
    }
  });

  // #896 §3 — the Promotions UI must not contain the word "Benefit" anywhere.
  it('says nothing about a "benefit" in the Promotions namespace', () => {
    for (const key of keys) {
      expect(locales.en.promotions[key].toLowerCase(), key).not.toContain('benefit');
    }
  });
});
