// #949 stage 1 — **Product** is the canonical term on screen.
//
// The entity was called *Sellable Item* and is now called *Product* (Q1 C on
// the thread, which also settled Q3: the renamed type axis is `gym_charges.type`
// and the global `charge_types` lookup keeps its own name). Stage 1 moved the
// copy a gym owner reads; the identifiers, the `/sellable-items` API root and
// the DB names follow in stages 2 and 3, so this gate deliberately speaks about
// locale **values** and nothing else — a key still spelled `col_sellable_item`
// is correct until stage 2 renames it, and failing on one here would make the
// stages unlandable in order.
//
// It lives in the API suite rather than beside the admin tests because CI runs
// `npm test` in `api/` only (the admin job type-checks and builds), which is the
// same reason `migration-074-dropped-columns.unit.test.ts` scans the Members App
// from here.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '..', '..', '..');
const LOCALE_FILES = ['admin', 'member'].flatMap((app) =>
  ['en', 'es', 'ca'].map((code) => ({
    label: `apps/${app}/locales/base/${code}.json`,
    path: join(REPO, 'apps', app, 'locales', 'base', `${code}.json`),
  })),
);

/**
 * `sellable` in any casing, in any language's copy — the retired English term,
 * and the one a contributor writing new copy would reach for.
 *
 * The Spanish and Catalan entries are the retired translations as whole
 * phrases. Bare `artículo` / `article` is deliberately **not** forbidden: it is
 * ordinary Spanish and Catalan for an item of any kind, and a gate that refused
 * it would be weakened by the first contributor who needed the word.
 */
const RETIRED = [
  /sellable/i,
  /art[íi]culos?\s+(vendibles?|de\s+venta|a\s+la\s+venta)/i,
  /articles?\s+(venibles?|vendibles?|de\s+venda|a\s+la\s+venda)/i,
];

/** Every leaf string of a locale file, as `namespace.key` → value. */
function values(path: string): [string, string][] {
  const out: [string, string][] = [];
  const walk = (node: unknown, prefix: string) => {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const at = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'string') out.push([at, value]);
      else if (value && typeof value === 'object') walk(value, at);
    }
  };
  walk(JSON.parse(readFileSync(path, 'utf8')), '');
  return out;
}

const offenders = (path: string, label: string) =>
  values(path)
    .filter(([, value]) => RETIRED.some((re) => re.test(value)))
    .map(([at, value]) => `${label}: ${at} = ${JSON.stringify(value)}`);

describe('Product is the canonical term in user-facing copy (#949)', () => {
  for (const { label, path } of LOCALE_FILES) {
    it(`${label} says Product, not Sellable Item`, () => {
      expect(offenders(path, label)).toEqual([]);
    });
  }

  it('reads the copy it claims to check', () => {
    // Without this the gate passes vacuously if a locale file moves or the
    // walker stops descending.
    for (const { label, path } of LOCALE_FILES) {
      const all = values(path);
      expect(all.length, `${label} produced no strings`).toBeGreaterThan(100);
    }
    const admin = new Map(values(LOCALE_FILES[0].path));
    expect(admin.get('nav.sellable_items')).toBe('Products');
    expect(admin.get('sellable_items.add')).toBe('+ Add Product');
  });

  it('judges values, not keys — the identifiers are stage 2', () => {
    const retiredKeyCleanValue = { sellable_items: { col_sellable_item: 'Product' } };
    const hit = Object.entries(retiredKeyCleanValue.sellable_items)
      .filter(([, value]) => RETIRED.some((re) => re.test(value)));
    expect(hit).toEqual([]);
  });

  it('would catch each wording stage 1 removed', () => {
    for (const shipped of [
      'Sellable Items',
      'Sellable Item Details',
      '+ Add Sellable Item',
      'No sellable items configured.',
      'Artículos a la Venta',
      'Artículo vendible',
      'Artículo de venta',
      'Los artículos vendibles obligatorios forman parte siempre de este plan de socio.',
      'Articles a la Venda',
      'Article venible',
      'Article de venda',
      'Els articles venibles obligatoris formen part sempre d’aquest pla de soci.',
    ]) {
      expect(RETIRED.some((re) => re.test(shipped)), `missed ${shipped}`).toBe(true);
    }
  });

  it('allows the wording stage 1 introduced, and ordinary uses of the word', () => {
    for (const kept of [
      'Products',
      'Product Details',
      '+ Add Product',
      'Productos',
      'Productes',
      'Artículo de la base de conocimiento', // bare `artículo`, not the entity
      'Article de la base de coneixement',
    ]) {
      expect(RETIRED.some((re) => re.test(kept)), `false positive on ${kept}`).toBe(false);
    }
  });
});
