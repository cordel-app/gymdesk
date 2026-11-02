/**
 * #2262: a Staff member's image. The 1080 x 1080 WebP master and its 256 x 256
 * thumbnail (the Professional Service / Product image pipeline), stored under
 * `<gym prefix>/staff/`. Nullable, no default, no backfill: a Staff member has no
 * image until one is uploaded. Re-entrant: each column is added only when absent.
 */
const TABLE = 'staff';
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
