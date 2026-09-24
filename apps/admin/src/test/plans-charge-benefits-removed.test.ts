import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// #635 stage 4 — Charge Benefits removed from the Membership Plans editor.
//
// §2: "Charge Benefits must disappear from the UI completely. Do not move
// Charge Benefits to another section or create an alternative Charge Benefits
// editor." So neither the section, nor the state and handlers that existed only
// for it, nor its translation keys may come back. `apps/admin` has no component
// test infrastructure, so this is a source scan — the same shape as
// `promotions-charge-benefits-removed.test.ts` (#626).
//
// What must survive is pinned down too: the three Sellable-Item-keyed Benefit
// sections that replace it (stage 1). Included Services went in part 2 of the
// same stage — see `included-services-removed.test.ts`.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const PLANS_DIR = join(__dirname, '..', 'app', '[locale]', 'plans');
const ASSIGNED_PLANS_DIR = join(__dirname, '..', 'app', '[locale]', 'financials', 'assigned-plans');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

type Messages = Record<string, unknown>;

function loadLocale(code: string): Messages {
  return JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
}

function getNamespaceKeys(messages: Messages, namespace: string): Set<string> {
  const ns = messages[namespace];
  if (ns == null || typeof ns !== 'object') return new Set();
  return new Set(Object.keys(ns as Record<string, unknown>));
}

function sourcesIn(dir: string): { file: string; src: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
    .map((file) => ({ file, src: readFileSync(join(dir, file), 'utf-8') }));
}

// The sources deliberately mention #635 and the removed section by name in
// comments, so every scan below runs against code with comments stripped.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const locales = Object.fromEntries(LOCALE_CODES.map((c) => [c, loadLocale(c)])) as Record<
  (typeof LOCALE_CODES)[number],
  Messages
>;

const REMOVED_PLAN_KEYS = [
  'section_charge_benefits',
  'no_charge_benefits',
  'save_charge_benefits',
  'cb_col_charge',
  'cb_col_action',
  'cb_action_no_benefit',
  'cb_action_waive',
  'cb_action_percentage_discount',
  'cb_action_fixed_discount',
  // Only the forecast's benefit lines used these, and Charge Benefits were
  // their only source.
  'forecast_benefit_prefix',
  'forecast_discount',
];

describe('Plans: Charge Benefits removed (#635 stage 4)', () => {
  const sources = sourcesIn(PLANS_DIR);

  it('found the Membership Plans editor sources to check', () => {
    expect(sources.map((s) => s.file)).toContain('page.tsx');
  });

  it('renders no Charge Benefits section in the Membership Plans editor', () => {
    for (const { file, src } of sources) {
      const code = stripComments(src);
      for (const key of REMOVED_PLAN_KEYS) {
        expect(code, `${file} still references the removed Charge Benefits key "${key}"`)
          .not.toContain(`plans.${key}`);
      }
    }
  });

  it('keeps no Charge Benefit frontend state, handlers or API calls', () => {
    for (const { file, src } of sources) {
      const code = stripComments(src);
      expect(code, `${file} still calls the plan charge-benefits endpoint`).not.toContain('/charge-benefits');
      for (const symbol of [
        'cbDraft', 'setCbDraft', 'cbSaving', 'cbEditForPlanId',
        'openCbEdit', 'cancelCbEdit', 'saveCbEdit',
        'ChargeBenefit', 'charge_benefits', 'CHARGE_ACTIONS', 'forecastBenefitLabel',
      ]) {
        expect(code, `${file} still declares Charge Benefit symbol "${symbol}"`).not.toContain(symbol);
      }
    }
  });

  it('drops the Assigned Plan charge-benefit snapshot from the Financials view', () => {
    for (const { file, src } of sourcesIn(ASSIGNED_PLANS_DIR)) {
      const code = stripComments(src);
      expect(code, `${file} still declares ChargeBenefitSnapshot`).not.toContain('ChargeBenefitSnapshot');
      // `AppliedPromotion.charge_benefits` is a *Promotion* snapshot field and
      // deliberately stays, so this checks the Assigned Plan's own field only.
      expect(code, `${file} still reads the Assigned Plan's charge_benefits`)
        .not.toContain('detail.charge_benefits');
    }
  });

  it('leaves the replacement Benefit sections in place', () => {
    const code = sources.map((s) => stripComments(s.src)).join('\n');
    // The three Benefit sections are rendered from BENEFIT_SECTIONS, whose
    // `titleKey` carries the bare key and is prefixed at the call site.
    for (const key of [
      'section_oneoff_benefits',
      'section_session_benefits',
      'section_plan_period_benefits',
      'plans.section_billing_duration',
    ]) {
      expect(code, `the Membership Plans editor no longer renders "${key}"`).toContain(key);
    }
  });

  it('drops the Charge Benefit keys from the "plans" namespace in every locale', () => {
    for (const code of LOCALE_CODES) {
      const keys = getNamespaceKeys(locales[code], 'plans');
      const leftover = REMOVED_PLAN_KEYS.filter((k) => keys.has(k));
      expect(leftover, `${code}.json still has removed "plans" Charge Benefit keys`).toEqual([]);
    }
  });
});
