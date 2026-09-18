import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// #503 stage 9: the ticket's Internationalization acceptance criteria require
// every new label/status/filter option to be translated into every supported
// locale, with "no raw enum values or untranslated technical keys displayed."
// next-intl has no locale fallback (mirrors apps/admin's own i18n.ts), so a
// key missing from es.json/ca.json renders as its raw dotted key path — the
// exact defect this test guards against, for the whole Member app (not just
// #503's own new keys), the same way apps/admin/src/test/member-locales.test.ts
// already does for the Admin app's Members page.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const SCAN_DIRS = [
  join(__dirname, '..', 'app'),
  join(__dirname, '..', 'components'),
];
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

type Messages = Record<string, unknown>;

function loadLocale(code: string): Messages {
  return JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
}

function getTopLevelNamespaces(messages: Messages): string[] {
  return Object.keys(messages).filter((k) => typeof messages[k] === 'object' && messages[k] !== null);
}

function flattenKeys(obj: unknown, prefix = ''): string[] {
  if (obj == null || typeof obj !== 'object') return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    flattenKeys(v, prefix ? `${prefix}.${k}` : k),
  );
}

function resolveKey(messages: Messages, dottedKey: string): unknown {
  return dottedKey.split('.').reduce<unknown>((cur, part) => {
    if (cur == null || typeof cur !== 'object') return undefined;
    return (cur as Record<string, unknown>)[part];
  }, messages);
}

function listTsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listTsxFiles(full));
    else if (entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/**
 * Extracts every translation key referenced across the Member app, fully
 * qualified with its namespace (resolving both `useTranslations('ns')`
 * scoped hooks and dotted keys passed to a global `useTranslations()` hook).
 * Dynamic keys (template literals with interpolation) are skipped — they
 * cannot be statically verified. Mirrors the extractor already proven in
 * apps/admin/src/test/member-locales.test.ts.
 */
function extractReferencedKeys(): string[] {
  const files = SCAN_DIRS.flatMap((d) => listTsxFiles(d));
  const keys = new Set<string>();

  for (const file of files) {
    const src = readFileSync(file, 'utf-8');

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

  return [...keys];
}

describe('Member app translations (#503 stage 9)', () => {
  const locales = Object.fromEntries(LOCALE_CODES.map((c) => [c, loadLocale(c)])) as Record<
    (typeof LOCALE_CODES)[number],
    Messages
  >;

  const namespaces = getTopLevelNamespaces(locales.en);

  it('found top-level namespaces in en.json to check', () => {
    expect(namespaces.length).toBeGreaterThan(0);
  });

  it.each(namespaces)('has an identical "%s" key set (all nesting levels) across every supported locale (en/es/ca)', (namespace) => {
    const enKeys = new Set(flattenKeys((locales.en as any)[namespace], namespace));

    for (const code of LOCALE_CODES) {
      if (code === 'en') continue;
      const keys = new Set(flattenKeys((locales[code] as any)[namespace], namespace));
      const missing = [...enKeys].filter((k) => !keys.has(k));
      const extra = [...keys].filter((k) => !enKeys.has(k));
      expect(missing, `${code}.json is missing "${namespace}" keys present in en.json`).toEqual([]);
      expect(extra, `${code}.json has stray "${namespace}" keys not present in en.json`).toEqual([]);
    }
  });

  const referencedKeys = extractReferencedKeys();

  it('found translation keys referenced by the Member app to check', () => {
    // Sanity check on the extractor itself — if this drops to 0 the regex
    // stopped matching (e.g. after a refactor) and the test below would
    // pass vacuously.
    expect(referencedKeys.length).toBeGreaterThan(100);
  });

  it.each(LOCALE_CODES)('every key referenced by the Member app resolves in %s.json (no raw key can render)', (code) => {
    const messages = locales[code];
    const unresolved = referencedKeys.filter((key) => resolveKey(messages, key) === undefined);
    expect(unresolved, `${code}.json is missing translations for these Member app keys`).toEqual([]);
  });
});
