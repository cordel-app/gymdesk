/**
 * #1849 stage 2c — `personal_goal_catalogue`: the one read model of the Personal
 * Goals a gym can see. The platform's System goals come from `base_personal_goals`
 * (`gym_id` NULL, `status` derived from `deleted_at`) and a gym's own goals from
 * `personal_goals` (`gym_id` set). Base ids were kept and legacy ids are the id
 * source for new goals (stage 2b), so the two sets never collide.
 *
 * Read-only: every writer still targets a real table. The foreign keys of
 * `member_personal_goals` / `gym_personal_goals` still point at the legacy
 * `personal_goals` rows (kept and mirrored); re-pointing them is a later stage.
 */
exports.up = async (knex) => {
  await knex.raw(`
    CREATE OR REPLACE VIEW personal_goal_catalogue AS
    SELECT id, NULL AS gym_id, slug, name, description, target_value, target_unit, target_type,
           image_url, image_thumbnail_url,
           IF(deleted_at IS NULL, 'active', 'deleted') AS status,
           created_at, created_by, modified_at, modified_by, deleted_at, deleted_by
      FROM base_personal_goals
    UNION ALL
    SELECT id, gym_id, slug, name, description, target_value, target_unit, target_type,
           image_url, image_thumbnail_url, status,
           created_at, created_by, modified_at, modified_by, deleted_at, deleted_by
      FROM personal_goals
     WHERE gym_id IS NOT NULL
  `);
};

exports.down = async (knex) => {
  await knex.raw('DROP VIEW IF EXISTS personal_goal_catalogue');
};
