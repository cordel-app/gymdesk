import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  EMPTY_VALUE,
  PLAN_SECTION_ORDER,
  PLAN_TIMELINE_STATUSES,
  PLAN_TIMELINE_STATUS_LABEL_KEYS,
  PlanTimelineStatus,
  formatPlanTimelineBilling,
  planTimelineRowTone,
} from '@/app/[locale]/plans/planProfile';

// #818 — the Membership Plan card's simulation becomes the Promotion card's.
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so the
// rendering is pinned by scanning the page sources the way
// plans-expanded-read-only.test.ts does, while the declaration's pure parts (the
// status labels, the Billing cell, the row tone) are exercised directly.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const PLANS_PAGE = join(__dirname, '..', 'app', '[locale]', 'plans', 'page.tsx');
const PROMOTIONS_PAGE = join(__dirname, '..', 'app', '[locale]', 'promotions', 'page.tsx');
const SHARED_TABLE = join(__dirname, '..', 'components', 'ExampleTimeline.tsx');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const plansSrc = stripComments(readFileSync(PLANS_PAGE, 'utf-8'));
const promotionsSrc = stripComments(readFileSync(PROMOTIONS_PAGE, 'utf-8'));
const sharedSrc = stripComments(readFileSync(SHARED_TABLE, 'utf-8'));

function namespace(code: string, name: 'plans' | 'promotions'): Record<string, string> {
  const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
  return (messages[name] ?? {}) as Record<string, string>;
}

const plansLocales = Object.fromEntries(
  LOCALE_CODES.map((c) => [c, namespace(c, 'plans')]),
) as Record<(typeof LOCALE_CODES)[number], Record<string, string>>;

describe('Plans: the Example timeline replaces the Billing Events Forecast', () => {
  it('takes the retired section’s place in the declared order', () => {
    expect([...PLAN_SECTION_ORDER]).toContain('section_fee_simulation');
    expect([...PLAN_SECTION_ORDER]).not.toContain('section_billing_forecast');
    // Still in the forecast's slot — the last of the Plan's own configuration
    // sections, since #881 moved Price History into PRICING and the timeline
    // inherited the end of the card. #915 appended the Billing Event Simulation
    // after it: a second read-only projection, not a replacement.
    expect(PLAN_SECTION_ORDER.indexOf('section_fee_simulation')).toBe(
      PLAN_SECTION_ORDER.indexOf('section_billing_event_simulation') - 1,
    );
    expect(PLAN_SECTION_ORDER.indexOf('section_billing_event_simulation')).toBe(
      PLAN_SECTION_ORDER.length - 1,
    );
  });

  it('renders the periods the server projects, and no forecast events', () => {
    expect(plansSrc).toContain('plans.section_fee_simulation');
    expect(plansSrc).toContain('plan.example_timeline.periods.map(');
    for (const gone of ['billing_forecast', 'forecast_total', 'BillingForecast', 'ForecastEvent']) {
      expect(plansSrc, `the retired forecast symbol "${gone}" is still referenced`).not.toContain(gone);
    }
  });

  it('classifies and prices nothing in the frontend', () => {
    // The Status comes from the server's own status key, and the Billing cell
    // from the shared formatter — never from the durations or a tax computation
    // re-done here (#817, and CLAUDE.md's "do not duplicate business logic").
    expect(plansSrc).toContain('PLAN_TIMELINE_STATUS_LABEL_KEYS[row.status]');
    expect(plansSrc).toContain('formatPlanTimelineBilling(');
    expect(plansSrc).not.toContain('classifyPlanDurationPeriod');
    expect(plansSrc).not.toContain('advanceBillingDate');
  });

  it('shows the hypothetical enrollment date the projection was anchored on', () => {
    expect(plansSrc).toContain('plans.timeline_example_note');
    expect(plansSrc).toContain('plan.example_timeline.anchorDate');
  });
});

describe('Example timeline: one table design for both cards (#818)', () => {
  it('is the shared component, rendered by the Plan card and the Promotion card', () => {
    expect(plansSrc).toContain("import { ExampleTimeline } from '@/components/ExampleTimeline'");
    expect(promotionsSrc).toContain("from '@/components/ExampleTimeline'");
    expect(plansSrc).toContain('<ExampleTimeline');
    expect(promotionsSrc).toContain('<ExampleTimeline');
  });

  // #1130 stage 2 adds the Cycle column "to the left of the existing Period
  // column", and nothing else about the four moved.
  it('renders the ticket’s four columns, in the ticket’s order, behind the Cycle one', () => {
    const headers = [...sharedSrc.matchAll(/\{labels\.(\w+)\}/g)].map((m) => m[1]);
    expect(headers).toEqual(['cycle', 'period', 'dates', 'status', 'billing']);
  });

  it('keeps the table free of any entity knowledge', () => {
    for (const symbol of ['promotion', 'plan', 'apiFetch', 'useTranslations', 'amount']) {
      expect(sharedSrc, `the shared table must not know about "${symbol}"`).not.toContain(symbol);
    }
  });

  it('gives the Promotion card’s hardcoded Status header a translated key', () => {
    expect(promotionsSrc).toContain("status: t('col_status')");
    for (const code of LOCALE_CODES) {
      expect(namespace(code, 'promotions').col_status).toBeTruthy();
      expect(namespace(code, 'promotions').timeline_dates_from).toBeTruthy();
    }
  });
});

describe('Example timeline: how a Plan’s row reads', () => {
  it('labels every status, and says (benefit) rather than (promotion)', () => {
    for (const status of PLAN_TIMELINE_STATUSES) {
      const key = PLAN_TIMELINE_STATUS_LABEL_KEYS[status];
      for (const code of LOCALE_CODES) {
        const label = plansLocales[code][key];
        expect(label, `plans.${key} missing from ${code}.json`).toBeTruthy();
        expect(label.toLowerCase()).not.toContain('promo');
      }
    }
    expect(plansLocales.en[PLAN_TIMELINE_STATUS_LABEL_KEYS.free_plan]).toBe('Free (benefit)');
    expect(plansLocales.en[PLAN_TIMELINE_STATUS_LABEL_KEYS.pay_regular]).toBe('Pay (regular)');
  });

  it('translates every key the section renders', () => {
    const keys = [
      'section_fee_simulation', 'col_period', 'col_dates', 'col_status', 'col_billing',
      'timeline_example_note', 'timeline_dates_from', 'timeline_no_charge', 'timeline_disclaimer',
      'timeline_duration_disclaimer', 'timeline_promotions_disclaimer', 'timeline_unavailable',
      'tax_included_suffix',
    ];
    for (const code of LOCALE_CODES) {
      for (const key of keys) {
        expect(plansLocales[code][key], `plans.${key} missing from ${code}.json`).toBeTruthy();
      }
    }
  });

  it('reads a waived period as No charge and a charged one as the VAT-inclusive price', () => {
    expect(formatPlanTimelineBilling({ amount: null, waived: true }, 'No charge', 'VAT included')).toBe('No charge');
    expect(formatPlanTimelineBilling({ amount: 60, waived: false }, 'No charge', 'VAT included'))
      .toBe('€60.00 VAT included');
  });

  it('reads a Plan with no price as the empty value, never as €0.00', () => {
    expect(formatPlanTimelineBilling({ amount: null, waived: false }, 'No charge', 'VAT included'))
      .toBe(EMPTY_VALUE);
  });

  it('tints a period that charges nothing green, the regular ones grey', () => {
    const tones = Object.fromEntries(
      PLAN_TIMELINE_STATUSES.map((s: PlanTimelineStatus) => [
        s, planTimelineRowTone({ status: s, waived: s !== 'pay_plan' && s !== 'pay_regular' }),
      ]),
    );
    expect(tones).toEqual({
      free_plan: 'free',
      prepaid_plan: 'free',
      bonus_plan: 'free',
      pay_plan: 'benefit',
      pay_regular: 'regular',
    });
  });

  // #946 — the first Pre-paid period collects the whole Pre-paid Duration, so it
  // charges: green is this table's "no charge" tone and would read as a free
  // period beside an amount.
  it('tints a charged Pre-paid period amber, not green', () => {
    expect(planTimelineRowTone({ status: 'prepaid_plan', waived: false })).toBe('benefit');
    expect(planTimelineRowTone({ status: 'prepaid_plan', waived: true })).toBe('free');
  });
});
