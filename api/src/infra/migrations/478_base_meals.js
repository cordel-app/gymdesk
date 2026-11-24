/**
 * #3328 stage 1 — `base_meals`: Cordel's catalogue of meals (Breakfast, Lunch, …),
 * administered from Cordel → Base Meals. Stage 1 adds the catalogue alone; nothing
 * references it yet. Stage 2 points the nutrition plans' meals at it, backfilled
 * from their `meal_type`, which is why the seeded rows' slugs ARE today's fixed
 * `meal_type` values (the closed list the three nutrition-plan routers validate).
 *
 * ── Shape ───────────────────────────────────────────────────────────────────
 * The `base_<catalogue>` pattern of 298/304/321: no `gym_id` (a platform
 * catalogue), soft delete through `deleted_at`, the plain-text actors of #1182,
 * the WebP image pair (`cordel/meals/<id>-<slug>[-thumbnail].webp`), `name` and
 * `description` as the base-locale (English) values and fallback, and
 * `base_meal_translations` beside it for every other locale (#967's rule).
 *
 * The slug is UNIQUE over every row, deleted ones included (#2951: a slug is
 * generated once and never reused); the name is unique among live rows only
 * (migration 183's VIRTUAL key device), like the Base goals.
 *
 * ── Idempotent ──────────────────────────────────────────────────────────────
 * Tables are created only when missing and the seed is `INSERT IGNORE` keyed on
 * the slug, so a re-run never overwrites a meal Cordel has since edited.
 */
const TABLE = 'base_meals';
const TRANSLATIONS = 'base_meal_translations';

// Mirrors SYSTEM_BASE_MEALS in api/src/domain/baseMeals.ts (a unit test asserts they agree).
const SEEDS = [
  { slug: 'recien_levantado', en: 'Just Woken Up', es: 'Recién levantado', ca: 'Just llevat' },
  { slug: 'breakfast', en: 'Breakfast', es: 'Desayuno', ca: 'Esmorzar' },
  { slug: 'media_manana', en: 'Mid-Morning Snack', es: 'Media mañana', ca: 'Mig matí' },
  { slug: 'lunch', en: 'Lunch', es: 'Comida', ca: 'Dinar' },
  { slug: 'snack', en: 'Snack', es: 'Merienda', ca: 'Berenar' },
  { slug: 'dinner', en: 'Dinner', es: 'Cena', ca: 'Sopar' },
  { slug: 'antes_de_dormir', en: 'Before Bed', es: 'Antes de dormir', ca: 'Abans de dormir' },
  { slug: 'two_three_hours_before_training', en: '2–3 Hours Before Training', es: '2-3 horas antes del entrenamiento', ca: "2-3 hores abans de l'entrenament" },
  { slug: 'immediately_before_training', en: 'Immediately Before Training', es: 'Inmediatamente antes del entrenamiento', ca: "Immediatament abans de l'entrenament" },
  { slug: 'immediately_after_training', en: 'Immediately After Training', es: 'Inmediatamente después del entrenamiento', ca: "Immediatament després de l'entrenament" },
];

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.raw(`
      CREATE TABLE ${TABLE} (
        id                  INT UNSIGNED  NOT NULL AUTO_INCREMENT,
        slug                VARCHAR(100)  NOT NULL,
        name                VARCHAR(255)  NOT NULL,
        description         VARCHAR(1000) NULL,
        image_url           VARCHAR(1024) NULL,
        image_thumbnail_url VARCHAR(1024) NULL,
        position            INT           NOT NULL DEFAULT 0,
        created_at   DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        created_by   VARCHAR(255) NULL,
        modified_at  DATETIME     NULL,
        modified_by  VARCHAR(255) NULL,
        deleted_at   DATETIME     NULL,
        deleted_by   VARCHAR(255) NULL,
        live_name_key VARCHAR(300)
          GENERATED ALWAYS AS (IF(deleted_at IS NULL, name, NULL)) VIRTUAL,
        PRIMARY KEY (id),
        UNIQUE KEY base_meals_slug_unique (slug),
        UNIQUE KEY base_meals_live_name (live_name_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  if (!(await knex.schema.hasTable(TRANSLATIONS))) {
    await knex.raw(`
      CREATE TABLE ${TRANSLATIONS} (
        base_meal_id INT UNSIGNED  NOT NULL,
        locale       VARCHAR(10)   NOT NULL,
        name         VARCHAR(255)  NOT NULL,
        description  VARCHAR(1000) NULL,
        created_at   DATETIME      NOT NULL DEFAULT (UTC_TIMESTAMP()),
        modified_at  DATETIME      NULL,
        PRIMARY KEY (base_meal_id, locale),
        KEY bmt_locale_name (locale, name),
        CONSTRAINT bmt_meal_fk FOREIGN KEY (base_meal_id)
          REFERENCES ${TABLE}(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  for (const [index, seed] of SEEDS.entries()) {
    await knex.raw(
      `INSERT IGNORE INTO ${TABLE} (slug, name, position, created_by) VALUES (?, ?, ?, 'System')`,
      [seed.slug, seed.en, index + 1],
    );
    for (const locale of ['es', 'ca']) {
      await knex.raw(
        `INSERT IGNORE INTO ${TRANSLATIONS} (base_meal_id, locale, name)
         SELECT id, ?, ? FROM ${TABLE} WHERE slug = ?`,
        [locale, seed[locale], seed.slug],
      );
    }
  }
};

// One-way in the sense of the other base_* catalogues: dropping the tables would
// lose Cordel's edits and images. Nothing references them in stage 1, so a
// manual drop is safe if ever needed.
exports.down = async () => {};
