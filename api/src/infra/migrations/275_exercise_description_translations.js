/**
 * #1419: exercise descriptions in every supported language.
 *
 * `exercises.description` stays the base (English) full description and gains a
 * sibling `short_description`, the one-line summary a list row shows. The other
 * locales live in `exercise_description_translations`, one row per
 * `(exercise_id, locale)` — the junction shape CLAUDE.md pins for translated
 * data and migration 210 built for names.
 *
 * It is a sibling of `exercise_translations` rather than two more columns on it
 * because that table's `name` is NOT NULL and its replace-all write deletes any
 * locale whose name is blank: a description-only row would be refused, and a
 * name edit would silently wipe the descriptions. Two junctions, one
 * convention; each is replaced independently by its own payload field.
 *
 * Nothing is backfilled here (a translation is never invented by DDL): the
 * operator script `npm run exercises:backfill-descriptions` loads reviewed text.
 */
const TABLE = 'exercise_description_translations';

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('exercises', 'short_description'))) {
    await knex.raw('ALTER TABLE exercises ADD COLUMN short_description VARCHAR(300) NULL AFTER description');
  }
  if (await knex.schema.hasTable(TABLE)) return;
  const [rows] = await knex.raw(
    `SELECT CHARACTER_SET_NAME, COLLATION_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exercises' AND COLUMN_NAME = 'name'`,
  );
  const col = rows[0];
  if (!col?.COLLATION_NAME) throw new Error('Cannot read exercises.name collation');
  if (!/^[A-Za-z0-9_]+$/.test(col.COLLATION_NAME) || !/^[A-Za-z0-9_]+$/.test(col.CHARACTER_SET_NAME)) {
    throw new Error('Unexpected charset/collation on exercises.name');
  }
  const cs = col.CHARACTER_SET_NAME;
  const co = col.COLLATION_NAME;
  await knex.raw(`
    CREATE TABLE ${TABLE} (
      exercise_id       INT UNSIGNED NOT NULL,
      locale            VARCHAR(10)  NOT NULL,
      short_description VARCHAR(300) CHARACTER SET ${cs} COLLATE ${co} NULL,
      description       TEXT         CHARACTER SET ${cs} COLLATE ${co} NULL,
      created_at        DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
      modified_at       DATETIME     NULL,
      PRIMARY KEY (exercise_id, locale),
      CONSTRAINT exdt_exercise_fk FOREIGN KEY (exercise_id)
        REFERENCES exercises(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=${cs} COLLATE=${co}
  `);
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists(TABLE);
  if (await knex.schema.hasColumn('exercises', 'short_description')) {
    await knex.raw('ALTER TABLE exercises DROP COLUMN short_description');
  }
};
