/**
 * #1849 stage F1 (Foods) — `base_nutrition_library_items`: the platform's Foods in
 * a table of their own, copied (never moved) from the System rows that
 * `nutrition_library_items` holds with `gym_id IS NULL`, together with the four
 * junctions that hang off an item. Personal Goals' 304 / Nutrition Goals' 321 one
 * catalogue over.
 *
 * ── Non-destructive, ids kept, unread ───────────────────────────────────────
 * Nothing is deleted or re-pointed. The legacy System rows and their junction rows,
 * the plan tables' foreign keys (`member_nutrition_plan_meal_items`,
 * `…_restrictions`, `nutrition_plan_template_meal_items` — `RESTRICT`; the two goal
 * illustration columns — `SET NULL`), the images under `cordel/nutrition/` and every
 * reader and writer stay as they are: nobody reads these tables yet. Moving the
 * five foreign keys is a later stage (the two-column approach of Personal Goals),
 * which is why ids are preserved.
 *
 * ── Shape ───────────────────────────────────────────────────────────────────
 * The `base_<catalogue>` pattern: no `gym_id`, soft delete through `deleted_at`
 * (the legacy `status` is derived), the plain-text actors of #1182, a VIRTUAL key
 * making the name unique among live rows only. The junctions point at the shared
 * lookups (`nutrition_library_categories`, `nutritional_qualities`), which are not
 * duplicated.
 *
 * ── Idempotent ──────────────────────────────────────────────────────────────
 * Tables are created only when missing and every copy is `INSERT IGNORE` keyed on
 * the preserved id / primary key, so a re-run adds nothing and never overwrites an
 * edited row. AUTO_INCREMENT moves past the highest legacy id so a new Base food
 * can never take an id the legacy table (and the plan tables) already use.
 */
const ITEMS = 'base_nutrition_library_items';
const CATEGORIES = 'base_nutrition_library_item_categories';
const QUALITIES = 'base_nutrition_library_item_qualities';
const TRANSLATIONS = 'base_nutrition_library_item_translations';
const DESCRIPTIONS = 'base_nutrition_library_item_description_translations';
const COLLATE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci';

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable(ITEMS))) {
    await knex.raw(`
      CREATE TABLE ${ITEMS} (
        id           INT UNSIGNED  NOT NULL AUTO_INCREMENT,
        name         VARCHAR(255)  NOT NULL,
        description  VARCHAR(1000) NULL,
        image_url    VARCHAR(1024) NULL,
        created_at   DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        created_by   VARCHAR(255) NULL,
        modified_at  DATETIME     NULL,
        modified_by  VARCHAR(255) NULL,
        deleted_at   DATETIME     NULL,
        deleted_by   VARCHAR(255) NULL,
        live_name_key VARCHAR(300)
          GENERATED ALWAYS AS (IF(deleted_at IS NULL, name, NULL)) VIRTUAL,
        PRIMARY KEY (id),
        UNIQUE KEY base_nli_live_name (live_name_key)
      ) ${COLLATE}
    `);
  }

  if (!(await knex.schema.hasTable(CATEGORIES))) {
    await knex.raw(`
      CREATE TABLE ${CATEGORIES} (
        item_id     INT UNSIGNED NOT NULL,
        category_id INT UNSIGNED NOT NULL,
        created_at  DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        PRIMARY KEY (item_id, category_id),
        KEY bnlic_category_idx (category_id),
        CONSTRAINT bnlic_item_fk FOREIGN KEY (item_id) REFERENCES ${ITEMS}(id) ON DELETE CASCADE,
        CONSTRAINT bnlic_category_fk FOREIGN KEY (category_id)
          REFERENCES nutrition_library_categories(id) ON DELETE CASCADE
      ) ${COLLATE}
    `);
  }

  if (!(await knex.schema.hasTable(QUALITIES))) {
    await knex.raw(`
      CREATE TABLE ${QUALITIES} (
        item_id    INT UNSIGNED NOT NULL,
        quality_id INT UNSIGNED NOT NULL,
        created_at DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        PRIMARY KEY (item_id, quality_id),
        KEY bnliq_quality_idx (quality_id),
        CONSTRAINT bnliq_item_fk FOREIGN KEY (item_id) REFERENCES ${ITEMS}(id) ON DELETE CASCADE,
        CONSTRAINT bnliq_quality_fk FOREIGN KEY (quality_id)
          REFERENCES nutritional_qualities(id) ON DELETE CASCADE
      ) ${COLLATE}
    `);
  }

  if (!(await knex.schema.hasTable(TRANSLATIONS))) {
    await knex.raw(`
      CREATE TABLE ${TRANSLATIONS} (
        item_id     INT UNSIGNED NOT NULL,
        locale      VARCHAR(10)  NOT NULL,
        name        VARCHAR(255) NOT NULL,
        created_at  DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        modified_at DATETIME     NULL,
        PRIMARY KEY (item_id, locale),
        KEY bnlit_locale_name (locale, name),
        CONSTRAINT bnlit_item_fk FOREIGN KEY (item_id) REFERENCES ${ITEMS}(id) ON DELETE CASCADE
      ) ${COLLATE}
    `);
  }

  if (!(await knex.schema.hasTable(DESCRIPTIONS))) {
    await knex.raw(`
      CREATE TABLE ${DESCRIPTIONS} (
        item_id     INT UNSIGNED  NOT NULL,
        locale      VARCHAR(10)   NOT NULL,
        description VARCHAR(1000) NOT NULL,
        created_at  DATETIME      NOT NULL DEFAULT (UTC_TIMESTAMP()),
        modified_at DATETIME      NULL,
        PRIMARY KEY (item_id, locale),
        CONSTRAINT bnlidt_item_fk FOREIGN KEY (item_id) REFERENCES ${ITEMS}(id) ON DELETE CASCADE
      ) ${COLLATE}
    `);
  }

  // Copy the System rows, keeping their ids. A deleted System food is copied as deleted.
  await knex.raw(`
    INSERT IGNORE INTO ${ITEMS}
      (id, name, description, image_url, created_at, created_by, modified_at, modified_by, deleted_at, deleted_by)
    SELECT id, name, description, image_url, created_at, COALESCE(created_by, 'System'),
           modified_at, modified_by,
           CASE WHEN status = 'deleted' THEN COALESCE(deleted_at, UTC_TIMESTAMP()) ELSE NULL END,
           deleted_by
    FROM nutrition_library_items
    WHERE gym_id IS NULL
  `);

  await knex.raw(`
    INSERT IGNORE INTO ${CATEGORIES} (item_id, category_id, created_at)
    SELECT c.item_id, c.category_id, c.created_at
    FROM nutrition_library_item_categories c
    JOIN nutrition_library_items i ON i.id = c.item_id AND i.gym_id IS NULL
  `);
  await knex.raw(`
    INSERT IGNORE INTO ${QUALITIES} (item_id, quality_id, created_at)
    SELECT q.item_id, q.quality_id, q.created_at
    FROM nutrition_library_item_qualities q
    JOIN nutrition_library_items i ON i.id = q.item_id AND i.gym_id IS NULL
  `);
  await knex.raw(`
    INSERT IGNORE INTO ${TRANSLATIONS} (item_id, locale, name, created_at, modified_at)
    SELECT t.item_id, t.locale, t.name, t.created_at, t.modified_at
    FROM nutrition_library_item_translations t
    JOIN nutrition_library_items i ON i.id = t.item_id AND i.gym_id IS NULL
  `);
  await knex.raw(`
    INSERT IGNORE INTO ${DESCRIPTIONS} (item_id, locale, description, created_at, modified_at)
    SELECT t.item_id, t.locale, t.description, t.created_at, t.modified_at
    FROM nutrition_library_item_description_translations t
    JOIN nutrition_library_items i ON i.id = t.item_id AND i.gym_id IS NULL
  `);

  const [[legacy]] = await knex.raw('SELECT COALESCE(MAX(id), 0) + 1 AS next FROM nutrition_library_items');
  const [[own]] = await knex.raw(`SELECT COALESCE(MAX(id), 0) + 1 AS next FROM ${ITEMS}`);
  await knex.raw(`ALTER TABLE ${ITEMS} AUTO_INCREMENT = ${Math.max(Number(legacy.next), Number(own.next))}`);
};

exports.down = async () => {};
