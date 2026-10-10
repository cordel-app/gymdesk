import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Structural test for #634 — the Member's Membership experience as
// independent sections.
//
// #931 removed the PROMOTIONS section: a Promotion applies to a Membership Plan
// or a Product, never to a Member. What is left of §13 is three siblings,
// and member-promotions-removed.test.ts is what pins the removal down.
//
// This repo has no component-test infra for apps/admin (see
// docs/architecture.md's TL;DR), so — like assign-plan-inline.test.ts (#628)
// and member-billing-simulation.test.ts (#629) — this pins down what the ticket
// settled by scanning the source and the locale files:
//   - MEMBERSHIP PLANS / ADDITIONAL SERVICES / BILLING SIMULATION are three
//     siblings, none nested inside a Membership Plan card (§13);
//   - adding a plan is additive and never supersedes another (§14);
//   - only Active + Public plans are offered (§2), picked with radio buttons;
//   - everything is inline — no CrudModal, no modal, no wizard (§15);
//   - a change in any configuration section re-runs the simulation (§12).

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const MEMBERS_DIR = join(__dirname, '..', 'app', '[locale]', 'members');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function read(file: string): string {
  return stripComments(readFileSync(join(MEMBERS_DIR, file), 'utf-8'));
}

const expandedRowSrc = read('MemberExpandedRow.tsx');
const plansSrc = read('MemberMembershipPlans.tsx');
const inFlightSrc = read('ProductSetsInFlight.tsx');
const simulationSrc = read('MemberBillingSimulation.tsx');

const SECTION_KEYS = [
  'section_membership_plans',
  'section_additional_services',
  'section_billing_simulation',
];

const PLAN_KEYS = [
  'no_active_membership_plans',
  'membership_plans_history',
  'add_membership_plan',
  'add_membership_plan_title',
  'add_membership_plan_submit',
  'add_membership_plan_loading',
  'add_membership_plan_none',
  'add_membership_plan_error_no_plan',
];

describe('Member Membership sections (#634)', () => {
  it('renders the sections as siblings, in the ticket\'s order', () => {
    const order = SECTION_KEYS.map((key) => expandedRowSrc.indexOf(`t('members.${key}')`));
    expect(order.every((i) => i > -1), 'every section label is rendered').toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('feeds the two configuration sections from one Member-level read', () => {
    expect(expandedRowSrc).toContain('/user-memberships/member/${memberId}/configuration');
    expect(expandedRowSrc).toContain('<MemberMembershipPlans');
    expect(expandedRowSrc).not.toContain('MemberAdditionalServices');
    expect(expandedRowSrc).toContain('<MemberBillingSimulation');
  });

  it('never nests Additional Services or the Simulation in a plan card (§13)', () => {
    for (const src of [plansSrc]) {
      expect(src).not.toContain('AdditionalPeriodicServices');
      expect(src).not.toContain('MemberBillingSimulation');
    }
  });

  it('adds a Membership Plan additively, never superseding another (§14)', () => {
    // #1325 PR 3b: "+ Add Membership Plan" creates a ProductSet version through
    // `POST /product-sets` and commits it (activate, or save-and-pay when a
    // payment is owed); assign-new-plan (the supersede action) is deliberately
    // not what it calls, and neither is the legacy `/user-memberships` create.
    expect(plansSrc).toMatch(/apiFetch<\{ id: number \}>\('\/product-sets',\s*\{\s*method: 'POST'/);
    expect(plansSrc).toContain('commitProductSetVersion(apiFetch, created.id)');
    expect(plansSrc).not.toContain('assign-new-plan');
    expect(plansSrc).not.toMatch(/apiFetch\('\/user-memberships',\s*\{\s*method: 'POST'/);
  });

  it('never sends `confirm` for a plan that is only being added (the server owns the one-plan rule)', () => {
    expect(plansSrc).not.toContain('confirm: true');
  });

  it('lists the in-flight versions and acts on them only through /product-sets (#1325 PR 3b)', () => {
    expect(plansSrc).toContain('<ProductSetsInFlight');
    expect(plansSrc).toContain('productSets={productSets}');
    expect(inFlightSrc).toContain('`/product-sets/${ps.id}/record-payment`');
    expect(inFlightSrc).toContain('`/product-sets/${ps.id}/save-and-pay`');
    expect(inFlightSrc).toContain('`/product-sets/${ps.id}`, { method: \'DELETE\' }');
    // The write actions follow the permission the page hands in, and nothing is
    // offered for an expired Draft but discarding it.
    expect(inFlightSrc).toContain('{canWrite && (');
    expect(inFlightSrc).toContain("ps.status === 'draft' && !ps.expired");
    // The screen never decides whether a payment is owed or what to confirm.
    expect(inFlightSrc).not.toContain('confirm');
  });

  it('commits through the server\'s own answer — activate, then save-and-pay on payment_required', () => {
    const lib = stripComments(readFileSync(join(__dirname, '..', 'lib', 'productSetCommit.ts'), 'utf-8'));
    expect(lib).toContain('/product-sets/${id}/activate');
    expect(lib).toContain("PAYMENT_REQUIRED = 'payment_required'");
    expect(lib).toContain('/product-sets/${id}/save-and-pay');
    expect(lib).not.toContain('confirm');
  });

  it('offers only Active + Public plans, selected with radio buttons (§2)', () => {
    expect(plansSrc).toContain("'/membership-plans?lifecycle_status=active&enrollment_status=public'");
    expect(plansSrc).toContain('type="radio"');
    // A plan already active for this Member can't be assigned twice.
    expect(plansSrc).toContain('activePlanIds');
  });

  it('shows every active plan, not just the newest (§1/§6)', () => {
    expect(plansSrc).toContain('plans.filter((p) => p.is_live)');
    expect(plansSrc).toContain('live.map(');
  });

  it('re-runs the Billing Simulation whenever the configuration changes (§12)', () => {
    expect(expandedRowSrc).toContain('setSimulationKey((k) => k + 1)');
    expect(expandedRowSrc).toContain('key={simulationKey}');
    for (const src of [plansSrc]) {
      expect(src).toContain('onChanged');
    }
  });

  it('names the Membership Plan behind each simulated charge (§7)', () => {
    expect(simulationSrc).toContain('line.plan_name');
  });

  it('introduces no modal anywhere in the four sections (§15)', () => {
    for (const src of [plansSrc, simulationSrc]) {
      expect(src).not.toContain('CrudModal');
      expect(src).not.toMatch(/<\w*Modal[\s/>]/);
    }
  });

  it('never recomputes money in the frontend', () => {
    // Every amount rendered by these sections comes from the server.
    for (const src of [plansSrc]) {
      expect(src).not.toMatch(/\*\s*quantity|regular_price\s*[-*]/);
    }
  });

  it('defines every new key in all locales', () => {
    for (const code of LOCALE_CODES) {
      const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
      for (const key of [...SECTION_KEYS, ...PLAN_KEYS]) {
        expect(messages.members?.[key], `${code}.json is missing members.${key}`).toBeTruthy();
      }
    }
  });
});
