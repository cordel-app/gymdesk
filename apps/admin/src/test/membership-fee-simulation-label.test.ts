import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PLAN_SECTION_ORDER } from '@/app/[locale]/plans/planProfile';

// #962 — "Example Timeline" was never what that section shows: it projects what
// the Membership Fee does over the periods of a contract, so it reads
// **Membership Fee Simulation** now, in the Membership Plan card and the
// Promotion card alike — the words the Assigned Plan card has used for the same
// projection since #924 stage 3.
//
// A label rename and nothing else: the projection, its endpoints, its dates and
// its amounts are untouched, which the last test here pins by asserting that the
// domain's own names (`example_timeline`, `ExampleTimeline`) are still what the
// code calls them.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const PLANS_PAGE = join(__dirname, '..', 'app', '[locale]', 'plans', 'page.tsx');
const PROMOTIONS_PAGE = join(__dirname, '..', 'app', '[locale]', 'promotions', 'page.tsx');
const ASSIGNED_PLAN_ROW = join(
  __dirname, '..', 'app', '[locale]', 'financials', 'assigned-plans', 'AssignedPlanExpandedRow.tsx',
);
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

/** The three namespaces that render the section, and the one key they all use. */
const SECTION_NAMESPACES = ['plans', 'promotions', 'assigned_plans_page'] as const;
const SECTION_KEY = 'section_fee_simulation';

/** What every locale's three namespaces must agree on. */
const SECTION_LABELS: Record<(typeof LOCALE_CODES)[number], string> = {
  en: 'Membership Fee Simulation',
  es: 'Simulación de la Cuota de Membresía',
  ca: 'Simulació de la Quota de Membresia',
};

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function messages(code: string): Record<string, Record<string, string>> {
  return JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
}

const locales = Object.fromEntries(LOCALE_CODES.map((c) => [c, messages(c)])) as Record<
  (typeof LOCALE_CODES)[number],
  Record<string, Record<string, string>>
>;

const plansSrc = stripComments(readFileSync(PLANS_PAGE, 'utf-8'));
const promotionsSrc = stripComments(readFileSync(PROMOTIONS_PAGE, 'utf-8'));
const assignedSrc = stripComments(readFileSync(ASSIGNED_PLAN_ROW, 'utf-8'));

describe('#962: the Example Timeline reads Membership Fee Simulation', () => {
  it('uses one key, with one wording per locale, in all three namespaces', () => {
    for (const code of LOCALE_CODES) {
      for (const ns of SECTION_NAMESPACES) {
        expect(locales[code][ns], `${ns} namespace missing from ${code}.json`).toBeTruthy();
        expect(
          locales[code][ns][SECTION_KEY],
          `${ns}.${SECTION_KEY} missing from ${code}.json`,
        ).toBe(SECTION_LABELS[code]);
      }
    }
  });

  it('retires both of the old keys rather than leaving one holding the new label', () => {
    for (const code of LOCALE_CODES) {
      expect(locales[code].plans).not.toHaveProperty('section_example_timeline');
      expect(locales[code].promotions).not.toHaveProperty('section_timeline');
    }
  });

  it('leaves no user-facing "example timeline" wording in any locale', () => {
    // The phrase lived in four values per locale: the two section headings and
    // the two empty-state hints that told the gym to configure something "to
    // preview an example timeline".
    const phrases = ['example timeline', 'línea de tiempo de ejemplo', 'línia de temps d’exemple', "línia de temps d'exemple"];
    for (const code of LOCALE_CODES) {
      for (const [ns, keys] of Object.entries(locales[code])) {
        if (typeof keys !== 'object' || keys === null) continue;
        for (const [key, value] of Object.entries(keys)) {
          if (typeof value !== 'string') continue;
          const lower = value.toLowerCase();
          for (const phrase of phrases) {
            expect(lower, `${code}.json ${ns}.${key} still says "${phrase}"`).not.toContain(phrase);
          }
        }
      }
    }
  });

  it('names the simulation in the empty state each page shows instead of the table', () => {
    expect(locales.en.plans.timeline_unavailable).toContain('membership fee simulation');
    expect(locales.en.promotions.timeline_empty).toContain('membership fee simulation');
  });

  it('renders that key from the Plan card, the Promotion card and the Assigned Plan card', () => {
    expect(plansSrc).toContain(`t('plans.${SECTION_KEY}')`);
    expect(promotionsSrc).toContain(`t('${SECTION_KEY}')`);
    expect(assignedSrc).toContain(`t('${SECTION_KEY}')`);
    // And none of them keeps a second heading for the same section.
    expect(plansSrc).not.toContain('section_example_timeline');
    expect(promotionsSrc).not.toContain("t('section_timeline')");
  });

  it('keeps the section in its declared slot, before the Billing Event Simulation', () => {
    expect(PLAN_SECTION_ORDER.indexOf(SECTION_KEY)).toBe(
      PLAN_SECTION_ORDER.indexOf('section_billing_event_simulation') - 1,
    );
  });

  it('changes no data, endpoint or projection — only the words', () => {
    // The API field, the shared table and the per-row status keys are the
    // projection's own names and are deliberately untouched (CLAUDE.md pins
    // `components/ExampleTimeline.tsx` and `example_timeline` by name).
    expect(plansSrc).toContain('plan.example_timeline');
    expect(plansSrc).toContain('<ExampleTimeline');
    expect(promotionsSrc).toContain('<ExampleTimeline');
    for (const code of LOCALE_CODES) {
      expect(locales[code].plans.timeline_free_benefit).toBeTruthy();
      expect(locales[code].promotions.timeline_free).toBeTruthy();
    }
  });
});
