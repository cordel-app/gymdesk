import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { simulationPriceLabelKey } from '@/lib/billingEventSimulation';

// #922 — the Promotion card's Billing Event Simulation.
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so the
// wiring is pinned by scanning the sources the way its Plan-side sibling does.
// The two properties a future edit could break silently are the ticket's own:
// the section renders through the *shared* component rather than a second
// Promotion-only copy of it, and every label it asks for exists in all three
// locales under the `promotions` namespace (next-intl prints a missing key
// verbatim).

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const PROMOTIONS_PAGE = join(__dirname, '..', 'app', '[locale]', 'promotions', 'page.tsx');
const COMPONENT = join(__dirname, '..', 'components', 'BillingEventSimulation.tsx');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const pageSrc = stripComments(readFileSync(PROMOTIONS_PAGE, 'utf-8'));
const componentSrc = stripComments(readFileSync(COMPONENT, 'utf-8'));

const promotionLocales = Object.fromEntries(
  LOCALE_CODES.map((code) => [
    code,
    JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8')).promotions ?? {},
  ]),
) as Record<(typeof LOCALE_CODES)[number], Record<string, string>>;

describe('Promotions: Billing Event Simulation', () => {
  it('renders the shared component, off the server-computed projection', () => {
    expect(pageSrc).toContain("from '@/components/BillingEventSimulation'");
    expect(pageSrc).toContain('<BillingEventSimulation');
    expect(pageSrc).toContain('/billing-event-simulation');
    expect(pageSrc).toContain("t('section_billing_event_simulation')");
  });

  it('keeps the Example Timeline beside it — neither projection replaces the other', () => {
    expect(pageSrc).toContain('{renderTimeline()}');
    expect(pageSrc).toContain('{renderBillingEventSimulation(promo)}');
  });

  // The section is read-only by nature: it is a projection of what billing
  // would do, so nothing in the card may offer to edit it.
  it('is read-only — no editor, no section Edit button, no draft', () => {
    const section = pageSrc.slice(
      pageSrc.indexOf('function renderBillingEventSimulation'),
      pageSrc.indexOf('function renderMainFields'),
    );
    expect(section).toContain('<BillingEventSimulation');
    expect(section).not.toMatch(/SectionEditButton|enterSectionEdit|onChange|<input|<select/);
  });

  // The amounts and the dates are the server's: the component may format money
  // and dates, but it must not derive a price, a tax split or a next date.
  it('does no billing or tax arithmetic of its own', () => {
    expect(componentSrc).not.toMatch(/tax_rate|rate_percent|amount_excl_tax/);
    expect(componentSrc).not.toMatch(/setMonth|addMonths|advanceBilling/);
    expect(componentSrc.match(/toFixed\(/g) ?? []).toHaveLength(1);
  });

  it('shares one price-label mapping with the Plan card', () => {
    // Same stored actions, resolved in each page's own namespace — which is how
    // a Promotion says *Waived* where a Plan says the same of its own benefit.
    expect(simulationPriceLabelKey(undefined)).toBe('simulation_price_regular');
    expect(simulationPriceLabelKey({
      source: 'promotion', name: 'Autumn', action: 'waive', value: null, period_status: null,
    })).toBe('simulation_price_waived');
    expect(simulationPriceLabelKey({
      source: 'promotion', name: 'Autumn', action: 'fixed_price', value: 10, period_status: null,
    })).toBe('simulation_price_fixed_price');
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
      'tax_included_suffix',
    ];
    for (const code of LOCALE_CODES) {
      for (const key of keys) {
        expect(promotionLocales[code][key], `${code}.promotions.${key}`).toBeTruthy();
      }
    }
  });

  it('keeps the interpolations the labels declare', () => {
    for (const code of LOCALE_CODES) {
      expect(promotionLocales[code].simulation_example_note).toContain('{date}');
      expect(promotionLocales[code].simulation_regular_was).toContain('{amount}');
      expect(promotionLocales[code].simulation_price_percentage).toContain('{value}');
      expect(promotionLocales[code].simulation_price_fixed_discount).toContain('{amount}');
      expect(promotionLocales[code].simulation_price_fixed_price).toContain('{amount}');
    }
  });

  // #896 §3 — the Promotions UI must not contain the word "Benefit" anywhere.
  it('never says "Benefit" in the English labels it adds', () => {
    for (const [key, value] of Object.entries(promotionLocales.en)) {
      if (!key.startsWith('simulation_') && key !== 'section_billing_event_simulation') continue;
      expect(value.toLowerCase(), key).not.toContain('benefit');
    }
  });
});
