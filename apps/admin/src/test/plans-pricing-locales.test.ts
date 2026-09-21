import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Regression test for #547 (Pricing section live VAT recalculation),
// guarding against the same class of bug fixed for Member/Assigned Plans
// (#540/#563/#511): next-intl has no locale fallback (see
// apps/admin/src/i18n.ts), so a key present in en.json but missing from
// es.json/ca.json renders as its raw dotted key path instead of localized text.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

// Every key #547 added to the pre-existing "plans" namespace: the live VAT
// recalculation preview, plus the Pricing section's Save / price-history /
// "Apply new price to assigned plans" flow.
const PRICING_KEYS = [
  'price_hint_inclusive',
  'price_preview',
  'tax_behavior_hint_inclusive',
  'section_pricing',
  'edit_pricing',
  'save',
  'label_price_incl_tax',
  'pricing_save_hint',
  'pricing_saved',
  'tax_included_suffix',
  'tax_rate_moved_hint',
  'apply_price_to_assigned',
  'confirm_apply_price',
  'confirm_apply_price_yes',
  'apply_price_done',
  'apply_price_done_with_discounts',
  'price_status_active',
  'price_status_applied',
  'price_status_inactive',
] as const;

type Messages = Record<string, unknown>;

function loadLocale(code: string): Messages {
  return JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
}

describe('Membership Plans Pricing translations (#547)', () => {
  const locales = Object.fromEntries(LOCALE_CODES.map((c) => [c, loadLocale(c)])) as Record<
    (typeof LOCALE_CODES)[number],
    Messages
  >;

  it.each(PRICING_KEYS)('plans.%s is defined and non-empty in every supported locale (en/es/ca)', (key) => {
    for (const code of LOCALE_CODES) {
      const plans = locales[code].plans as Record<string, unknown> | undefined;
      const value = plans?.[key];
      expect(value, `${code}.json is missing plans.${key}`).toBeTypeOf('string');
      expect((value as string).length, `${code}.json has an empty plans.${key}`).toBeGreaterThan(0);
    }
  });

  it('every interpolation placeholder used in the English string exists in the Spanish and Catalan strings', () => {
    const placeholderRe = /\{(\w+)\}/g;
    for (const key of PRICING_KEYS) {
      const enValue = (locales.en.plans as Record<string, string>)[key];
      const enPlaceholders = [...enValue.matchAll(placeholderRe)].map((m) => m[1]).sort();
      for (const code of LOCALE_CODES) {
        if (code === 'en') continue;
        const value = (locales[code].plans as Record<string, string>)[key];
        const placeholders = [...value.matchAll(placeholderRe)].map((m) => m[1]).sort();
        expect(placeholders, `${code}.json plans.${key} placeholders differ from en.json`).toEqual(enPlaceholders);
      }
    }
  });
});
