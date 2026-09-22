/**
 * #644: Nutrition Library — review and classify nutritional qualities.
 *
 * The four quality slugs (`protein`, `carbohydrate`, `fat`, `fiber`) already
 * exist — `protein`/`carbohydrate` from migration 110, `fat`/`fiber` from
 * migration 142 — but only the first two were ever assigned to items, by
 * migration 127 (#350), which deliberately tagged just the unambiguous primary
 * protein and carbohydrate sources and left everything else untouched. That
 * left `fat` and `fiber` at zero assignments across the whole library, which is
 * what this ticket asks to fix.
 *
 * `nutrition_library_items` stores no macro values (the columns are
 * `id, gym_id, name, status, image_url, created_at, modified_at`), so there is
 * no stored number to threshold against. The classification is therefore made
 * by food, from general nutritional composition, and seeded here — same
 * approach as 127, and the reason it lives in a migration: the per-item
 * decisions are reviewable in this diff and versioned with the schema.
 *
 * ── Criterion ────────────────────────────────────────────────────────────────
 *
 * A quality is marked when the food is a *recognised dietary source* of that
 * nutrient — it supplies a substantial share of the nutrient in the meal it
 * appears in, not a trace. Indicative guide, per 100 g of the food as normally
 * served (cooked where applicable):
 *
 *   protein       >= 10 g
 *   carbohydrate  >= 10 g
 *   fat           >=  8 g
 *   fiber         >=  2 g
 *
 * For fiber the numbers sit close together across staples, so the rule is made
 * explicit rather than left to rounding: whole-plant and wholegrain foods
 * (brown rice, oats, quinoa, vegetables, salad, fruit, nuts) are marked;
 * refined-grain staples (white rice, pasta, bread) are not. A nutrient present
 * only in trace amounts — a spoonful of sauce, a leafy garnish, a hot drink —
 * is never marked, which is why seven items below stay deliberately untagged.
 *
 * ── Scope ────────────────────────────────────────────────────────────────────
 *
 * Matching is by item name and covers gym-created items as well as the system
 * ones (`gym_id IS NULL`), so a gym that added its own "Salmon" gets the same
 * classification — the ticket thread asked for "all" items when the two scopes
 * were put as a question. Three things make that safe to do from a migration:
 *
 * 1. It is **additive only** (`INSERT IGNORE`): no existing assignment is ever
 *    deleted, so a gym that curated its own tags keeps every one of them and can
 *    remove an added tag from the admin UI like any other. Re-reviewing the 20
 *    links 127 created against the criterion above found none that contradict
 *    it, so nothing needs removing anyway.
 * 2. It is a **one-time review**, not a standing rule — a gym item created after
 *    this migration runs is never touched by it.
 * 3. A gym item whose name is not in the table is left alone: there is nothing
 *    to classify it from but its name.
 *
 * `nutrition_library_items.name` collates `utf8mb4_0900_ai_ci`, so the match is
 * case- and accent-insensitive: a gym's "salmon" or "Salmón" row is classified
 * as "Salmon" too. That is the intent (same food, different spelling), but it is
 * worth knowing before reading the affected-row count.
 *
 * ── Reversal ─────────────────────────────────────────────────────────────────
 *
 * `down()` is deliberately **narrower than `up()`**: it only removes what this
 * migration added to *system* items. Because `up()` is `INSERT IGNORE` it keeps
 * no record of which links it actually created, so a name-and-slug delete cannot
 * tell its own row from one somebody set by hand. Leaving an extra tag on a gym
 * item is recoverable from the UI; deleting a gym's curated tag is not, so the
 * asymmetry errs in the recoverable direction. On system items the only actor
 * who could have set a tag by hand is the same superadmin who owns this
 * classification, which makes the residual acceptable there.
 */

const PROTEIN = 'protein';
const CARBOHYDRATE = 'carbohydrate';
const FAT = 'fat';
const FIBER = 'fiber';

const QUALITY_SLUGS = [PROTEIN, CARBOHYDRATE, FAT, FIBER];

/**
 * Every one of the 32 system items seeded by migration 078, reviewed against
 * the criterion above. `qualities: []` records a reviewed item that qualifies
 * for nothing — kept in the table so the review is complete on its face rather
 * than by omission.
 *
 * Values in the notes are per 100 g as normally served.
 */
const CLASSIFICATION = [
  // ── Main dishes ───────────────────────────────────────────────────────────
  { name: 'Chicken',        qualities: [PROTEIN],               note: '~31 g protein, ~4 g fat (breast) — lean' },
  { name: 'Beef',           qualities: [PROTEIN, FAT],          note: '~26 g protein, ~15 g fat' },
  { name: 'Turkey',         qualities: [PROTEIN],               note: '~29 g protein, ~3 g fat — lean' },
  { name: 'Salmon',         qualities: [PROTEIN, FAT],          note: '~25 g protein, ~13 g fat — oily fish' },
  { name: 'Tuna',           qualities: [PROTEIN],               note: '~25 g protein, ~1-5 g fat — lean' },
  { name: 'Eggs',           qualities: [PROTEIN, FAT],          note: '~13 g protein, ~11 g fat' },
  { name: 'Tofu',           qualities: [PROTEIN, FAT],          note: '~16 g protein, ~9 g fat (firm)' },

  // ── Sides ─────────────────────────────────────────────────────────────────
  { name: 'Rice',           qualities: [CARBOHYDRATE],          note: '~28 g carbohydrate; refined, ~0.4 g fiber' },
  { name: 'Brown Rice',     qualities: [CARBOHYDRATE, FIBER],   note: '~23 g carbohydrate; wholegrain, ~4x the fiber of white rice' },
  { name: 'Vegetables',     qualities: [FIBER],                 note: '~2-5 g fiber; little protein, carbohydrate or fat' },
  { name: 'Salad',          qualities: [FIBER],                 note: 'group item: leaves alone are ~1.2 g fiber, a mixed raw-vegetable salad ~2 g — judgement call, marked' },
  { name: 'Potatoes',       qualities: [CARBOHYDRATE],          note: '~17 g carbohydrate; ~1.8 g fiber, below the bar' },
  { name: 'Sweet Potatoes', qualities: [CARBOHYDRATE, FIBER],   note: '~20 g carbohydrate, ~3 g fiber' },
  { name: 'Pasta',          qualities: [CARBOHYDRATE],          note: '~25 g carbohydrate; refined grain' },
  { name: 'Quinoa',         qualities: [CARBOHYDRATE, FIBER],   note: '~21 g carbohydrate, ~2.8 g fiber — wholegrain' },

  // ── Sauces ────────────────────────────────────────────────────────────────
  { name: 'Tomato Sauce',   qualities: [],                      note: 'served in spoonfuls — trace amounts only' },
  { name: 'Yogurt Sauce',   qualities: [],                      note: 'served in spoonfuls — trace amounts only' },
  { name: 'Olive Oil',      qualities: [FAT],                   note: '100 g fat — pure dietary fat' },
  { name: 'Mustard',        qualities: [],                      note: 'condiment — trace amounts only' },
  { name: 'Hot Sauce',      qualities: [],                      note: 'condiment — trace amounts only' },

  // ── Drinks ────────────────────────────────────────────────────────────────
  { name: 'Water',          qualities: [],                      note: 'no macronutrients' },
  { name: 'Coffee',         qualities: [],                      note: 'no macronutrients when unsweetened' },
  { name: 'Tea',            qualities: [],                      note: 'no macronutrients when unsweetened' },
  { name: 'Juice',          qualities: [CARBOHYDRATE],          note: '~10-12 g sugars per 100 ml — the one drink that clears a bar' },

  // ── Desserts ──────────────────────────────────────────────────────────────
  { name: 'Fruit',          qualities: [CARBOHYDRATE, FIBER],   note: '~10-15 g carbohydrate, ~2-3 g fiber' },
  { name: 'Yogurt',         qualities: [PROTEIN],               note: '~10 g protein (strained/Greek-style); ~3 g fat, below the bar' },
  { name: 'Oats',           qualities: [CARBOHYDRATE, FIBER],   note: '~12 g carbohydrate cooked; ~1.7 g fiber cooked — marked by the wholegrain rule (~10 g dry)' },
  { name: 'Honey',          qualities: [CARBOHYDRATE],          note: '~82 g sugars' },

  // ── Other ─────────────────────────────────────────────────────────────────
  { name: 'Bread',          qualities: [CARBOHYDRATE],          note: '~49 g carbohydrate; refined grain unless wholemeal' },
  { name: 'Nuts',           qualities: [PROTEIN, FAT, FIBER],   note: '~20 g protein, ~50 g fat, ~8 g fiber' },
  { name: 'Dairy',          qualities: [PROTEIN, FAT],          note: 'group item (milk/cheese/curd): cheese carries it at ~25 g protein, ~33 g fat; milk alone is below both bars' },
  { name: 'Sugar',          qualities: [CARBOHYDRATE],          note: '100 g sugars' },
];

/**
 * The (name, quality) pairs migration 127 already created, on system items
 * only. `up()` re-inserts them harmlessly (INSERT IGNORE), but `down()` must
 * leave them behind rather than undoing 127's work as well.
 */
const TAGGED_BY_127 = new Set([
  ...['Chicken', 'Beef', 'Turkey', 'Salmon', 'Tuna', 'Eggs', 'Tofu', 'Yogurt', 'Nuts']
    .map((name) => `${name}|${PROTEIN}`),
  ...['Rice', 'Brown Rice', 'Potatoes', 'Sweet Potatoes', 'Pasta', 'Quinoa', 'Oats', 'Bread', 'Fruit', 'Honey', 'Sugar']
    .map((name) => `${name}|${CARBOHYDRATE}`),
]);

/** name → [slug, ...] for the items that qualify for at least one quality. */
function namesBySlug() {
  const bySlug = new Map();
  for (const { name, qualities } of CLASSIFICATION) {
    for (const slug of qualities) {
      if (!bySlug.has(slug)) bySlug.set(slug, []);
      bySlug.get(slug).push(name);
    }
  }
  return bySlug;
}

exports.up = async (knex) => {
  // Each INSERT below joins the catalogue on `slug`; a missing row would make it
  // a silent no-op rather than an error. `fat`/`fiber` are seeded by migration
  // 142 and `protein`/`carbohydrate` by 110, so this should never fire — but
  // fail loudly if it does instead of reporting a review that tagged nothing.
  const [present] = await knex.raw(
    `SELECT slug FROM nutritional_qualities WHERE slug IN (${QUALITY_SLUGS.map(() => '?').join(',')})`,
    QUALITY_SLUGS,
  );
  const missing = QUALITY_SLUGS.filter((slug) => !present.some((row) => row.slug === slug));
  if (missing.length > 0) {
    throw new Error(`nutritional_qualities is missing catalogue row(s): ${missing.join(', ')}`);
  }

  for (const [slug, names] of namesBySlug()) {
    const marks = names.map(() => '?').join(',');
    // INSERT IGNORE: the (item_id, quality_id) primary key makes a re-run, and
    // any tag an admin already set by hand, a no-op rather than a duplicate-key
    // failure.
    await knex.raw(
      `INSERT IGNORE INTO nutrition_library_item_qualities (item_id, quality_id)
       SELECT nli.id, nq.id
       FROM nutrition_library_items nli
       JOIN nutritional_qualities nq ON nq.slug = ?
       WHERE nli.status = 'active' AND nli.name IN (${marks})`,
      [slug, ...names],
    );
  }

  // An item whose name is not in the table above keeps whatever tags it has:
  // a system item renamed by a superadmin (or added after this table was
  // written), and any gym food this classification has never heard of. Both are
  // intended — there is nothing to classify them from — but report them at the
  // same scope the INSERTs ran at, rather than letting the migration look like
  // it covered the whole library.
  const marks = CLASSIFICATION.map(() => '?').join(',');
  const [[counts]] = await knex.raw(
    `SELECT SUM(gym_id IS NULL) AS system_items, SUM(gym_id IS NOT NULL) AS gym_items
     FROM nutrition_library_items
     WHERE status = 'active' AND name NOT IN (${marks})`,
    CLASSIFICATION.map((row) => row.name),
  );
  if (Number(counts.system_items) > 0) {
    console.warn(
      `[167] ${counts.system_items} system nutrition library item(s) are not in the classification ` +
      'table — their nutritional qualities were left unchanged.',
    );
  }
  if (Number(counts.gym_items) > 0) {
    console.warn(
      `[167] ${counts.gym_items} gym-created item(s) have a name this classification does not cover — ` +
      'left unchanged, to be tagged by their gym from the Nutrition Library page.',
    );
  }
};

exports.down = async (knex) => {
  for (const [slug, names] of namesBySlug()) {
    // System items only, and only the pairs 127 does not own — see "Reversal"
    // in the header: gym-owned tags are left in place rather than risking the
    // deletion of one a gym set by hand, and 127's assignments stay so that
    // reverting this migration doesn't also revert #350.
    const removable = names.filter((name) => !TAGGED_BY_127.has(`${name}|${slug}`));
    if (removable.length === 0) continue;

    const marks = removable.map(() => '?').join(',');
    await knex.raw(
      `DELETE nliq FROM nutrition_library_item_qualities nliq
       JOIN nutrition_library_items nli ON nli.id = nliq.item_id
       JOIN nutritional_qualities nq ON nq.id = nliq.quality_id
       WHERE nq.slug = ? AND nli.gym_id IS NULL AND nli.name IN (${marks})`,
      [slug, ...removable],
    );
  }
};

// Exported for the unit test that guards the table's shape (no DB access).
exports.CLASSIFICATION = CLASSIFICATION;
exports.QUALITY_SLUGS = QUALITY_SLUGS;
