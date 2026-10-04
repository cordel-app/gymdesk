import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { simulationPriceLabelKey } from '@/lib/billingEventSimulation';

// #924 stage 4 — the Assigned Plan card's **Billing Event Forecast**.
//
// §8 asks for the Membership Plan card's Billing Event Simulation (#915) on an
// Assigned Plan and §1 says how: "Do not create a separate visual system for
// Assigned Plans." So the section is the shared
// `components/BillingEventSimulation.tsx` the Plan and Promotion cards already
// render, the groups come from the server, and the page contributes nothing but
// labels and a date formatter.
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so the
// wiring is pinned by scanning the source the way the stage 3 test does, while
// the pure parts are exercised directly.

const SRC = join(__dirname, '..');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;
const ASSIGNED_PLANS_DIR = join(SRC, 'components', 'assignedPlan');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const rowSrc = stripComments(
  readFileSync(join(ASSIGNED_PLANS_DIR, 'AssignedPlanExpandedRow.tsx'), 'utf-8'),
);

function assignedPlansNamespace(code: string): Record<string, string> {
  const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
  return (messages.assigned_plans_page ?? {}) as Record<string, string>;
}

describe('#924 §8: the section renders the shared Billing Event Simulation', () => {
  it('renders the shared component, not one of its own', () => {
    expect(rowSrc).toContain(
      "import { BillingEventSimulation } from '@/components/BillingEventSimulation'",
    );
    expect(rowSrc).toContain('<BillingEventSimulation');
    expect(rowSrc).toContain("t('section_billing_forecast')");
  });

  it('reads the server’s projection and prices nothing itself', () => {
    expect(rowSrc).toContain('detail.billing_event_simulation');
    // No tax arithmetic and no amounts of its own: the server quotes every
    // figure, VAT included (#817).
    expect(rowSrc).not.toMatch(/billing_event_simulation[\s\S]{0,400}?\*\s*1\.21/);
    expect(rowSrc).not.toMatch(/billing_event_simulation[\s\S]{0,400}?\.lines/);
  });

  it('sits below the Membership Fee Simulation, both above the Billing Events ledger', () => {
    // The two simulations answer "what will happen" (one per period about the
    // fee, one per date about every line); the ledger below them answers "what
    // happened" (#924's Q4 answer: keep it).
    const fee = rowSrc.indexOf("t('section_fee_simulation')");
    const forecast = rowSrc.indexOf("t('section_billing_forecast')");
    const additional = rowSrc.indexOf("t('section_additional_services')");
    const ledger = rowSrc.indexOf("t('section_billing_events')");
    expect(fee).toBeGreaterThan(-1);
    expect(forecast).toBeGreaterThan(fee);
    expect(additional).toBeGreaterThan(forecast);
    expect(ledger).toBeGreaterThan(additional);
  });

  it('labels every key the shared component can resolve, in every locale', () => {
    // next-intl prints a missing key verbatim and `t()` has no defaultValue, so
    // an unmapped key would render `simulation_price_waived` on screen.
    const actions = [
      undefined, 'no_benefit', 'waive', 'included',
      'percentage_discount', 'fixed_discount', 'fixed_price',
    ] as const;
    const priceKeys = new Set(
      actions.map((action) => simulationPriceLabelKey(
        action === undefined
          ? undefined
          : { source: 'promotion', name: null, action, value: null, period_status: null },
      )),
    );
    for (const code of LOCALE_CODES) {
      const ns = assignedPlansNamespace(code);
      for (const key of [
        'section_billing_forecast', 'simulation_example_note', 'simulation_unavailable',
        'simulation_mandatory', 'simulation_total', 'simulation_regular_was',
        'simulation_prepaid_periods', 'simulation_disclaimer', 'simulation_truncated',
        'tax_included_suffix',
        // #955's collapsible cards — the shared component resolves these in the
        // calling page's own namespace too, so the forecast section needs them.
        'simulation_col_date', 'simulation_col_event', 'simulation_col_status',
        'simulation_col_amount', 'simulation_items_count',
        'simulation_expand_all', 'simulation_collapse_all',
        ...priceKeys,
      ]) {
        expect(ns[key], `${code}.assigned_plans_page.${key}`).toBeTruthy();
      }
    }
  });

  it('words the anchor note for a real contract, not for a hypothetical member', () => {
    // The Plan card's own copy reads "Example: a member starting on {date}" —
    // this card has a member, and the date is where the forecast starts.
    const ns = assignedPlansNamespace('en');
    expect(ns.simulation_example_note).toContain('{date}');
    expect(ns.simulation_example_note.toLowerCase()).not.toContain('example');
  });
});
