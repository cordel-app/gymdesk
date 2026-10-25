/**
 * #1849 stage E2 (Exercises) — the read models of the Exercises a gym can see, the
 * Foods' catalogue views (325) one catalogue over, one view per table the readers use so a
 * reader changes a table name and nothing else:
 *
 *   exercise_catalogue                              (the exercises)
 *   exercise_translation_catalogue                  (name per locale)
 *   exercise_description_translation_catalogue      (short description / description per locale)
 *   exercise_muscle_catalogue                       (exercise <-> muscle, with the role)
 *   exercise_allowed_result_type_catalogue          (exercise <-> allowed result type)
 *
 * A System exercise (`gym_id` NULL, no `cloned_from_id`) comes from the `base_exercise*`
 * tables, which Cordel's router (E2a) writes; a gym's own exercise and its rows come from
 * the legacy tables. Base ids are drawn from the legacy sequence, so the two never collide.
 * Read-only: every writer still targets a real table, and the plan tables and
 * `cloned_from_id` still reference the legacy rows (E3).
 */
const COLUMNS = `name, description, short_description, status, min_reps_default, max_reps_default,
  rest_default_seconds, sets_default, source, source_id, slug, equipment, category, level, mechanic,
  force_type, image_male_url, image_female_url, video_male_url, video_female_url,
  created_at, created_by, modified_at, modified_by, deleted_at, deleted_by`;

exports.up = async (knex) => {
  await knex.raw(`
    CREATE OR REPLACE VIEW exercise_catalogue AS
    SELECT id, NULL AS gym_id, NULL AS cloned_from_id, ${COLUMNS} FROM base_exercises
    UNION ALL
    SELECT id, gym_id, cloned_from_id, ${COLUMNS} FROM exercises WHERE gym_id IS NOT NULL
  `);
  const junction = (view, base, legacy, cols) => knex.raw(`
    CREATE OR REPLACE VIEW ${view} AS
    SELECT ${cols} FROM ${base}
    UNION ALL
    SELECT ${cols.split(', ').map((c) => `t.${c}`).join(', ')} FROM ${legacy} t
      JOIN exercises e ON e.id = t.exercise_id AND e.gym_id IS NOT NULL
  `);
  await junction('exercise_translation_catalogue', 'base_exercise_translations', 'exercise_translations',
    'exercise_id, locale, name, created_at, modified_at');
  await junction('exercise_description_translation_catalogue', 'base_exercise_description_translations', 'exercise_description_translations',
    'exercise_id, locale, short_description, description, created_at, modified_at');
  await junction('exercise_muscle_catalogue', 'base_exercise_muscles', 'exercise_muscles',
    'exercise_id, role, muscle, muscle_id, created_at');
  await junction('exercise_allowed_result_type_catalogue', 'base_exercise_allowed_result_types', 'exercise_allowed_result_types',
    'exercise_id, result_type_id');
};

exports.down = async (knex) => {
  for (const v of [
    'exercise_allowed_result_type_catalogue', 'exercise_muscle_catalogue',
    'exercise_description_translation_catalogue', 'exercise_translation_catalogue', 'exercise_catalogue',
  ]) await knex.raw(`DROP VIEW IF EXISTS ${v}`);
};
