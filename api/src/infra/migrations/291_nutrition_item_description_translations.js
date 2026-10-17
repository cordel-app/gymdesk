/**
 * #1720: Nutrition Library item descriptions in every supported language.
 *
 * `nutrition_library_items.description` stays the base (English) value and the
 * fallback; every other locale is one row of this junction, `(item_id, locale)`
 * — the shape CLAUDE.md pins for translated data and migrations 166 (names) and
 * 275 (exercise descriptions) already use. It is a sibling of
 * `nutrition_library_item_translations` rather than a column on it because that
 * table's `name` is NOT NULL and its replace-all write deletes blank locales.
 *
 * Nothing is backfilled: a translation is never invented by DDL.
 */
const TABLE = 'nutrition_library_item_description_translations';

exports.up = async (knex) => {
  if (await knex.schema.hasTable(TABLE)) return;
  const [rows] = await knex.raw(
    `SELECT CHARACTER_SET_NAME, COLLATION_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nutrition_library_items' AND COLUMN_NAME = 'description'`,
  );
  const col = rows[0];
  if (!col?.COLLATION_NAME) throw new Error('Cannot read nutrition_library_items.description collation');
  if (!/^[A-Za-z0-9_]+$/.test(col.COLLATION_NAME) || !/^[A-Za-z0-9_]+$/.test(col.CHARACTER_SET_NAME)) {
    throw new Error('Unexpected charset/collation on nutrition_library_items.description');
  }
  const cs = col.CHARACTER_SET_NAME;
  const co = col.COLLATION_NAME;
  const [idRows] = await knex.raw(
    `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nutrition_library_items' AND COLUMN_NAME = 'id'`,
  );
  const idType = idRows[0]?.COLUMN_TYPE;
  if (!idType || !/^[a-z]+(\(\d+\))?( unsigned)?$/i.test(idType)) throw new Error('Unexpected type of nutrition_library_items.id');
  await knex.raw(`
    CREATE TABLE ${TABLE} (
      item_id     ${idType} NOT NULL,
      locale      VARCHAR(10)  NOT NULL,
      description VARCHAR(1000) CHARACTER SET ${cs} COLLATE ${co} NOT NULL,
      created_at  DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
      modified_at DATETIME     NULL,
      PRIMARY KEY (item_id, locale),
      CONSTRAINT nlidt_item_fk FOREIGN KEY (item_id)
        REFERENCES nutrition_library_items(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=${cs} COLLATE=${co}
  `);
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists(TABLE);
};
