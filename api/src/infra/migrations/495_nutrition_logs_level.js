/**
 * #3489 — a meal may be marked Partially Done.
 *
 * `nutrition_logs.level` is `done` (Fully Done, the full per-meal contribution)
 * or `partial` (Partially Done, half of it), the vocabulary
 * `nutrition_requirement_logs.level` already uses (migration 281). Every
 * existing row was a full completion, so the column defaults to `done` and the
 * rows written before it read exactly as they did. As for a restriction, a
 * completion is only ever raised (partial -> done) and never taken back.
 */
exports.up = async (knex) => {
  if (await knex.schema.hasColumn('nutrition_logs', 'level')) return;
  await knex.raw(`ALTER TABLE nutrition_logs
    ADD COLUMN level VARCHAR(10) NOT NULL DEFAULT 'done' AFTER logged_date,
    ADD CONSTRAINT chk_nutrition_logs_level CHECK (level IN ('partial', 'done'))`);
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasColumn('nutrition_logs', 'level'))) return;
  await knex.raw(`ALTER TABLE nutrition_logs
    DROP CHECK chk_nutrition_logs_level,
    DROP COLUMN level`);
};
