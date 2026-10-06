/**
 * #932 — a Nutrition Goal may be **illustrated by** a Nutrition Library food.
 *
 * The ticket asks My Nutrition to show a picture beside each goal "using the
 * existing food/item image associated with the corresponding nutrition item".
 * A goal has no such item: `member_nutrition_plan_goals.item_name` is a slug
 * from the plan routers' closed `NUTRITION_GOALS` vocabulary (`protein`,
 * `water`, `weight_loss`, …), not a food, and only one of the thirteen
 * (`water`) has a same-named row in the library. The ticket's Q1 on the thread
 * was never answered, so this is the recommended shape, recorded here: the
 * staff member who configures a goal may **pick a food to illustrate it**, and
 * that food's own `image_url` is what the member sees — the one image source
 * My Nutrition already has (§3: no second image source, mapping or bundled
 * placeholder).
 *
 * The column is nullable on both goal tables — the template's and the
 * member plan's, because a plan created from a template copies its goals —
 * with `ON DELETE SET NULL`: a food soft-deletes through `status = 'deleted'`
 * and is never hard-deleted by the application, so the SET NULL is for the
 * platform operator's SQL only, and a goal whose illustration goes loses the
 * picture rather than the goal. No backfill: every existing goal keeps the
 * standard fallback it showed before, and nothing guesses a food from a slug.
 *
 * Added with knex's builder — the two generated FK names are 50 and 59
 * characters, under MySQL's 64 — but named explicitly all the same so the
 * three nutrition FKs on each table read as one family (`nptg_*`, `mnpg_*`).
 */

const COLUMN = 'nutrition_library_item_id';
const TABLES = [
  ['nutrition_plan_template_goals', 'nptg'],
  ['member_nutrition_plan_goals', 'mnpg'],
];

exports.up = async (knex) => {
  for (const [table, prefix] of TABLES) {
    if (await knex.schema.hasColumn(table, COLUMN)) continue;
    await knex.schema.alterTable(table, (t) => {
      t.integer(COLUMN).unsigned().nullable();
      t.foreign(COLUMN, `${prefix}_lib_fk`).references('id').inTable('nutrition_library_items').onDelete('SET NULL');
      t.index([COLUMN], `${prefix}_lib_idx`);
    });
  }
};

exports.down = async (knex) => {
  for (const [table, prefix] of TABLES) {
    if (!(await knex.schema.hasColumn(table, COLUMN))) continue;
    await knex.schema.alterTable(table, (t) => {
      t.dropForeign([COLUMN], `${prefix}_lib_fk`);
      t.dropIndex([COLUMN], `${prefix}_lib_idx`);
      t.dropColumn(COLUMN);
    });
  }
};
