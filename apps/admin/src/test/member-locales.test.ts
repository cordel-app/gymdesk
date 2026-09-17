import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// Regression test for #540: the Member page (list + expanded row sections —
// Account, Membership, Training Plans, Nutrition Plans, Session Packages,
// Billing Events) rendered raw translation keys (e.g. "members.section_account")
// instead of localized text, because es.json/ca.json were missing dozens of
// keys that en.json already had under the "members" namespace. next-intl has
// no locale fallback (see apps/admin/src/i18n.ts) — each locale file must be
// complete on its own, or a missing key renders as its raw dotted key path.
//
// This test guards against that class of bug recurring by:
//  1. Asserting every locale defines exactly the same key set for every
//     translation namespace the Member page components use.
//  2. Asserting every translation key actually referenced by the Member page
//     components (parsed from source) resolves in every supported locale.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const MEMBERS_DIR = join(__dirname, '..', 'app', '[locale]', 'members');
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

// Every namespace referenced by a component under apps/admin/src/app/[locale]/members/
// via useTranslations('<namespace>') or a dotted key on the global t().
const MEMBER_NAMESPACES = [
  'members',
  'member_payments',
  'member_training_plans',
  'training_plan_editor',
  'workout_template_blocks',
  'block_exercises',
];

/**
 * Extracts every translation key referenced in the Member page components,
 * fully qualified with its namespace (resolving both `useTranslations('ns')`
 * scoped hooks and dotted keys passed to a global `useTranslations()` hook).
 * Dynamic keys (template literals with interpolation, e.g. `members.x_${y}`)
 * are skipped — they cannot be statically verified.
 */
function extractReferencedKeys(): string[] {
  const files = readdirSync(MEMBERS_DIR).filter((f) => f.endsWith('.tsx'));
  const keys = new Set<string>();

  for (const file of files) {
    const src = readFileSync(join(MEMBERS_DIR, file), 'utf-8');

    const hookRe = /const\s+(\w+)\s*=\s*useTranslations\((?:'([^']*)')?\)/g;
    const hooks: { name: string; ns: string | null }[] = [];
    let hookMatch: RegExpExecArray | null;
    while ((hookMatch = hookRe.exec(src))) {
      hooks.push({ name: hookMatch[1], ns: hookMatch[2] ?? null });
    }

    for (const hook of hooks) {
      // \b ensures we match the actual hook variable (e.g. `t(`), not any
      // substring ending in the hook name (e.g. "sort(", "start(").
      const callRe = new RegExp(`\\b${hook.name}\\(\\s*[\`']([a-zA-Z0-9_.$\\{\\}]+)[\`']`, 'g');
      let callMatch: RegExpExecArray | null;
      while ((callMatch = callRe.exec(src))) {
        const rawKey = callMatch[1];
        if (rawKey.includes('${')) continue; // dynamic — skip
        keys.add(hook.ns ? `${hook.ns}.${rawKey}` : rawKey);
      }
    }
  }

  // Only keep keys under namespaces the Member page actually owns/uses —
  // filters out any incidental match against an unrelated global key.
  return [...keys].filter((k) => MEMBER_NAMESPACES.some((ns) => k === ns || k.startsWith(`${ns}.`)));
}

describe('Member page translations (#540)', () => {
  const locales = Object.fromEntries(LOCALE_CODES.map((c) => [c, loadLocale(c)])) as Record<
    (typeof LOCALE_CODES)[number],
    Messages
  >;

  it.each(MEMBER_NAMESPACES)('has an identical "%s" key set across every supported locale (en/es/ca)', (namespace) => {
    const enKeys = getNamespaceKeys(locales.en, namespace);
    expect(enKeys.size, `expected "${namespace}" namespace to exist in en.json`).toBeGreaterThan(0);

    for (const code of LOCALE_CODES) {
      if (code === 'en') continue;
      const keys = getNamespaceKeys(locales[code], namespace);
      const missing = [...enKeys].filter((k) => !keys.has(k));
      const extra = [...keys].filter((k) => !enKeys.has(k));
      expect(missing, `${code}.json is missing "${namespace}" keys present in en.json`).toEqual([]);
      expect(extra, `${code}.json has stray "${namespace}" keys not present in en.json`).toEqual([]);
    }
  });

  const referencedKeys = extractReferencedKeys();

  it('found translation keys referenced by the Member page components to check', () => {
    // Sanity check on the extractor itself — if this drops to 0 the regex
    // stopped matching (e.g. after a refactor) and the test below would
    // pass vacuously.
    expect(referencedKeys.length).toBeGreaterThan(50);
  });

  it.each(LOCALE_CODES)('every key referenced by the Member page components resolves in %s.json (no raw key can render)', (code) => {
    const messages = locales[code];
    const unresolved = referencedKeys.filter((key) => resolveKey(messages, key) === undefined);
    expect(unresolved, `${code}.json is missing translations for these Member page keys`).toEqual([]);
  });
});
