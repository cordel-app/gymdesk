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
 * with `ON DELETE SET NULL`, the action 078 chose for `nptm_main_dish_fk` on
 * the same target: a gym delete cascades to its foods (105's `nli_gym_fk`) and
 * `cleanupTestGyms` hard-deletes them, so a goal whose illustration goes loses
 * the picture rather than the goal. No backfill: every existing goal keeps the
 * standard fallback it showed before, and nothing guesses a food from a slug.
 *
 * Three guarded statements per table rather than one `alterTable`: MySQL DDL
 * is non-transactional, so a metadata-lock timeout on the FK would leave the
 * column in place and a column-only guard would skip the FK and the index for
 * good. The index is declared **before** the FK so the FK is backed by it
 * instead of auto-creating a second, identical one. Knex's generated names
 * would be 63 and 61 characters — one under MySQL's 64 — which is the reason
 * to name them (`nptg_*`, `mnpg_*`, the families each table already has).
 */

const COLUMN = 'nutrition_library_item_id';
const TABLES = [
  ['nutrition_plan_template_goals', 'nptg'],
  ['member_nutrition_plan_goals', 'mnpg'],
];

async function fkExists(knex, table, name) {
  const [[row]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?
        AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
    [table, name],
  );
  return Number(row.cnt) > 0;
}

async function indexExists(knex, table, name) {
  const [[row]] = await knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, name],
  );
  return Number(row.cnt) > 0;
}

exports.up = async (knex) => {
  for (const [table, prefix] of TABLES) {
    const fk = `${prefix}_lib_fk`;
    const idx = `${prefix}_lib_idx`;
    if (!(await knex.schema.hasColumn(table, COLUMN))) {
      await knex.raw(`ALTER TABLE ${table} ADD COLUMN ${COLUMN} INT UNSIGNED NULL`);
    }
    if (!(await indexExists(knex, table, idx))) {
      await knex.raw(`ALTER TABLE ${table} ADD INDEX ${idx} (${COLUMN})`);
    }
    if (!(await fkExists(knex, table, fk))) {
      await knex.raw(
        `ALTER TABLE ${table} ADD CONSTRAINT ${fk} FOREIGN KEY (${COLUMN})
           REFERENCES nutrition_library_items(id) ON DELETE SET NULL`,
      );
    }
  }
};

exports.down = async (knex) => {
  for (const [table, prefix] of TABLES) {
    const fk = `${prefix}_lib_fk`;
    const idx = `${prefix}_lib_idx`;
    // The FK before the index that backs it (ER_DROP_INDEX_FK otherwise).
    if (await fkExists(knex, table, fk)) await knex.raw(`ALTER TABLE ${table} DROP FOREIGN KEY ${fk}`);
    if (await indexExists(knex, table, idx)) await knex.raw(`ALTER TABLE ${table} DROP INDEX ${idx}`);
    if (await knex.schema.hasColumn(table, COLUMN)) await knex.raw(`ALTER TABLE ${table} DROP COLUMN ${COLUMN}`);
  }
};
