/**
 * #3328 stage 2 — the nutrition plans' meals reference a Base Meal.
 *
 * `nutrition_plan_template_meals` (gym and Base templates) and
 * `member_nutrition_plan_meals` (assigned plans) gain `base_meal_id`, an FK to
 * `base_meals` (migration 478) with `ON DELETE RESTRICT`: a Base Meal is soft
 * deleted, and Cordel's delete route refuses one that is referenced, so the
 * RESTRICT only backstops a hand-written hard delete.
 *
 * ── Backfill ────────────────────────────────────────────────────────────────
 * Migration 478 seeded the Base Meals with today's fixed `meal_type` values as
 * their slugs, so every typed meal is matched by slug. A meal with no
 * `meal_type` (a pre-#1785 legacy row) keeps `base_meal_id` NULL and still reads
 * through its `display_name`, exactly as before. Re-runnable: only NULL
 * references are filled.
 *
 * ── meal_type ───────────────────────────────────────────────────────────────
 * The column stays as a copy of the meal's slug (readers written before this
 * stage, the Members App included, still read it), but it is no longer a closed
 * list: a meal Cordel adds has a slug of its own. So the two CHECKs of
 * migration 143 are dropped and the column is widened to the slug's width
 * (ENTITY_SLUG_MAX = 120); the reference, not the CHECK, now says which meals
 * exist.
 */
const TABLES = [
  { table: 'nutrition_plan_template_meals', check: 'chk_nptm_meal_type', fk: 'nptm_base_meal_fk', idx: 'nptm_base_meal_idx' },
  { table: 'member_nutrition_plan_meals', check: 'chk_mnpm_meal_type', fk: 'mnpm_base_meal_fk', idx: 'mnpm_base_meal_idx' },
];

const constraintExists = (knex, table, name) =>
  knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
    [table, name],
  ).then(([rows]) => Number(rows[0].cnt) > 0);

exports.up = async (knex) => {
  for (const { table, check, fk, idx } of TABLES) {
    if (await constraintExists(knex, table, check)) {
      await knex.raw(`ALTER TABLE ${table} DROP CHECK ${check}`);
    }
    await knex.raw(`ALTER TABLE ${table} MODIFY COLUMN meal_type VARCHAR(120) NULL`);
    if (!(await knex.schema.hasColumn(table, 'base_meal_id'))) {
      await knex.raw(`ALTER TABLE ${table} ADD COLUMN base_meal_id INT UNSIGNED NULL AFTER meal_type`);
    }
    if (!(await constraintExists(knex, table, fk))) {
      await knex.raw(`ALTER TABLE ${table}
        ADD KEY ${idx} (base_meal_id),
        ADD CONSTRAINT ${fk} FOREIGN KEY (base_meal_id) REFERENCES base_meals(id) ON DELETE RESTRICT`);
    }
    await knex.raw(`
      UPDATE ${table} t
        JOIN base_meals bm ON bm.slug = t.meal_type
         SET t.base_meal_id = bm.id
       WHERE t.base_meal_id IS NULL`);
  }
};

// One-way: restoring the closed CHECK would refuse every meal Cordel added
// since. Dropping the reference loses nothing `meal_type` does not also hold,
// so a manual rollback is `DROP FOREIGN KEY` + `DROP COLUMN` if ever needed.
exports.down = async () => {};
