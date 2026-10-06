import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  BENEFIT_ITEM_COLUMN_MIN_WIDTH,
  PRODUCT_BENEFIT_COLUMNS,
  ProductBenefitColumnKey,
  benefitTableMinWidth,
  formatBenefitPrice,
  productBenefitColumns,
} from '@/components/ProductBenefits';

// #916 — the Membership Plan card's three Product sections must read as
// one table, and each row must show what the item normally costs and what it
// costs inside the Plan.
//
// The ticket's central invariant is that the sections no longer have
// independent column layouts: `PRODUCT_BENEFIT_COLUMNS` is the one
// declaration and every section renders from it, so a column a section has no
// value for keeps its place with a "—" instead of vanishing and shifting the
// columns after it.
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so the
// pure declaration is exercised directly and the wiring is pinned by scanning
// the sources, the way plans-benefit-sections.test.ts does.

const SRC = join(__dirname, '..');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const componentSrc = stripComments(
  readFileSync(join(SRC, 'components', 'ProductBenefits.tsx'), 'utf-8'),
);
const plansSrc = stripComments(
  readFileSync(join(SRC, 'app', '[locale]', 'plans', 'page.tsx'), 'utf-8'),
);
const promotionsSrc = stripComments(
  readFileSync(join(SRC, 'app', '[locale]', 'promotions', 'page.tsx'), 'utf-8'),
);

const keysOf = (cols: { key: ProductBenefitColumnKey }[]) => cols.map((c) => c.key);

describe('#916: one shared column declaration', () => {
  it('fixes the column order the ticket asks for', () => {
    // #959 appended Requirement — a Promotion line's Mandatory/Optional flag —
    // between Benefit and the prices. It is off for every Plan section
    // (`showRequirement` defaults to false), so the Plan grid below is unchanged;
    // what the declaration pins is the order, not the length.
    expect(keysOf([...PRODUCT_BENEFIT_COLUMNS])).toEqual([
      'item', 'quantity', 'frequency', 'action', 'requirement',
      'original_price', 'final_price',
    ]);
  });

  it('keeps Benefit between Frequency and the prices, never after them', () => {
    const at = (key: ProductBenefitColumnKey) =>
      PRODUCT_BENEFIT_COLUMNS.findIndex((c) => c.key === key);
    expect(at('action')).toBeGreaterThan(at('frequency'));
    expect(at('action')).toBeLessThan(at('original_price'));
    expect(at('final_price')).toBeGreaterThan(at('original_price'));
  });

  it('right-aligns the numbers and left-aligns the words', () => {
    const align = Object.fromEntries(PRODUCT_BENEFIT_COLUMNS.map((c) => [c.key, c.align]));
    expect(align).toMatchObject({
      item: 'left', quantity: 'right', frequency: 'left', action: 'left',
      requirement: 'left', original_price: 'right', final_price: 'right',
    });
  });

  it('sizes every column but the name, which takes the rest', () => {
    const flexible = PRODUCT_BENEFIT_COLUMNS.filter((c) => c.width == null);
    expect(keysOf(flexible)).toEqual(['item']);
    for (const col of PRODUCT_BENEFIT_COLUMNS) {
      if (col.width != null) expect(col.width).toBeGreaterThan(0);
    }
  });
});

describe('#916: productBenefitColumns()', () => {
  const full = { showFrequency: true, showAction: true, showPrices: true };

  it('is the whole grid for the Membership Plan sections', () => {
    expect(keysOf(productBenefitColumns(full))).toEqual([
      'item', 'quantity', 'frequency', 'action', 'original_price', 'final_price',
    ]);
  });

  it('gives every section of one page the same columns — the flags are the page\'s, not the section\'s', () => {
    // Called once per section with the same flags, it can only answer the same
    // grid, which is what makes the horizontal positions identical.
    const oneoff = productBenefitColumns(full);
    const periodical = productBenefitColumns(full);
    expect(keysOf(oneoff)).toEqual(keysOf(periodical));
    expect(oneoff.map((c) => c.width)).toEqual(periodical.map((c) => c.width));
  });

  it('drops the two price columns for a caller that does not price its rows', () => {
    expect(keysOf(productBenefitColumns({ ...full, showPrices: false }))).toEqual([
      'item', 'quantity', 'frequency', 'action',
    ]);
  });

  it('drops the treatment column for a caller that named no context', () => {
    expect(keysOf(productBenefitColumns({ ...full, showAction: false }))).toEqual([
      'item', 'quantity', 'frequency', 'original_price', 'final_price',
    ]);
  });

  it('never reorders what it keeps', () => {
    for (const showFrequency of [true, false]) {
      for (const showAction of [true, false]) {
        for (const showPrices of [true, false]) {
          const kept = keysOf(productBenefitColumns({ showFrequency, showAction, showPrices }));
          const expected = keysOf([...PRODUCT_BENEFIT_COLUMNS]).filter((k) => kept.includes(k));
          expect(kept).toEqual(expected);
        }
      }
    }
  });
});

describe('#916: the table scrolls rather than squashing', () => {
  it('adds up the fixed widths plus a floor for the name column', () => {
    const columns = productBenefitColumns({
      showFrequency: true, showAction: true, showPrices: true,
    });
    const fixed = columns.reduce((sum, c) => sum + (c.width ?? 0), 0);
    expect(benefitTableMinWidth(columns)).toBe(fixed + BENEFIT_ITEM_COLUMN_MIN_WIDTH);
  });

  it('asks for less room when a page shows fewer columns', () => {
    const withPrices = productBenefitColumns({
      showFrequency: true, showAction: true, showPrices: true,
    });
    const without = productBenefitColumns({
      showFrequency: true, showAction: true, showPrices: false,
    });
    expect(benefitTableMinWidth(without)).toBeLessThan(benefitTableMinWidth(withPrices));
  });
});

describe('#916: the read-only view renders from the declaration', () => {
  it('builds one grid for the section and renders every cell through it', () => {
    expect(componentSrc).toContain('const columns = productBenefitColumns({');
    expect(componentSrc).toContain('<col key={col.key}');
    expect(componentSrc).toContain("<th key={col.key} style={{ ...thSt, textAlign: col.align }}>{t(col.labelKey)}</th>");
    expect(componentSrc).toContain('<td key={col.key} style={{ ...tdSt, textAlign: col.align }}>{cell(col, r)}</td>');
  });

  it('fixes the layout, so a long item name cannot widen its column', () => {
    expect(componentSrc).toContain("tableLayout: 'fixed'");
    expect(componentSrc).toContain('minWidth: benefitTableMinWidth(columns)');
    expect(componentSrc).toContain("overflowX: 'auto'");
  });

  it('no longer spells the columns out one <th> at a time', () => {
    // The four inline headers the view carried before the shared declaration.
    for (const key of ['col_product', 'col_quantity', 'col_frequency', 'col_item_action']) {
      expect(componentSrc, `${key} is still restated in the view's JSX`)
        .not.toContain(`<th style={thSt}>{t('${key}')}</th>`);
    }
  });

  it('keeps a missing frequency as a "—" in its own cell', () => {
    // #1128: the label — and the decision that an absent or unknown value has
    // none — is `billingFrequencyLabel()`'s, so the cell reads `?? '—'` rather
    // than interpolating the column into a key of its own.
    expect(componentSrc).toMatch(/billingFrequencyLabel\(row\.product_billing_frequency, tFreq\) \?\? '—'/);
  });

  it('shows "—" for an item with no price rather than €0.00', () => {
    expect(componentSrc).toContain('if (unit == null) return <span style={mutedValueSt}>—</span>;');
  });

  it('shows the line total only when the quantity makes it differ from the unit price', () => {
    expect(componentSrc).toContain('line != null && line !== unit');
    expect(componentSrc).toContain("t('benefit_total_price', { amount: formatBenefitPrice(line) })");
  });

  it('formats money, and never prices anything itself (#817)', () => {
    expect(formatBenefitPrice(0)).toBe('€0.00');
    expect(formatBenefitPrice(16.5)).toBe('€16.50');
    // No discount arithmetic in the component: the server's numbers are read,
    // never recomputed from a quantity and a percentage.
    expect(componentSrc).not.toMatch(/original_price_incl_tax\s*\*/);
    expect(componentSrc).not.toMatch(/\/\s*100\s*\)/);
  });

  it('stays read-only — the price columns add no control (#797)', () => {
    const start = componentSrc.indexOf('export function ProductBenefitView');
    expect(start).toBeGreaterThan(-1);
    const view = componentSrc.slice(start);
    for (const control of ['<input', '<select', '<textarea', '<button', 'onChange']) {
      expect(view, `${control} in the read-only view`).not.toContain(control);
    }
  });
});

describe('#916: the Plans card', () => {
  it('asks for the price columns', () => {
    expect(plansSrc).toContain('showPrices');
  });

  it('shows the Frequency column in all three sections, so they line up', () => {
    expect(plansSrc.match(/showFrequency: true/g) ?? []).toHaveLength(3);
    expect(plansSrc).not.toContain('showFrequency: false');
  });

  it('reads the amounts off the row instead of computing them', () => {
    for (const field of ['original_price_incl_tax', 'final_price_incl_tax']) {
      expect(plansSrc, `${field} is computed in the page`).not.toContain(field);
    }
  });
});

describe('#919/#920: the Promotions card shares the same declaration', () => {
  // #916 left the Promotion sections alone and said so here, because their
  // columns were this pair of tickets' question. They answered it: the three
  // Promotion sections read as one table too, with a Regular / Final Price pair
  // of their own — the same `PRODUCT_BENEFIT_COLUMNS` above, labelled from
  // the `promotions` namespace. See promotion-benefit-columns.test.ts for the
  // rest of it.
  it('asks for the price columns', () => {
    expect(promotionsSrc).toContain('showPrices');
  });

  it('shows the Frequency column in all three sections, so they line up', () => {
    expect(promotionsSrc.match(/showFrequency: true/g) ?? []).toHaveLength(3);
    expect(promotionsSrc).not.toContain('showFrequency: false');
  });
});

describe('#916: locale coverage', () => {
  const REQUIRED = [
    'col_original_price', 'col_final_price', 'benefit_total_price',
    // #1128: the Frequency column's own labels are no longer the page's. A
    // Product's billing frequency reads from the one `billing_frequency`
    // namespace, asserted by `api/src/test/billing-frequency-labels.unit.test.ts`.
  ];

  for (const code of LOCALE_CODES) {
    it(`${code}.json defines every key the columns render`, () => {
      const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
      const plans = (messages.plans ?? {}) as Record<string, string>;
      for (const key of REQUIRED) {
        expect(plans[key], `plans.${key} missing from ${code}.json`).toBeTruthy();
      }
      expect(plans.benefit_total_price).toContain('{amount}');
    });
  }
});
