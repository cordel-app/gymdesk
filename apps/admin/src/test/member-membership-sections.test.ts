import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Structural test for #634 — the Member's Membership experience as four
// independent sections.
//
// This repo has no component-test infra for apps/admin (see
// docs/architecture.md's TL;DR), so — like assign-plan-inline.test.ts (#628)
// and member-billing-simulation.test.ts (#629) — this pins down what the ticket
// settled by scanning the source and the locale files:
//   - MEMBERSHIP PLANS / PROMOTIONS / ADDITIONAL SERVICES / BILLING SIMULATION
//     are four siblings, none nested inside a Membership Plan card (§13);
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
const promotionsSrc = read('MemberPromotions.tsx');
const servicesSrc = read('MemberAdditionalServices.tsx');
const simulationSrc = read('MemberBillingSimulation.tsx');

const SECTION_KEYS = [
  'section_membership_plans',
  'section_promotions',
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

const PROMOTION_KEYS = [
  'promotions_none',
  'promotions_add',
  'promotions_add_title',
  'promotions_submit',
  'promotions_remove',
  'promotions_history',
  'promotions_on_plan',
  'promotions_label_plan',
  'promotions_label_promotion',
  'promotions_pick_plan',
  'promotions_pick_plan_first',
  'promotions_already_applied',
  'promotions_error_no_plan',
  'promotions_error_no_promotion',
  'promotions_needs_plan',
  'additional_services_needs_plan',
];

describe('Member Membership sections (#634)', () => {
  it('renders the four sections as siblings, in the ticket\'s order', () => {
    const order = SECTION_KEYS.map((key) => expandedRowSrc.indexOf(`t('members.${key}')`));
    expect(order.every((i) => i > -1), 'every section label is rendered').toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('feeds the three configuration sections from one Member-level read', () => {
    expect(expandedRowSrc).toContain('/user-memberships/member/${memberId}/configuration');
    expect(expandedRowSrc).toContain('<MemberMembershipPlans');
    expect(expandedRowSrc).toContain('<MemberPromotions');
    expect(expandedRowSrc).toContain('<MemberAdditionalServices');
    expect(expandedRowSrc).toContain('<MemberBillingSimulation');
  });

  it('never nests Promotions, Additional Services or the Simulation in a plan card (§13)', () => {
    for (const src of [plansSrc]) {
      expect(src).not.toContain('MemberPromotions');
      expect(src).not.toContain('AdditionalPeriodicServices');
      expect(src).not.toContain('MemberBillingSimulation');
    }
  });

  it('adds a Membership Plan additively, never superseding another (§14)', () => {
    // POST /user-memberships creates a new assignment; assign-new-plan (the
    // supersede action) is deliberately not what "+ Add Membership Plan" calls.
    expect(plansSrc).toMatch(/apiFetch\('\/user-memberships',\s*\{\s*method: 'POST'/);
    expect(plansSrc).not.toContain('assign-new-plan');
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

  it('keeps Promotions at Member level, each row naming its plan (§3)', () => {
    expect(promotionsSrc).toContain("t('promotions_on_plan'");
    expect(promotionsSrc).toContain('/user-memberships/${targetPlanId}/promotions');
    // Compatibility with the chosen plan is what scopes the picker.
    expect(promotionsSrc).toContain('membership_plan_id=${target.membership_plan_id}');
  });

  it('applies the stacking rules to the Promotion picker', () => {
    expect(promotionsSrc).toContain('nonStackableApplied');
    expect(promotionsSrc).toContain('appliedIdsOnTarget');
    expect(promotionsSrc).toContain('disabled={saving || blocked !== null}');
  });

  it('reuses the #631 inline editor for Additional Services, once per live plan (§4)', () => {
    expect(servicesSrc).toContain('<AdditionalPeriodicServices');
    expect(servicesSrc).toContain('plans.filter((p) => p.is_live');
    expect(servicesSrc).toContain('services.filter((s) => s.user_membership_id === plan.id)');
  });

  it('re-runs the Billing Simulation whenever the configuration changes (§12)', () => {
    expect(expandedRowSrc).toContain('setSimulationKey((k) => k + 1)');
    expect(expandedRowSrc).toContain('key={simulationKey}');
    for (const src of [plansSrc, promotionsSrc, servicesSrc]) {
      expect(src).toContain('onChanged');
    }
  });

  it('names the Membership Plan behind each simulated charge (§7)', () => {
    expect(simulationSrc).toContain('line.plan_name');
  });

  it('introduces no modal anywhere in the four sections (§15)', () => {
    for (const src of [plansSrc, promotionsSrc, servicesSrc, simulationSrc]) {
      expect(src).not.toContain('CrudModal');
      expect(src).not.toMatch(/<\w*Modal[\s/>]/);
    }
  });

  it('never recomputes money in the frontend', () => {
    // Every amount rendered by these sections comes from the server.
    for (const src of [plansSrc, promotionsSrc]) {
      expect(src).not.toMatch(/\*\s*quantity|regular_price\s*[-*]/);
    }
  });

  it('defines every new key in all locales', () => {
    for (const code of LOCALE_CODES) {
      const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
      for (const key of [...SECTION_KEYS, ...PLAN_KEYS, ...PROMOTION_KEYS]) {
        expect(messages.members?.[key], `${code}.json is missing members.${key}`).toBeTruthy();
      }
    }
  });
});
