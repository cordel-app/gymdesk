/**
 * #967: multilingual exercise names.
 *
 * `exercises.name` is a single free-text string (English) and it is the only
 * human-readable field a member sees in a workout. This adds per-locale names
 * for the same underlying exercise — no second exercise per language — using
 * the junction shape `CLAUDE.md` pins for translated *data* and migration 166
 * already built for `nutrition_library_items`: one row per
 * `(exercise_id, locale)`, `PRIMARY KEY` on the pair, FK `ON DELETE CASCADE`,
 * plus `KEY (locale, name)` for the search subquery. Adding a fourth locale is
 * then data rather than DDL, and every existing id, FK and relationship is
 * untouched.
 *
 * `exercises.name` stays the base (English) value: it is what a locale with no
 * row falls back to at read time (so nothing ever renders blank), what the
 * routers' own duplicate check compares, and what an edit form submits back.
 * The table serves **both** kinds of exercise — a Base Exercise (`gym_id IS
 * NULL`) and a gym's own — because they are one table and #967 §8 asks for one
 * contract; the FK is to `exercises(id)` and carries no `gym_id` of its own, so
 * a translation cannot outlive the exercise it names and tenant scoping stays
 * exactly where it already is (on `exercises`).
 *
 * **Nothing is seeded, and nothing is backfilled.** There is no base-exercise
 * seed in this repository to translate (the catalogue is written by
 * `/platform/exercises` and, since #964, by the Free Exercise DB importer, whose
 * source is English-only), and an existing exercise — base or custom — keeps its
 * current name as the base value with no rows here. That is exactly what #967 §9
 * asks for: an exercise with one name keeps it, and a translation is never
 * invented on its behalf. A locale with no row simply renders the base name
 * until someone types one in the editor.
 */

const TABLE = 'exercise_translations';

/**
 * `exercises` was created by knex (migration 023) without an explicit charset,
 * so its `name` inherits the schema default. This table's `name` is `COALESCE`d
 * with it on every read (`localizedExerciseNameSql`), and MySQL raises
 * ER_CANT_AGGREGATE_2COLLATIONS when the two sides differ — which would break
 * every exercise read across six routers at runtime rather than here. So take
 * the charset and collation from the column we fall back to, exactly as
 * migration 166 does, instead of assuming one.
 */
async function baseNameCollation(knex) {
  const [rows] = await knex.raw(
    `SELECT CHARACTER_SET_NAME, COLLATION_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exercises'
       AND COLUMN_NAME = 'name'`,
  );
  const col = rows[0];
  if (!col?.COLLATION_NAME) {
    throw new Error('Cannot read exercises.name collation — is migration 023 applied?');
  }
  // Identifiers, not values: reject anything that isn't a plain MySQL name
  // before it reaches the DDL below.
  if (!/^[A-Za-z0-9_]+$/.test(col.COLLATION_NAME) || !/^[A-Za-z0-9_]+$/.test(col.CHARACTER_SET_NAME)) {
    throw new Error(`Unexpected charset/collation on exercises.name: ${col.CHARACTER_SET_NAME}/${col.COLLATION_NAME}`);
  }
  return col;
}

exports.up = async (knex) => {
  if (await knex.schema.hasTable(TABLE)) return;
  const { CHARACTER_SET_NAME: charset, COLLATION_NAME: collation } = await baseNameCollation(knex);
  // VARCHAR(200) mirrors `exercises.name`: a translation that would not fit the
  // column it falls back to is refused by the router (400), never truncated.
  await knex.raw(`
    CREATE TABLE ${TABLE} (
      exercise_id INT UNSIGNED NOT NULL,
      locale      VARCHAR(10)  NOT NULL,
      name        VARCHAR(200) CHARACTER SET ${charset} COLLATE ${collation} NOT NULL,
      created_at  DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
      modified_at DATETIME     NULL,
      PRIMARY KEY (exercise_id, locale),
      KEY ext_locale_name (locale, name),
      CONSTRAINT ext_exercise_fk FOREIGN KEY (exercise_id)
        REFERENCES exercises(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=${charset} COLLATE=${collation}
  `);
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists(TABLE);
};
