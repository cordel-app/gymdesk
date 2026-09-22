import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Regression test for #630 — the Assigned Plan context-menu action previously
// labelled "Close" is displayed as "Cancel".
//
// The rename is label-only: the action still posts to /user-memberships/:id/close,
// still runs the two-step confirm (plain confirm, then the unused-value warning
// confirm), and still maps onto the same status workflow. This pins both halves
// down — the new wording, and the behaviour that must not have moved with it.
//
// The confirm dialog's own dismiss button used to reuse the generic "cancel"
// key; with the action itself now called "Cancel" that would render two
// identically-labelled buttons, so the dialog uses the dedicated
// action_close_confirm / action_close_dismiss labels instead.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const EXPANDED_ROW = join(
  __dirname, '..', 'app', '[locale]', 'financials', 'assigned-plans', 'AssignedPlanExpandedRow.tsx',
);
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

type Messages = Record<string, unknown>;

function loadLocale(code: string): Messages {
  return JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
}

function assignedPlansKey(messages: Messages, key: string): string | undefined {
  const ns = messages['assigned_plans_page'];
  if (ns == null || typeof ns !== 'object') return undefined;
  const value = (ns as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

// The source comments reference #630 and the old "Close" wording by name, so
// the source scans below run against code with comments stripped.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const locales = Object.fromEntries(LOCALE_CODES.map((c) => [c, loadLocale(c)])) as Record<
  (typeof LOCALE_CODES)[number],
  Messages
>;

const EXPECTED_ACTION_LABEL: Record<(typeof LOCALE_CODES)[number], string> = {
  en: 'Cancel',
  es: 'Cancelar',
  ca: 'Cancel·la',
};

describe('Assigned Plans: "Close" renamed to "Cancel" (#630)', () => {
  const source = stripComments(readFileSync(EXPANDED_ROW, 'utf-8'));

  it.each(LOCALE_CODES)('labels the context-menu action "Cancel" in %s.json', (code) => {
    expect(assignedPlansKey(locales[code], 'action_close')).toBe(EXPECTED_ACTION_LABEL[code]);
  });

  it('no longer describes the action as closing in the English confirmations', () => {
    for (const key of ['confirm_close', 'confirm_close_with_warnings']) {
      const message = assignedPlansKey(locales.en, key);
      expect(message, `en.json lost assigned_plans_page.${key}`).toBeTypeOf('string');
      expect(message!.toLowerCase(), `en.json still says "close" in ${key}`).not.toMatch(/\bclos(e|ing)\b/);
      expect(message!.toLowerCase(), `en.json does not mention cancelling in ${key}`).toMatch(/cancel/);
    }
  });

  it('gives the confirm dialog distinct confirm/dismiss labels in every locale', () => {
    for (const code of LOCALE_CODES) {
      const confirm = assignedPlansKey(locales[code], 'action_close_confirm');
      const dismiss = assignedPlansKey(locales[code], 'action_close_dismiss');
      expect(confirm, `${code}.json is missing assigned_plans_page.action_close_confirm`).toBeTypeOf('string');
      expect(dismiss, `${code}.json is missing assigned_plans_page.action_close_dismiss`).toBeTypeOf('string');
      expect(confirm, `${code}.json reuses the same label for both confirm buttons`).not.toBe(dismiss);
    }
  });

  it('renders the menu action from action_close and the dialogs from the dedicated labels', () => {
    expect(source).toContain("label: t('action_close')");
    expect(source).toContain("confirmLabel={t('action_close_confirm')}");
    expect(source).toContain("cancelLabel={t('action_close_dismiss')}");
    // The generic "cancel" label belongs to the edit form, never to these dialogs.
    expect(source).not.toContain("cancelLabel={t('cancel')}");
  });

  it('keeps the action, its endpoint and its two-step confirm flow unchanged', () => {
    expect(source).toContain("setCloseStep('confirm')");
    expect(source).toContain("closeStep === 'warn'");
    expect(source.match(/\/user-memberships\/\$\{assignedPlanId\}\/close/g) ?? []).toHaveLength(2);
    expect(source).toContain('JSON.stringify({ confirm: true })');
  });
});
