import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  BillingDurationItem,
  billingDurationItems,
  billingDurationSummaryStyle,
} from '@/components/BillingDurationSummary';

// #879 — Membership Plans → Billing & Duration adopts the Promotions look.
//
// The ticket is strictly a presentation change: the same six values, in the
// compact `Label: Value` form Promotions has shown since #550, wrapping
// responsively, with the two long explanatory sentences dropped from the
// summary (§5/§6) and every field, label key, editor and billing behaviour left
// exactly as it was (§2/§7/§10).
//
// Its load-bearing requirement is *reuse*: both cards must render one
// component, so the next change to that look cannot touch one screen and miss
// the other. apps/admin has no component-test infra (docs/architecture.md's
// TL;DR), so the wiring is pinned by scanning the two page sources — the way
// plans-expanded-read-only.test.ts does — while the shared module's pure parts
// are exercised directly.

const SRC = join(__dirname, '..');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const plansSrc = stripComments(readFileSync(join(SRC, 'app', '[locale]', 'plans', 'page.tsx'), 'utf-8'));
const promotionsSrc = stripComments(readFileSync(join(SRC, 'app', '[locale]', 'promotions', 'page.tsx'), 'utf-8'));
const componentSrc = stripComments(readFileSync(join(SRC, 'components', 'BillingDurationSummary.tsx'), 'utf-8'));

/** The Plans card's read-only Billing & Duration branch. */
function plansSummarySlice(): string {
  const start = plansSrc.indexOf('<BillingDurationSummary');
  expect(start, 'the Plans card does not render BillingDurationSummary').toBeGreaterThan(-1);
  const end = plansSrc.indexOf('BENEFIT_SECTIONS.map(', start);
  expect(end).toBeGreaterThan(start);
  return plansSrc.slice(start, end);
}

describe('#879: one component for both cards', () => {
  it('is rendered by the Plans card and by the Promotions card', () => {
    for (const [name, src] of [['plans', plansSrc], ['promotions', promotionsSrc]] as const) {
      expect(src, `${name} does not import the shared summary`).toContain(
        "from '@/components/BillingDurationSummary'",
      );
      expect(src, `${name} does not render the shared summary`).toContain('<BillingDurationSummary');
    }
  });

  it('keeps the look in the shared module, not in either page', () => {
    // The literal the Promotion card used to carry inline. Restating it in a
    // page is what let the two screens drift apart in the first place.
    const inlineLook = /display: 'flex', gap: 24, fontSize: 13, flexWrap: 'wrap'/;
    expect(componentSrc).toMatch(inlineLook);
    expect(plansSummarySlice()).not.toMatch(inlineLook);
    expect(promotionsSrc).not.toMatch(inlineLook);
  });

  it('wraps responsively rather than falling back to the old two-column rows (§8)', () => {
    expect(billingDurationSummaryStyle.display).toBe('flex');
    expect(billingDurationSummaryStyle.flexWrap).toBe('wrap');
  });
});

describe('#879: the Plan summary', () => {
  const slice = plansSummarySlice();

  it('shows all six values, durations first (§2)', () => {
    // The four durations still come from the one DURATION_FIELDS list.
    expect(slice).toContain('DURATION_FIELDS.map((field) => ({');
    expect(slice).toContain("label: t(`plans.label_${field}`)");
    const frequency = slice.indexOf("t('plans.label_billing_frequency')");
    const autoRenew = slice.indexOf("t('plans.auto_renew')");
    const durations = slice.indexOf('DURATION_FIELDS.map(');
    expect(frequency).toBeGreaterThan(durations);
    expect(autoRenew).toBeGreaterThan(frequency);
  });

  // #892: the value carries the unit its number is counted in, so the summary
  // renders through the shared `formatPlanDurationPeriods()` — which is also
  // what keeps "Not configured" (§4) and the Details modal in step with it.
  it('keeps "Not configured" for an unset duration (§4), through the shared formatter', () => {
    expect(slice).toContain('formatPlanDurationPeriods(plan[field], plan.billing_policy, planT)');
    const profileSrc = readFileSync(
      join(__dirname, '..', 'app', '[locale]', 'plans', 'planProfile.ts'), 'utf-8',
    );
    expect(profileSrc).toContain("t('not_configured')");
    expect(profileSrc).toContain("t('periods_value', { n: value, frequency: unit })");
  });

  it('drops the two long descriptions from the summary (§5/§6)', () => {
    expect(slice).not.toContain('desc_recurring_billing');
    expect(slice).not.toContain('desc_auto_renew');
    // They are the editor's, and the editor is untouched (§7).
    expect(plansSrc).toContain("t('plans.desc_recurring_billing')");
    expect(plansSrc).toContain("t('plans.desc_auto_renew')");
  });

  it('still says so when the Plan has no billing policy', () => {
    expect(slice).toContain("t('plans.no_billing')");
  });

  it('holds no control — reading stays read-only (#797)', () => {
    for (const control of ['<input', '<select', '<textarea', '<button', 'onChange']) {
      expect(slice, `${control} in the read-only summary`).not.toContain(control);
    }
  });

  it('leaves the section header and its Edit action alone (§7)', () => {
    expect(plansSrc).toContain("title={t('plans.section_billing_duration')}");
    expect(plansSrc).toContain('openDurationEdit(plan)');
  });
});

describe('#879: the Promotion summary is unchanged in behaviour', () => {
  it('still omits a month count of zero rather than spelling it out', () => {
    for (const field of ['free', 'paid', 'payBeforehand', 'bonus']) {
      expect(promotionsSrc).toMatch(new RegExp(`${field} > 0 && \\{ key:`));
    }
  });
});

describe('billingDurationItems()', () => {
  const item: BillingDurationItem = { key: 'free_periods', label: 'Free Period', value: 1 };

  it('keeps the items a page decided to show, in order', () => {
    const second: BillingDurationItem = { key: 'paid_periods', label: 'Paid Duration', value: 2 };
    expect(billingDurationItems([item, second])).toEqual([item, second]);
  });

  it('drops the conditions that did not hold', () => {
    expect(billingDurationItems([false, item, null, undefined])).toEqual([item]);
    expect(billingDurationItems([])).toEqual([]);
  });

  it('keeps an item whose value is itself falsy', () => {
    // "Auto-renew: No" and a zero month count are values, not absent items —
    // only the page's own condition decides whether an item exists.
    const zero: BillingDurationItem = { key: 'bonus_periods', label: 'Bonus Duration', value: 0 };
    expect(billingDurationItems([zero])).toEqual([zero]);
  });
});

describe('#879: no new locale keys were needed', () => {
  // The summary reuses the keys the DetailRow list already used, so a locale
  // that was complete before this ticket stays complete.
  const REQUIRED = [
    'label_free_periods', 'label_paid_periods', 'label_pay_beforehand_periods',
    'label_bonus_periods', 'label_billing_frequency', 'auto_renew',
    'not_configured', 'months_value', 'periods_value', 'periods_value_plain',
    'no_billing', 'yes', 'no',
  ];

  for (const code of LOCALE_CODES) {
    it(`${code}.json still defines every key the summary renders`, () => {
      const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
      const keys = new Set(Object.keys((messages.plans ?? {}) as Record<string, unknown>));
      for (const key of REQUIRED) {
        expect(keys.has(key), `plans.${key} missing from ${code}.json`).toBe(true);
      }
    });
  }
});
