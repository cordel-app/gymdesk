import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #815 — the Promotion sections are named after the Promotion, not after
// "Benefits".
//
// This is a label-only rename: the translation keys, the API endpoint slugs
// (`session-benefits`, …), the `action` enum values and every promotion rule
// stay exactly as they were, so the test pins the *values* rather than the keys.
//
// The scope is the Promotion UI. A Membership Plan's own benefit sections keep
// the Plan's terminology — #816 says so in as many words ("Keep the existing
// section name exactly as: ONE-OFF BENEFITS") — and so do the Assigned Plan's
// own benefit sections, which render the assignment's snapshot of the Plan.
// That is why the Assigned Plan card's *applied Promotion* sections got their
// own promotion-scoped keys instead of sharing the configuration section's.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const ASSIGNED_PLANS_DIR = join(__dirname, '..', 'components', 'assignedPlan');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

type Messages = Record<string, unknown>;

const locales = Object.fromEntries(
  LOCALE_CODES.map((c) => [c, JSON.parse(readFileSync(join(LOCALES_DIR, `${c}.json`), 'utf-8'))]),
) as Record<(typeof LOCALE_CODES)[number], Messages>;

function ns(messages: Messages, namespace: string): Record<string, string> {
  const section = messages[namespace];
  expect(section, `namespace "${namespace}" is missing`).toBeTruthy();
  return section as Record<string, string>;
}

/** "Benefit"/"Beneficio"/"Benefici" in any of the three locales, any case. */
const BENEFIT_WORD = /benefi(t|ci)/i;
// English "promotion", Spanish "promoción"/"promociones" (the plural drops the
// accent) and Catalan "promoció"/"promocions".
const PROMOTION_WORD = /promotion|promoci/i;

// The four section headers the ticket renames, with the English label it asks for.
const PROMOTION_SECTIONS: [key: string, english: string][] = [
  ['section_session_benefits', 'Session Promotion'],
  ['section_oneoff_benefits', 'One-off Promotion'],
  ['section_period_benefits', 'Periodical Promotion'],
  ['section_membership_fee_benefits', 'Membership Fee Promotion'],
];

// The empty states and add buttons that spell the section name out.
const PROMOTION_SECTION_COPY = [
  'no_session_benefits',
  'add_session_benefit',
  'no_oneoff_benefits',
  'add_oneoff_benefit',
  'no_period_benefits',
  'add_period_benefit',
  'no_membership_fee_benefit',
];

describe('#815 Promotion editor section labels', () => {
  it('names the four sections after the Promotion in English', () => {
    const promotions = ns(locales.en, 'promotions');
    for (const [key, english] of PROMOTION_SECTIONS) {
      expect(promotions[key], `promotions.${key}`).toBe(english);
    }
  });

  it('leaves no "Benefit" wording in the sections or their copy, in any locale', () => {
    for (const code of LOCALE_CODES) {
      const promotions = ns(locales[code], 'promotions');
      for (const key of [...PROMOTION_SECTIONS.map(([k]) => k), ...PROMOTION_SECTION_COPY]) {
        const value = promotions[key];
        expect(value, `${code}.json is missing promotions.${key}`).toBeTruthy();
        expect(BENEFIT_WORD.test(value), `${code}.json promotions.${key} = "${value}"`).toBe(false);
        expect(PROMOTION_WORD.test(value), `${code}.json promotions.${key} = "${value}"`).toBe(true);
      }
    }
  });

  it('keeps the keys and the endpoint slugs, so nothing but the label moved', () => {
    const page = readFileSync(
      join(__dirname, '..', 'app', '[locale]', 'promotions', 'page.tsx'),
      'utf-8',
    );
    for (const [key] of PROMOTION_SECTIONS) expect(page).toContain(key);
    for (const slug of ['session-benefits', 'oneoff-benefits', 'periodical-benefits']) {
      expect(page).toContain(slug);
    }
  });
});

describe('#815 the Assigned Plan card', () => {
  const promotionsCard = readFileSync(join(ASSIGNED_PLANS_DIR, 'AssignedPlanPromotions.tsx'), 'utf-8');
  const configurationCard = readFileSync(
    join(ASSIGNED_PLANS_DIR, 'AssignedPlanConfiguration.tsx'),
    'utf-8',
  );

  const PROMO_KEYS = [
    'promo_benefits_oneoff',
    'promo_benefits_session',
    'promo_benefits_period',
    'promo_no_oneoff_benefits',
    'promo_no_session_benefits',
    'promo_no_period_benefits',
    'promo_membership_fee_benefit',
    'promo_no_membership_fee_benefit',
  ];

  it('titles an applied Promotion’s grant sections with promotion-scoped keys', () => {
    for (const key of ['promo_benefits_oneoff', 'promo_benefits_session', 'promo_benefits_period']) {
      expect(promotionsCard).toContain(key);
    }
    // It must not borrow the configuration section's Plan-worded keys.
    for (const shared of ["'benefits_oneoff'", "'benefits_session'", "'benefits_period'"]) {
      expect(promotionsCard).not.toContain(shared);
    }
  });

  it('has every promotion-scoped key in every locale (next-intl has no fallback)', () => {
    for (const code of LOCALE_CODES) {
      const page = ns(locales[code], 'assigned_plans_page');
      const missing = PROMO_KEYS.filter((k) => !page[k]);
      expect(missing, `${code}.json is missing assigned_plans_page keys`).toEqual([]);
      for (const key of PROMO_KEYS) {
        expect(BENEFIT_WORD.test(page[key]), `${code}.json ${key} = "${page[key]}"`).toBe(false);
      }
    }
  });

  it('leaves the assignment’s own benefit sections on the Plan’s terminology', () => {
    for (const key of ['benefits_oneoff', 'benefits_session', 'benefits_period']) {
      expect(configurationCard).toContain(key);
      for (const code of LOCALE_CODES) {
        expect(BENEFIT_WORD.test(ns(locales[code], 'assigned_plans_page')[key])).toBe(true);
      }
    }
    // The Personal Membership Fee Benefit is not a Promotion (#772) and keeps
    // its name, including the hint that says exactly that.
    const page = ns(locales.en, 'assigned_plans_page');
    expect(page.label_personal_fee_benefit).toBe('Personal Membership Fee Benefit');
    expect(page.section_membership_fee_benefit).toBe('Membership Fee Benefit');
  });
});

describe('#815 does not reach the Membership Plan editor', () => {
  it('keeps the Plan’s own benefit sections named after Benefits (#816)', () => {
    const plans = ns(locales.en, 'plans');
    expect(plans.section_oneoff_benefits).toBe('One-off Benefits');
    expect(plans.section_session_benefits).toBe('Session Benefits');
    expect(plans.section_plan_period_benefits).toBe('Period Benefits');
  });
});
