import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #970 — "Training Plans" named two different things: the global, reusable
// definitions (Training Plan Templates) and the plans a member has actually
// been assigned. The second one reads **Assigned Training Plans** now, in the
// sidebar, on its own page and in the Member card's section, so the two concepts
// are told apart by their names rather than by where the user happens to be.
//
// A label rename and nothing else: the routes, the feature-flag keys, the
// locale keys themselves, the API and the behaviour are untouched — which the
// last two tests pin, because a rename that moved an identifier would be a
// different ticket.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const NAV_CONFIG = join(__dirname, '..', 'config', 'navigationGroups.ts');
const PLANS_PAGE = join(__dirname, '..', 'app', '[locale]', 'training-plans', 'page.tsx');
const MEMBER_ROW = join(__dirname, '..', 'app', '[locale]', 'members', 'MemberExpandedRow.tsx');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

type Locale = (typeof LOCALE_CODES)[number];

/** The word each locale uses for "assigned", lower-cased for comparison. */
const ASSIGNED_WORD: Record<Locale, string> = {
  en: 'assigned',
  es: 'asignad',
  ca: 'assignat',
};

/** The word each locale uses for "templates", lower-cased for comparison. */
const TEMPLATE_WORD: Record<Locale, string> = {
  en: 'template',
  es: 'plantill',
  ca: 'plantill',
};

/** Every label that names the member's assigned plans, section or page. */
const ASSIGNED_LABELS: readonly [string, string][] = [
  ['nav', 'training_plans'],
  ['members', 'training_plans'],
  ['members', 'section_training_plans'],
  ['members', 'no_training_plans'],
  ['training_plans', 'title'],
  ['training_plans', 'empty'],
  ['training_plans', 'editor_back'],
  ['member_training_plans', 'title'],
];

/** Every label that names the global template concept, which keeps its name. */
const TEMPLATE_LABELS: readonly [string, string][] = [
  ['nav', 'training_plan_templates'],
  ['nav', 'base_training_plan_templates'],
  ['training_plan_templates', 'title'],
  ['recycle_bin', 'entity_training_plan_template'],
];

function messages(code: Locale): Record<string, Record<string, string>> {
  return JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
}

const locales = Object.fromEntries(LOCALE_CODES.map((c) => [c, messages(c)])) as Record<
  Locale,
  Record<string, Record<string, string>>
>;

describe('#970: the member\'s plans read as Assigned Training Plans', () => {
  it('says "assigned" in every locale, for every label naming that section', () => {
    for (const code of LOCALE_CODES) {
      for (const [ns, key] of ASSIGNED_LABELS) {
        const value = locales[code][ns]?.[key];
        expect(value, `${ns}.${key} missing from ${code}.json`).toBeTruthy();
        expect(
          value.toLowerCase(),
          `${ns}.${key} in ${code}.json should name the assigned plans`,
        ).toContain(ASSIGNED_WORD[code]);
      }
    }
  });

  it('leaves the global Training Plan Templates named after templates', () => {
    for (const code of LOCALE_CODES) {
      for (const [ns, key] of TEMPLATE_LABELS) {
        const value = locales[code][ns]?.[key];
        expect(value, `${ns}.${key} missing from ${code}.json`).toBeTruthy();
        expect(
          value.toLowerCase(),
          `${ns}.${key} in ${code}.json names the template concept`,
        ).toContain(TEMPLATE_WORD[code]);
        expect(
          value.toLowerCase(),
          `${ns}.${key} in ${code}.json must not be renamed to "assigned"`,
        ).not.toContain(ASSIGNED_WORD[code]);
      }
    }
  });

  it('keeps the route, the locale keys and the feature flag the navigation already used', () => {
    const nav = readFileSync(NAV_CONFIG, 'utf-8');
    expect(nav).toContain("href: '/{{locale}}/training-plans'");
    expect(nav).toContain("labelKey: 'nav.training_plans'");
    expect(nav).toContain("featureKey: 'training.training_plans'");
    expect(nav).toContain("href: '/{{locale}}/training-plan-templates'");
    expect(nav).toContain("labelKey: 'nav.training_plan_templates'");
  });

  it('keeps both headings reading from their existing keys', () => {
    expect(readFileSync(PLANS_PAGE, 'utf-8')).toContain("t('training_plans.title')");
    expect(readFileSync(MEMBER_ROW, 'utf-8')).toContain("t('members.section_training_plans')");
  });
});
