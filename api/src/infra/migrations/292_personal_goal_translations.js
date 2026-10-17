/**
 * #1719 — a Personal Goal's name and description in every supported language.
 *
 * `personal_goal_translations` is migration 282's `nutrition_goal_translations`
 * one catalogue over: one row per `(personal_goal_id, locale)` carrying the
 * translated `name` and `description`, with `personal_goals.name` /
 * `description` staying the base-locale value and the fallback. A blank
 * description is NULL and falls back to the base one at read time.
 *
 * **Backfill.** Only the seven System goals, and only their names (es, ca): the
 * Admin has always shown them through the `goal_library.personal_goal_<slug>`
 * label keys, and translated rows keep that screen reading the same. System rows
 * carry no description, so none is invented. A gym's own goal has no known
 * translation and none is invented — it falls back to its single name.
 *
 * Mirrors `SYSTEM_PERSONAL_GOAL_TRANSLATIONS` in
 * `api/src/domain/nutritionGoalTranslations.ts` (the migration is plain JS and
 * cannot import it); a unit test asserts they agree.
 */

const TABLE = 'personal_goal_translations';

const SEEDS = {
  weight_loss: { es: 'Pérdida de peso', ca: 'Pèrdua de pes' },
  weight_gain: { es: 'Aumento de peso', ca: 'Augment de pes' },
  muscle_gain: { es: 'Ganancia muscular', ca: 'Guany muscular' },
  maintenance: { es: 'Mantenimiento', ca: 'Manteniment' },
  performance: { es: 'Rendimiento', ca: 'Rendiment' },
  recovery: { es: 'Recuperación', ca: 'Recuperació' },
  energy: { es: 'Energía', ca: 'Energia' },
};

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.raw(`
      CREATE TABLE ${TABLE} (
        personal_goal_id INT UNSIGNED  NOT NULL,
        locale           VARCHAR(10)   NOT NULL,
        name             VARCHAR(255)  NOT NULL,
        description      VARCHAR(1000) NULL,
        created_at       DATETIME      NOT NULL DEFAULT (UTC_TIMESTAMP()),
        modified_at      DATETIME      NULL,
        PRIMARY KEY (personal_goal_id, locale),
        KEY pgt_locale_name (locale, name),
        CONSTRAINT pgt_goal_fk FOREIGN KEY (personal_goal_id)
          REFERENCES personal_goals(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  for (const [slug, seed] of Object.entries(SEEDS)) {
    for (const locale of ['es', 'ca']) {
      await knex.raw(
        `INSERT IGNORE INTO ${TABLE} (personal_goal_id, locale, name, description)
         SELECT id, ?, ?, NULL FROM personal_goals WHERE slug = ? AND gym_id IS NULL`,
        [locale, seed[locale], slug],
      );
    }
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists(TABLE);
};

exports.SEEDS = SEEDS;
