import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// Regression test for #626 — Charge Benefits removed from the Promotion editor.
//
// The Promotion editor must no longer display or allow configuration of Charge
// Benefits, and none of the frontend state / handlers / API calls that existed
// only for that section may come back. Everything else about the Promotion
// editor — One-off, Session, Period and Membership Fee Benefits, and the
// unrelated Membership Plans Charge Benefits section — must stay exactly as it
// was, so this also pins those down.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const PROMOTIONS_DIR = join(__dirname, '..', 'app', '[locale]', 'promotions');
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

function resolveKey(messages: Messages, dottedKey: string): unknown {
  return dottedKey.split('.').reduce<unknown>((cur, part) => {
    if (cur == null || typeof cur !== 'object') return undefined;
    return (cur as Record<string, unknown>)[part];
  }, messages);
}

function promotionsSources(): { file: string; src: string }[] {
  return readdirSync(PROMOTIONS_DIR)
    .filter((f) => f.endsWith('.tsx'))
    .map((file) => ({ file, src: readFileSync(join(PROMOTIONS_DIR, file), 'utf-8') }));
}

// Comments in the sources deliberately reference #626 and the removed section by
// name, so the source scans below run against code with comments stripped.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const locales = Object.fromEntries(LOCALE_CODES.map((c) => [c, loadLocale(c)])) as Record<
  (typeof LOCALE_CODES)[number],
  Messages
>;

// Translation keys, frontend state and API calls that belonged exclusively to
// the removed Charge Benefits section.
const REMOVED_PROMOTION_KEYS = [
  'section_charge_benefits',
  'no_charge_benefits',
  'add_charge_benefit',
  'save_charge_benefits',
  'col_charge',
];

describe('Promotions: Charge Benefits removed (#626)', () => {
  const sources = promotionsSources();

  it('found the Promotion editor sources to check', () => {
    expect(sources.map((s) => s.file)).toContain('page.tsx');
  });

  it('renders no Charge Benefits section in the Promotion editor', () => {
    for (const { file, src } of sources) {
      const code = stripComments(src);
      for (const key of REMOVED_PROMOTION_KEYS) {
        expect(code, `${file} still references the removed Charge Benefits key "${key}"`).not.toContain(`'${key}'`);
      }
    }
  });

  it('keeps no Charge Benefit frontend state, handlers or API calls', () => {
    for (const { file, src } of sources) {
      const code = stripComments(src);
      expect(code, `${file} still calls the promotion charge-benefits endpoint`).not.toContain('/charge-benefits');
      for (const symbol of ['cbDraft', 'setCbDraft', 'cachedCb', 'setCachedCb', 'ChargeBenefit']) {
        expect(code, `${file} still declares Charge Benefit state "${symbol}"`).not.toContain(symbol);
      }
    }
  });

  it('leaves the other Promotion benefit sections in place', () => {
    const code = sources.map((s) => stripComments(s.src)).join('\n');
    for (const key of [
      'section_session_benefits',
      'section_oneoff_benefits',
      'section_period_benefits',
      'section_membership_fee_benefits',
    ]) {
      expect(code, `the Promotion editor no longer renders "${key}"`).toContain(`'${key}'`);
    }
  });

  it('drops the Charge Benefit keys from the "promotions" namespace in every locale', () => {
    for (const code of LOCALE_CODES) {
      const keys = getNamespaceKeys(locales[code], 'promotions');
      const leftover = REMOVED_PROMOTION_KEYS.filter((k) => keys.has(k));
      expect(leftover, `${code}.json still has removed "promotions" Charge Benefit keys`).toEqual([]);
    }
  });

  // The Membership Plans editor has its own, unrelated Charge Benefits section
  // (plans namespace) — #626 only removes the Promotion one.
  it('leaves the Membership Plans Charge Benefits section untouched', () => {
    for (const code of LOCALE_CODES) {
      expect(resolveKey(locales[code], 'plans.section_charge_benefits'), `${code}.json lost plans.section_charge_benefits`).toBeTypeOf('string');
      expect(resolveKey(locales[code], 'plans.no_charge_benefits'), `${code}.json lost plans.no_charge_benefits`).toBeTypeOf('string');
    }
  });

  it('has an identical "promotions" key set across every supported locale (en/es/ca)', () => {
    const enKeys = getNamespaceKeys(locales.en, 'promotions');
    expect(enKeys.size).toBeGreaterThan(0);

    for (const code of LOCALE_CODES) {
      if (code === 'en') continue;
      const keys = getNamespaceKeys(locales[code], 'promotions');
      const missing = [...enKeys].filter((k) => !keys.has(k));
      const extra = [...keys].filter((k) => !enKeys.has(k));
      expect(missing, `${code}.json is missing "promotions" keys present in en.json`).toEqual([]);
      expect(extra, `${code}.json has stray "promotions" keys not present in en.json`).toEqual([]);
    }
  });
});
