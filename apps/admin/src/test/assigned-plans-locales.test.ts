import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// Regression test for #511 (stage 4 — Assigned Plans frontend), guarding
// against the same class of bug fixed for the Member page in #540/#563:
// next-intl has no locale fallback (see apps/admin/src/i18n.ts), so a key
// present in en.json but missing from es.json/ca.json renders as its raw
// dotted key path instead of localized text.
//
//  1. Asserts the "assigned_plans_page" namespace has an identical key set
//     across every supported locale.
//  2. Asserts every translation key actually referenced by the Assigned
//     Plans page components (parsed from source) resolves in every locale.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
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

function resolveKey(messages: Messages, dottedKey: string): unknown {
  return dottedKey.split('.').reduce<unknown>((cur, part) => {
    if (cur == null || typeof cur !== 'object') return undefined;
    return (cur as Record<string, unknown>)[part];
  }, messages);
}

// Every namespace referenced by a component under
// apps/admin/src/app/[locale]/financials/assigned-plans/ via
// useTranslations('<namespace>') or a dotted key on the global t().
const ASSIGNED_PLANS_NAMESPACES = ['assigned_plans_page', 'status'];

function extractReferencedKeys(): string[] {
  const files = readdirSync(ASSIGNED_PLANS_DIR).filter((f) => f.endsWith('.tsx'));
  const keys = new Set<string>();

  for (const file of files) {
    const src = readFileSync(join(ASSIGNED_PLANS_DIR, file), 'utf-8');

    const hookRe = /const\s+(\w+)\s*=\s*useTranslations\((?:'([^']*)')?\)/g;
    const hooks: { name: string; ns: string | null }[] = [];
    let hookMatch: RegExpExecArray | null;
    while ((hookMatch = hookRe.exec(src))) {
      hooks.push({ name: hookMatch[1], ns: hookMatch[2] ?? null });
    }

    for (const hook of hooks) {
      const callRe = new RegExp(`\\b${hook.name}\\(\\s*[\`']([a-zA-Z0-9_.$\\{\\}]+)[\`']`, 'g');
      let callMatch: RegExpExecArray | null;
      while ((callMatch = callRe.exec(src))) {
        const rawKey = callMatch[1];
        if (rawKey.includes('${')) continue; // dynamic — skip
        keys.add(hook.ns ? `${hook.ns}.${rawKey}` : rawKey);
      }
    }
  }

  return [...keys].filter((k) => ASSIGNED_PLANS_NAMESPACES.some((ns) => k === ns || k.startsWith(`${ns}.`)));
}

describe('Assigned Plans page translations (#511 stage 4)', () => {
  const locales = Object.fromEntries(LOCALE_CODES.map((c) => [c, loadLocale(c)])) as Record<
    (typeof LOCALE_CODES)[number],
    Messages
  >;

  it('has an identical "assigned_plans_page" key set across every supported locale (en/es/ca)', () => {
    const enKeys = getNamespaceKeys(locales.en, 'assigned_plans_page');
    expect(enKeys.size).toBeGreaterThan(0);

    for (const code of LOCALE_CODES) {
      if (code === 'en') continue;
      const keys = getNamespaceKeys(locales[code], 'assigned_plans_page');
      const missing = [...enKeys].filter((k) => !keys.has(k));
      const extra = [...keys].filter((k) => !enKeys.has(k));
      expect(missing, `${code}.json is missing "assigned_plans_page" keys present in en.json`).toEqual([]);
      expect(extra, `${code}.json has stray "assigned_plans_page" keys not present in en.json`).toEqual([]);
    }
  });

  const referencedKeys = extractReferencedKeys();

  it('found translation keys referenced by the Assigned Plans page components to check', () => {
    expect(referencedKeys.length).toBeGreaterThan(30);
  });

  it.each(LOCALE_CODES)('every key referenced by the Assigned Plans page components resolves in %s.json (no raw key can render)', (code) => {
    const messages = locales[code];
    const unresolved = referencedKeys.filter((key) => resolveKey(messages, key) === undefined);
    expect(unresolved, `${code}.json is missing translations for these Assigned Plans page keys`).toEqual([]);
  });
});
