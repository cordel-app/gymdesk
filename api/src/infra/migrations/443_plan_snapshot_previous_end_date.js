/**
 * #3007 stage 2(b) — a plan marked `to_be_canceled` keeps running; `previous_end_date` records the
 * snapshot's `ends_at` at the moment it was marked, so discarding the Draft that carries the mark
 * restores the plan exactly (no new snapshot). Nullable DATE, no default, no backfill: NULL on every
 * existing row and on every plan that is not pending cancellation. Adding a nullable column is an
 * online change (ALGORITHM=INSTANT where available).
 */
exports.up = async (knex) => {
  const [[col]] = await knex.raw(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'plan_snapshots' AND COLUMN_NAME = 'previous_end_date'`);
  if (Number(col.n) === 0) await knex.raw('ALTER TABLE plan_snapshots ADD COLUMN previous_end_date DATE NULL');
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE plan_snapshots DROP COLUMN previous_end_date');
};
