/**
 * #1957 stage 1 — an assigned Nutrition Plan carries an inclusive `end_date`.
 *
 * Written once, by the Complete action, with the day it was completed. NULL means
 * an ongoing assignment, which is what every existing row is: no backfill, because
 * a completed plan's real completion day is not recorded anywhere (`modified_at`
 * also moves on unrelated edits). No CHECK (ALGORITHM=COPY).
 */

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('member_nutrition_plans', 'end_date'))) {
    await knex.raw('ALTER TABLE member_nutrition_plans ADD COLUMN end_date DATE NULL');
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('member_nutrition_plans', 'end_date')) {
    await knex.raw('ALTER TABLE member_nutrition_plans DROP COLUMN end_date');
  }
};
