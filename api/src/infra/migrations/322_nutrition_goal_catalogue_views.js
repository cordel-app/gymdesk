/**
 * #1849 stage N3 (Nutrition Goals) — the read models of the Nutrition Goals a gym
 * can see, Personal Goals' migrations 315/317 one catalogue over.
 *
 * `nutrition_goal_catalogue`: System goals from `base_nutrition_goals` (`gym_id`
 * NULL, `status` derived from `deleted_at`) plus a gym's own goals from
 * `nutrition_goals` (`gym_id` set). Base ids are drawn from the legacy sequence
 * (stage N2), so the two never collide.
 *
 * `nutrition_goal_translation_catalogue`: a System goal's translations from
 * `base_nutrition_goal_translations`, a gym-owned goal's from
 * `nutrition_goal_translations`.
 *
 * Read-only; every writer still targets the real tables. The legacy System rows
 * stay (mirrored by N2) until the final stage deletes them.
 */
exports.up = async (knex) => {
  await knex.raw(`
    CREATE OR REPLACE VIEW nutrition_goal_catalogue AS
    SELECT id, NULL AS gym_id, slug, name, description, image_url, image_thumbnail_url,
           IF(deleted_at IS NULL, 'active', 'deleted') AS status,
           created_at, created_by, modified_at, modified_by, deleted_at, deleted_by
      FROM base_nutrition_goals
    UNION ALL
    SELECT id, gym_id, slug, name, description, image_url, image_thumbnail_url, status,
           created_at, created_by, modified_at, modified_by, deleted_at, deleted_by
      FROM nutrition_goals
     WHERE gym_id IS NOT NULL
  `);
  await knex.raw(`
    CREATE OR REPLACE VIEW nutrition_goal_translation_catalogue AS
    SELECT base_nutrition_goal_id AS nutrition_goal_id, locale, name, description
      FROM base_nutrition_goal_translations
    UNION ALL
    SELECT t.nutrition_goal_id, t.locale, t.name, t.description
      FROM nutrition_goal_translations t
      JOIN nutrition_goals g ON g.id = t.nutrition_goal_id AND g.gym_id IS NOT NULL
  `);
};

exports.down = async (knex) => {
  await knex.raw('DROP VIEW IF EXISTS nutrition_goal_translation_catalogue');
  await knex.raw('DROP VIEW IF EXISTS nutrition_goal_catalogue');
};
