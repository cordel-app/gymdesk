/**
 * #1849 stage N1 (Nutrition Goals) — `base_nutrition_goals`: the platform's
 * Nutrition Goal templates in a table of their own, copied (never moved) from the
 * System rows that `nutrition_goals` holds with `gym_id IS NULL`. Personal Goals'
 * stage 2a (migration 304) one catalogue over.
 *
 * ── Non-destructive, ids kept ───────────────────────────────────────────────
 * Nothing is deleted or re-pointed. The legacy System rows,
 * `nutrition_goal_translations`, the images under `cordel/nutrition_goals/` and
 * every reader and writer stay as they are; nobody reads this table yet. Unlike
 * Personal Goals, no table references a Nutrition Goal by id (the plan routers
 * validate a plan goal's `item_name` against a closed slug list), so there is no
 * foreign key to move later: the next stages are Cordel's CRUD and the gym-side
 * reads, then the delete of the legacy rows.
 *
 * ── Shape ───────────────────────────────────────────────────────────────────
 * The `base_<catalogue>` pattern of 298/304: no `gym_id`, soft delete through
 * `deleted_at`, the plain-text actors of #1182, `slug` the label handle of a seeded
 * goal, a VIRTUAL key that makes slug/name unique among live rows only, the WebP
 * image pair, and `base_nutrition_goal_translations` beside it.
 *
 * ── Idempotent ──────────────────────────────────────────────────────────────
 * The tables are created only when missing and the copies are `INSERT IGNORE` keyed
 * on the preserved id, so a re-run adds nothing and never overwrites an edited row.
 * AUTO_INCREMENT moves past the highest legacy id so a new Base goal can never take
 * an id the legacy table uses.
 */
const TABLE = 'base_nutrition_goals';
const TRANSLATIONS = 'base_nutrition_goal_translations';

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.raw(`
      CREATE TABLE ${TABLE} (
        id                  INT UNSIGNED  NOT NULL AUTO_INCREMENT,
        slug                VARCHAR(50)   NULL,
        name                VARCHAR(255)  NOT NULL,
        description         VARCHAR(1000) NULL,
        image_url           VARCHAR(1024) NULL,
        image_thumbnail_url VARCHAR(1024) NULL,
        created_at   DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        created_by   VARCHAR(255) NULL,
        modified_at  DATETIME     NULL,
        modified_by  VARCHAR(255) NULL,
        deleted_at   DATETIME     NULL,
        deleted_by   VARCHAR(255) NULL,
        live_slug_key VARCHAR(60)
          GENERATED ALWAYS AS (IF(deleted_at IS NULL, slug, NULL)) VIRTUAL,
        live_name_key VARCHAR(300)
          GENERATED ALWAYS AS (IF(deleted_at IS NULL, name, NULL)) VIRTUAL,
        PRIMARY KEY (id),
        UNIQUE KEY base_nutrition_goals_live_slug (live_slug_key),
        UNIQUE KEY base_nutrition_goals_live_name (live_name_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  if (!(await knex.schema.hasTable(TRANSLATIONS))) {
    await knex.raw(`
      CREATE TABLE ${TRANSLATIONS} (
        base_nutrition_goal_id INT UNSIGNED  NOT NULL,
        locale                 VARCHAR(10)   NOT NULL,
        name                   VARCHAR(255)  NOT NULL,
        description            VARCHAR(1000) NULL,
        created_at             DATETIME      NOT NULL DEFAULT (UTC_TIMESTAMP()),
        modified_at            DATETIME      NULL,
        PRIMARY KEY (base_nutrition_goal_id, locale),
        KEY bngt_locale_name (locale, name),
        CONSTRAINT bngt_goal_fk FOREIGN KEY (base_nutrition_goal_id)
          REFERENCES ${TABLE}(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  // Copy the System rows, keeping their ids. A deleted System goal is copied as deleted.
  await knex.raw(`
    INSERT IGNORE INTO ${TABLE}
      (id, slug, name, description, image_url, image_thumbnail_url,
       created_at, created_by, modified_at, modified_by, deleted_at, deleted_by)
    SELECT id, slug, name, description, image_url, image_thumbnail_url,
           created_at, COALESCE(created_by, 'System'), modified_at, modified_by,
           CASE WHEN status = 'deleted' THEN COALESCE(deleted_at, UTC_TIMESTAMP()) ELSE NULL END,
           deleted_by
    FROM nutrition_goals
    WHERE gym_id IS NULL
  `);

  await knex.raw(`
    INSERT IGNORE INTO ${TRANSLATIONS}
      (base_nutrition_goal_id, locale, name, description, created_at, modified_at)
    SELECT t.nutrition_goal_id, t.locale, t.name, t.description, t.created_at, t.modified_at
    FROM nutrition_goal_translations t
    JOIN nutrition_goals g ON g.id = t.nutrition_goal_id AND g.gym_id IS NULL
  `);

  const [[legacy]] = await knex.raw('SELECT COALESCE(MAX(id), 0) + 1 AS next FROM nutrition_goals');
  const [[own]] = await knex.raw(`SELECT COALESCE(MAX(id), 0) + 1 AS next FROM ${TABLE}`);
  await knex.raw(`ALTER TABLE ${TABLE} AUTO_INCREMENT = ${Math.max(Number(legacy.next), Number(own.next))}`);
};

exports.down = async () => {};
