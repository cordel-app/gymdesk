import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * #809 — Nutrition → Dashboard.
 *
 * Source-level guards for the parts of the acceptance criteria a type check
 * cannot see:
 *
 *  1. **Read-only.** "This ticket only introduces a read-only dashboard
 *     representation of the existing data" (§13), so the page must not issue a
 *     write of any kind.
 *  2. **No second derivation.** The card's count, which Templates qualify and
 *     the Template status all come from the one endpoint — the page must not
 *     filter or recount client-side (§8, §11).
 *  3. **Translations.** next-intl has no locale fallback (see
 *     `apps/admin/src/i18n.ts`), so a key present in en.json but missing from
 *     es.json/ca.json renders as its raw dotted key path — including the bucket
 *     card's own label.
 */

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;
const NAMESPACE = 'nutrition_dashboard';

const navSrc = readFileSync(join(__dirname, '..', 'config', 'navigationGroups.ts'), 'utf-8');
const pageSrc = readFileSync(
  join(__dirname, '..', 'app', '[locale]', 'nutrition', 'page.tsx'),
  'utf-8',
);

type Messages = Record<string, unknown>;

const loadLocale = (code: string): Messages =>
  JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));

function namespaceKeys(messages: Messages): Set<string> {
  const ns = messages[NAMESPACE];
  if (ns == null || typeof ns !== 'object') return new Set();
  return new Set(Object.keys(ns as Record<string, unknown>));
}

describe('Nutrition → Dashboard navigation (#809)', () => {
  it('is the Nutrition group\'s Dashboard entry, gated by the group itself', () => {
    const nutrition = navSrc.slice(navSrc.indexOf("id: 'nutrition'"), navSrc.indexOf("id: 'payments'"));
    expect(nutrition).toContain("href: '/{{locale}}/nutrition'");
    expect(nutrition).toContain("featureKey: 'nutrition'");
  });
});

describe('Nutrition → Dashboard page (#809)', () => {
  it('is read-only — it never issues a write request', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(pageSrc, `the Dashboard must not ${method} anything`).not.toContain(`method: '${method}'`);
    }
  });

  it('reads the single aggregating endpoint', () => {
    expect(pageSrc).toContain("'/nutrition/dashboard/nutrition-plans'");
  });

  // §4 and §7: which cards qualify is the server's decision. A page that
  // filtered or recounted would be a second implementation of the rule, and the
  // one the ticket warns against (§8: do not infer the count).
  it('does not re-filter or recount the cards it was given', () => {
    expect(pageSrc).not.toMatch(/\.filter\(/);
    expect(pageSrc).not.toMatch(/active_members\s*[><]/);
  });

  it('renders the three card fields of the ticket', () => {
    expect(pageSrc).toContain('card.active_members');
    expect(pageSrc).toContain("t('active_members')");
    expect(pageSrc).toContain("t('template_status')");
  });

  // The bucket card the issue owner asked for by name: it has no Template, so
  // it has no Template name and no Template status either.
  it('labels the no-template bucket and renders no status badge for it', () => {
    expect(pageSrc).toContain("t('no_template')");
    expect(pageSrc).toMatch(/card\.name\s*\?\?\s*t\('no_template'\)/);
    // The badge is rendered on the truthy side of a `card.status` test, so a
    // bucket card (null status) falls through to the em dash.
    expect(pageSrc).toMatch(/card\.status\s*\r?\n?\s*\?/);
    expect(pageSrc).toContain('—');
  });

  // A Template status is shown with the shared badge, never a colour spelled
  // out in the page, and its label comes from the shared `status` namespace.
  it('uses the shared StatusBadge for the Template status', () => {
    expect(pageSrc).toContain("import { StatusBadge } from '@/components/StatusBadge'");
    expect(pageSrc).toContain('<StatusBadge status={card.status} label={tStatus(card.status)} />');
  });
});

describe('Nutrition → Dashboard translations (#809)', () => {
  const locales = Object.fromEntries(LOCALE_CODES.map((c) => [c, loadLocale(c)])) as Record<
    (typeof LOCALE_CODES)[number],
    Messages
  >;

  it('defines every key the page asks for', () => {
    const expected = [
      'title', 'subtitle', 'nutrition_plans', 'active_members',
      'template_status', 'no_template', 'loading', 'empty', 'error_generic',
    ];
    const enKeys = namespaceKeys(locales.en);
    const missing = expected.filter((k) => !enKeys.has(k));
    expect(missing, 'en.json is missing nutrition_dashboard keys the page renders').toEqual([]);
  });

  it.each(LOCALE_CODES)('has an identical "nutrition_dashboard" key set in %s.json', (code) => {
    const enKeys = namespaceKeys(locales.en);
    expect(enKeys.size).toBeGreaterThan(0);
    const keys = namespaceKeys(locales[code]);
    expect([...enKeys].filter((k) => !keys.has(k)), `${code}.json is missing keys present in en.json`).toEqual([]);
    expect([...keys].filter((k) => !enKeys.has(k)), `${code}.json has stray keys not in en.json`).toEqual([]);
  });

  // The Template status badge reads its label from the shared `status`
  // namespace, so every value nutrition_plan_templates.status can hold needs a
  // key there — next-intl prints a missing key verbatim.
  it.each(LOCALE_CODES)('has a status label for every Template status in %s.json', (code) => {
    const status = locales[code].status as Record<string, string> | undefined;
    expect(status, `${code}.json has no status namespace`).toBeTruthy();
    for (const value of ['active', 'inactive', 'draft', 'deleted']) {
      expect(status![value], `${code}.json is missing status.${value}`).toBeTruthy();
    }
  });
});
