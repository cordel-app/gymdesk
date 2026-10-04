// #949 stage 3 — the retired entity is gone from the code, the wire and the
// schema, and this gate is what keeps it gone.
//
// Stage 2 banned the retired spellings *a TypeScript reader chooses* — the
// camel/Pascal/SCREAMING identifiers and the English prose — and said nothing
// about `snake_case` or the route path, because those were stage 3's: the
// `/sellable-items` API root, the `gym_charges` table with its `gym_charge_id`
// FK column, its eight CHECKs and `sellable_item_professional_services`, the
// response fields, the stored `promotions.applies_to` value and simulation line
// `kind`, the `financials.gym_charges` feature flag and the `gym_charge` audit
// entity type. Stage 3 has moved all of them (migration 214, and `/products` in
// `app.ts`), so the ban now covers those shapes too and the gate is a flat one
// again — no allowlist to rot, because nothing correct can match it.
//
// Two things deliberately stay outside it, and both are *paths* rather than
// code: the two legacy admin routes (`financials/sellable-items`,
// `financials/gym-charges`), kept so a bookmark written before either rename
// still lands on `financials/products`. The hyphenated `gym-charges` is
// therefore not a banned shape, since that folder's name is the only place it
// occurs; `sellable` in any casing is banned, and the assertion at the bottom
// pins the two redirect files as the only paths that may name a retired term.
// The old migrations are outside it too, for the reason they are never edited:
// they are `.js`, and this gate reads `.ts`/`.tsx` only. A migration's SQL is
// the history of a schema that really did carry those names.
//
// It scans the two Next apps from the API suite for the same reason
// `migration-074-dropped-columns.unit.test.ts` does — CI runs `npm test` in
// `api/` only.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO = join(__dirname, '..', '..', '..');
const ROOTS = [
  join(REPO, 'api', 'src'),
  join(REPO, 'apps', 'admin', 'src'),
  join(REPO, 'apps', 'member', 'src'),
];

/**
 * The retired spellings, as shapes.
 *
 * `SellableItem` and `sellableItem` cover every identifier stage 2 moved
 * (`SellableItemBenefitRow`, `createSellableItem`, `sellableItemsRouter`, …);
 * `SELLABLE_ITEM` / `SELLABLE_BENEFIT` cover the constants; `sellableSection`
 * and `SellableBenefit` cover the two the entity's name was shortened in; and
 * the prose forms cover a comment or a test description. One `/sellable/i`
 * would cover all of those, and stage 3 adds it — the narrower shapes are kept
 * beside it because each one names what it was, which is what a failure message
 * has to say.
 *
 * Stage 3's own shapes are the three the schema and the wire carried: anything
 * spelling `sellable` at all (the API root `/sellable-items`, the
 * `sellable_item_*` fields, the stored `'sellable_item'` value), the
 * `gym_charge`/`gym_charges` table and column family in SQL, and its
 * `gymCharge`/`GymCharge` camel and Pascal forms. The hyphenated `gym-charges`
 * is not among them: see the header.
 */
const RETIRED = [
  /sellable/i,
  /Sellable\s*Items?/,
  /sellable\s+items?/,
  /sellableItem/,
  /sellableSection/,
  /SELLABLE[_ ]ITEMS?/,
  /SELLABLE_BENEFIT/,
  /SellableBenefit/,
  /gym_charges?/,
  /gymCharges?/,
  /GymCharges?/,
  /GYM_CHARGES?/,
];

/**
 * The two files whose job is to quote the retired wording: this gate's own
 * fixtures, and the copy gate's list of what stage 1 removed. Nothing else may
 * be added — a file that needs an exception is a file that needs renaming.
 */
const QUOTES_THE_RETIRED_TERM = [
  join('api', 'src', 'test', 'product-identifiers.unit.test.ts'),
  join('api', 'src', 'test', 'product-terminology.unit.test.ts'),
];

function sources(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

const says = (text: string) => RETIRED.some((re) => re.test(text));

const offenders = (file: string): string[] => {
  const at = relative(REPO, file);
  if (QUOTES_THE_RETIRED_TERM.includes(at)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line, i) => [line, i + 1] as const)
    .filter(([line]) => says(line))
    .map(([line, n]) => `${at}:${n}: ${line.trim()}`);
};

describe('the retired identifier is gone from the code (#949 stage 2)', () => {
  const files = ROOTS.flatMap(sources);

  it('reads the trees it claims to check', () => {
    // Without this the gate passes vacuously if a root moves.
    expect(files.length).toBeGreaterThan(500);
    for (const root of ROOTS) expect(sources(root).length).toBeGreaterThan(2);
    for (const at of QUOTES_THE_RETIRED_TERM) {
      expect(files.map((f) => relative(REPO, f))).toContain(at);
    }
  });

  it('finds none of the retired spellings', () => {
    expect(files.flatMap(offenders)).toEqual([]);
  });

  it('would catch each shape stage 2 renamed', () => {
    for (const retired of [
      'import { SellableItemFrequency } from',
      'const sellableItems = await load()',
      'SELLABLE_ITEM_BENEFIT_COLUMNS',
      'const SELLABLE_ITEMS_PAGE = join(',
      'renderSellableBenefitSection()',
      'SELLABLE_BENEFIT_SECTIONS',
      'const [sellableSectionDraft, setDraft] = useState()',
      '// one Sellable Item per row',
      '// the Sellable Items list',
      "it('lists the sellable items', () => {",
      '// the same `SELLABLE ITEM | QUANTITY |` grid',
    ]) {
      expect(says(retired), `missed ${retired}`).toBe(true);
    }
  });

  it('would catch each shape stage 3 moved', () => {
    // The wire and the schema: the API root, the response fields, the stored
    // values, the table and its FK column, the feature flag, the audit entity
    // type, and the camel forms of the table's name.
    for (const retired of [
      "apiFetch('/sellable-items')",
      "await request(app).get('/sellable-items/1')",
      "kind: 'sellable_item'",
      "applies_to: 'sellable_item'",
      'row.sellable_item_name',
      'FROM sellable_item_professional_services',
      'FROM gym_charges gc',
      'b.gym_charge_id',
      "requireFeatureEnabled('financials.gym_charges')",
      'entityType="gym_charge"',
      'const gymChargeId = Number(row.id)',
      'interface GymCharge extends ProductOption {',
      'GYM_CHARGES_PAGE',
    ]) {
      expect(says(retired), `missed ${retired}`).toBe(true);
    }
  });

  it('leaves the names that are not the retired entity alone', () => {
    // `charge_types` is a different concept that merely shares a word and keeps
    // the name **Charge Type** (the hard constraint, and Q3 on the thread), so
    // every spelling of it has to pass — including the column that says which
    // Charge Types seed a per-gym Product. The legacy admin route's own folder
    // name is the only place the hyphenated form occurs, so it passes too.
    for (const kept of [
      'FROM charge_types ct',
      'charge_type_id',
      'ct.is_product = 1',
      "entityType: 'product'",
      "apiFetch('/products')",
      'FROM product_professional_services',
      'impact.products > 0',
      "requireFeatureEnabled('financials.products')",
      "permanentRedirect(`/${locale}/financials/products`)",
      '// `financials/gym-charges` is kept for the name before that',
      "for (const junk of ['plan', 'products', 'MEMBERSHIP_PLAN'])",
    ]) {
      expect(says(kept), `false positive on ${kept}`).toBe(false);
    }
  });

  it('keeps the two retired routes only as redirects', () => {
    // The only paths that still spell a retired name are the two legacy admin
    // routes, kept so a bookmark written before either rename lands on
    // `financials/products`. Neither body names the term it is called after.
    const legacy = join(
      REPO, 'apps', 'admin', 'src', 'app', '[locale]', 'financials', 'sellable-items', 'page.tsx',
    );
    const charges = join(
      REPO, 'apps', 'admin', 'src', 'app', '[locale]', 'financials', 'gym-charges', 'page.tsx',
    );
    for (const redirect of [legacy, charges]) {
      const src = readFileSync(redirect, 'utf8');
      expect(src).toContain('permanentRedirect(`/${locale}/financials/products`)');
    }
    expect(readFileSync(legacy, 'utf8')).not.toMatch(/sellable/i);
    expect(readFileSync(charges, 'utf8')).not.toMatch(/gym.charges/i);
    const retiredPaths = files
      .filter((f) => /sellable|gym-charges/i.test(relative(REPO, f)))
      .map((f) => relative(REPO, f))
      .sort();
    expect(retiredPaths).toEqual([relative(REPO, charges), relative(REPO, legacy)].sort());
  });
});
