import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  SELLABLE_ITEM_BENEFIT_COLUMNS,
  sellableItemBenefitColumns,
} from '@/components/SellableItemBenefits';

// #924 stage 1 — the Assigned Plan's three Sellable Item sections join the one
// shared column grid.
//
// The ticket's §1 is the rule the whole stage serves:
//
//   > Do not create a separate visual system for Assigned Plans.
//
// and §4 says what that means here: the same `SELLABLE ITEM | QUANTITY |
// FREQUENCY | BENEFIT | REGULAR PRICE | FINAL PRICE` grid the Membership Plan
// (#916) and Promotion (#919/#920) cards already render from, tax included,
// reusing the shared component rather than "implementing an Assigned Plan-
// specific version". What stays the Assigned Plan's own is *where the numbers
// come from*: its snapshot (#635 §17), never the live catalogue.
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so the
// shared declaration is exercised directly and the page's wiring is pinned by
// scanning the source, the way plan-benefit-columns.test.ts does.

const SRC = join(__dirname, '..');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;
const ASSIGNED_PLANS_DIR = join(SRC, 'app', '[locale]', 'financials', 'assigned-plans');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const configSrc = stripComments(
  readFileSync(join(ASSIGNED_PLANS_DIR, 'AssignedPlanConfiguration.tsx'), 'utf-8'),
);
const typesSrc = stripComments(readFileSync(join(ASSIGNED_PLANS_DIR, 'types.ts'), 'utf-8'));

function assignedPlansKeys(code: string): Set<string> {
  const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
  return new Set(Object.keys(messages.assigned_plans_page ?? {}));
}

describe('#924 §1/§4: the snapshot sections render from the shared grid', () => {
  it('renders the shared read-only view, not a table of its own', () => {
    expect(configSrc).toContain('SellableItemBenefitView');
    expect(configSrc).toContain("from '@/components/SellableItemBenefits'");
    // The replaced table's own header/cell styles went with it; a page that
    // restates them is the separate visual system §1 forbids.
    expect(configSrc).not.toContain('<table');
    expect(configSrc).not.toContain('<thead');
    expect(configSrc).not.toContain('borderCollapse');
  });

  it('shows the full six-column grid — Benefit and both prices included', () => {
    // The page opts into the two price columns and the Benefit column; the grid
    // itself, and the order, are the shared declaration's.
    expect(configSrc).toContain('showPrices');
    expect(configSrc).toContain('benefitContext="plan"');
    // #959's Requirement is a *Promotion* line's flag, so these Plan-side
    // snapshot sections do not opt in and their grid is the six columns it was.
    expect(configSrc).not.toContain('showRequirement');
    expect(
      sellableItemBenefitColumns({ showFrequency: true, showAction: true, showPrices: true })
        .map((c) => c.key),
    ).toEqual(
      SELLABLE_ITEM_BENEFIT_COLUMNS.map((c) => c.key).filter((k) => k !== 'requirement'),
    );
  });

  it('keeps the Frequency column in all three sections, as the Plan card does', () => {
    // #916: a column a section has no value for keeps its cell with a "—"
    // rather than disappearing and shifting the columns after it.
    const sections = configSrc.match(/\{ section: '(oneoff|session|periodical)'[^}]*\}/g) ?? [];
    expect(sections, 'the three benefit sections are no longer declared in one place')
      .toHaveLength(3);
    for (const section of sections) {
      expect(section, `${section} hides the Frequency column`).toContain('showFrequency: true');
    }
  });

  it("shows the Session section's agreed renewal Frequency, the others' item frequency (§5)", () => {
    const sectionOf = (name: string) =>
      (configSrc.match(new RegExp(`\\{ section: '${name}'[^}]*\\}`)) ?? [''])[0];
    expect(sectionOf('session')).toContain("viewFrequencyColumn: 'benefit'");
    expect(sectionOf('oneoff')).toContain("viewFrequencyColumn: 'item'");
    expect(sectionOf('periodical')).toContain("viewFrequencyColumn: 'item'");
  });

  it('leaves the editor on quantity alone — no Benefit column, no Frequency control', () => {
    // #896 stage 4 / #918: the assignment's section `PUT` takes `gym_charge_id`
    // + `quantity`, and keeps a kept line's stored pair and Frequency. A
    // control the save cannot carry would be one that silently changes nothing,
    // so the editor renders neither — which is also why the read-only mapping
    // is the one place the extra fields are added.
    const editor = (configSrc.match(/<SellableItemBenefitEditor[\s\S]*?\/>/) ?? [''])[0];
    expect(editor, 'the editor now offers a Benefit column').not.toContain('benefitContext');
    expect(editor, 'the editor now offers a Frequency control').not.toContain('frequencyColumn');
    expect(configSrc).toContain('toBenefitItems(benefitDraft)');
  });

  it('maps the frozen line into the shared row rather than re-reading the entity', () => {
    // One mapping, built on the editor's own (#797): the half that reads and the
    // half that writes cannot disagree about what a line is.
    expect(configSrc).toMatch(/function toViewRow\([\s\S]{0,200}\.\.\.toDraftRow\(b\)/);
    expect(configSrc).toContain('rows={rows.map(toViewRow)}');
    for (const field of [
      'original_price_incl_tax', 'final_price_incl_tax',
      'original_line_price_incl_tax', 'final_line_price_incl_tax',
    ]) {
      expect(configSrc, `${field} is not passed through to the grid`).toContain(field);
      expect(typesSrc, `${field} is not part of the snapshot row`).toContain(field);
    }
  });

  it('prices nothing in the page — the amounts are the server\'s (#817)', () => {
    // No multiplication by a quantity, no percentage arithmetic, no tax factor:
    // the server reports the unit and line pair and the page formats them.
    expect(configSrc).not.toMatch(/unit_price\s*\*/);
    expect(configSrc).not.toMatch(/\bvalue\s*\/\s*100\b/);
    expect(configSrc).not.toContain('tax_rate');
  });
});

describe('#924 stage 1: locales', () => {
  const REQUIRED = [
    'col_item_action', 'col_original_price', 'col_final_price', 'benefit_total_price',
    'item_action_no_benefit', 'item_action_waive', 'item_action_percentage_discount',
    'session_frequency_none', 'session_frequency_once', 'session_frequency_week',
    'session_frequency_four_weeks', 'session_frequency_month', 'session_frequency_year',
  ];

  it('has every key the shared grid resolves, in every locale', () => {
    // next-intl prints a missing key verbatim and has no fallback, so a cell
    // would read "assigned_plans_page.col_final_price" on screen.
    for (const code of LOCALE_CODES) {
      const keys = assignedPlansKeys(code);
      expect(REQUIRED.filter((k) => !keys.has(k)), `${code}.json`).toEqual([]);
    }
  });

  it('labels the Benefit column the way the Membership Plan does, never "Promotion"', () => {
    // §4: the same behaviour and terminology as the Plan these lines came from.
    // The word "Promotion" belongs to the applied-Promotion sections (#896 §3).
    const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf-8'));
    expect(en.assigned_plans_page.col_item_action).toBe(en.plans.col_item_action);
    expect(en.assigned_plans_page.item_action_no_benefit).toBe(en.plans.item_action_no_benefit);
  });
});
