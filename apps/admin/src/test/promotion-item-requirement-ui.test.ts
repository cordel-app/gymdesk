import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_PROMOTION_ITEM_REQUIREMENT,
  PROMOTION_ITEM_REQUIREMENTS,
  promotionItemRequirementLabelKey,
  toPromotionItemRequirement,
} from '@/lib/promotionItemRequirement';
import {
  PRODUCT_BENEFIT_COLUMNS,
  ProductBenefitRow,
  productBenefitColumns,
  toBenefitItems,
} from '@/components/ProductBenefits';

// #959 — a Product configured inside a **Promotion** carries a
// **Requirement**: Mandatory, or Optional for an item the member may decline when
// the Promotion is assigned.
//
// The rule itself is the API's: `domain/promotionItemRequirement.ts` declares the
// option set, the three section `PUT`s are the 400 and `chk_<table>_requirement`
// (migration 207) is the backstop, each with its own test. Nothing here is
// enforcement. What is pinned is the part only the UI can get wrong:
//
//   * the list this app renders still agrees with the API's (the third place of
//     the "three places" rule the API module's header states);
//   * the Requirement is one more entry in the **shared** column declaration,
//     rendered only where the page opts in — the Promotions page — so no Plan or
//     Assigned Plan section grows a control its `PUT` cannot carry;
//   * a section that does not configure it keeps submitting payloads without the
//     key, because the API reads "no requirement named" as *keep what is stored*
//     (#896's rule, which a replace-all `PUT` makes load-bearing);
//   * both options have a label in all three locales — next-intl prints a
//     missing key verbatim;
//   * and the labels obey #896 §3: nothing in the Promotions namespace says
//     "Benefit", which the shared `product-benefit-actions-ui.test.ts`
//     already asserts namespace-wide and these keys must not be the exception.
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so the
// structure is scanned from source the way the two tests above it do, while the
// shared module's pure parts are exercised directly.

const ROOT = join(__dirname, '..', '..', '..', '..');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const COMPONENT = join(__dirname, '..', 'components', 'ProductBenefits.tsx');
const PROMOTIONS_PAGE = join(__dirname, '..', 'app', '[locale]', 'promotions', 'page.tsx');
const PLANS_PAGE = join(__dirname, '..', 'app', '[locale]', 'plans', 'page.tsx');
const API_DECLARATION = join(ROOT, 'api', 'src', 'domain', 'promotionItemRequirement.ts');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const componentSrc = stripComments(readFileSync(COMPONENT, 'utf-8'));
const promotionsSrc = stripComments(readFileSync(PROMOTIONS_PAGE, 'utf-8'));
const plansSrc = stripComments(readFileSync(PLANS_PAGE, 'utf-8'));

function row(over: Partial<ProductBenefitRow> = {}): ProductBenefitRow {
  return {
    gym_charge_id: 1, quantity: 2, gym_charge_name: 'Locker Fee',
    gym_charge_type: 'service', gym_charge_billing_frequency: 'month',
    gym_charge_status: 'active', ...over,
  };
}

describe('the option set mirrors the API declaration', () => {
  it('offers the same two values, in the same order', () => {
    const src = readFileSync(API_DECLARATION, 'utf-8');
    const block = /export const PROMOTION_ITEM_REQUIREMENTS[^=]*=\s*\[([^\]]*)\]/.exec(src);
    expect(block, 'PROMOTION_ITEM_REQUIREMENTS is gone from the API declaration').not.toBeNull();
    const apiList = [...(block as RegExpExecArray)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect([...PROMOTION_ITEM_REQUIREMENTS]).toEqual(apiList);
  });

  it('mirrors the API default, which is also migration 207\'s backfill', () => {
    const src = readFileSync(API_DECLARATION, 'utf-8');
    expect(src).toContain("DEFAULT_PROMOTION_ITEM_REQUIREMENT: PromotionItemRequirement = 'mandatory'");
    expect(DEFAULT_PROMOTION_ITEM_REQUIREMENT).toBe('mandatory');
  });

  it('reads anything else back as the default rather than leaving a cell empty', () => {
    expect(toPromotionItemRequirement('optional')).toBe('optional');
    expect(toPromotionItemRequirement('')).toBe('mandatory');
    expect(toPromotionItemRequirement(undefined)).toBe('mandatory');
    expect(toPromotionItemRequirement('Optional')).toBe('mandatory');
  });
});

describe('it is one more column of the shared grid, not a grid of its own', () => {
  it('sits after Benefit and before the two prices', () => {
    const at = (key: string) => PRODUCT_BENEFIT_COLUMNS.findIndex((c) => c.key === key);
    expect(at('requirement')).toBeGreaterThan(at('action'));
    expect(at('requirement')).toBeLessThan(at('original_price'));
  });

  it('renders only where the page opts in', () => {
    const keys = (opts: Parameters<typeof productBenefitColumns>[0]) =>
      productBenefitColumns(opts).map((c) => c.key);
    const base = { showFrequency: true, showAction: true, showPrices: true };
    expect(keys(base)).not.toContain('requirement');
    expect(keys({ ...base, showRequirement: true })).toContain('requirement');
  });

  it('is the Promotions page that opts in, in both halves of the card', () => {
    // One editor and one read-only view, both wired from the page's two wrappers —
    // which is also where the Promotion's own context is named, so all three
    // sections get the column at once.
    expect(promotionsSrc.match(/showRequirement/g) ?? []).toHaveLength(2);
  });

  it('is not offered by the Membership Plans page — the thread excludes Plans', () => {
    expect(plansSrc).not.toContain('showRequirement');
  });

  it('uses the existing inline select rather than a new control', () => {
    // §"The UI should use the application's existing control/component patterns…
    // Do not introduce a custom visual pattern".
    expect(componentSrc).toMatch(
      /value=\{toPromotionItemRequirement\(row\.requirement\)\}[\s\S]{0,320}?style=\{inlineSelectSt\}/,
    );
    expect(componentSrc).toContain('{PROMOTION_ITEM_REQUIREMENTS.map((r) => (');
  });

  it('declares no colour, badge or style of its own', () => {
    // The catalogue item's own #893 `Mandatory` pill is `mandatoryTagStyle` and
    // belongs to the Plans page; this column is a value in a cell.
    const cell = componentSrc.slice(componentSrc.indexOf("case 'requirement':"));
    expect(cell.slice(0, 300)).not.toMatch(/#[0-9a-f]{3,6}|mandatoryTagStyle/i);
  });
});

describe('the payload keeps the API\'s replace-all rule', () => {
  it('submits the Requirement only when the draft row carries the key', () => {
    expect(toBenefitItems([row()])).toEqual([{ gym_charge_id: 1, quantity: 2 }]);
    expect(toBenefitItems([row({ requirement: 'optional' })]))
      .toEqual([{ gym_charge_id: 1, quantity: 2, requirement: 'optional' }]);
  });

  it('carries it beside the treatment pair and the Frequency', () => {
    expect(toBenefitItems([row({
      requirement: 'mandatory', action: 'percentage_discount', value: 50, frequency: 'month',
    })])).toEqual([{
      gym_charge_id: 1, quantity: 2, frequency: 'month', requirement: 'mandatory',
      action: 'percentage_discount', value: 50,
    }]);
  });

  it('seeds a new line with the default only where the column is shown', () => {
    expect(componentSrc).toContain(
      "showRequirement ? { requirement: DEFAULT_PROMOTION_ITEM_REQUIREMENT } : undefined,",
    );
  });
});

describe('every option has a label', () => {
  it('names each value with its own key', () => {
    expect(promotionItemRequirementLabelKey('mandatory')).toBe('item_requirement_mandatory');
    expect(promotionItemRequirementLabelKey('optional')).toBe('item_requirement_optional');
  });

  for (const code of LOCALE_CODES) {
    it(`has every key in ${code}`, () => {
      const promotions = JSON.parse(
        readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'),
      ).promotions;
      for (const key of ['col_requirement', 'item_requirement_hint']) {
        expect(promotions[key], `promotions.${key} missing in ${code}`).toBeTruthy();
      }
      for (const requirement of PROMOTION_ITEM_REQUIREMENTS) {
        const key = promotionItemRequirementLabelKey(requirement);
        expect(promotions[key], `promotions.${key} missing in ${code}`).toBeTruthy();
      }
    });

    it(`says nothing about "Benefit" in ${code} (#896 §3)`, () => {
      const promotions = JSON.parse(
        readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'),
      ).promotions;
      for (const key of [
        'col_requirement', 'item_requirement_hint',
        'item_requirement_mandatory', 'item_requirement_optional',
      ]) {
        expect(String(promotions[key]).toLowerCase(), `${code}.promotions.${key}`)
          .not.toMatch(/benefi/);
      }
    });
  }
});
