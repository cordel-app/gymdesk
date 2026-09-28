import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  EMPTY_PLAN_GENERAL_FORM,
  EMPTY_VALUE,
  PLAN_GENERAL_EDITABLE_FIELDS,
  PLAN_GENERAL_FIELDS,
  PLAN_GENERAL_SECTION,
  PLAN_SECTION_ORDER,
  PlanGeneralRow,
  formatPlanCurrentPrice,
  formatPlanGeneralField,
  isPlanGeneralFormValid,
  toPlanGeneralFormValues,
  toPlanGeneralUpdatePayload,
} from '@/app/[locale]/plans/planProfile';

// #816 — Membership Plans join the #797/#798/#800 pattern.
//
//   Collapsed              → the summary row
//   Expanded               → the COMPLETE plan, read-only, in §2's order
//   ⋮ → Edit               → the existing editors, General form and all five
//                            section-level ones
//
// Two things the ticket is explicit about and this file guards: PRICING moves up
// to sit immediately after GENERAL and is now visible while expanded, and the
// section names do not change (§14) — a Plan's benefit sections keep the Plan's
// terminology even though #815 renamed the Promotion's.
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so the
// structure is pinned by scanning the page source the way
// centers-inline-edit.test.ts does, while the shared declaration's pure parts
// (the order, the mapping, the payload, the formatters) are exercised directly.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const PLANS_DIR = join(__dirname, '..', 'app', '[locale]', 'plans');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const pageSrc = stripComments(readFileSync(join(PLANS_DIR, 'page.tsx'), 'utf-8'));

function plansNamespace(code: string): Record<string, string> {
  const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
  return (messages.plans ?? {}) as Record<string, string>;
}

const locales = Object.fromEntries(LOCALE_CODES.map((c) => [c, plansNamespace(c)])) as Record<
  (typeof LOCALE_CODES)[number],
  Record<string, string>
>;

/** The source between two markers, comments already stripped. */
function slice(from: string, to: string): string {
  const start = pageSrc.indexOf(from);
  expect(start, `marker not found: ${from}`).toBeGreaterThan(-1);
  const end = pageSrc.indexOf(to, start + from.length);
  expect(end, `marker not found after ${from}: ${to}`).toBeGreaterThan(start);
  return pageSrc.slice(start, end);
}

/** Everything the expanded card renders — both halves of every section. */
const expandedSrc = slice('{isExpanded && (', '<ConfirmDialog');
/** The read-only GENERAL rendering alone. */
const generalReadOnlySrc = slice('PLAN_GENERAL_FIELDS.map((field) => (', '<SectionHeader');

/** A plan row as the list endpoint returns one, for the pure helpers. */
function row(overrides: Partial<PlanGeneralRow> = {}): PlanGeneralRow {
  return {
    name: 'Standard',
    description: 'Full gym access',
    lifecycle_status: 'active',
    enrollment_status: 'public',
    member_limit: '2',
    member_count: 24,
    ...overrides,
  };
}

describe('Plans: the expanded card is read-only (#816 §1, §12)', () => {
  it('renders one expanded body, not a separate "edit mode replaces the card" branch', () => {
    // Pre-#816 the card had two mutually exclusive bodies: `isEditing &&` (the
    // General form only) and `isExpanded && !isEditing &&` (the sections). The
    // second is what hid Pricing and Billing & Duration from anyone editing.
    expect(pageSrc).not.toContain('isExpanded && !isEditing');
    expect(pageSrc).toContain('{isExpanded && (');
  });

  it('holds no writing control in the read-only GENERAL rendering', () => {
    for (const control of ['<input', '<select', '<textarea', '<button', 'onChange', 'onClick']) {
      expect(generalReadOnlySrc, `${control} inside the read-only GENERAL section`).not.toContain(control);
    }
  });

  it('gates every section-level Edit button behind Edit mode', () => {
    const actions = [...expandedSrc.matchAll(/action=\{[^\n]*/g)].map((m) => m[0]);
    // Pricing, Billing & Duration, the three Benefit sections (one JSX) and Centers.
    expect(actions.length).toBeGreaterThanOrEqual(4);
    for (const action of actions) {
      expect(action, `un-gated section action: ${action}`).toContain('isEditing');
    }
  });

  it('gates every section-level editor, and the apply-price action, behind Edit mode', () => {
    for (const guard of [
      'isEditing && pricingForPlanId === plan.id ?',
      'isEditing && durationEditForPlanId === plan.id ?',
      'isEditing && isEditingBenefit(plan.id, section) ?',
      'isEditing && centersForPlanId === plan.id ?',
      'isEditing && plan.current_price != null &&',
    ]) {
      expect(expandedSrc, `missing guard: ${guard}`).toContain(guard);
    }
  });

  it('leaves Edit mode with every section editor closed rather than half-typed', () => {
    expect(pageSrc).toContain('function closeSectionForms()');
    expect(pageSrc).toMatch(/function cancelEdit\(\)[\s\S]{0,200}closeSectionForms\(\)/);
    expect(pageSrc).toMatch(/setEditingId\(null\);\s*closeSectionForms\(\);/);
  });
});

describe('Plans: ⋮ → Edit is the single entry point (#816 §13)', () => {
  it('keeps the Edit action in the context menu, gated like any write', () => {
    expect(pageSrc).toContain("{ label: t('plans.edit'), onClick: () => openInlineEdit(plan), disabled: !canWrite, title: readOnlyTitle }");
  });

  it('expands the card it opens, so Cancel reveals the read-only view', () => {
    expect(pageSrc).toMatch(/function openInlineEdit\(plan: Plan\) \{[\s\S]{0,400}setExpanded\(\(prev\) => new Set\(prev\)\.add\(plan\.id\)\)/);
  });

  it('seeds the form from the shared declaration and submits its payload', () => {
    expect(pageSrc).toContain('setEditForm(toPlanGeneralFormValues(plan))');
    expect(pageSrc).toContain('body: JSON.stringify(toPlanGeneralUpdatePayload(editForm))');
    expect(pageSrc).toContain('isPlanGeneralFormValid(editForm)');
  });

  it('renders one control per editable field, from the same field list', () => {
    expect(pageSrc).toContain('PLAN_GENERAL_EDITABLE_FIELDS.map((field) => (');
    expect(pageSrc).toContain('renderGeneralControl(plan, field)');
    // Every control the form renders is labelled, as the pre-#816 form was not.
    expect(pageSrc).toContain('htmlFor={`plan-${plan.id}-${field.key}`}');
  });

  it('keeps expanding from ever entering Edit mode', () => {
    expect(pageSrc).toMatch(/function toggleExpand\(id: number\) \{\s*if \(editingId === id\) return;/);
    expect(pageSrc).not.toMatch(/function toggleExpand[\s\S]{0,300}setEditingId/);
  });
});

describe('Plans: expanded section order (#816 §2)', () => {
  it('declares the ticket order once, in planProfile.ts', () => {
    expect([...PLAN_SECTION_ORDER]).toEqual([
      'section_general',
      'section_pricing',
      'section_billing_duration',
      'section_oneoff_benefits',
      'section_session_benefits',
      'section_plan_period_benefits',
      'section_centers',
      'section_example_timeline',
      'section_prices',
    ]);
  });

  it('renders the sections in that order', () => {
    // The three Benefit sections come out of one `BENEFIT_SECTIONS.map`, so the
    // JSX carries that marker where they belong and their relative order is
    // asserted from the declaration below.
    const markers = [
      'plans.section_general',
      'plans.section_pricing',
      'plans.section_billing_duration',
      'BENEFIT_SECTIONS.map(',
      'plans.section_centers',
      'plans.section_example_timeline',
      'plans.section_prices',
    ];
    const positions = markers.map((m) => {
      const at = expandedSrc.indexOf(m);
      expect(at, `marker not rendered in the expanded card: ${m}`).toBeGreaterThan(-1);
      return at;
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('orders the Benefit sections One-off → Session → Period', () => {
    const declaration = slice('const BENEFIT_SECTIONS:', 'function savedBenefits(');
    const benefitOrder = [...declaration.matchAll(/titleKey: '([^']+)'/g)].map((m) => m[1]);
    expect(benefitOrder).toEqual([
      'section_oneoff_benefits',
      'section_session_benefits',
      'section_plan_period_benefits',
    ]);
    expect(benefitOrder).toEqual(
      PLAN_SECTION_ORDER.filter((k) => k.endsWith('benefits')),
    );
  });
});

describe('Plans: PRICING in the expanded card (#816 §4)', () => {
  it('is visible while expanded, immediately after GENERAL', () => {
    const general = expandedSrc.indexOf('plans.section_general');
    const pricing = expandedSrc.indexOf('plans.section_pricing');
    const billing = expandedSrc.indexOf('plans.section_billing_duration');
    expect(pricing).toBeGreaterThan(general);
    expect(pricing).toBeLessThan(billing);
  });

  it('shows the existing Tax Rate and Current Price, with no second price source', () => {
    expect(expandedSrc).toContain("label={t('plans.label_tax_rate')}");
    expect(expandedSrc).toContain("label={t('plans.label_current_price')}");
    // Still the plan's own columns — never a second fetch or a recomputed price.
    // #817 moved the formatting into planProfile.ts's `formatPlanCurrentPrice`,
    // which is handed the plan row itself and does no arithmetic of its own
    // (asserted directly in plans-price-history-collapsible.test.ts).
    expect(expandedSrc).toContain('formatPlanCurrentPrice(');
    expect(expandedSrc).toContain('plans.tax_included_suffix');
    expect(pageSrc).not.toContain('/pricing/preview');
  });

  it('falls back to the em dash when no price is configured yet', () => {
    expect(
      formatPlanCurrentPrice(
        { current_price: null, amount_excl_tax: null, amount_incl_tax: null },
        'VAT included',
        (excl, incl) => `net €${excl} + tax = €${incl}`,
      ),
    ).toBe(EMPTY_VALUE);
  });

  it('keeps Pricing editable through the existing PUT', () => {
    expect(pageSrc).toContain('`/membership-plans/${planId}/pricing`');
  });
});

describe('Plans: terminology is unchanged (#816 §6–§8, §14)', () => {
  it('keeps the Plan section names, never the Promotion ones #815 introduced', () => {
    for (const key of ['promo_benefits_session', 'promo_benefits_oneoff', 'promo_benefits_periodical']) {
      expect(pageSrc, `${key} belongs to the Promotion card, not the Plan`).not.toContain(key);
    }
    expect(locales.en.section_oneoff_benefits).toBe('One-off Benefits');
    expect(locales.en.section_session_benefits).toBe('Session Benefits');
    expect(locales.en.section_plan_period_benefits).toBe('Period Benefits');
    // #818 renamed this one section: the Billing Events Forecast became the
    // Example Timeline, the name the Promotion card already uses.
    expect(locales.en.section_example_timeline).toBe('Example Timeline');
  });

  it('introduces no BILLING PLAN section', () => {
    expect(pageSrc).not.toContain('section_billing_plan');
    for (const code of LOCALE_CODES) {
      expect(Object.keys(locales[code])).not.toContain('section_billing_plan');
    }
  });

  it('renames the old Status section header to GENERAL in every locale', () => {
    for (const code of LOCALE_CODES) {
      expect(locales[code].section_general, `plans.section_general missing from ${code}.json`).toBeTruthy();
      // The key it replaces is gone: nothing reads it any more.
      expect(Object.keys(locales[code])).not.toContain('section_status');
    }
    expect(pageSrc).not.toContain('plans.section_status');
    expect(locales.en.section_general).toBe('General');
  });
});

describe('planProfile: the GENERAL field set', () => {
  it('lists §3\'s fields in §3\'s order', () => {
    expect(PLAN_GENERAL_FIELDS.map((f) => f.key)).toEqual([
      'name',
      'description',
      'lifecycle_status',
      'enrollment_status',
      'member_limit',
      'member_count',
    ]);
    expect(PLAN_GENERAL_SECTION.titleKey).toBe('section_general');
  });

  it('labels the read-only rows with the plain keys, not the form\'s starred one', () => {
    const labels = Object.fromEntries(PLAN_GENERAL_FIELDS.map((f) => [f.key, f.labelKey]));
    expect(labels.name).toBe('col_name');
    expect(labels.description).toBe('col_description');
    expect(locales.en.col_name).toBe('Name');
    expect(locales.en.label_name).toContain('*');
    for (const field of PLAN_GENERAL_FIELDS) {
      for (const code of LOCALE_CODES) {
        expect(locales[code][field.labelKey], `plans.${field.labelKey} missing from ${code}.json`).toBeTruthy();
      }
    }
  });

  it('never offers a control for the derived member count', () => {
    expect(PLAN_GENERAL_EDITABLE_FIELDS.map((f) => f.key)).toEqual([
      'name',
      'description',
      'lifecycle_status',
      'enrollment_status',
      'member_limit',
    ]);
    expect(PLAN_GENERAL_FIELDS.find((f) => f.key === 'member_count')!.editable).toBe(false);
    expect(pageSrc).not.toContain('member_count: ');
  });

  it('maps a persisted row onto the form values', () => {
    expect(toPlanGeneralFormValues(row())).toEqual({
      name: 'Standard',
      description: 'Full gym access',
      lifecycle_status: 'active',
      enrollment_status: 'public',
      member_limit: '2',
    });
  });

  it('turns a null description into the empty control value, and back to null', () => {
    const values = toPlanGeneralFormValues(row({ description: null }));
    expect(values.description).toBe('');
    expect(toPlanGeneralUpdatePayload(values).description).toBeNull();
  });

  it('submits exactly the columns the pre-#816 form did, trimmed', () => {
    const payload = toPlanGeneralUpdatePayload({
      ...EMPTY_PLAN_GENERAL_FORM,
      name: '  Standard  ',
      description: '  Full gym access  ',
      lifecycle_status: 'paused',
      enrollment_status: 'public',
      member_limit: 'family',
    });
    expect(payload).toEqual({
      name: 'Standard',
      description: 'Full gym access',
      lifecycle_status: 'paused',
      enrollment_status: 'public',
      member_limit: 'family',
    });
    // Price and VAT stay out of it: saving them is what opens a new price (#547).
    expect(Object.keys(payload)).not.toContain('price');
    expect(Object.keys(payload)).not.toContain('tax_rate_id');
  });

  it('requires a name and nothing else', () => {
    expect(isPlanGeneralFormValid(EMPTY_PLAN_GENERAL_FORM)).toBe(false);
    expect(isPlanGeneralFormValid({ ...EMPTY_PLAN_GENERAL_FORM, name: '   ' })).toBe(false);
    expect(isPlanGeneralFormValid({ ...EMPTY_PLAN_GENERAL_FORM, name: 'Standard' })).toBe(true);
  });
});

describe('planProfile: read-only formatting', () => {
  const translateStatus = (key: string) => `status:${key}`;
  const translateMemberLimit = (value: string) => `limit:${value}`;

  function render(key: string, r: PlanGeneralRow = row()): string {
    const field = PLAN_GENERAL_FIELDS.find((f) => f.key === key)!;
    return formatPlanGeneralField(r, field, translateStatus, translateMemberLimit);
  }

  it('reads a status through the same labels the form\'s select shows', () => {
    expect(render('lifecycle_status')).toBe('status:active');
    expect(render('enrollment_status')).toBe('status:public');
  });

  it('reads the member limit through its own label', () => {
    expect(render('member_limit')).toBe('limit:2');
  });

  it('renders the derived count as a number, never as a blank', () => {
    expect(render('member_count')).toBe('24');
    expect(render('member_count', row({ member_count: 0 }))).toBe('0');
  });

  it('falls back to the em dash for anything missing', () => {
    expect(render('description', row({ description: null }))).toBe(EMPTY_VALUE);
    expect(render('description', row({ description: '' }))).toBe(EMPTY_VALUE);
    expect(EMPTY_VALUE).toBe('—');
  });
});
