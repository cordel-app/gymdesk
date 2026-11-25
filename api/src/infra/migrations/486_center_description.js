/**
 * #3342: a Center has a description, translated into every supported language.
 *
 * `centers.description` is the base-locale text and the fallback; every other
 * locale is one row of `center_description_translations`, one per
 * `(center_id, locale)` — the junction shape CLAUDE.md pins for translated data
 * (migrations 210, 275). A row belongs to its Center (cascade on delete); the
 * Center carries the audit columns.
 *
 * Additive only: no row is backfilled (a translation is never invented by DDL),
 * so every existing Center reads with no description. Safe to re-run.
 */
const TABLE = 'center_description_translations';

exports.up = async (knex) => {
  const [rows] = await knex.raw(
    `SELECT CHARACTER_SET_NAME, COLLATION_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'centers' AND COLUMN_NAME = 'name'`,
  );
  const col = rows[0];
  if (!col?.COLLATION_NAME) throw new Error('Cannot read centers.name collation');
  if (!/^[A-Za-z0-9_]+$/.test(col.COLLATION_NAME) || !/^[A-Za-z0-9_]+$/.test(col.CHARACTER_SET_NAME)) {
    throw new Error('Unexpected charset/collation on centers.name');
  }
  const cs = col.CHARACTER_SET_NAME;
  const co = col.COLLATION_NAME;
  // The base text and its translations share centers.name's collation.
  if (!(await knex.schema.hasColumn('centers', 'description'))) {
    await knex.raw(`ALTER TABLE centers ADD COLUMN description TEXT CHARACTER SET ${cs} COLLATE ${co} NULL AFTER name`);
  }
  if (await knex.schema.hasTable(TABLE)) return;
  await knex.raw(`
    CREATE TABLE ${TABLE} (
      center_id   INT UNSIGNED NOT NULL,
      locale      VARCHAR(10)  NOT NULL,
      description TEXT         CHARACTER SET ${cs} COLLATE ${co} NOT NULL,
      created_at  DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
      PRIMARY KEY (center_id, locale),
      CONSTRAINT cdt_center_fk FOREIGN KEY (center_id)
        REFERENCES centers(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=${cs} COLLATE=${co}
  `);
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists(TABLE);
  if (await knex.schema.hasColumn('centers', 'description')) {
    await knex.raw('ALTER TABLE centers DROP COLUMN description');
  }
};
