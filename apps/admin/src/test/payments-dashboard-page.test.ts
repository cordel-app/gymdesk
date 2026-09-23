import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * #674 — Payments → Dashboard.
 *
 * Source-level guards for the two things that would silently break the
 * acceptance criteria without failing a type check:
 *
 *  1. **Feature-flag gating.** "When the feature flag is disabled, the
 *     Dashboard must not be visible or accessible" — the nav entry must carry
 *     `payments.dashboard`, and the page must bounce a direct URL rather than
 *     rely on the sidebar alone.
 *  2. **Translations.** next-intl has no locale fallback (see
 *     `apps/admin/src/i18n.ts`), so a key present in en.json but missing from
 *     es.json/ca.json renders as its raw dotted key path.
 */

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;
const NAMESPACE = 'payments_dashboard';

const navSrc = readFileSync(join(__dirname, '..', 'config', 'navigationGroups.ts'), 'utf-8');
const pageSrc = readFileSync(
  join(__dirname, '..', 'app', '[locale]', 'payments', 'dashboard', 'page.tsx'),
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

describe('Payments → Dashboard navigation (#674)', () => {
  it('adds the Dashboard entry to the Payments group', () => {
    const payments = navSrc.slice(navSrc.indexOf("id: 'payments'"), navSrc.indexOf("id: 'financials'"));
    expect(payments).toContain("href: '/{{locale}}/payments/dashboard'");
    expect(payments).toContain("labelKey: 'nav.dashboard'");
  });

  it('gates the Dashboard entry on its own feature flag, not a sibling page flag', () => {
    const entry = navSrc.slice(
      navSrc.indexOf("href: '/{{locale}}/payments/dashboard'"),
      navSrc.indexOf("href: '/{{locale}}/payments/transactions'"),
    );
    expect(entry).toContain("featureKey: 'payments.dashboard'");
    expect(entry).not.toContain('payments.transactions');
    expect(entry).not.toContain('payments.billing_events');
  });
});

describe('Payments → Dashboard page (#674)', () => {
  it('is read-only — it never issues a write request', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(pageSrc, `the Dashboard must not ${method} anything`).not.toContain(`method: '${method}'`);
    }
  });

  it('reads the single summary endpoint', () => {
    expect(pageSrc).toContain("'/payments/dashboard/summary'");
  });

  it('redirects away when the feature flag is disabled, so a direct URL is not accessible', () => {
    expect(pageSrc).toContain("flags['payments.dashboard'] !== false");
    expect(pageSrc).toContain("flags['payments'] !== false");
    expect(pageSrc).toMatch(/if\s*\(!canRead\s*\|\|\s*!flagEnabled\)\s*router\.replace/);
  });

  it('keeps the superadmin flag bypass out of an impersonated session (#439)', () => {
    expect(pageSrc).toContain('isSuperadmin && !isImpersonating');
  });

  it('labels each card with the period the API counted over, not a browser-derived month', () => {
    expect(pageSrc).toContain("timeZone: 'UTC'");
    expect(pageSrc).toContain('summary.current_month_start');
    expect(pageSrc).toContain('summary.previous_month_start');
  });

  it('renders all four cards of the ticket', () => {
    for (const key of [
      'scheduled_this_month',
      'total_last_month',
      'failed_last_month',
      'successful_last_month',
    ]) {
      expect(pageSrc).toContain(`summary.${key}`);
    }
  });
});

describe('Payments → Dashboard translations (#674)', () => {
  const locales = Object.fromEntries(LOCALE_CODES.map((c) => [c, loadLocale(c)])) as Record<
    (typeof LOCALE_CODES)[number],
    Messages
  >;

  it('defines every key the page asks for', () => {
    const expected = [
      'title', 'subtitle', 'billing_events', 'billing_events_unit',
      'card_scheduled_this_month', 'card_total_last_month',
      'card_failed_last_month', 'card_successful_last_month',
      'loading', 'empty', 'error_generic',
    ];
    const enKeys = namespaceKeys(locales.en);
    const missing = expected.filter((k) => !enKeys.has(k));
    expect(missing, 'en.json is missing payments_dashboard keys the page renders').toEqual([]);
  });

  it.each(LOCALE_CODES)('has an identical "payments_dashboard" key set in %s.json', (code) => {
    const enKeys = namespaceKeys(locales.en);
    expect(enKeys.size).toBeGreaterThan(0);
    const keys = namespaceKeys(locales[code]);
    expect([...enKeys].filter((k) => !keys.has(k)), `${code}.json is missing keys present in en.json`).toEqual([]);
    expect([...keys].filter((k) => !enKeys.has(k)), `${code}.json has stray keys not in en.json`).toEqual([]);
  });
});
