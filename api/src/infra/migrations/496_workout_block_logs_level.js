/**
 * #3494 — a workout block may be marked Partially Done.
 *
 * `workout_block_logs.level` is `done` (Fully Done, the full contribution the
 * old Mark done recorded) or `partial` (Partially Done, half of it): the
 * vocabulary `nutrition_logs.level` (migration 495) and
 * `nutrition_requirement_logs.level` (migration 281) already use. Every
 * existing row was a full completion, so the column defaults to `done` and the
 * rows written before it read exactly as they did.
 */
exports.up = async (knex) => {
  if (await knex.schema.hasColumn('workout_block_logs', 'level')) return;
  await knex.raw(`ALTER TABLE workout_block_logs
    ADD COLUMN level VARCHAR(10) NOT NULL DEFAULT 'done' AFTER logged_date,
    ADD CONSTRAINT chk_workout_block_logs_level CHECK (level IN ('partial', 'done'))`);
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasColumn('workout_block_logs', 'level'))) return;
  await knex.raw(`ALTER TABLE workout_block_logs
    DROP CHECK chk_workout_block_logs_level,
    DROP COLUMN level`);
};
