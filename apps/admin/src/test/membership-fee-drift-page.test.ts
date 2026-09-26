import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * #635 stage 14 — Payments → Membership Fee Drift.
 *
 * The page that surfaces the stage 12 impact report, so the correction can be
 * reviewed before `billing.date_aware_membership_fee` is switched on. Source-level
 * guards for the things that would silently break it without failing a type check:
 *
 *  1. **Read-only.** The page exists so a money-moving correction is *reviewed*
 *     before it lands. A write control on it — a flag switch, an "apply" — would
 *     defeat that, so no write request may appear in its source.
 *  2. **Feature-flag gating.** The nav entry must carry the page's own
 *     `payments.membership_fee_drift` key (migration 190), and the page must
 *     bounce a direct URL rather than rely on the sidebar alone.
 *  3. **Shared list chrome.** CLAUDE.md: a list page's filter bar is
 *     `FilterBar`/`FilterField` and its table is `DataTable` — never a second
 *     hand-rolled look.
 *  4. **Translations.** next-intl has no locale fallback (`apps/admin/src/i18n.ts`),
 *     so a key present in en.json but missing from es.json/ca.json renders as its
 *     raw dotted key path.
 */

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;
const NAMESPACE = 'membership_fee_drift';

const navSrc = readFileSync(join(__dirname, '..', 'config', 'navigationGroups.ts'), 'utf-8');
const pageSrc = readFileSync(
  join(__dirname, '..', 'app', '[locale]', 'payments', 'membership-fee-drift', 'page.tsx'),
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

/**
 * Every literal `t('…')` key the page and its expanded row ask for. The four
 * interpolated `t(`card_${…}`)` keys cannot be read this way and have their own
 * case below.
 */
function translationKeysUsed(src: string): string[] {
  return [...new Set([...src.matchAll(/\bt\('([a-z0-9_]+)'/g)].map((m) => m[1]))];
}

describe('Payments → Membership Fee Drift navigation (#635 stage 14)', () => {
  it('adds the entry to the Payments group', () => {
    const payments = navSrc.slice(navSrc.indexOf("id: 'payments'"), navSrc.indexOf("id: 'financials'"));
    expect(payments).toContain("href: '/{{locale}}/payments/membership-fee-drift'");
    expect(payments).toContain("labelKey: 'nav.membership_fee_drift'");
  });

  it('gates the entry on its own feature flag, not a sibling page flag', () => {
    const start = navSrc.indexOf("href: '/{{locale}}/payments/membership-fee-drift'");
    const entry = navSrc.slice(start, start + 220);
    expect(entry).toContain("featureKey: 'payments.membership_fee_drift'");
    expect(entry).not.toContain('payments.transactions');
    expect(entry).not.toContain('payments.billing_events');
  });

  it.each(LOCALE_CODES)('labels the entry in %s.json', (code) => {
    const nav = loadLocale(code).nav as Record<string, string>;
    expect(nav.membership_fee_drift, `${code}.json is missing nav.membership_fee_drift`).toBeTruthy();
  });
});

describe('Payments → Membership Fee Drift page (#635 stage 14)', () => {
  it('is read-only — it never issues a write request', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(pageSrc, `the report must not ${method} anything`).not.toContain(`method: '${method}'`);
    }
  });

  it('reads the stage 12 report endpoint and nothing else', () => {
    expect(pageSrc).toContain("'/user-memberships/reports/membership-fee-drift'");
    const fetches = [...pageSrc.matchAll(/apiFetch<[^>]*>\('([^']+)'/g)].map((m) => m[1]);
    expect(fetches).toEqual(['/user-memberships/reports/membership-fee-drift']);
  });

  it('redirects away when the feature flag is disabled, so a direct URL is not accessible', () => {
    expect(pageSrc).toContain("flags['payments.membership_fee_drift'] !== false");
    expect(pageSrc).toContain("flags['payments'] !== false");
    expect(pageSrc).toMatch(/if\s*\(!canRead\s*\|\|\s*!flagEnabled\)\s*router\.replace/);
  });

  it('keeps the superadmin flag bypass out of an impersonated session (#439)', () => {
    expect(pageSrc).toContain('isSuperadmin && !isImpersonating');
  });

  it('wears the shared filter bar and list chrome (#724)', () => {
    expect(pageSrc).toContain("from '@/components/FilterBar'");
    expect(pageSrc).toContain("from '@/components/DataTable'");
    expect(pageSrc).toContain('<FilterBar>');
    expect(pageSrc).toContain('<DataTable');
  });

  it('offers View Audit Log through the shared button, by canonical entity type', () => {
    expect(pageSrc).toContain('<ViewAuditLogButton');
    expect(pageSrc).toContain('entityType="user_membership"');
  });

  it('renders every field of the report the ticket asked to surface', () => {
    // "current stored price, Promotion timeline, benefit end date, newly resolved
    // price, and difference" — #635's own wording for this report.
    for (const field of [
      'stored_final_price', 'regular_fee', 'charged_amount', 'resolved_amount',
      'difference', 'benefit_ends_on', 'free_months', 'paid_months', 'bonus_months',
      'billing_date', 'date_aware_pricing_enabled', 'examined', 'total_difference',
    ]) {
      expect(pageSrc, `the page never renders ${field}`).toContain(field);
    }
  });

  it('keys an applied Promotion on the application, not on (assignment, promotion) (#635 stage 9)', () => {
    expect(pageSrc).toContain('key={p.user_membership_promotion_id}');
  });

  it('formats a billing date in UTC, so a cycle cannot shift a day in the viewer\'s zone', () => {
    expect(pageSrc).toContain("timeZone: 'UTC'");
  });
});

describe('Payments → Membership Fee Drift translations (#635 stage 14)', () => {
  const locales = Object.fromEntries(LOCALE_CODES.map((c) => [c, loadLocale(c)])) as Record<
    (typeof LOCALE_CODES)[number],
    Messages
  >;

  it('defines every key the page asks for', () => {
    const enKeys = namespaceKeys(locales.en);
    const used = translationKeysUsed(pageSrc);
    expect(used.length).toBeGreaterThan(20);
    expect(used.filter((k) => !enKeys.has(k)), 'en.json is missing keys the page renders').toEqual([]);
  });

  it('defines the four summary cards the page builds by interpolation', () => {
    const enKeys = namespaceKeys(locales.en);
    for (const card of ['examined', 'affected', 'increases', 'total_difference']) {
      expect(enKeys.has(`card_${card}`), `en.json is missing card_${card}`).toBe(true);
      expect(enKeys.has(`card_${card}_hint`), `en.json is missing card_${card}_hint`).toBe(true);
    }
  });

  it.each(LOCALE_CODES)('has an identical "membership_fee_drift" key set in %s.json', (code) => {
    const enKeys = namespaceKeys(locales.en);
    expect(enKeys.size).toBeGreaterThan(0);
    const keys = namespaceKeys(locales[code]);
    expect([...enKeys].filter((k) => !keys.has(k)), `${code}.json is missing keys present in en.json`).toEqual([]);
    expect([...keys].filter((k) => !enKeys.has(k)), `${code}.json has stray keys not in en.json`).toEqual([]);
  });
});
