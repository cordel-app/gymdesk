/**
 * #967: multilingual exercise names.
 *
 * `exercises.name` is a single free-text string (English) and it is the only
 * human-readable field a member sees in a workout. This adds per-locale names
 * for the same underlying exercise — no second exercise per language — using
 * the junction shape `CLAUDE.md` pins for translated *data* and migration 166
 * already built for `nutrition_library_items`: one row per
 * `(exercise_id, locale)`, `PRIMARY KEY` on the pair, FK `ON DELETE CASCADE`,
 * plus `KEY (locale, name)` kept for symmetry with 166 — every query this ticket
 * adds is served by the PRIMARY KEY, the cross-language search included (it
 * correlates on `exercise_id` and carries no `locale` predicate), so the index is
 * there for a future per-locale lookup rather than for one that exists today.
 * Adding a fourth locale is data rather than DDL, and every existing id, FK and
 * relationship is untouched.
 *
 * `exercises.name` stays the base (English) value: it is what a locale with no
 * row falls back to at read time (so nothing ever renders blank), what the
 * routers' own duplicate check compares, and what an edit form submits back.
 * Uniqueness therefore stays on the base name alone — as it does for
 * `nutrition_library_items` (166) — and two exercises of one gym may carry the
 * same Spanish name while their base names differ. Deliberate: a live-name unique
 * index here (183's `live_name_key` device) would make a gym's second translation
 * fail a save for a reason no screen could explain.
 * The table serves **both** kinds of exercise — a Base Exercise (`gym_id IS
 * NULL`) and a gym's own — because they are one table and #967 §8 asks for one
 * contract; the FK is to `exercises(id)` and carries no `gym_id` of its own, so
 * a translation cannot outlive the exercise it names and tenant scoping stays
 * exactly where it already is (on `exercises`).
 *
 * **Nothing is seeded, and nothing is backfilled.** There is no base-exercise
 * seed in this repository to translate — the catalogue is written by
 * `/platform/exercises` — and an existing exercise — base or custom — keeps its
 * current name as the base value with no rows here. That is exactly what #967 §9
 * asks for: an exercise with one name keeps it, and a translation is never
 * invented on its behalf. A locale with no row simply renders the base name
 * until someone types one in the editor.
 */

/**
 * 207 is deliberately skipped: #964's Free Exercise DB import is in flight on its
 * own branch and already holds `207_exercise_source_provenance.js`, so taking 207
 * here would land two migrations under one number. Numbering stays sequential
 * once that branch merges.
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
    CREATE TABLE IF NOT EXISTS ${TABLE} (
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
