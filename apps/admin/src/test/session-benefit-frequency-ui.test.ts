import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  SESSION_BENEFIT_FREQUENCIES,
  sessionFrequencyLabelKey,
  toSessionBenefitFrequency,
} from '@/lib/sessionBenefitFrequency';
import {
  SELLABLE_ITEM_BENEFIT_COLUMNS,
  SellableItemBenefitRow,
  toBenefitItems,
} from '@/components/SellableItemBenefits';

// #918 — a Session Benefit carries a renewal **Frequency** ("2 Personal
// Training Classes per week"), configured in the Membership Plan's Session
// Benefits section.
//
// The rule itself is the API's: `domain/sessionBenefitFrequency.ts` declares the
// option set, the section `PUT` is the 400 and `chk_<table>_frequency`
// (migration 205) is the backstop, each with its own test. Nothing here is
// enforcement. What is pinned is the part only the UI can get wrong:
//
//   * the list this app renders still agrees with the API's (the third place of
//     the "two places" rule the API module's header states);
//   * the Frequency stays **one** column — the ticket's "must align with the
//     Frequency column used by the other Sellable Item sections" — so it is the
//     same `SELLABLE_ITEM_BENEFIT_COLUMNS` entry, switched by a prop, and the
//     Session section is the only caller that switches it;
//   * a section that does not configure it keeps submitting payloads without
//     the key, because the API reads "no frequency named" as *keep what is
//     stored* (#896's rule, which a replace-all `PUT` makes load-bearing);
//   * every option, `—` included, has a label in all three locales — next-intl
//     prints a missing key verbatim.
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so the
// structure is scanned from source the way sellable-item-benefit-actions-ui.test.ts
// does, while the shared module's pure parts are exercised directly.

const ROOT = join(__dirname, '..', '..', '..', '..');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const COMPONENT = join(__dirname, '..', 'components', 'SellableItemBenefits.tsx');
const PLANS_PAGE = join(__dirname, '..', 'app', '[locale]', 'plans', 'page.tsx');
const PROMOTIONS_PAGE = join(__dirname, '..', 'app', '[locale]', 'promotions', 'page.tsx');
const API_DECLARATION = join(ROOT, 'api', 'src', 'domain', 'sessionBenefitFrequency.ts');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const componentSrc = stripComments(readFileSync(COMPONENT, 'utf-8'));
const plansSrc = stripComments(readFileSync(PLANS_PAGE, 'utf-8'));
const promotionsSrc = stripComments(readFileSync(PROMOTIONS_PAGE, 'utf-8'));

function row(over: Partial<SellableItemBenefitRow> = {}): SellableItemBenefitRow {
  return {
    gym_charge_id: 1, quantity: 2, gym_charge_name: 'Personal Training Class',
    gym_charge_type: 'sessions', gym_charge_billing_frequency: null,
    gym_charge_status: 'active', ...over,
  };
}

describe('the option set mirrors the API declaration', () => {
  it('offers the same five periods, in the same order', () => {
    const src = readFileSync(API_DECLARATION, 'utf-8');
    const block = /export const SESSION_BENEFIT_FREQUENCIES[^=]*=\s*\[([^\]]*)\]/.exec(src);
    expect(block, 'SESSION_BENEFIT_FREQUENCIES is gone from the API declaration').not.toBeNull();
    const apiList = [...(block as RegExpExecArray)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect([...SESSION_BENEFIT_FREQUENCIES]).toEqual(apiList);
  });

  it('offers Weekly, which the Sellable Item frequency dropdown does not (#821)', () => {
    expect(SESSION_BENEFIT_FREQUENCIES).toContain('week');
    expect(SESSION_BENEFIT_FREQUENCIES).not.toContain('per_session');
  });

  it('reads anything else back as `—` rather than guessing', () => {
    expect(toSessionBenefitFrequency('month')).toBe('month');
    expect(toSessionBenefitFrequency('')).toBeNull();
    expect(toSessionBenefitFrequency('weekly')).toBeNull();
  });
});

describe('the Frequency column stays one column', () => {
  it('is the same shared column declaration, between Quantity and Benefit', () => {
    expect(SELLABLE_ITEM_BENEFIT_COLUMNS.map((c) => c.key)).toEqual([
      // #959 appended Requirement after Benefit; Frequency's position is unmoved.
      'item', 'quantity', 'frequency', 'action', 'requirement',
      'original_price', 'final_price',
    ]);
  });

  it('switches what the column shows by prop, with `item` as the default', () => {
    expect(componentSrc).toMatch(/frequencyColumn = 'item'/);
    expect(componentSrc).toMatch(/frequencyColumn === 'benefit'/);
  });

  it('is the Session section alone that asks for the benefit\'s own Frequency', () => {
    const sessionSection = /\{ section: 'session',[^}]*\}/.exec(plansSrc);
    expect(sessionSection).not.toBeNull();
    expect((sessionSection as RegExpExecArray)[0]).toContain("frequencyColumn: 'benefit'");
    for (const other of ['oneoff', 'periodical']) {
      const line = new RegExp(`\\{ section: '${other}',[^}]*\\}`).exec(plansSrc);
      expect((line as RegExpExecArray)[0]).toContain("frequencyColumn: 'item'");
    }
  });

  it('leaves the Promotions page on the Sellable Item\'s own frequency', () => {
    // #918 is a Membership Plan field. A Promotion's session grant has no
    // renewal Frequency, so its sections must not render the selector.
    expect(promotionsSrc).not.toContain('frequencyColumn');
  });
});

describe('the payload keeps the API\'s replace-all rule', () => {
  it('submits the Frequency only when the draft row carries the key', () => {
    expect(toBenefitItems([row()])).toEqual([{ gym_charge_id: 1, quantity: 2 }]);
    expect(toBenefitItems([row({ frequency: 'week' })]))
      .toEqual([{ gym_charge_id: 1, quantity: 2, frequency: 'week' }]);
  });

  it('submits an explicit null for `—`, which is what clears a stored value', () => {
    expect(toBenefitItems([row({ frequency: null })]))
      .toEqual([{ gym_charge_id: 1, quantity: 2, frequency: null }]);
  });

  it('keeps carrying the treatment pair beside it (#896)', () => {
    expect(toBenefitItems([row({ frequency: 'month', action: 'percentage_discount', value: 50 })]))
      .toEqual([{
        gym_charge_id: 1, quantity: 2, frequency: 'month',
        action: 'percentage_discount', value: 50,
      }]);
  });
});

describe('every option has a label', () => {
  it('names `—` and each frequency with its own key', () => {
    expect(sessionFrequencyLabelKey(null)).toBe('session_frequency_none');
    expect(sessionFrequencyLabelKey('four_weeks')).toBe('session_frequency_four_weeks');
  });

  for (const code of LOCALE_CODES) {
    it(`has every key in ${code}`, () => {
      const plans = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8')).plans;
      for (const key of ['session_frequency_none', 'session_frequency_hint']) {
        expect(plans[key], `plans.${key} missing in ${code}`).toBeTruthy();
      }
      for (const frequency of SESSION_BENEFIT_FREQUENCIES) {
        const key = sessionFrequencyLabelKey(frequency);
        expect(plans[key], `plans.${key} missing in ${code}`).toBeTruthy();
      }
    });
  }
});
