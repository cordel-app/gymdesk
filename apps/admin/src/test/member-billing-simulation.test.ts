import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Structural test for #629 — the Member's Billing Simulation section.
//
// This repo has no component-test infra for apps/admin (see
// docs/architecture.md's TL;DR), so — like assign-plan-inline.test.ts (#628) —
// this pins down the rules the ticket thread settled by scanning the source
// and the locale files:
//   - the simulation is a Member-level section of its own, not nested inside a
//     Membership Plan card (#629 thread Q4 → #634 §13);
//   - it renders the server's resolved amounts and never recomputes them
//     (CLAUDE.md: no business logic duplicated in the frontend);
//   - it re-runs when the Member's plans change (#634 §12).

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const MEMBERS_DIR = join(__dirname, '..', 'app', '[locale]', 'members');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function read(file: string): string {
  return stripComments(readFileSync(join(MEMBERS_DIR, file), 'utf-8'));
}

const simulationSrc = read('MemberBillingSimulation.tsx');
const expandedRowSrc = read('MemberExpandedRow.tsx');

const SIMULATION_KEYS = [
  'section_billing_simulation',
  'billing_simulation_loading',
  'billing_simulation_error',
  'billing_simulation_unavailable',
  'billing_simulation_section_one_off',
  'billing_simulation_section_year',
  'billing_simulation_section_month',
  'billing_simulation_section_four_weeks',
  'billing_simulation_section_week',
  'billing_simulation_section_session',
  'billing_simulation_section_other',
  'billing_simulation_regular',
  'billing_simulation_section_total',
  'billing_simulation_total',
  'billing_simulation_benefit_included',
  'billing_simulation_benefit_waive',
  'billing_simulation_benefit_fixed_price',
  'billing_simulation_benefit_percentage',
  'billing_simulation_benefit_fixed_discount',
  'billing_simulation_price_note',
  'billing_simulation_truncated',
  // #635 stage 8 — the Plan's own Billing & Duration periods.
  'billing_simulation_plan_free',
  'billing_simulation_plan_prepaid',
  'billing_simulation_plan_paid',
  'billing_simulation_plan_bonus',
  'billing_simulation_plan_regular',
];

describe('Member Billing Simulation (#629)', () => {
  it('reads the consolidated Member-level endpoint', () => {
    expect(simulationSrc).toContain('/user-memberships/member/${memberId}/billing-simulation');
  });

  it('is its own section of the Member row, outside the Membership Plan cards', () => {
    expect(expandedRowSrc).toContain("<Section label={t('members.section_billing_simulation')}>");
    // The plan cards are rendered inside the Membership section's map over
    // `memberships` — the simulation must not be one of them.
    const membershipSection = expandedRowSrc.slice(
      expandedRowSrc.indexOf("t('members.section_membership')"),
      expandedRowSrc.indexOf("t('members.section_billing_simulation')"),
    );
    expect(membershipSection).not.toContain('<MemberBillingSimulation');
  });

  it('introduces no modal', () => {
    for (const forbidden of ['CrudModal', 'overlayStyle', 'modalStyle']) {
      expect(simulationSrc, `the simulation uses ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('re-runs when the Member\'s plans change', () => {
    expect(expandedRowSrc).toContain('setSimulationKey((k) => k + 1)');
    expect(expandedRowSrc).toContain('<MemberBillingSimulation key={simulationKey}');
  });

  it('renders the server-resolved amounts rather than recomputing them', () => {
    expect(simulationSrc).toContain('line.regular_price');
    expect(simulationSrc).toContain('line.actual_charge');
    expect(simulationSrc).toContain('event.total');
    // No arithmetic over the response — the API is the source of truth for
    // every amount, including the totals.
    expect(simulationSrc).not.toMatch(/\breduce\(/);
  });

  it('writes nothing — the simulation is read-only', () => {
    for (const method of ["method: 'POST'", "method: 'PUT'", "method: 'DELETE'"]) {
      expect(simulationSrc, `the simulation issues a ${method} request`).not.toContain(method);
    }
  });

  it('formats plain dates without a timezone-shifting Date parse', () => {
    expect(simulationSrc).not.toContain('new Date(');
  });

  // #635 stage 8 — a waived Membership Fee can come from the assignment's own
  // Billing & Duration as well as from a Promotion, and the line has to say
  // which. The classification itself stays server-side.
  it('labels a plan-sourced benefit from its own namespace, not the Promotions one', () => {
    expect(simulationSrc).toContain("benefit.source === 'membership_plan'");
    expect(simulationSrc).toContain('PLAN_PERIOD_STATUS_KEY');
    expect(simulationSrc).toMatch(/free_plan:\s*'billing_simulation_plan_free'/);
    expect(simulationSrc).toMatch(/bonus_plan:\s*'billing_simulation_plan_bonus'/);
    // #635 stage 13: a pre-paid month reads as pre-paid, not as a waiver.
    expect(simulationSrc).toMatch(/prepaid_plan:\s*'billing_simulation_plan_prepaid'/);
  });

  it('derives no Billing & Duration period of its own', () => {
    for (const forbidden of ['free_months', 'paid_months', 'bonus_months', 'planDuration']) {
      expect(simulationSrc).not.toContain(forbidden);
    }
  });

  it('defines every simulation key in all locales', () => {
    for (const code of LOCALE_CODES) {
      const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
      for (const key of SIMULATION_KEYS) {
        expect(messages.members?.[key], `${code}.json is missing members.${key}`).toBeTruthy();
      }
    }
  });
});
