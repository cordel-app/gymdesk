import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// #635 stage 4 (part 2) — Included Services removed from the admin UI.
//
// §1: "Remove the existing Included Services concept from Membership Plans
// [and] Assigned Membership Plans … Do not rename it or move it somewhere
// else." The issue answered where the relation goes instead: the Activity Type
// names the Membership Plans allowed to book it (`activity_type_eligible_plans`,
// #481), which the Activity Types page already edits — so nothing replaces the
// section on the Plans page, and this file pins that down.
//
// `apps/admin` has no component test infrastructure, so this is a source scan,
// the same shape as `plans-charge-benefits-removed.test.ts` (part 1).

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const PLANS_DIR = join(__dirname, '..', 'app', '[locale]', 'plans');
const ASSIGNED_PLANS_DIR = join(__dirname, '..', 'app', '[locale]', 'financials', 'assigned-plans');
const MEMBERS_DIR = join(__dirname, '..', 'app', '[locale]', 'members');
const ACTIVITY_TYPES_DIR = join(__dirname, '..', 'app', '[locale]', 'activity-types');
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

// The sources deliberately name the removed section in comments, so every scan
// below runs against code with comments stripped.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const locales = Object.fromEntries(LOCALE_CODES.map((c) => [c, loadLocale(c)])) as Record<
  (typeof LOCALE_CODES)[number],
  Messages
>;

const REMOVED_PLAN_KEYS = [
  'section_allowances',
  'add_allowance',
  'allowance_type',
  'allowance_unlimited',
  'allowance_session_count',
  'no_allowances',
  // Only the allowance sub-form used these three.
  'label_activity_type',
  'session_count',
  'recurrence',
  'unlimited',
];

describe('Plans: Included Services removed (#635 stage 4)', () => {
  const sources = sourcesIn(PLANS_DIR);

  it('found the Membership Plans editor sources to check', () => {
    expect(sources.map((s) => s.file)).toContain('page.tsx');
  });

  it('renders no Included Services section in the Membership Plans editor', () => {
    for (const { file, src } of sources) {
      const code = stripComments(src);
      for (const key of REMOVED_PLAN_KEYS) {
        expect(code, `${file} still references the removed Included Services key "${key}"`)
          .not.toContain(`plans.${key}`);
      }
    }
  });

  it('keeps no allowance frontend state, handlers or API calls', () => {
    for (const { file, src } of sources) {
      const code = stripComments(src);
      expect(code, `${file} still calls the plan allowances endpoint`).not.toContain('/allowances');
      for (const symbol of [
        'allowanceForPlanId', 'allowanceForm', 'setAllowanceForm',
        'openAddAllowance', 'handleSaveAllowance', 'handleDeleteAllowance',
        'ALLOWANCE_TYPES', 'Allowance', 'allowances',
      ]) {
        expect(code, `${file} still declares allowance symbol "${symbol}"`).not.toContain(symbol);
      }
    }
  });

  it('drops the allowance usage list from the Assigned Plan card, which shows its snapshot', () => {
    const sources = sourcesIn(ASSIGNED_PLANS_DIR);
    for (const { file, src } of sources) {
      const code = stripComments(src);
      expect(code, `${file} still declares ActivityAllowanceUsage`).not.toContain('ActivityAllowanceUsage');
      expect(code, `${file} still reads activity_allowances`).not.toContain('activity_allowances');
    }
    // The section is not left empty: it renders the assignment's own #635
    // snapshot, which is what it bills from since stage 3 (#714). Stage 6 moved
    // the three benefit kinds into their own editable sections
    // (AssignedPlanConfiguration.tsx), so the keys are looked for across the
    // card's sources rather than in the expanded row alone.
    const rowSrc = sources.find((s) => s.file === 'AssignedPlanExpandedRow.tsx')!.src;
    expect(rowSrc).toContain('detail.snapshot');
    const cardSrc = sources.map((s) => s.src).join('\n');
    for (const key of ['benefits_oneoff', 'benefits_session', 'benefits_period']) {
      expect(cardSrc, `the Assigned Plan card does not render "${key}"`).toContain(key);
    }
  });

  it('drops the allowance list from the Member page Membership Plan card', () => {
    for (const { file, src } of sourcesIn(MEMBERS_DIR)) {
      const code = stripComments(src);
      expect(code, `${file} still reads activity_allowances`).not.toContain('activity_allowances');
      expect(code, `${file} still declares PlanAllowance`).not.toContain('PlanAllowance');
    }
  });

  it('keeps the inverted relation editable from the Activity Types page', () => {
    const code = sourcesIn(ACTIVITY_TYPES_DIR).map((s) => stripComments(s.src)).join('\n');
    expect(code).toContain('eligible-plans');
    expect(code).toContain('label_eligible_plans');
  });

  it('drops the Included Services keys from the "plans" namespace in every locale', () => {
    for (const code of LOCALE_CODES) {
      const keys = getNamespaceKeys(locales[code], 'plans');
      const leftover = REMOVED_PLAN_KEYS.filter((k) => keys.has(k));
      expect(leftover, `${code}.json still has removed "plans" Included Services keys`).toEqual([]);
    }
  });

  it('replaces the allowance-usage keys of the Assigned Plan card in every locale', () => {
    for (const code of LOCALE_CODES) {
      const keys = getNamespaceKeys(locales[code], 'assigned_plans_page');
      for (const removed of ['benefit_remaining', 'benefit_unlimited']) {
        expect(keys.has(removed), `${code}.json still has "assigned_plans_page.${removed}"`).toBe(false);
      }
      for (const added of ['section_benefits', 'benefits_oneoff', 'benefits_session', 'benefits_period']) {
        expect(keys.has(added), `${code}.json is missing "assigned_plans_page.${added}"`).toBe(true);
      }
    }
  });

  it('stops offering a staff override for the allowance rejection that can no longer happen', () => {
    const panel = readFileSync(
      join(__dirname, '..', 'app', '[locale]', 'calendar', 'ClassSessionDetailPanel.tsx'),
      'utf-8',
    );
    const code = stripComments(panel);
    expect(code).not.toContain('allowance_exhausted');
    // Eligibility and center coverage are the gates that remain.
    expect(code).toContain('plan_not_eligible');
    expect(code).toContain('center_not_covered');
  });
});
