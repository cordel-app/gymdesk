import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Regression test for #631 — Additional Periodic Services on an Assigned Plan.
//
// The section is inline row CRUD with no modal (#631 §1/§2, acceptance
// criteria "Add/remove uses inline editing" and "No modal is introduced"), only
// recurring Sellable Items are offered, and add/remove must re-run the Member's
// Billing Simulation immediately (#631 §6). This repo has no component-test
// infra for apps/admin (see docs/architecture.md's TL;DR), so — like
// assign-plan-inline.test.ts (#628) — this pins the structure down by scanning
// the source and the locale files.

const SRC = join(__dirname, '..');
const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const ASSIGNED_PLANS_DIR = join(SRC, 'app', '[locale]', 'financials', 'assigned-plans');
const MEMBERS_DIR = join(SRC, 'app', '[locale]', 'members');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function read(path: string): string {
  return stripComments(readFileSync(path, 'utf-8'));
}

const sectionSrc = read(join(ASSIGNED_PLANS_DIR, 'AdditionalPeriodicServices.tsx'));
const assignedPlanRowSrc = read(join(ASSIGNED_PLANS_DIR, 'AssignedPlanExpandedRow.tsx'));
const memberRowSrc = read(join(MEMBERS_DIR, 'MemberExpandedRow.tsx'));
// #634 §4: the Member-level ADDITIONAL SERVICES section, which reuses this
// editor once per live Membership Plan.
const memberSectionSrc = read(join(MEMBERS_DIR, 'MemberAdditionalServices.tsx'));

const SECTION_KEYS = [
  'section_additional_services',
  'services_none',
  'services_add',
  'services_save',
  'services_remove',
  'services_removed',
  'services_select_item',
  'services_items_error',
  'services_col_item',
  'services_col_quantity',
  'services_col_frequency',
  'services_col_price',
  'services_col_start_date',
  'services_col_end_date',
  'services_col_actions',
  'services_item_retired',
];

// Every value `gym_charges.billing_frequency` can hold — the label lookup is a
// template key, so the locale tests' static scan can't catch a missing one.
const FREQUENCY_KEYS = [
  'services_frequency_week',
  'services_frequency_four_weeks',
  'services_frequency_month',
  'services_frequency_year',
  'services_frequency_once',
  'services_frequency_per_session',
];

describe('Additional Periodic Services (#631)', () => {
  it('is a section of the Assigned Plan expanded row', () => {
    expect(assignedPlanRowSrc).toContain('<AdditionalPeriodicServices');
    expect(assignedPlanRowSrc).toContain("t('section_additional_services')");
  });

  it('adds and removes inline, introducing no modal', () => {
    for (const forbidden of ['CrudModal', 'ConfirmDialog', 'overlayStyle', 'modalStyle']) {
      expect(sectionSrc, `the section uses ${forbidden}`).not.toContain(forbidden);
    }
    // The draft lives in a row of the same table, not in a dialog.
    expect(sectionSrc).toContain('{adding && (');
    expect(sectionSrc).toContain('<tr>');
  });

  it('offers only recurring Sellable Items, classified server-side', () => {
    expect(sectionSrc).toContain('/sellable-items');
    expect(sectionSrc).toContain("benefit_category === 'periodical'");
    expect(sectionSrc).toContain("i.status === 'active'");
  });

  it('writes through the Assigned Plan services endpoints', () => {
    expect(sectionSrc).toContain('/user-memberships/${assignedPlanId}/services');
    expect(sectionSrc).toContain("method: 'POST'");
    expect(sectionSrc).toContain("method: 'DELETE'");
  });

  it('never re-derives the price or the billing frequency locally', () => {
    // Both come from the Sellable Item the API returns (#631 §2) — the section
    // formats them, it never computes a charge (CLAUDE.md: no business logic
    // duplicated in the frontend).
    expect(sectionSrc).not.toMatch(/unit_price\s*\*/);
    expect(sectionSrc).not.toContain('four_weeks:');
  });

  it('keeps removed services listed as history rather than hiding them', () => {
    // Keyed on `ends_at`, not `active`: a service removed today is still
    // billable through today, but must not offer Remove a second time.
    expect(sectionSrc).toContain('s.ends_at == null ?');
    expect(sectionSrc).toContain("t('services_removed')");
  });

  it('hides Add for a plan that bills nothing further', () => {
    expect(sectionSrc).toContain('ATTACHABLE_STATUSES');
    expect(sectionSrc).toContain('!adding && canAttach');
  });

  it('re-runs the Member Billing Simulation when a service changes (#631 §6)', () => {
    // #634 §4 promoted this to a Member-level section: the expanded row renders
    // MemberAdditionalServices, which reuses this editor once per live plan,
    // and `onChanged` re-reads the configuration and remounts the simulation.
    expect(memberRowSrc).toContain('<MemberAdditionalServices');
    expect(memberRowSrc).toContain('onChanged={reloadConfiguration}');
    expect(memberRowSrc).toMatch(/setSimulationKey\(\(k\) => k \+ 1\)/);
    expect(memberSectionSrc).toContain('<AdditionalPeriodicServices');
    expect(memberSectionSrc).toContain('onChanged={onChanged}');
  });

  it('defines every section key in all locales', () => {
    for (const code of LOCALE_CODES) {
      const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
      for (const key of [...SECTION_KEYS, ...FREQUENCY_KEYS]) {
        expect(messages.assigned_plans_page?.[key], `${code}.json is missing assigned_plans_page.${key}`).toBeTruthy();
      }
      expect(
        messages.members?.section_additional_services,
        `${code}.json is missing members.section_additional_services`,
      ).toBeTruthy();
    }
  });
});
