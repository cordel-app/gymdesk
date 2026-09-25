import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #635 stage 1 — Membership Plans aligned with the Promotion benefit structure.
//
// The Plans card must gain a Billing & Duration section (Free Period / Paid
// Duration / Bonus Duration) and the three Sellable-Item-keyed Benefit sections
// (One-off / Session / Period), each independently editable (§10) and with no
// modal (§15). Membership Fee Benefits must NOT appear (§6), and the legacy
// Included Services / Charge Benefits sections must survive stage 1 untouched —
// retiring them is stage 4, and doing it early would break package credits and
// the Billing Forecast.
//
// This repo has no component-test infra for apps/admin (see docs/architecture.md's
// TL;DR), so — like promotions-section-editing.test.ts (#627) — this pins the
// structure down by scanning the page source and the locale files.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const PLANS_PAGE = join(__dirname, '..', 'app', '[locale]', 'plans', 'page.tsx');
const SHARED_COMPONENT = join(__dirname, '..', 'components', 'SellableItemBenefits.tsx');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

type Messages = Record<string, unknown>;

function loadLocale(code: string): Messages {
  return JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
}

function planKeys(messages: Messages): Set<string> {
  const ns = messages.plans;
  if (ns == null || typeof ns !== 'object') return new Set();
  return new Set(Object.keys(ns as Record<string, unknown>));
}

// Comments deliberately name the sections and the stages, so every scan below
// runs on comment-free code.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const pageSrc = stripComments(readFileSync(PLANS_PAGE, 'utf-8'));
const componentSrc = stripComments(readFileSync(SHARED_COMPONENT, 'utf-8'));
const locales = Object.fromEntries(LOCALE_CODES.map((c) => [c, loadLocale(c)])) as Record<
  (typeof LOCALE_CODES)[number],
  Messages
>;

// #635 stage 13 added the fourth field, Pre-paid Duration.
const DURATION_FIELDS = ['free_months', 'paid_months', 'pay_beforehand_months', 'bonus_months'] as const;
const BENEFIT_SECTIONS = ['oneoff', 'session', 'periodical'] as const;

describe('Plans: Billing & Duration (#635 §7)', () => {
  it('renders its own section with Free Period, Paid, Pre-paid and Bonus Duration', () => {
    expect(pageSrc).toContain('plans.section_billing_duration');
    for (const field of DURATION_FIELDS) {
      expect(pageSrc, `${field} missing from DURATION_FIELDS`).toMatch(
        new RegExp(`DURATION_FIELDS[\\s\\S]{0,120}'${field}'`),
      );
    }
  });

  it('is edited independently of every other section', () => {
    expect(pageSrc).toContain('durationEditForPlanId');
    expect(pageSrc).toContain('openDurationEdit');
    expect(pageSrc).toContain('cancelDurationEdit');
    expect(pageSrc).toContain('saveDurationEdit');
  });

  it('sends an emptied field as null, so it reads as "not configured" rather than 0', () => {
    expect(pageSrc).toMatch(/raw === ''\s*\?\s*null/);
  });

  // Stage 1 kept Pay Beforehand out of a Plan because §7 listed three fields.
  // The thread's stage 13 answer asks for it ("I'd also like to include the
  // pre-paid duration which will flag in the simulation as pre-paid - no
  // charge"), so the Plan now carries it — the Membership Fee Benefit is what
  // stays Promotion-only (§6).
  it('carries Pre-paid Duration, and still no Membership Fee Benefit (§6)', () => {
    expect(pageSrc).toContain('pay_beforehand_months');
    expect(pageSrc).not.toContain('membership_fee_benefit');
  });

  // Stage 13: Initial Billing / Initial Service / Recurring Service are gone
  // (migration 189) and the surviving cadence is presented inside this section.
  it('is the only billing section, carrying the Billing frequency and Auto-renew', () => {
    expect(pageSrc).not.toContain('initial_billing');
    expect(pageSrc).not.toContain('initial_service');
    expect(pageSrc).not.toContain('recurring_service');
    expect(pageSrc).not.toContain('plans.section_billing\'');
    expect(pageSrc).toContain('plans.label_billing_frequency');
    expect(pageSrc).toContain('recurring_billing_unit');
    expect(pageSrc).toContain('plans.label_auto_renew');
  });
});

describe('Plans: One-off / Session / Period Benefits (#635 §3–§5)', () => {
  it('declares all three sections with their own endpoints', () => {
    for (const section of BENEFIT_SECTIONS) {
      expect(pageSrc, `no '${section}' entry in BENEFIT_SECTIONS`).toMatch(
        new RegExp(`section: '${section}'`),
      );
    }
    expect(pageSrc).toContain("endpoint: 'oneoff-benefits'");
    expect(pageSrc).toContain("endpoint: 'session-benefits'");
    expect(pageSrc).toContain("endpoint: 'periodical-benefits'");
  });

  it('edits exactly one section of one plan at a time (§10)', () => {
    expect(pageSrc).toContain('benefitEditFor');
    expect(pageSrc).toMatch(/planId: number; section: BenefitSection/);
    expect(pageSrc).toContain('isEditingBenefit');
  });

  it('reuses the shared editor rather than a second copy of the markup', () => {
    expect(pageSrc).toContain('SellableItemBenefitEditor');
    expect(pageSrc).toContain('SellableItemBenefitView');
    expect(componentSrc).toContain('export function SellableItemBenefitEditor');
    expect(componentSrc).toContain('export function SellableItemBenefitView');
  });

  it('classifies items only by the server-computed benefit_category (#550)', () => {
    expect(pageSrc).toContain('benefit_category === section');
    // The classification rules themselves must not be re-derived client-side.
    expect(pageSrc).not.toMatch(/type === 'sessions'/);
  });

  it('offers only active items as new selections', () => {
    expect(pageSrc).toMatch(/benefit_category === section && gc\.status === 'active'/);
  });

  it('keeps an already-selected item visible after it goes inactive (#550)', () => {
    expect(componentSrc).toContain('inactive: true');
  });

  it('introduces no modal (§15)', () => {
    expect(pageSrc).not.toContain('CrudModal');
    expect(componentSrc).not.toContain('CrudModal');
  });

  it('does not add Membership Fee Benefits, which stay Promotion-only (§6)', () => {
    expect(pageSrc).not.toContain('membership_fee');
  });
});

// Stage 4 retired both legacy sections: Charge Benefits in part 1 (see
// plans-charge-benefits-removed.test.ts) and Included Services in part 2 —
// which activities a plan may book is the Activity Type's own eligible-plan
// list now, edited from the Activity Types page.
describe('Plans: Included Services retired in stage 4', () => {
  it('no longer renders Included Services', () => {
    expect(pageSrc).not.toContain('plans.section_allowances');
    expect(pageSrc).not.toContain('allowance');
  });
});

describe('Plans: locale coverage', () => {
  const REQUIRED_KEYS = [
    'section_billing_duration',
    'label_free_months',
    'label_paid_months',
    'label_bonus_months',
    'label_pay_beforehand_months',
    'label_billing_frequency',
    'desc_billing_duration',
    'months_value',
    'not_configured',
    'section_oneoff_benefits',
    'no_oneoff_benefits',
    'add_oneoff_benefit',
    'section_session_benefits',
    'no_session_benefits',
    'add_session_benefit',
    'section_plan_period_benefits',
    'no_plan_period_benefits',
    'add_period_benefit',
    'col_sellable_item',
    'col_quantity',
    'col_frequency',
    'inactive_item_tag',
    'frequency_week',
    'frequency_month',
    'frequency_four_weeks',
    'frequency_year',
  ];

  for (const code of LOCALE_CODES) {
    it(`${code}.json defines every new plans.* key`, () => {
      const keys = planKeys(locales[code]);
      for (const key of REQUIRED_KEYS) {
        expect(keys.has(key), `plans.${key} missing from ${code}.json`).toBe(true);
      }
    });
  }

  it('translates the new keys rather than copying English into es/ca', () => {
    const en = locales.en.plans as Record<string, string>;
    for (const code of ['es', 'ca'] as const) {
      const ns = locales[code].plans as Record<string, string>;
      expect(ns.section_billing_duration).not.toBe(en.section_billing_duration);
      expect(ns.no_session_benefits).not.toBe(en.no_session_benefits);
    }
  });
});
