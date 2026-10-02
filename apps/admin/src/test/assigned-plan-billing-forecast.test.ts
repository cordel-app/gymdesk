import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { simulationPriceLabelKey } from '@/lib/billingEventSimulation';

// #924 stage 4 — the Assigned Plan card's **Billing Event Forecast**.
//
// §8 asks the Assigned Plan for the Billing Event Simulation the Membership
// Plan card already has, and §1/§12 say how: "Do not create a separate visual
// system for Assigned Plans", "Reuse Membership Plan billing-event
// simulation". So the section renders the one shared
// `components/BillingEventSimulation.tsx` (#922) — the third card to do so —
// the groups and amounts come from the server, and the page contributes
// nothing but labels in its own namespace.
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so the
// wiring is pinned by scanning the source, the way the stage-3 test beside this
// one does.

const SRC = join(__dirname, '..');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;
const ASSIGNED_PLANS_DIR = join(SRC, 'app', '[locale]', 'financials', 'assigned-plans');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const rowSrc = stripComments(
  readFileSync(join(ASSIGNED_PLANS_DIR, 'AssignedPlanExpandedRow.tsx'), 'utf-8'),
);
const typesSrc = readFileSync(join(ASSIGNED_PLANS_DIR, 'types.ts'), 'utf-8');

function assignedPlansNamespace(code: string): Record<string, string> {
  const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
  return (messages.assigned_plans_page ?? {}) as Record<string, string>;
}

/** Every label the shared component resolves, in the calling page's namespace. */
const SHARED_COMPONENT_KEYS = [
  'simulation_example_note', 'simulation_unavailable', 'simulation_mandatory',
  'simulation_total', 'simulation_regular_was', 'simulation_prepaid_periods',
  'simulation_disclaimer', 'simulation_truncated', 'tax_included_suffix',
] as const;

describe('#924 §8: the section renders the shared Billing Event Simulation', () => {
  it('renders the shared component, not a table of its own', () => {
    expect(rowSrc).toContain("import { BillingEventSimulation } from '@/components/BillingEventSimulation'");
    expect(rowSrc).toContain('<BillingEventSimulation');
    expect(rowSrc).toContain("t('section_billing_forecast')");
  });

  it('reads the server’s projection and computes nothing itself', () => {
    expect(rowSrc).toContain('detail.billing_event_simulation');
    expect(typesSrc).toContain('billing_event_simulation: BillingEventSimulationData | null');
    // No grouping, totalling or tax arithmetic in the page (#817, and §12's
    // "no duplicate billing or pricing logic").
    expect(rowSrc).not.toMatch(/billing_event_simulation[\s\S]{0,400}?(reduce|\*\s*1\.2|toFixed)/);
  });

  it('sits between the Membership Fee Simulation and the Additional Products section (§11)', () => {
    const fee = rowSrc.indexOf("t('section_fee_simulation')");
    const forecast = rowSrc.indexOf("t('section_billing_forecast')");
    const additional = rowSrc.indexOf("t('section_additional_services')");
    expect(fee).toBeGreaterThan(-1);
    expect(forecast).toBeGreaterThan(fee);
    expect(additional).toBeGreaterThan(forecast);
  });

  it('formats the group dates with the card’s own locale-safe helper', () => {
    // The dates are plain `YYYY-MM-DD`; going through `new Date(ymd)` would
    // shift them by a timezone, which is why the card has `fmtTimelineDate`.
    expect(rowSrc).toMatch(/formatDate=\{\(date\) => fmtTimelineDate\(date, locale\)\}/);
  });

  it('labels every key the shared component resolves, in every locale', () => {
    // next-intl prints a missing key verbatim and `t()` has no defaultValue, so
    // a key missing here renders `simulation_total` on screen.
    const priceKeys = (['no_benefit', 'waive', 'percentage_discount', 'fixed_discount', 'fixed_price'] as const)
      .map((action) => simulationPriceLabelKey({ source: 'promotion', name: null, action, value: null, period_status: null }));
    for (const code of LOCALE_CODES) {
      const ns = assignedPlansNamespace(code);
      for (const key of ['section_billing_forecast', ...SHARED_COMPONENT_KEYS, ...priceKeys]) {
        expect(ns[key], `${code}.assigned_plans_page.${key}`).toBeTruthy();
      }
    }
  });

  it('reads as a forecast rather than as a catalogue example', () => {
    // The Plan card's note says "Example: a member starting on {date}"; an
    // Assigned Plan is a real contract, so its own note must not call itself an
    // example of an enrollment that has already happened.
    const en = assignedPlansNamespace('en');
    expect(en.section_billing_forecast).toBe('Billing Event Forecast');
    expect(en.simulation_example_note).toContain('{date}');
    expect(en.simulation_example_note.toLowerCase()).not.toContain('example');
  });

  it('keeps the Billing Events ledger as its own section', () => {
    // The forecast is what is still to come; the ledger is what was charged.
    // Neither replaces the other (the thread's Q4 answer).
    expect(rowSrc).toContain("t('section_billing_events')");
    for (const code of LOCALE_CODES) {
      expect(assignedPlansNamespace(code).section_billing_events).toBeTruthy();
    }
  });
});
