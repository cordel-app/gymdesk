/**
 * #1991 stage 4b: when a ProductSet version entered Pending Payment. The
 * checkout expires two hours after Save & Pay and returns to Draft, and
 * `last_activity_at` (the last Draft edit) cannot say when that started.
 *
 * Nullable, no default: only `pending_payment` rows carry it, set by
 * `submitForPayment()` and cleared when the version returns to Draft. Rows
 * already pending get a fresh two hours rather than expiring on the first run.
 * Re-entrant: the column is added only when absent.
 */
const TABLE = 'product_sets';
const COLUMN = 'pending_at';

const hasColumn = async (knex) => {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`, [TABLE, COLUMN]);
  return rows.length > 0;
};

exports.up = async (knex) => {
  if (!(await hasColumn(knex))) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} DATETIME NULL AFTER last_activity_at`);
  }
  await knex.raw(`UPDATE ${TABLE} SET ${COLUMN} = UTC_TIMESTAMP() WHERE status = 'pending_payment' AND ${COLUMN} IS NULL`);
};

exports.down = async (knex) => {
  if (await hasColumn(knex)) await knex.raw(`ALTER TABLE ${TABLE} DROP COLUMN ${COLUMN}`);
};
