import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PROMOTION_ITEM_ACTIONS } from '@/lib/productBenefitActions';

// #924 stage 2 — the applied-Promotion grant sections of the Assigned Plan card
// join the same shared column grid stage 1 put the Plan Benefit sections on.
//
// §1 is the rule ("do not create a separate visual system for Assigned Plans")
// and §6 is where it points next: the Products an applied Promotion
// granted were the card's last hand-rolled `<table>`, with its own columns, its
// own widths and one money column. They now render from
// `PRODUCT_BENEFIT_COLUMNS` (#916, #919/#920) in the Promotion's own
// option set, while the numbers stay the application's own snapshot (#635 §16).
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so the
// page's wiring is pinned by scanning the source, as
// assigned-plan-benefit-columns.test.ts does for stage 1.

const SRC = join(__dirname, '..');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;
const ASSIGNED_PLANS_DIR = join(SRC, 'components', 'assignedPlan');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const promotionsSrc = stripComments(
  readFileSync(join(ASSIGNED_PLANS_DIR, 'AssignedPlanPromotions.tsx'), 'utf-8'),
);
const typesSrc = stripComments(readFileSync(join(ASSIGNED_PLANS_DIR, 'types.ts'), 'utf-8'));

function assignedPlansMessages(code: string): Record<string, string> {
  const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
  return messages.assigned_plans_page ?? {};
}

describe('#924 §1/§6: the grant sections render from the shared grid', () => {
  it('renders the shared read-only view, not a table of its own', () => {
    expect(promotionsSrc).toContain('ProductBenefitView');
    expect(promotionsSrc).toContain("from '@/components/ProductBenefits'");
    // The replaced table's markup and its own header/cell styles went with it.
    expect(promotionsSrc).not.toContain('<table');
    expect(promotionsSrc).not.toContain('<thead');
    expect(promotionsSrc).not.toContain('borderCollapse');
    expect(promotionsSrc).not.toContain('function GrantTable');
  });

  it('shows the full six-column grid, in the Promotion\'s option set', () => {
    // All five actions can appear on a grant (#896 §16), which is why the
    // context is the Promotion's and not the Plan's three.
    expect(promotionsSrc).toContain('benefitContext="promotion"');
    expect(promotionsSrc).toContain('showPrices');
  });

  it('keeps the Frequency column in all three sections', () => {
    // #916: a One-off grant has no frequency to show, and its cell stays with a
    // "—" rather than disappearing and shifting the columns after it — which is
    // what the per-section `showFrequency` flag used to do here.
    expect(promotionsSrc).toContain('showFrequency\n');
    expect(promotionsSrc).not.toContain('showFrequency: false');
    expect(promotionsSrc).not.toContain('showFrequency: true');
  });

  it('leaves the renewal Frequency to the Plan\'s Session Benefits (#918)', () => {
    // A Promotion grant has no `frequency` column at all, so the shared cell
    // stays on its default `'item'` — the Product's own billing frequency.
    expect(promotionsSrc).not.toContain('frequencyColumn');
  });

  it('maps the frozen grant into the shared row and prices nothing itself', () => {
    expect(promotionsSrc).toContain('function toGrantRow');
    expect(promotionsSrc).toContain('rows={(p[key] ?? []).map(toGrantRow)}');
    for (const field of [
      'original_price_incl_tax', 'final_price_incl_tax',
      'original_line_price_incl_tax', 'final_line_price_incl_tax',
    ]) {
      expect(promotionsSrc, `${field} is not passed through to the grid`).toContain(field);
      expect(typesSrc, `${field} is not part of the grant row`).toContain(field);
    }
    // #817: no arithmetic in the page — not a multiplication by the quantity,
    // not a percentage, not a tax factor.
    expect(promotionsSrc).not.toMatch(/unit_price\s*\*/);
    expect(promotionsSrc).not.toMatch(/\bvalue\s*\/\s*100\b/);
    expect(promotionsSrc).not.toContain('tax_rate');
  });

  it('asks for promotion-voiced labels, leaving the Plan sections theirs', () => {
    // Both halves of this card live in one namespace, so the key itself carries
    // the voice: the Plan Benefit sections above keep `item_action_*`
    // ("Benefit"), these ask for `promo_item_action_*` ("Promotion").
    expect(promotionsSrc).toContain('PROMOTION_VOICED_KEYS');
    expect(promotionsSrc).toContain('`promo_${key}`');
    expect(promotionsSrc).toContain('t={grantT}');
  });
});

describe('#924 stage 2: locales', () => {
  const REQUIRED = [
    'promo_col_item_action',
    ...PROMOTION_ITEM_ACTIONS.map((a) => `promo_item_action_${a}`),
  ];

  it('has every promotion-voiced key the grid resolves, in every locale', () => {
    // next-intl prints a missing key verbatim and has no fallback, so a cell
    // would read "assigned_plans_page.promo_item_action_waive" on screen.
    for (const code of LOCALE_CODES) {
      const keys = new Set(Object.keys(assignedPlansMessages(code)));
      expect(REQUIRED.filter((k) => !keys.has(k)), `${code}.json`).toEqual([]);
    }
  });

  it('says "Promotion" where a Promotion grants the line, "Benefit" where a Plan does', () => {
    // #896 §3/§4 — the same stored `no_benefit`, two voices, one card.
    const en = assignedPlansMessages('en');
    expect(en.promo_col_item_action).toBe('Promotion');
    expect(en.promo_item_action_no_benefit).toBe('No promotion');
    expect(en.col_item_action).toBe('Benefit');
    expect(en.item_action_no_benefit).toBe('No benefit');
  });

  it('never says "Benefit" in a promotion-voiced label (§3)', () => {
    for (const code of LOCALE_CODES) {
      const ns = assignedPlansMessages(code);
      for (const key of REQUIRED) {
        expect(String(ns[key]).toLowerCase(), `${code}.${key}`).not.toMatch(/benefi/);
      }
    }
  });
});
