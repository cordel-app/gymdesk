/**
 * #2010 stage 1: a Professional Service's image. `professional_services` holds
 * both the platform's Base services (`gym_id IS NULL`) and a gym's own, so one
 * pair of columns serves both: the 1080 x 1080 WebP master and its 256 x 256
 * thumbnail (the Product image pipeline, #1715).
 *
 * Nullable, no default, no backfill: a service has no image until one is
 * uploaded. Re-entrant: each column is added only when absent.
 */
const TABLE = 'professional_services';
const COLUMNS = [
  ['image_url', 'VARCHAR(1024) NULL'],
  ['image_thumbnail_url', 'VARCHAR(1024) NULL'],
];

const hasColumn = async (knex, column) => {
  const [rows] = await knex.raw(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`, [TABLE, column]);
  return rows.length > 0;
};

exports.up = async (knex) => {
  for (const [column, definition] of COLUMNS) {
    if (!(await hasColumn(knex, column))) {
      await knex.raw(`ALTER TABLE ${TABLE} ADD COLUMN ${column} ${definition}`);
    }
  }
};

exports.down = async (knex) => {
  for (const [column] of [...COLUMNS].reverse()) {
    if (await hasColumn(knex, column)) await knex.raw(`ALTER TABLE ${TABLE} DROP COLUMN ${column}`);
  }
};
