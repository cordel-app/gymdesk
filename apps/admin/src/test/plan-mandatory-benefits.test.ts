import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  SellableItemBenefitRow,
  addBenefitRow,
  isMandatoryBenefitRow,
} from '@/components/SellableItemBenefits';

// #893 — a Mandatory Sellable Item is always part of a Membership Plan and the
// editor must not allow it to be removed.
//
// The rule itself is the API's (`api/src/domain/mandatoryPlanBenefits.ts`, with
// its own unit tests and the router's integration tests): §7 is explicit that
// the frontend must not be able to bypass it, so nothing here is enforcement.
// What is pinned here is the part only the UI can get wrong — that a mandatory
// row renders without a Remove control and without an item picker that could be
// used to swap the item away, that it says *why* (§3), and that Promotions are
// untouched (§9), which is what the explicit `enforceMandatory` opt-in buys.
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so the
// structure is scanned from the source the way plans-expanded-read-only.test.ts
// does, while the shared module's pure parts are exercised directly.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const COMPONENT = join(__dirname, '..', 'components', 'SellableItemBenefits.tsx');
const PLANS_PAGE = join(__dirname, '..', 'app', '[locale]', 'plans', 'page.tsx');
const PROMOTIONS_PAGE = join(__dirname, '..', 'app', '[locale]', 'promotions', 'page.tsx');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

const MANDATORY_KEYS = ['mandatory_item_tag', 'mandatory_benefit_hint'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const componentSrc = stripComments(readFileSync(COMPONENT, 'utf-8'));
const plansSrc = stripComments(readFileSync(PLANS_PAGE, 'utf-8'));
const promotionsSrc = stripComments(readFileSync(PROMOTIONS_PAGE, 'utf-8'));

function row(over: Partial<SellableItemBenefitRow> = {}): SellableItemBenefitRow {
  return {
    gym_charge_id: 1, quantity: 1, gym_charge_name: 'Insurance Fee', gym_charge_type: 'fee',
    gym_charge_billing_frequency: 'year', gym_charge_status: 'active', ...over,
  };
}

describe('isMandatoryBenefitRow', () => {
  it('reads a tinyint, a boolean, and an absent field', () => {
    expect(isMandatoryBenefitRow(row({ gym_charge_mandatory: 1 }))).toBe(true);
    expect(isMandatoryBenefitRow(row({ gym_charge_mandatory: true }))).toBe(true);
    expect(isMandatoryBenefitRow(row({ gym_charge_mandatory: 0 }))).toBe(false);
    expect(isMandatoryBenefitRow(row({ gym_charge_mandatory: false }))).toBe(false);
    // A Promotion's rows do not carry the field at all — never mandatory.
    expect(isMandatoryBenefitRow(row())).toBe(false);
  });
});

describe('addBenefitRow carries the mandatory flag', () => {
  it('seeds a hand-picked mandatory item as mandatory straight away', () => {
    let draft: SellableItemBenefitRow[] = [];
    const setDraft = (fn: (prev: SellableItemBenefitRow[]) => SellableItemBenefitRow[]) => {
      draft = fn(draft);
    };
    addBenefitRow(setDraft, [{
      id: 4, name: 'Insurance Fee', type: 'fee', billing_frequency: 'year',
      status: 'active', benefit_category: 'periodical', mandatory: 1,
    }], draft);
    expect(draft).toHaveLength(1);
    expect(isMandatoryBenefitRow(draft[0])).toBe(true);
  });

  it('defaults to non-mandatory for an item the catalogue does not flag', () => {
    let draft: SellableItemBenefitRow[] = [];
    const setDraft = (fn: (prev: SellableItemBenefitRow[]) => SellableItemBenefitRow[]) => {
      draft = fn(draft);
    };
    addBenefitRow(setDraft, [{
      id: 5, name: 'Locker Rental', type: 'fee', billing_frequency: 'month',
      status: 'active', benefit_category: 'periodical',
    }], draft);
    expect(isMandatoryBenefitRow(draft[0])).toBe(false);
  });
});

describe('the shared benefit editor', () => {
  it('gates the whole behaviour on an explicit opt-in', () => {
    expect(componentSrc).toContain('enforceMandatory = false');
    // One derived flag per row, from the row's own joined column.
    expect(componentSrc).toContain('const mandatory = enforceMandatory && isMandatoryBenefitRow(row);');
  });

  it('renders neither a Remove control nor an item picker for a mandatory row', () => {
    // The Remove button and the <select> are both behind the same ternary, so a
    // mandatory item can be neither dropped nor swapped for another one.
    expect(componentSrc).toMatch(/\{mandatory \? <span \/> : \(\s*<button/);
    expect(componentSrc).toMatch(/\{mandatory \? \(\s*<span style=\{\{ fontSize: 13 \}\}>/);
    // The picker is the other half of that ternary, so there is exactly one of
    // it. #896 stage 4 added a second <select> to the grid — the line's pricing
    // treatment — which a mandatory row *does* get: Mandatory says the item must
    // exist, never what it costs.
    expect(componentSrc.match(/<select/g) ?? []).toHaveLength(2);
    expect(componentSrc).toContain('{benefitActionsFor(benefitContext).map((a) => (');
  });

  it('keeps the quantity editable (§4)', () => {
    // The quantity input sits outside the mandatory ternary: Mandatory says the
    // item must exist, never what its quantity is.
    const input = componentSrc.slice(componentSrc.indexOf('<input'));
    expect(input).toContain('quantity: parseInt(e.target.value, 10) || 1');
    expect(input.slice(0, input.indexOf('/>'))).not.toContain('mandatory');
  });

  it('says why the row cannot be removed, in the form only (§3)', () => {
    expect(componentSrc).toContain("t('mandatory_item_tag')");
    expect(componentSrc).toContain('const hasMandatory = enforceMandatory && draft.some(isMandatoryBenefitRow);');
    expect(componentSrc).toContain("{hasMandatory && <p style={{ ...hintSt, marginBottom: 8 }}>{t('mandatory_benefit_hint')}</p>}");
  });
});

describe('who opts in', () => {
  it('the Membership Plans page does, for both halves of the section', () => {
    expect(plansSrc.match(/enforceMandatory/g) ?? []).toHaveLength(2);
  });

  it('Promotions do not (§9)', () => {
    expect(promotionsSrc).not.toContain('enforceMandatory');
  });
});

describe('locale keys', () => {
  // next-intl has no locale fallback and prints a missing key verbatim, so a key
  // present only in en.json would render as `plans.mandatory_item_tag` on screen.
  for (const code of LOCALE_CODES) {
    it(`${code}.json defines every key under "plans"`, () => {
      const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
      const ns = messages['plans'];
      expect(ns).toBeTypeOf('object');
      for (const key of MANDATORY_KEYS) {
        expect(typeof ns[key], `${code}.plans.${key}`).toBe('string');
        expect((ns[key] as string).length).toBeGreaterThan(0);
      }
    });
  }
});
