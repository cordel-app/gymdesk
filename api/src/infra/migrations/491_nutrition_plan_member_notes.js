/**
 * #3474 — Member Notes on Nutrition Plans.
 *
 * `member_notes` is a free-text note written for the member, distinct from `description`
 * (the plan's own description). It lives on the template (a gym's own and a Base one,
 * `gym_id IS NULL`, are the same table) and on the assigned plan, where it is a copy taken
 * when the plan is created from a template, so a later template edit never reaches a plan
 * already assigned. Nullable, no default, no backfill: every existing plan has none.
 *
 * TEXT columns are added in place (ALGORITHM=INPLACE on MySQL 8).
 */
const TABLES = ['nutrition_plan_templates', 'member_nutrition_plans'];

exports.up = async (knex) => {
  for (const table of TABLES) {
    if (await knex.schema.hasColumn(table, 'member_notes')) continue;
    await knex.raw(`ALTER TABLE ${table} ADD COLUMN member_notes TEXT NULL AFTER description`);
  }
};

exports.down = async (knex) => {
  for (const table of TABLES) {
    if (!(await knex.schema.hasColumn(table, 'member_notes'))) continue;
    await knex.raw(`ALTER TABLE ${table} DROP COLUMN member_notes`);
  }
};
