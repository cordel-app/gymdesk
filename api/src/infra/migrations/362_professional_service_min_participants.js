/**
 * #2293: a Professional Service's Minimum Participants — the number of confirmed
 * bookings an activity delivered by it needs to take place. Nullable, no default,
 * no backfill: NULL (every existing service) means no minimum. Re-entrant.
 */
const TABLE = 'professional_services';
const COLUMN = 'min_participants';

const hasColumn = async (knex) => {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`, [TABLE, COLUMN]);
  return rows.length > 0;
};

exports.up = async (knex) => {
  if (!(await hasColumn(knex))) await knex.raw(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} INT UNSIGNED NULL`);
};

exports.down = async (knex) => {
  if (await hasColumn(knex)) await knex.raw(`ALTER TABLE ${TABLE} DROP COLUMN ${COLUMN}`);
};
