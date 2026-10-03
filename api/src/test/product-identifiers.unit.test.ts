// #949 stage 2 — the code says **Product**, and what still says otherwise is
// stage 3's, by shape rather than by exception.
//
// Stage 2 renamed the identifiers, the file names, the locale keys and the admin
// route folder. It deliberately moved nothing that crosses the wire or the
// schema, because that is what stage 3 (`Q1 C` on the thread) carries with a
// migration and a `db-reviewer` pass: the `/sellable-items` API root, the
// `gym_charges` table with its `gym_charge_id` FK column in twelve tables and
// its eight CHECKs, `sellable_item_professional_services`, the response fields
// (`products`, `sellable_item_id`, `sellable_item_name`, …), the stored
// `promotions.applies_to` value and simulation line `kind` (`'sellable_item'`),
// the `financials.gym_charges` feature flag and the `gym_charge` audit entity
// type.
//
// So this gate bans the *retired spellings a TypeScript reader chooses* — the
// camel/Pascal/SCREAMING identifiers and the English prose — and says nothing
// about `snake_case` or the route path, none of which can match the patterns
// below. That is what lets it be a flat ban with no allowlist to rot: a stage-3
// PR adds nothing here, because the names it moves were never matched.
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
 * the prose forms cover a comment or a test description.
 */
const RETIRED = [
  /Sellable\s*Items?/,
  /sellable\s+items?/,
  /sellableItem/,
  /sellableSection/,
  /SELLABLE[_ ]ITEMS?/,
  /SELLABLE_BENEFIT/,
  /SellableBenefit/,
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

  it('leaves every spelling stage 3 owns alone', () => {
    for (const kept of [
      "apiFetch('/sellable-items')",
      "await request(app).get('/sellable-items/1')",
      "kind: 'sellable_item'",
      "applies_to: 'sellable_item'",
      'row.sellable_item_name',
      'FROM sellable_item_professional_services',
      'impact.products > 0',
      "requireFeatureEnabled('financials.gym_charges')",
      'entityType="gym_charge"',
      "for (const junk of ['plan', 'sellable', 'MEMBERSHIP_PLAN'])",
    ]) {
      expect(says(kept), `false positive on ${kept}`).toBe(false);
    }
  });

  it('keeps the retired route only as a redirect', () => {
    // The one path that still spells the old term is the legacy admin route,
    // kept so a bookmark written before the rename lands on
    // `financials/products`. Its body names the term nowhere.
    const legacy = join(
      REPO, 'apps', 'admin', 'src', 'app', '[locale]', 'financials', 'sellable-items', 'page.tsx',
    );
    const src = readFileSync(legacy, 'utf8');
    expect(src).toContain('permanentRedirect(`/${locale}/financials/products`)');
    expect(src).not.toMatch(/sellable/i);
    const retiredPaths = files
      .filter((f) => /sellable/i.test(relative(REPO, f)))
      .map((f) => relative(REPO, f));
    expect(retiredPaths).toEqual([relative(REPO, legacy)]);
  });
});
