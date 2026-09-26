import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #635 stage 6 — the Assigned Membership Plan exposes the same structure as the
// Membership Plan it came from, edited section by section.
//
// §9: Billing & Duration (Free Period / Paid Duration / Bonus Duration) plus
// One-off / Session / Period Benefits. §10: each section has its own
// Edit/Save/Cancel, only the section being edited is unlocked, and no
// CrudModal is introduced. §6: no Sellable-Item-keyed Membership Fee *Benefit*
// section — the assignment's own Membership Fee is part of Billing & Duration,
// which is a different thing.
//
// #772 adds the one Membership Fee benefit the Assigned Plan does carry: the
// **Personal Membership Fee Benefit**, a `No benefit` / `% discount` pair that
// belongs to the contract rather than to a Promotion and never expires. It is
// its own section, with the same Edit/Save/Cancel shape, and it is still not a
// Charge Benefit: nothing about it is keyed on a Sellable Item.
//
// This repo has no component-test infra for apps/admin (see docs/architecture.md's
// TL;DR), so — like plans-benefit-sections.test.ts (#635 stage 1) — the
// structure is pinned by scanning the component source and the locale files.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const ASSIGNED_PLANS_DIR = join(__dirname, '..', 'app', '[locale]', 'financials', 'assigned-plans');
const CONFIGURATION = join(ASSIGNED_PLANS_DIR, 'AssignedPlanConfiguration.tsx');
const EXPANDED_ROW = join(ASSIGNED_PLANS_DIR, 'AssignedPlanExpandedRow.tsx');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

type Messages = Record<string, unknown>;

function loadLocale(code: string): Messages {
  return JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
}

function namespaceKeys(messages: Messages): Set<string> {
  const ns = messages.assigned_plans_page;
  if (ns == null || typeof ns !== 'object') return new Set();
  return new Set(Object.keys(ns as Record<string, unknown>));
}

// Comments name the sections and the ticket paragraphs, so every scan below
// runs on comment-free code.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const src = stripComments(readFileSync(CONFIGURATION, 'utf-8'));
const rowSrc = stripComments(readFileSync(EXPANDED_ROW, 'utf-8'));
const locales = Object.fromEntries(LOCALE_CODES.map((c) => [c, loadLocale(c)])) as Record<
  (typeof LOCALE_CODES)[number],
  Messages
>;

// #635 stage 13 added the fourth field, Pre-paid Duration.
const DURATION_FIELDS = ['free_months', 'paid_months', 'pay_beforehand_months', 'bonus_months'] as const;
const BENEFIT_SECTIONS = ['oneoff', 'session', 'periodical'] as const;

describe('Assigned Plan: Billing & Duration (#635 §7/§9)', () => {
  it('renders its own section with Free Period, Paid, Pre-paid and Bonus Duration', () => {
    expect(src).toContain('section_billing_duration');
    for (const field of DURATION_FIELDS) {
      expect(src, `${field} missing from DURATION_FIELDS`).toMatch(
        new RegExp(`DURATION_FIELDS[\\s\\S]{0,120}'${field}'`),
      );
    }
  });

  it('also exposes the frozen cadence and Membership Fee of the snapshot', () => {
    for (const key of ['label_billing_interval', 'label_billing_unit', 'label_membership_fee']) {
      expect(src, `the section does not render "${key}"`).toContain(key);
    }
  });

  // Stage 13: the Pre-paid Duration is sent like the other three — blank means
  // "not configured", which the API stores as NULL and reads differently from 0.
  it('sends the Pre-paid Duration, blank included', () => {
    expect(src).toContain('pay_beforehand_months: durationForm.pay_beforehand_months');
    expect(src).toMatch(/pay_beforehand_months[\s\S]{0,80}\? null : Number\(durationForm\.pay_beforehand_months\)/);
  });

  it('saves it to the assignment, never to the Membership Plan (§15)', () => {
    expect(src).toContain('/user-memberships/${assignedPlanId}/billing-duration');
    expect(src, 'the editor writes to a membership-plans endpoint').not.toContain('/membership-plans/');
  });
});

describe('Assigned Plan: One-off / Session / Period Benefits (#635 §3–§5/§9)', () => {
  it('has one independently edited section per benefit kind', () => {
    for (const section of BENEFIT_SECTIONS) {
      expect(src, `${section} missing from BENEFIT_SECTIONS`).toMatch(
        new RegExp(`section: '${section}'`),
      );
    }
    for (const key of ['benefits_oneoff', 'benefits_session', 'benefits_period']) {
      expect(src, `the card does not render "${key}"`).toContain(key);
    }
  });

  it('reuses the shared Promotion/Plan benefit editor rather than a second one', () => {
    expect(src).toContain('SellableItemBenefitEditor');
    expect(src).toContain("from '@/components/SellableItemBenefits'");
  });

  it('saves each section to its own assignment endpoint', () => {
    for (const endpoint of ['oneoff-benefits', 'session-benefits', 'periodical-benefits']) {
      expect(src, `no route for "${endpoint}"`).toContain(endpoint);
    }
    expect(src).toContain('/user-memberships/${assignedPlanId}/${endpoint}');
  });

  it('shows the price frozen on the line, not the catalogue price (§17)', () => {
    expect(src).toContain('col_snapshot_price');
    expect(src).toContain('r.unit_price');
  });
});

describe('Assigned Plan configuration: editing rules (#635 §10)', () => {
  it('unlocks one section at a time', () => {
    // A single `editing` value names the open section; every other section's
    // Edit button is disabled while it is set.
    expect(src).toMatch(/const \[editing, setEditing\] = useState<'billing' \| 'fee_benefit' \| BenefitSection \| null>/);
    expect(src).toMatch(/disabled=\{editing !== null\}/);
  });

  it('introduces no modal', () => {
    expect(src).not.toContain('CrudModal');
    expect(src).not.toContain('Modal');
  });

  it('adds no Sellable-Item-keyed Membership Fee Benefits section (§6)', () => {
    // #635 §6's rule, unchanged: the Charge-Benefit vocabulary has no place
    // here. #772's section is keyed on nothing but the assignment itself.
    expect(src).not.toContain('benefits_membership_fee');
    expect(src).not.toContain('charge_benefit');
  });

  it("offers the Personal Membership Fee Benefit's two options and nothing else (#772)", () => {
    expect(src).toContain('section_membership_fee_benefit');
    expect(src).toMatch(
      /const PERSONAL_FEE_BENEFIT_ACTIONS: readonly PersonalFeeBenefitAction\[\] = \['no_benefit', 'percentage_discount'\]/,
    );
    // The percentage field only exists for the option that has one.
    expect(src).toContain("feeBenefitForm.action === 'percentage_discount' && (");
  });

  it('saves the Personal Membership Fee Benefit to its own endpoint (#772)', () => {
    expect(src).toContain('/user-memberships/${assignedPlanId}/fee-benefit');
    // Replace-all: `no_benefit` sends no percentage rather than keeping the
    // last one around.
    expect(src).toContain("feeBenefitForm.action === 'percentage_discount' && feeBenefitForm.value !== ''");
  });

  it('is rendered by the Assigned Plans expanded row, from the assignment snapshot', () => {
    expect(rowSrc).toContain('<AssignedPlanConfiguration');
    expect(rowSrc).toContain('snapshot={detail.snapshot}');
  });
});

describe('Assigned Plan configuration: locales', () => {
  const REQUIRED_KEYS = [
    'section_configuration', 'section_billing_duration',
    'label_pay_beforehand_months',
    'label_free_months', 'label_paid_months', 'label_bonus_months',
    'label_billing_interval', 'label_billing_unit', 'label_membership_fee',
    'months_value', 'not_configured', 'snapshot_edit_hint',
    'col_sellable_item', 'col_quantity', 'col_frequency', 'col_snapshot_price',
    'inactive_item_tag',
    'no_oneoff_benefits', 'no_session_benefits', 'no_period_benefits',
    'add_oneoff_benefit', 'add_session_benefit', 'add_period_benefit',
    'unit_day', 'unit_week', 'unit_month', 'unit_year',
    'frequency_once', 'frequency_per_session', 'frequency_four_weeks',
    'frequency_week', 'frequency_month', 'frequency_year',
    // #772 — the Personal Membership Fee Benefit section.
    'section_membership_fee_benefit', 'label_personal_fee_benefit',
    'label_personal_fee_benefit_percentage', 'personal_fee_benefit_no_benefit',
    'personal_fee_benefit_percentage_discount', 'personal_fee_benefit_percentage_value',
    'personal_fee_benefit_hint',
  ];

  it('has every new key in every locale (next-intl has no fallback)', () => {
    for (const code of LOCALE_CODES) {
      const keys = namespaceKeys(locales[code]);
      const missing = REQUIRED_KEYS.filter((k) => !keys.has(k));
      expect(missing, `${code}.json is missing assigned_plans_page keys`).toEqual([]);
    }
  });
});
