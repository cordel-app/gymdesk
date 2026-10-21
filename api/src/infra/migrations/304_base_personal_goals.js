/**
 * #1849 stage 2a — `base_personal_goals`: the platform's Personal Goal templates
 * in a table of their own, copied (never moved) from the System rows that
 * `personal_goals` holds with `gym_id IS NULL`.
 *
 * ── Non-destructive, ids kept ───────────────────────────────────────────────
 * Per the owner's answer on #1849: the System goal ids are kept (no remapping),
 * and nothing is deleted or re-pointed here. `personal_goals` rows with
 * `gym_id IS NULL`, `personal_goal_translations`, the images under `cordel/goals/`
 * and the foreign keys of `member_personal_goals` / `gym_personal_goals` are all
 * untouched and remain authoritative: no reader or writer uses this table yet.
 * Cordel CRUD (stage 2b) and the gym-side reads and relationships (stage 2c)
 * move onto it later; the legacy rows are deleted in the final stage only.
 *
 * ── Shape ───────────────────────────────────────────────────────────────────
 * The `base_<catalogue>` pattern of `base_products` (298): no `gym_id`, soft
 * delete through `deleted_at`, the plain-text actors of #1182, a `template_key`
 * VIRTUAL generated column that makes the slug/name unique among live rows
 * only. `slug` is the label handle of a seeded goal (`goal_library.personal_goal_<slug>`).
 * The target pair and `target_type` and both image references are the columns
 * `personal_goals` carries (218, 245, 225/293).
 *
 * ── Idempotent ──────────────────────────────────────────────────────────────
 * The table is created only when missing and the copy is `INSERT IGNORE` keyed
 * on the preserved id, so a re-run (or a crash between the two) adds nothing and
 * never overwrites a row Cordel has edited since. AUTO_INCREMENT is moved past
 * the highest `personal_goals` id so a goal created here later can never collide
 * with an id the legacy table (and its foreign keys) already uses.
 */

const TABLE = 'base_personal_goals';
const TRANSLATIONS = 'base_personal_goal_translations';

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.raw(`
      CREATE TABLE ${TABLE} (
        id                  INT UNSIGNED  NOT NULL AUTO_INCREMENT,
        slug                VARCHAR(50)   NULL,
        name                VARCHAR(255)  NOT NULL,
        description         VARCHAR(1000) NULL,
        target_value        DECIMAL(10,2) NULL,
        target_unit         VARCHAR(20)   NULL,
        target_type         VARCHAR(10)   NOT NULL DEFAULT 'absolute',
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
        UNIQUE KEY base_personal_goals_live_slug (live_slug_key),
        UNIQUE KEY base_personal_goals_live_name (live_name_key),
        CONSTRAINT chk_base_pgoal_target_type CHECK (target_type IN ('absolute','relative')),
        CONSTRAINT chk_base_pgoal_target_unit CHECK (target_unit IS NULL OR target_value IS NOT NULL),
        CONSTRAINT chk_base_pgoal_target_value
          CHECK (target_value IS NULL OR target_value >= 0 OR target_type = 'relative')
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  if (!(await knex.schema.hasTable(TRANSLATIONS))) {
    await knex.raw(`
      CREATE TABLE ${TRANSLATIONS} (
        base_personal_goal_id INT UNSIGNED  NOT NULL,
        locale                VARCHAR(10)   NOT NULL,
        name                  VARCHAR(255)  NOT NULL,
        description           VARCHAR(1000) NULL,
        created_at            DATETIME      NOT NULL DEFAULT (UTC_TIMESTAMP()),
        modified_at           DATETIME      NULL,
        PRIMARY KEY (base_personal_goal_id, locale),
        KEY bpgt_locale_name (locale, name),
        CONSTRAINT bpgt_goal_fk FOREIGN KEY (base_personal_goal_id)
          REFERENCES ${TABLE}(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  // Copy the System rows, keeping their ids. A deleted System goal is copied as deleted.
  await knex.raw(`
    INSERT IGNORE INTO ${TABLE}
      (id, slug, name, description, target_value, target_unit, target_type,
       image_url, image_thumbnail_url, created_at, created_by, modified_at, modified_by,
       deleted_at, deleted_by)
    SELECT id, slug, name, description, target_value, target_unit, target_type,
           image_url, image_thumbnail_url, created_at, COALESCE(created_by, 'System'),
           modified_at, modified_by,
           CASE WHEN status = 'deleted' THEN COALESCE(deleted_at, UTC_TIMESTAMP()) ELSE NULL END,
           deleted_by
    FROM personal_goals
    WHERE gym_id IS NULL
  `);

  await knex.raw(`
    INSERT IGNORE INTO ${TRANSLATIONS}
      (base_personal_goal_id, locale, name, description, created_at, modified_at)
    SELECT t.personal_goal_id, t.locale, t.name, t.description, t.created_at, t.modified_at
    FROM personal_goal_translations t
    JOIN personal_goals g ON g.id = t.personal_goal_id AND g.gym_id IS NULL
  `);

  const [[row]] = await knex.raw('SELECT COALESCE(MAX(id), 0) + 1 AS next FROM personal_goals');
  const [[own]] = await knex.raw(`SELECT COALESCE(MAX(id), 0) + 1 AS next FROM ${TABLE}`);
  const next = Math.max(Number(row.next), Number(own.next));
  await knex.raw(`ALTER TABLE ${TABLE} AUTO_INCREMENT = ${next}`);
};

exports.down = async () => {};
