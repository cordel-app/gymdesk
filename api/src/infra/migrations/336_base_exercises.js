/**
 * #1849 stage E1 (Exercises) — `base_exercises`: the platform's Exercises in a table of
 * their own, copied (never moved) from the System rows `exercises` holds with
 * `gym_id IS NULL`, together with the four junctions that hang off an exercise
 * (`exercise_translations`, `exercise_description_translations`, `exercise_muscles`,
 * `exercise_allowed_result_types`). Personal Goals' 304, Nutrition Goals' 321 and Foods'
 * 324 one catalogue over.
 *
 * ── Non-destructive, ids kept, unread ───────────────────────────────────────
 * Nothing is deleted or re-pointed. The legacy System rows, their junctions, the
 * foreign keys that point at `exercises` (`workout_template_exercises`,
 * `workout_exercises`, `exercise_logs`, `member_standalone_exercises` — RESTRICT — and
 * the self FK `exercises.cloned_from_id` — SET NULL) and every reader and writer stay as
 * they are: nobody reads these tables yet. Ids are preserved so the later stages can use
 * the two-column approach; AUTO_INCREMENT moves past the highest legacy id so a new Base
 * exercise can never take an id a gym-owned exercise already uses.
 *
 * ── Shape ───────────────────────────────────────────────────────────────────
 * The `exercises` columns minus `gym_id`, `cloned_from_id` and the frozen
 * `*_by_membership_id` pairs. `status` (active | inactive | deleted) stays because an
 * exercise can be inactive, which a goal cannot. The Free Exercise DB provenance keys
 * (`source:source_id` among all rows, `slug` among non-deleted rows) keep their unique
 * indexes. The junctions point at the shared lookups (`muscles`, `result_types`).
 *
 * Idempotent: tables are created only when missing and every copy is `INSERT IGNORE`.
 */
const EX = 'base_exercises';
const TR = 'base_exercise_translations';
const DT = 'base_exercise_description_translations';
const MU = 'base_exercise_muscles';
const RT = 'base_exercise_allowed_result_types';
const COLLATE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci';

exports.up = async (knex) => {
  if (!(await knex.schema.hasTable(EX))) {
    await knex.raw(`
      CREATE TABLE ${EX} (
        id                   INT UNSIGNED  NOT NULL AUTO_INCREMENT,
        name                 VARCHAR(200)  NOT NULL,
        description          TEXT          NULL,
        short_description    VARCHAR(300)  NULL,
        status               VARCHAR(20)   NOT NULL DEFAULT 'active',
        min_reps_default     INT UNSIGNED  NULL,
        max_reps_default     INT UNSIGNED  NULL,
        rest_default_seconds INT UNSIGNED  NULL,
        sets_default         INT UNSIGNED  NULL,
        source               VARCHAR(40)   NULL,
        source_id            VARCHAR(120)  NULL,
        slug                 VARCHAR(220)  NULL,
        equipment            VARCHAR(60)   NULL,
        category             VARCHAR(60)   NULL,
        level                VARCHAR(30)   NULL,
        mechanic             VARCHAR(30)   NULL,
        force_type           VARCHAR(30)   NULL,
        image_male_url       VARCHAR(1024) NULL,
        image_female_url     VARCHAR(1024) NULL,
        video_male_url       VARCHAR(1024) NULL,
        video_female_url     VARCHAR(1024) NULL,
        created_at           DATETIME      NOT NULL DEFAULT (UTC_TIMESTAMP()),
        created_by           VARCHAR(255)  NULL,
        modified_at          DATETIME      NULL,
        modified_by          VARCHAR(255)  NULL,
        deleted_at           DATETIME      NULL,
        deleted_by           VARCHAR(255)  NULL,
        base_source_key VARCHAR(165) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
          GENERATED ALWAYS AS (IF(source IS NOT NULL AND source_id IS NOT NULL, CONCAT(source, ':', source_id), NULL)) VIRTUAL,
        base_slug_key VARCHAR(220)
          GENERATED ALWAYS AS (IF(status <> 'deleted' AND slug IS NOT NULL, slug, NULL)) VIRTUAL,
        PRIMARY KEY (id),
        UNIQUE KEY base_ex_source_key (base_source_key),
        UNIQUE KEY base_ex_slug_key (base_slug_key),
        KEY base_ex_name_idx (name),
        CONSTRAINT base_ex_status_check CHECK (status IN ('active','inactive','deleted')),
        CONSTRAINT base_ex_reps_check CHECK (min_reps_default IS NULL OR max_reps_default IS NULL OR min_reps_default <= max_reps_default)
      ) ${COLLATE}
    `);
  }
  if (!(await knex.schema.hasTable(TR))) {
    await knex.raw(`
      CREATE TABLE ${TR} (
        exercise_id INT UNSIGNED NOT NULL,
        locale      VARCHAR(10)  NOT NULL,
        name        VARCHAR(200) NOT NULL,
        created_at  DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        modified_at DATETIME     NULL,
        PRIMARY KEY (exercise_id, locale),
        KEY bext_locale_name (locale, name),
        CONSTRAINT bext_exercise_fk FOREIGN KEY (exercise_id) REFERENCES ${EX}(id) ON DELETE CASCADE
      ) ${COLLATE}
    `);
  }
  if (!(await knex.schema.hasTable(DT))) {
    await knex.raw(`
      CREATE TABLE ${DT} (
        exercise_id       INT UNSIGNED NOT NULL,
        locale            VARCHAR(10)  NOT NULL,
        short_description VARCHAR(300) NULL,
        description       TEXT         NULL,
        created_at        DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        modified_at       DATETIME     NULL,
        PRIMARY KEY (exercise_id, locale),
        CONSTRAINT bexdt_exercise_fk FOREIGN KEY (exercise_id) REFERENCES ${EX}(id) ON DELETE CASCADE
      ) ${COLLATE}
    `);
  }
  if (!(await knex.schema.hasTable(MU))) {
    await knex.raw(`
      CREATE TABLE ${MU} (
        id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
        exercise_id INT UNSIGNED NOT NULL,
        role        VARCHAR(20)  NOT NULL,
        muscle      VARCHAR(60)  NOT NULL,
        muscle_id   INT UNSIGNED NULL,
        created_at  DATETIME     NOT NULL DEFAULT (UTC_TIMESTAMP()),
        PRIMARY KEY (id),
        UNIQUE KEY bexm_ex_muscle_unique (exercise_id, muscle),
        KEY bexm_muscle_idx (muscle_id),
        CONSTRAINT bexm_exercise_fk FOREIGN KEY (exercise_id) REFERENCES ${EX}(id) ON DELETE CASCADE,
        CONSTRAINT bexm_muscle_fk FOREIGN KEY (muscle_id) REFERENCES muscles(id) ON DELETE RESTRICT,
        CONSTRAINT bexm_role_check CHECK (role IN ('principal','secondary'))
      ) ${COLLATE}
    `);
  }
  if (!(await knex.schema.hasTable(RT))) {
    await knex.raw(`
      CREATE TABLE ${RT} (
        exercise_id    INT UNSIGNED NOT NULL,
        result_type_id INT UNSIGNED NOT NULL,
        PRIMARY KEY (exercise_id, result_type_id),
        KEY bexrt_result_type_idx (result_type_id),
        CONSTRAINT bexrt_exercise_fk FOREIGN KEY (exercise_id) REFERENCES ${EX}(id) ON DELETE CASCADE,
        CONSTRAINT bexrt_result_type_fk FOREIGN KEY (result_type_id) REFERENCES result_types(id) ON DELETE CASCADE
      ) ${COLLATE}
    `);
  }

  // Copy the System rows keeping their ids; a deleted one is copied as deleted.
  await knex.raw(`
    INSERT IGNORE INTO ${EX}
      (id, name, description, short_description, status, min_reps_default, max_reps_default,
       rest_default_seconds, sets_default, source, source_id, slug, equipment, category, level,
       mechanic, force_type, image_male_url, image_female_url, video_male_url, video_female_url,
       created_at, created_by, modified_at, modified_by, deleted_at, deleted_by)
    SELECT id, name, description, short_description, status, min_reps_default, max_reps_default,
           rest_default_seconds, sets_default, source, source_id, slug, equipment, category, level,
           mechanic, force_type, image_male_url, image_female_url, video_male_url, video_female_url,
           created_at, COALESCE(created_by, 'System'), modified_at, modified_by,
           CASE WHEN status = 'deleted' THEN COALESCE(deleted_at, UTC_TIMESTAMP()) ELSE deleted_at END, deleted_by
      FROM exercises WHERE gym_id IS NULL
  `);
  await knex.raw(`
    INSERT IGNORE INTO ${TR} (exercise_id, locale, name, created_at, modified_at)
    SELECT t.exercise_id, t.locale, t.name, t.created_at, t.modified_at
      FROM exercise_translations t JOIN exercises e ON e.id = t.exercise_id AND e.gym_id IS NULL
  `);
  await knex.raw(`
    INSERT IGNORE INTO ${DT} (exercise_id, locale, short_description, description, created_at, modified_at)
    SELECT t.exercise_id, t.locale, t.short_description, t.description, t.created_at, t.modified_at
      FROM exercise_description_translations t JOIN exercises e ON e.id = t.exercise_id AND e.gym_id IS NULL
  `);
  await knex.raw(`
    INSERT IGNORE INTO ${MU} (exercise_id, role, muscle, muscle_id, created_at)
    SELECT m.exercise_id, m.role, m.muscle, m.muscle_id, m.created_at
      FROM exercise_muscles m JOIN exercises e ON e.id = m.exercise_id AND e.gym_id IS NULL
  `);
  await knex.raw(`
    INSERT IGNORE INTO ${RT} (exercise_id, result_type_id)
    SELECT a.exercise_id, a.result_type_id
      FROM exercise_allowed_result_types a JOIN exercises e ON e.id = a.exercise_id AND e.gym_id IS NULL
  `);

  // New Base ids must not collide with any legacy id (gym-owned or System).
  const [[max]] = await knex.raw('SELECT COALESCE(MAX(id), 0) AS m FROM exercises');
  const [[auto]] = await knex.raw(`SELECT AUTO_INCREMENT AS a FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exercises'`);
  const next = Math.max(Number(max.m) + 1, Number(auto.a || 1));
  await knex.raw(`ALTER TABLE ${EX} AUTO_INCREMENT = ${next}`);
};

exports.down = async () => {};
