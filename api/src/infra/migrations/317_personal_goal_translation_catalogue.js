/**
 * #1849 stage 2e — (1) re-runs 316's idempotent backfill for the rows written
 * between that migration and the deploy of the writers that now set
 * `base_personal_goal_id`; (2) `personal_goal_translation_catalogue`, the read
 * model of a goal's translations: a System goal's from
 * `base_personal_goal_translations` (keyed by the Base id, which equals the
 * legacy id) and a gym-owned goal's from `personal_goal_translations`. Read-only;
 * the translation writers still target the real tables.
 */
exports.up = async (knex) => {
  for (const table of ['member_personal_goals', 'gym_personal_goals']) {
    await knex.raw(`
      UPDATE ${table} t
        JOIN personal_goals p ON p.id = t.personal_goal_id AND p.gym_id IS NULL
         SET t.base_personal_goal_id = p.id
       WHERE t.base_personal_goal_id IS NULL
    `);
  }
  await knex.raw(`
    CREATE OR REPLACE VIEW personal_goal_translation_catalogue AS
    SELECT base_personal_goal_id AS personal_goal_id, locale, name, description
      FROM base_personal_goal_translations
    UNION ALL
    SELECT t.personal_goal_id, t.locale, t.name, t.description
      FROM personal_goal_translations t
      JOIN personal_goals g ON g.id = t.personal_goal_id AND g.gym_id IS NOT NULL
  `);
};

exports.down = async (knex) => {
  await knex.raw('DROP VIEW IF EXISTS personal_goal_translation_catalogue');
};
