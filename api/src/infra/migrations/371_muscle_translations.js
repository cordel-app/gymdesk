/**
 * #2402 — a muscle's name in every supported language.
 *
 * `muscle_translations` is `exercise_translations`' shape one catalogue over:
 * one row per `(muscle_id, locale)`, with `muscles.name` staying the base
 * (English) value and the fallback. No backfill: a muscle with no row reads
 * its base name. Re-entrant.
 */
const TABLE = 'muscle_translations';

exports.up = async (knex) => {
  if (await knex.schema.hasTable(TABLE)) return;
  await knex.raw(`
    CREATE TABLE ${TABLE} (
      muscle_id   INT UNSIGNED NOT NULL,
      locale      VARCHAR(10)  NOT NULL,
      name        VARCHAR(120) NOT NULL,
      created_at  DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
      modified_at DATETIME     NULL,
      PRIMARY KEY (muscle_id, locale),
      KEY mt_locale_name (locale, name),
      CONSTRAINT mt_muscle_fk FOREIGN KEY (muscle_id)
        REFERENCES muscles(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
};

exports.down = async (knex) => {
  await knex.raw(`DROP TABLE IF EXISTS ${TABLE}`);
};
