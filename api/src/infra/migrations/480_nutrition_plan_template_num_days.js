/**
 * #3333 stage 1 — a Nutrition Plan Template states how many days it covers.
 *
 * `nutrition_plan_templates.num_days` is an integer 0..7 (the listing's
 * *Days* column, beside a template's own day rows). It is NOT NULL with a
 * default of 0, guarded by `chk_npt_num_days`, and backfilled from the
 * template's day rows, capped at 7 (a day row with weekday 7 means "All
 * Days", so a template may hold up to eight rows). Gym and Base templates
 * share the table, so both are covered. Re-runnable: every clause is guarded.
 */
const hasCheck = (knex) =>
  knex.raw(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nutrition_plan_templates' AND CONSTRAINT_NAME = 'chk_npt_num_days'`,
  ).then(([rows]) => Number(rows[0].cnt) > 0);

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('nutrition_plan_templates', 'num_days'))) {
    await knex.raw(
      'ALTER TABLE nutrition_plan_templates ADD COLUMN num_days TINYINT UNSIGNED NOT NULL DEFAULT 0',
    );
    await knex.raw(
      `UPDATE nutrition_plan_templates npt
          SET npt.num_days = LEAST(7, (SELECT COUNT(*) FROM nutrition_plan_template_days d
                                        WHERE d.nutrition_plan_template_id = npt.id))`,
    );
  }
  if (!(await hasCheck(knex))) {
    await knex.raw(
      'ALTER TABLE nutrition_plan_templates ADD CONSTRAINT chk_npt_num_days CHECK (num_days BETWEEN 0 AND 7)',
    );
  }
};

exports.down = async (knex) => {
  if (await hasCheck(knex)) {
    await knex.raw('ALTER TABLE nutrition_plan_templates DROP CHECK chk_npt_num_days');
  }
  if (await knex.schema.hasColumn('nutrition_plan_templates', 'num_days')) {
    await knex.raw('ALTER TABLE nutrition_plan_templates DROP COLUMN num_days');
  }
};
