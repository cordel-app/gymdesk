import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  EMPTY_VALUE,
  PLAN_PRICING_SUBSECTIONS,
  PLAN_SECTION_ORDER,
  formatPlanCurrentPrice,
} from '@/app/[locale]/plans/planProfile';

// #817 — two presentation changes in the Membership Plan's expanded card:
//
//   §1  PRICE HISTORY becomes a collapsible card, collapsed every time the plan
//       is expanded; its rows, dates, amounts and statuses are untouched.
//   §2  CURRENT PRICE reads as the customer price *and* its net, e.g.
//       "€60.00 VAT included (net €49.59 + tax = €60.00)".
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so §1
// is pinned by scanning the page source the way plans-expanded-read-only.test.ts
// and theme-colors-collapsible.test.ts do, while §2's formatting — the one piece
// with real logic — is exercised directly as the pure function it now is.

const PLANS_DIR = join(__dirname, '..', 'app', '[locale]', 'plans');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const pageSrc = stripComments(readFileSync(join(PLANS_DIR, 'page.tsx'), 'utf-8'));

function plansNamespace(code: string): Record<string, string> {
  const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
  return (messages.plans ?? {}) as Record<string, string>;
}

const locales = Object.fromEntries(LOCALE_CODES.map((c) => [c, plansNamespace(c)])) as Record<
  (typeof LOCALE_CODES)[number],
  Record<string, string>
>;

/** The `CollapsibleCard` component body. */
const headerSrc =
  pageSrc.match(/function CollapsibleCard[\s\S]*?\n}\n/)?.[0] ?? '';

/** The PRICE HISTORY card, from its opening tag to its closing one. */
const priceHistorySrc = (() => {
  const start = pageSrc.indexOf('<CollapsibleCard');
  expect(start, 'PRICE HISTORY is not rendered through CollapsibleCard').toBeGreaterThan(-1);
  const end = pageSrc.indexOf('</CollapsibleCard>', start);
  expect(end).toBeGreaterThan(start);
  return pageSrc.slice(start, end);
})();

describe('Plans: Price History is a collapsible card (#817 §1)', () => {
  it('renders the Price History header as a CollapsibleCard', () => {
    expect(priceHistorySrc).toContain("title={t('plans.section_prices')}");
    expect(priceHistorySrc).toContain('onToggle={() => togglePriceHistory(plan.id)}');
    // #881: no longer a section of the plan — it is declared as PRICING's own
    // sub-section, and a key in both lists would render the history twice.
    expect([...PLAN_PRICING_SUBSECTIONS]).toEqual(['section_prices']);
    expect([...PLAN_SECTION_ORDER]).not.toContain('section_prices');
  });

  it('starts collapsed: open state is a set nothing seeds', () => {
    expect(pageSrc).toMatch(
      /const \[priceHistoryOpen, setPriceHistoryOpen\] = useState<Set<number>>\(new Set\(\)\)/,
    );
    expect(pageSrc).toContain('const isPriceHistoryOpen = priceHistoryOpen.has(plan.id);');
    // Nothing ever pre-fills the set, so "collapsed by default" cannot regress
    // into "collapsed until some other code decides otherwise".
    const seeds = [...pageSrc.matchAll(/setPriceHistoryOpen\(/g)];
    expect(seeds.length, 'setPriceHistoryOpen is called from more than the two toggles').toBe(2);
  });

  it('forgets the open state when the plan collapses, so re-expanding starts collapsed', () => {
    const toggle = pageSrc.match(/function toggleExpand\(id: number\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    expect(toggle, 'toggleExpand could not be located').not.toBe('');
    expect(toggle).toContain('setPriceHistoryOpen(');
    expect(toggle).toMatch(/next\.delete\(id\)/);
  });

  it('renders the history rows only while open, and leaves them unchanged', () => {
    // The card owns "only while open": its body is a child it renders behind
    // `open`, so no caller can forget the guard.
    expect(priceHistorySrc).toContain('open={isPriceHistoryOpen}');
    expect(headerSrc).toContain('{open && (');
    expect(priceHistorySrc).toContain('{(plan.price_history ?? []).length === 0 ? (');
    // The existing row content: the validity window, the price, the VAT hint and
    // the status badge. §1 changes the framing only.
    expect(priceHistorySrc).toContain('String(row.valid_from).slice(0, 10)');
    expect(priceHistorySrc).toContain('parseFloat(row.price).toFixed(2)');
    expect(priceHistorySrc).toContain("t('plans.price_hint_inclusive', { rate: parseFloat(row.tax_rate_percent) })");
    expect(priceHistorySrc).toContain('t(`plans.price_status_${row.status}`)');
    expect(priceHistorySrc).toContain("t('plans.no_prices')");
  });

  it('makes the whole header an accessible toggle button', () => {
    expect(headerSrc, 'CollapsibleSectionHeader could not be located').not.toBe('');
    expect(headerSrc).toMatch(/<button/);
    expect(headerSrc).toContain('aria-expanded={open}');
    expect(headerSrc).toContain('onClick={onToggle}');
    // The chevron is decoration next to the label the button already announces.
    expect(headerSrc).toContain('aria-hidden="true"');
    expect(headerSrc).toContain("transform: open ? 'rotate(180deg)' : 'none'");
  });

  it('keeps the section label styling shared with the non-collapsible headers', () => {
    expect(headerSrc).toContain('style={sectionLabelSt}');
  });

  // #881 §7 — the card reuses the plan card's themed chrome rather than
  // declaring a second card look, and it is a card rather than the section
  // divider it was, because it now sits *inside* a section.
  it('is a card built from the shared card surface, not a section divider', () => {
    expect(headerSrc).toContain('style={nestedCardSt}');
    expect(headerSrc).not.toContain('...subSectionSt');
    expect(pageSrc).toContain('const nestedCardSt: React.CSSProperties = { ...cardSurfaceStyle');
  });
});

// #881 — Price History moves into PRICING and stops being a section of its own.
describe('Plans: Price History lives inside PRICING (#881)', () => {
  it('renders the card between the PRICING fields and the next section', () => {
    const pricing = pageSrc.indexOf("plans.section_pricing");
    const card = pageSrc.indexOf('<CollapsibleCard');
    const nextSection = pageSrc.indexOf("plans.section_billing_duration");
    expect(pricing).toBeGreaterThan(-1);
    expect(card).toBeGreaterThan(pricing);
    expect(card).toBeLessThan(nextSection);
  });

  it('renders the history exactly once, and never as a top-level section', () => {
    expect([...pageSrc.matchAll(/<CollapsibleCard/g)].length).toBe(1);
    expect([...pageSrc.matchAll(/plans\.section_prices/g)].length).toBe(1);
    // The retired framing: a `SectionHeader` for Price History would put it back
    // beside the numbered sections.
    expect(pageSrc).not.toContain("<SectionHeader title={t('plans.section_prices')}");
    expect(pageSrc).not.toContain('CollapsibleSectionHeader');
  });

  it('adds no control to the card beyond its own expander', () => {
    // #797/#816: an expanded card is read-only outside Edit mode. The expander
    // is the card's, not the history's — the rows carry nothing writable.
    for (const control of ['<input', '<select', '<textarea', '<button', 'onChange', 'onClick']) {
      expect(priceHistorySrc, `the Price History card renders a ${control}`).not.toContain(control + ' ');
    }
    expect(priceHistorySrc).not.toContain('onClick=');
  });
});

describe('Plans: Current price shows gross and net (#817 §2)', () => {
  const t = (excl: string, incl: string) => `net €${excl} + tax = €${incl}`;

  it('renders the tax-inclusive total first, then the net → total calculation', () => {
    expect(
      formatPlanCurrentPrice(
        { current_price: '60.00', amount_excl_tax: 49.59, amount_incl_tax: 60 },
        'VAT included',
        t,
      ),
    ).toBe('€60.00 VAT included (net €49.59 + tax = €60.00)');
  });

  it('formats both numbers to two decimals', () => {
    expect(
      formatPlanCurrentPrice(
        { current_price: '10', amount_excl_tax: 8.26, amount_incl_tax: 10 },
        'VAT included',
        t,
      ),
    ).toBe('€10.00 VAT included (net €8.26 + tax = €10.00)');
  });

  it('never recomputes the split — it prints exactly what the server sent', () => {
    // Deliberately inconsistent numbers: a frontend that re-derived the net from
    // a rate would "correct" them and drift from the nightly run's own pricing.
    expect(
      formatPlanCurrentPrice(
        { current_price: '100.00', amount_excl_tax: 1, amount_incl_tax: 2 },
        'VAT included',
        t,
      ),
    ).toBe('€2.00 VAT included (net €1.00 + tax = €2.00)');
  });

  it('is the em dash only when no price is configured', () => {
    expect(
      formatPlanCurrentPrice({ current_price: null, amount_excl_tax: null, amount_incl_tax: null }, 'VAT included', t),
    ).toBe(EMPTY_VALUE);
    expect(
      formatPlanCurrentPrice({ current_price: null, amount_excl_tax: 10, amount_incl_tax: 12.1 }, 'VAT included', t),
    ).toBe(EMPTY_VALUE);
  });

  it('falls back to the gross alone when there is no split to show', () => {
    // A gym with no tax rate at all: the price is configured, so the row must
    // still show it rather than reading "not configured".
    expect(
      formatPlanCurrentPrice({ current_price: '45.5', amount_excl_tax: null, amount_incl_tax: null }, 'VAT included', t),
    ).toBe('€45.50');
    expect(
      formatPlanCurrentPrice({ current_price: 'not a number', amount_excl_tax: null, amount_incl_tax: null }, 'VAT included', t),
    ).toBe(EMPTY_VALUE);
  });

  it('reads its label pieces from the locale files, in all three languages', () => {
    for (const code of LOCALE_CODES) {
      const ns = locales[code];
      expect(ns.label_current_price, `plans.label_current_price missing in ${code}`).toBeTruthy();
      expect(ns.tax_included_suffix, `plans.tax_included_suffix missing in ${code}`).toBeTruthy();
      expect(ns.price_preview, `plans.price_preview missing in ${code}`).toContain('{excl}');
      expect(ns.price_preview).toContain('{incl}');
      expect(ns.section_prices, `plans.section_prices missing in ${code}`).toBeTruthy();
    }
  });
});
