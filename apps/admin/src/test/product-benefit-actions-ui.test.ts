import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_BENEFIT_ACTION,
  PLAN_BENEFIT_ACTIONS,
  PROMOTION_ITEM_ACTIONS,
  benefitActionOf,
  benefitActionRequiresValue,
  benefitActionsFor,
} from '@/lib/productBenefitActions';
import {
  ProductBenefitRow,
  addBenefitRow,
  benefitTreatmentLabel,
  clampBenefitValue,
  invalidBenefitValueRow,
  toBenefitItems,
} from '@/components/ProductBenefits';

// #896 stage 4 — the Product configured inside a Promotion or a
// Membership Plan gains a pricing treatment beside its Quantity.
//
// The rule itself is the API's: `domain/productBenefitActions.ts` declares
// the two option sets, `benefitConfigError()` is the 400 and the CHECK beside
// each of the twelve tables is the backstop (stage 1/2, with their own tests).
// Nothing here is enforcement. What is pinned is the part only the UI can get
// wrong:
//
//   * the option lists this app renders still agree with the API's (the third
//     place of the "two places" rule the API module's header states);
//   * a Plan's dropdown cannot offer `Fixed discount` / `Fixed Price` (§16);
//   * the value input appears exactly when the action asks for one (§6), and
//     only the value belonging to the selected action is submitted (§16);
//   * a caller that configures no treatment keeps sending quantity-only lines,
//     because the API reads "no action named" as *keep what is stored*;
//   * the Promotions UI never says "Benefit" (§3), while the same stored
//     `no_benefit` reads as *No benefit* on the Plans page (§4).
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so the
// structure is scanned from source the way plans-expanded-read-only.test.ts
// does, while the shared module's pure parts are exercised directly.

const ROOT = join(__dirname, '..', '..', '..', '..');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const COMPONENT = join(__dirname, '..', 'components', 'ProductBenefits.tsx');
const PLANS_PAGE = join(__dirname, '..', 'app', '[locale]', 'plans', 'page.tsx');
const PROMOTIONS_PAGE = join(__dirname, '..', 'app', '[locale]', 'promotions', 'page.tsx');
const ASSIGNED_PLAN = join(
  __dirname, '..', 'app', '[locale]', 'financials', 'assigned-plans', 'AssignedPlanConfiguration.tsx',
);
const API_DECLARATION = join(ROOT, 'api', 'src', 'domain', 'productBenefitActions.ts');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const componentSrc = stripComments(readFileSync(COMPONENT, 'utf-8'));
const plansSrc = stripComments(readFileSync(PLANS_PAGE, 'utf-8'));
const promotionsSrc = stripComments(readFileSync(PROMOTIONS_PAGE, 'utf-8'));
const assignedPlanSrc = stripComments(readFileSync(ASSIGNED_PLAN, 'utf-8'));

function row(over: Partial<ProductBenefitRow> = {}): ProductBenefitRow {
  return {
    product_id: 1, quantity: 1, product_name: 'Personal Training', product_type: 'fee',
    product_billing_frequency: null, product_status: 'active', ...over,
  };
}

/** The API's own list, read out of its source — this app cannot import it. */
function apiActions(name: string): string[] {
  const src = readFileSync(API_DECLARATION, 'utf-8');
  const block = new RegExp(`export const ${name}[^=]*=\\s*\\[([^\\]]*)\\]`).exec(src);
  expect(block, `${name} is gone from the API declaration`).not.toBeNull();
  return [...(block as RegExpExecArray)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('the option sets mirror the API declaration', () => {
  it('offers the Promotion side all five, in the API\'s order', () => {
    expect([...PROMOTION_ITEM_ACTIONS]).toEqual(apiActions('PROMOTION_ITEM_ACTIONS'));
  });

  it('offers a Membership Plan the same three the API allows it (§16)', () => {
    expect([...PLAN_BENEFIT_ACTIONS]).toEqual(apiActions('PLAN_BENEFIT_ACTIONS'));
    // Spelled out too: a Plan must never be able to pick a monetary treatment.
    expect(PLAN_BENEFIT_ACTIONS).not.toContain('fixed_discount');
    expect(PLAN_BENEFIT_ACTIONS).not.toContain('fixed_price');
  });

  it('starts a new line neutral (§13)', () => {
    expect(DEFAULT_BENEFIT_ACTION).toBe('no_benefit');
    expect(benefitActionsFor('promotion')[0]).toBe('no_benefit');
    expect(benefitActionsFor('plan')[0]).toBe('no_benefit');
  });

  it('reads an action its context may not configure as the default', () => {
    expect(benefitActionOf('promotion', 'fixed_price')).toBe('fixed_price');
    expect(benefitActionOf('plan', 'fixed_price')).toBe('no_benefit');
    expect(benefitActionOf('plan', undefined)).toBe('no_benefit');
  });

  it('asks for a value for exactly the three that take one (§6)', () => {
    expect(benefitActionRequiresValue('no_benefit')).toBe(false);
    expect(benefitActionRequiresValue('waive')).toBe(false);
    expect(benefitActionRequiresValue('percentage_discount')).toBe(true);
    expect(benefitActionRequiresValue('fixed_discount')).toBe(true);
    expect(benefitActionRequiresValue('fixed_price')).toBe(true);
  });
});

describe('addBenefitRow seeds the neutral treatment', () => {
  it('adds a line that charges the item\'s own price until someone says otherwise', () => {
    let draft: ProductBenefitRow[] = [];
    const setDraft = (fn: (prev: ProductBenefitRow[]) => ProductBenefitRow[]) => {
      draft = fn(draft);
    };
    addBenefitRow(setDraft, [{
      id: 7, name: 'Personal Training', type: 'fee', billing_frequency: null,
      status: 'active', benefit_category: 'session',
    }], draft);
    expect(draft[0].action).toBe('no_benefit');
    expect(draft[0].value).toBeNull();
  });
});

describe('toBenefitItems', () => {
  it('sends quantity alone for a caller that configures no treatment', () => {
    // The Assigned Plan snapshot sections: their endpoint takes quantity only,
    // and `parseProductBenefitInput()` reads an unnamed action as "keep
    // what is stored" — sending a default here would clear a real discount.
    expect(toBenefitItems([row()])).toEqual([{ product_id: 1, quantity: 1 }]);
  });

  it('sends the pair once the line carries one', () => {
    expect(toBenefitItems([row({ action: 'percentage_discount', value: 20 })]))
      .toEqual([{ product_id: 1, quantity: 1, action: 'percentage_discount', value: 20 }]);
  });

  it('submits only the value the selected action takes (§16)', () => {
    // The editor keeps a typed number while the action changes, so switching
    // back restores it; this is where the one that no longer applies is dropped.
    expect(toBenefitItems([row({ action: 'waive', value: 20 })]))
      .toEqual([{ product_id: 1, quantity: 1, action: 'waive', value: null }]);
    expect(toBenefitItems([row({ action: 'no_benefit', value: 20 })]))
      .toEqual([{ product_id: 1, quantity: 1, action: 'no_benefit', value: null }]);
  });
});

describe('invalidBenefitValueRow', () => {
  it('passes a complete line and one that needs no value', () => {
    expect(invalidBenefitValueRow([row({ action: 'waive', value: null })])).toBeNull();
    expect(invalidBenefitValueRow([row({ action: 'fixed_price', value: '20.00' })])).toBeNull();
    expect(invalidBenefitValueRow([row()])).toBeNull();
  });

  it('names the line whose action asks for a value it has not got', () => {
    for (const value of [null, undefined, '', 'abc', -1]) {
      expect(invalidBenefitValueRow([row({ action: 'fixed_discount', value: value as any })]))
        .not.toBeNull();
    }
  });

  it('refuses a percentage outside 0..100, as the API does', () => {
    expect(invalidBenefitValueRow([row({ action: 'percentage_discount', value: 101 })])).not.toBeNull();
    expect(invalidBenefitValueRow([row({ action: 'percentage_discount', value: 100 })])).toBeNull();
    expect(invalidBenefitValueRow([row({ action: 'percentage_discount', value: 0 })])).toBeNull();
  });
});

describe('clampBenefitValue', () => {
  it('clamps a percentage as it is typed and leaves an amount alone', () => {
    expect(clampBenefitValue('percentage_discount', '120')).toBe('100');
    expect(clampBenefitValue('percentage_discount', '20')).toBe('20');
    expect(clampBenefitValue('fixed_price', '1200')).toBe('1200');
  });

  it('keeps an empty box empty rather than inventing a zero', () => {
    expect(clampBenefitValue('percentage_discount', '')).toBe('');
    expect(clampBenefitValue('fixed_discount', '')).toBe('');
  });
});

describe('benefitTreatmentLabel', () => {
  const t = (key: string) => key;

  it('says the same stored action differently in each context (§3/§4)', () => {
    // One vocabulary, two namespaces: the key is the same, the page's messages
    // are not — `promotions.item_action_no_benefit` is "No promotion".
    expect(benefitTreatmentLabel(t, 'promotion', row({ action: 'no_benefit' })))
      .toBe('item_action_no_benefit');
    expect(benefitTreatmentLabel(t, 'plan', row({ action: 'no_benefit' })))
      .toBe('item_action_no_benefit');
  });

  it('carries the configured value for the three that have one', () => {
    expect(benefitTreatmentLabel(t, 'promotion', row({ action: 'percentage_discount', value: 20 })))
      .toBe('item_action_percentage_discount (20%)');
    expect(benefitTreatmentLabel(t, 'promotion', row({ action: 'fixed_discount', value: 10 })))
      .toBe('item_action_fixed_discount (10.00€)');
    expect(benefitTreatmentLabel(t, 'promotion', row({ action: 'fixed_price', value: '20' })))
      .toBe('item_action_fixed_price (20.00€)');
  });

  it('never shows a Plan a treatment it may not configure', () => {
    expect(benefitTreatmentLabel(t, 'plan', row({ action: 'fixed_price', value: 20 })))
      .toBe('item_action_no_benefit');
  });
});

describe('the shared editor renders the treatment', () => {
  it('gates the whole column on an explicit context', () => {
    expect(componentSrc).toContain('benefitContext?: ProductBenefitContext;');
    expect(componentSrc).toContain("...(benefitContext ? ['130px', '110px'] : []),");
    expect(componentSrc).toContain("{benefitContext && <span style={colHeaderSt}>{t('col_item_action')}</span>}");
  });

  it('builds the dropdown from the context\'s own option set', () => {
    expect(componentSrc).toContain('{benefitActionsFor(benefitContext).map((a) => (');
    expect(componentSrc).toContain("<option key={a} value={a}>{t(`item_action_${a}`)}</option>");
    // The list is never spelled out in the component — one declaration only.
    expect(componentSrc).not.toContain("'fixed_price'");
  });

  it('shows the value input exactly when the action asks for one (§6)', () => {
    expect(componentSrc).toContain('benefitActionRequiresValue(action) ? (');
    expect(componentSrc).toContain(') : <span />');
    // …and names it after the action, since one header could not say
    // "Promotion (%)", "Promotion amount" and "Promotion price" at once.
    expect(componentSrc).toContain('{t(`item_action_value_${action}`)}');
  });

  it('keeps a typed value when the action changes', () => {
    // Only `action` is patched — the value survives, and toBenefitItems() is
    // what drops it from the payload while it does not apply.
    expect(componentSrc).toMatch(
      /updateBenefitRow\(setDraft, categoryItems, idx, \{\s*action: e\.target\.value as ProductBenefitAction,\s*\}\)/,
    );
  });

  it('shows the configured treatment in the read-only half too', () => {
    // #916 put the read-only cells behind the shared column declaration, so the
    // treatment is rendered by the `action` column instead of its own inline
    // `<td>`. The rule is unchanged: still `benefitTreatmentLabel`, still shown
    // only where the caller named a context.
    expect(componentSrc).toContain("case 'action':");
    expect(componentSrc).toContain(
      'benefitContext ? benefitTreatmentLabel(t, benefitContext, row) : null',
    );
    expect(componentSrc).toContain('showAction: benefitContext != null');
  });
});

describe('who names a context', () => {
  it('Promotions do, for both halves of every section', () => {
    expect(promotionsSrc.match(/benefitContext="promotion"/g) ?? []).toHaveLength(2);
    // …and render through the shared component rather than a second copy of it.
    expect(promotionsSrc).toContain("from '@/components/ProductBenefits'");
    expect(promotionsSrc).not.toContain('function addBenefitRow');
    expect(promotionsSrc).not.toContain('function updateBenefitRow');
  });

  it('Membership Plans do, for both halves of every section', () => {
    expect(plansSrc.match(/benefitContext="plan"/g) ?? []).toHaveLength(2);
  });

  it('the Assigned Plan snapshot editor does not', () => {
    // Its `PUT` takes quantity alone (#635 stage 6), so a dropdown there would
    // be a control that silently changes nothing.
    const editor = (assignedPlanSrc.match(/<ProductBenefitEditor[\s\S]*?\/>/) ?? [''])[0];
    expect(editor, 'the Assigned Plan editor offers an action dropdown').not.toContain('benefitContext');
  });

  it("the Assigned Plan's read-only sections do, to *show* what was agreed (#924)", () => {
    // The other half of the same rule: the pair is frozen on the line (#896
    // stage 2), so the card has a real treatment to report — as a column of the
    // shared grid, in the Plan's own option set, which is where the line came
    // from. Reading it is not configuring it.
    const view = (assignedPlanSrc.match(/<ProductBenefitView[\s\S]*?\/>/) ?? [''])[0];
    expect(view).toContain('benefitContext="plan"');
  });

  it('both pages refuse a Save that the API would 400 (§6)', () => {
    expect(plansSrc).toContain('invalidBenefitValueRow(benefitDraft)');
    expect(promotionsSrc).toContain('invalidBenefitValueRow(draft)');
    expect(plansSrc).toContain("t('plans.benefit_value_required', { item: incomplete.product_name })");
    expect(promotionsSrc).toContain("t('benefit_value_required', { item: incomplete.product_name })");
  });
});

describe('locale keys', () => {
  const PROMOTION_KEYS = [
    'col_item_action', 'benefit_value_required',
    ...PROMOTION_ITEM_ACTIONS.map((a) => `item_action_${a}`),
    ...PROMOTION_ITEM_ACTIONS.filter(benefitActionRequiresValue).map((a) => `item_action_value_${a}`),
  ];
  const PLAN_KEYS = [
    'col_item_action', 'benefit_value_required',
    ...PLAN_BENEFIT_ACTIONS.map((a) => `item_action_${a}`),
    ...PLAN_BENEFIT_ACTIONS.filter(benefitActionRequiresValue).map((a) => `item_action_value_${a}`),
  ];

  for (const code of LOCALE_CODES) {
    const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));

    // next-intl has no locale fallback and prints a missing key verbatim, so a
    // key present only in en.json renders as `promotions.item_action_waive`.
    it(`${code}.json defines every key the Promotions sections interpolate`, () => {
      for (const key of PROMOTION_KEYS) {
        expect(typeof messages.promotions?.[key], `${code}.promotions.${key}`).toBe('string');
      }
    });

    it(`${code}.json defines every key the Membership Plan sections interpolate`, () => {
      for (const key of PLAN_KEYS) {
        expect(typeof messages.plans?.[key], `${code}.plans.${key}`).toBe('string');
      }
    });

    it(`${code}.json never says "Benefit" anywhere in the Promotions UI (§3)`, () => {
      const ns = messages.promotions as Record<string, unknown>;
      for (const [key, value] of Object.entries(ns)) {
        if (typeof value !== 'string') continue;
        expect(value.toLowerCase(), `${code}.promotions.${key}`).not.toMatch(/benefi/);
      }
    });
  }

  it('says "No promotion" and "No benefit" for the same stored action (§3/§4)', () => {
    const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf-8'));
    expect(en.promotions.item_action_no_benefit).toBe('No promotion');
    expect(en.plans.item_action_no_benefit).toBe('No benefit');
    expect(en.promotions.col_item_action).toBe('Promotion');
    expect(en.plans.col_item_action).toBe('Benefit');
  });
});
