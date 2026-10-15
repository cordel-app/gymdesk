/**
 * #1623 — a Nutrition Goal carries an image and its name and description in
 * every supported language.
 *
 * **Image.** `nutrition_goals.image_url` (1080 × 1080 WebP) and
 * `image_thumbnail_url` (256 × 256 WebP), the shape `membership_plans` 278 and
 * `members` 275 use. NULL is what every existing goal means ("no image"): no
 * backfill, no CHECK.
 *
 * **Translations.** `nutrition_goal_translations` is one row per
 * `(nutrition_goal_id, locale)` holding the translated `name` and `description`
 * (CLAUDE.md's junction shape for translated data: the entity's own columns stay
 * the base-locale value and the fallback). Both columns are in the one table
 * because a goal's name and description are edited and read together; a blank
 * description is NULL and falls back to the base one at read time.
 *
 * **Backfill.** Only the seven System goals are translated here (es, ca), with
 * the English description filled in where the row has none: there is a known
 * wording for them. A gym's own goal has no known translation and none is
 * invented — it keeps its single name as the base value and falls back to it
 * until someone types the others in the editor.
 *
 * Mirrors `SYSTEM_NUTRITION_GOAL_TEXTS` in `api/src/domain/nutritionGoalTranslations.ts`
 * (the migration is plain JS and cannot import it); a unit test asserts they agree.
 */

const TABLE = 'nutrition_goal_translations';
const COLUMNS = ['image_url', 'image_thumbnail_url'];

const SEEDS = {
  calories: {
    en: 'Daily energy intake target.',
    es: { name: 'Calorías', description: 'Objetivo de ingesta diaria de energía.' },
    ca: { name: 'Calories', description: "Objectiu d'ingesta diària d'energia." },
  },
  protein: {
    en: 'Daily protein intake target.',
    es: { name: 'Proteínas', description: 'Objetivo de ingesta diaria de proteínas.' },
    ca: { name: 'Proteïnes', description: "Objectiu d'ingesta diària de proteïnes." },
  },
  carbohydrates: {
    en: 'Daily carbohydrate intake target.',
    es: { name: 'Carbohidratos', description: 'Objetivo de ingesta diaria de carbohidratos.' },
    ca: { name: 'Hidrats de carboni', description: "Objectiu d'ingesta diària d'hidrats de carboni." },
  },
  fats: {
    en: 'Daily fat intake target.',
    es: { name: 'Grasas', description: 'Objetivo de ingesta diaria de grasas.' },
    ca: { name: 'Greixos', description: "Objectiu d'ingesta diària de greixos." },
  },
  fiber: {
    en: 'Daily fiber intake target.',
    es: { name: 'Fibra', description: 'Objetivo de ingesta diaria de fibra.' },
    ca: { name: 'Fibra', description: "Objectiu d'ingesta diària de fibra." },
  },
  water: {
    en: 'Daily water intake target.',
    es: { name: 'Agua', description: 'Objetivo de ingesta diaria de agua.' },
    ca: { name: 'Aigua', description: "Objectiu d'ingesta diària d'aigua." },
  },
  fasting: {
    en: 'Fasting window to follow.',
    es: { name: 'Ayuno', description: 'Ventana de ayuno a seguir.' },
    ca: { name: 'Dejuni', description: 'Finestra de dejuni a seguir.' },
  },
};

exports.up = async (knex) => {
  for (const column of COLUMNS) {
    if (!(await knex.schema.hasColumn('nutrition_goals', column))) {
      await knex.raw(`ALTER TABLE nutrition_goals ADD COLUMN ${column} VARCHAR(1024) NULL`);
    }
  }

  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.raw(`
      CREATE TABLE ${TABLE} (
        nutrition_goal_id INT UNSIGNED  NOT NULL,
        locale            VARCHAR(10)   NOT NULL,
        name              VARCHAR(255)  NOT NULL,
        description       VARCHAR(1000) NULL,
        created_at        DATETIME      NOT NULL DEFAULT (UTC_TIMESTAMP()),
        modified_at       DATETIME      NULL,
        PRIMARY KEY (nutrition_goal_id, locale),
        KEY ngt_locale_name (locale, name),
        CONSTRAINT ngt_goal_fk FOREIGN KEY (nutrition_goal_id)
          REFERENCES nutrition_goals(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  for (const [slug, seed] of Object.entries(SEEDS)) {
    // Fills only a description the row does not have yet, so a wording Cordel
    // already changed is never overwritten.
    await knex.raw(
      `UPDATE nutrition_goals SET description = ?
        WHERE slug = ? AND gym_id IS NULL AND description IS NULL`,
      [seed.en, slug],
    );
    for (const locale of ['es', 'ca']) {
      await knex.raw(
        `INSERT IGNORE INTO ${TABLE} (nutrition_goal_id, locale, name, description)
         SELECT id, ?, ?, ? FROM nutrition_goals WHERE slug = ? AND gym_id IS NULL`,
        [locale, seed[locale].name, seed[locale].description, slug],
      );
    }
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists(TABLE);
  for (const column of [...COLUMNS].reverse()) {
    if (await knex.schema.hasColumn('nutrition_goals', column)) {
      await knex.raw(`ALTER TABLE nutrition_goals DROP COLUMN ${column}`);
    }
  }
};

exports.SEEDS = SEEDS;
