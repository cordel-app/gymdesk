/**
 * #350: Nutrition Library data quality review.
 *
 * The seeded system nutrition_library_items (migration 078) were never tagged
 * with nutritional_qualities (migration 110 only seeded the `protein` and
 * `carbohydrate` quality catalogue rows, not any item assignments). This
 * backfills the unambiguous, well-known cases for the seeded system items
 * (gym_id IS NULL) only — gym-owned items keep whatever tags each gym chose.
 *
 * Conservative on purpose: only items that are unambiguously a primary
 * protein or carbohydrate source are tagged. Items with no clear match
 * (sauces, drinks, salad, vegetables) are left untagged rather than guessed.
 */

const PROTEIN_ITEMS = ['Chicken', 'Beef', 'Turkey', 'Salmon', 'Tuna', 'Eggs', 'Tofu', 'Yogurt', 'Nuts'];
const CARB_ITEMS = ['Rice', 'Brown Rice', 'Potatoes', 'Sweet Potatoes', 'Pasta', 'Quinoa', 'Oats', 'Bread', 'Fruit', 'Honey', 'Sugar'];

async function tag(knex, names, slug) {
  if (names.length === 0) return;
  const marks = names.map(() => '?').join(',');
  await knex.raw(
    `INSERT IGNORE INTO nutrition_library_item_qualities (item_id, quality_id)
     SELECT nli.id, nq.id
     FROM nutrition_library_items nli
     JOIN nutritional_qualities nq ON nq.slug = ?
     WHERE nli.gym_id IS NULL AND nli.status = 'active' AND nli.name IN (${marks})`,
    [slug, ...names],
  );
}

async function untag(knex, names, slug) {
  if (names.length === 0) return;
  const marks = names.map(() => '?').join(',');
  await knex.raw(
    `DELETE nliq FROM nutrition_library_item_qualities nliq
     JOIN nutrition_library_items nli ON nli.id = nliq.item_id
     JOIN nutritional_qualities nq ON nq.id = nliq.quality_id
     WHERE nq.slug = ? AND nli.gym_id IS NULL AND nli.name IN (${marks})`,
    [slug, ...names],
  );
}

exports.up = async (knex) => {
  await tag(knex, PROTEIN_ITEMS, 'protein');
  await tag(knex, CARB_ITEMS, 'carbohydrate');
};

exports.down = async (knex) => {
  await untag(knex, PROTEIN_ITEMS, 'protein');
  await untag(knex, CARB_ITEMS, 'carbohydrate');
};
