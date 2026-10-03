import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  PRODUCT_BENEFIT_COLUMNS,
  ProductBenefitColumnKey,
  productBenefitColumns,
} from '@/components/ProductBenefits';

// #919/#920 — the Promotion card's three Product sections must read as one
// table, each row must show the Regular Price and the Final Price, and the
// Membership Fee Promotion's duration must stop claiming to be a count of
// months.
//
// The first half is #916's invariant one screen over, so the assertions are
// about *wiring*, not a second declaration: the Promotion sections render from
// the same `PRODUCT_BENEFIT_COLUMNS`, which is what makes the horizontal
// boundaries identical. #920's own words:
//
//   > Session Promotion, One-off Promotion and Periodical Promotion must
//   > visually behave as one table with shared column boundaries, while
//   > remaining separated into their existing semantic sections.
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so the
// pure declaration is exercised directly and the page wiring is pinned by
// scanning the source, the way plan-benefit-columns.test.ts does.

const SRC = join(__dirname, '..');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const promotionsSrc = stripComments(
  readFileSync(join(SRC, 'app', '[locale]', 'promotions', 'page.tsx'), 'utf-8'),
);

const keysOf = (cols: { key: ProductBenefitColumnKey }[]) => cols.map((c) => c.key);

describe('#919/#920: one grid for the three Promotion sections', () => {
  it('asks for the Frequency column in every section, not only the Periodical one', () => {
    // The flag is the page's, not the section's: called with the same flags for
    // each section, `productBenefitColumns()` can only answer the same
    // grid — which is what puts QUANTITY, FREQUENCY and PROMOTION at the same
    // horizontal position in all three.
    expect(promotionsSrc.match(/showFrequency: true/g) ?? []).toHaveLength(3);
    expect(promotionsSrc).not.toContain('showFrequency: false');
  });

  it('asks for the two price columns', () => {
    expect(promotionsSrc).toContain('showPrices');
  });

  it('renders the sections through the shared view, never a second table', () => {
    expect(promotionsSrc).toContain('<ProductBenefitView');
    expect(promotionsSrc).toContain('benefitContext="promotion"');
  });

  it('gets the ticket\'s column order from the shared declaration', () => {
    expect(keysOf(productBenefitColumns({
      showFrequency: true, showAction: true, showPrices: true,
    }))).toEqual(['item', 'quantity', 'frequency', 'action', 'original_price', 'final_price']);
  });

  it('keeps Promotion between Frequency and Regular Price (#920 §1)', () => {
    const at = (key: ProductBenefitColumnKey) =>
      PRODUCT_BENEFIT_COLUMNS.findIndex((c) => c.key === key);
    expect(at('action')).toBeGreaterThan(at('frequency'));
    expect(at('action')).toBeLessThan(at('original_price'));
  });

  it('reads the amounts off the row instead of computing them (#817)', () => {
    for (const field of ['original_price_incl_tax', 'final_price_incl_tax']) {
      expect(promotionsSrc, `${field} is computed in the page`).not.toContain(field);
    }
  });
});

describe('#919/#920: the Membership Fee Promotion duration', () => {
  it('labels the column Duration, never Duration (months)', () => {
    // The value is a count of the Promotion's periods; the column said
    // "(months)", which is what both tickets asked to drop. The key itself is
    // the rename — `col_duration` already existed in the namespace.
    expect(promotionsSrc).not.toContain('col_duration_months');
    expect(promotionsSrc.match(/t\('col_duration'\)/g) ?? []).toHaveLength(2);
  });

  it('still renders the duration in both halves of the section', () => {
    // One for the editor's column header, one for the read-only table's <th> —
    // the rename must not have dropped the column from either half.
    expect(promotionsSrc).toContain("<span style={colHeaderSt}>{t('col_duration')}</span>");
    expect(promotionsSrc).toContain("<th style={thSt}>{t('col_duration')}</th>");
  });
});

describe('#919/#920: locale coverage', () => {
  const REQUIRED = [
    // #920's two price columns. The shared declaration's label keys are
    // resolved in the caller's namespace, which is what lets the Promotion card
    // say "Regular Price" where the Plan card says "Original price".
    'col_original_price', 'col_final_price', 'benefit_total_price',
    // The Frequency column now shows for the Session and One-off sections too,
    // whose items carry these two frequencies — and next-intl prints a missing
    // key verbatim, so an absent one would render "promotions.frequency_once".
    'frequency_once', 'frequency_per_session',
    // The Membership Fee Promotion column.
    'col_duration',
  ];

  for (const code of LOCALE_CODES) {
    it(`${code}.json defines every key the sections render`, () => {
      const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
      const promotions = (messages.promotions ?? {}) as Record<string, string>;
      for (const key of REQUIRED) {
        expect(promotions[key], `promotions.${key} missing from ${code}.json`).toBeTruthy();
      }
      expect(promotions.benefit_total_price).toContain('{amount}');
      // The renamed keys are gone rather than left behind as dead "(months)"
      // labels nothing resolves.
      expect(promotions.col_duration_months).toBeUndefined();
      expect(promotions.label_duration_months).toBeUndefined();
      expect(promotions.col_duration).not.toMatch(/month|mes|mesos/i);
    });
  }
});
