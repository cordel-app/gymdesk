/**
 * #1849 stage 2b — re-runs migration 304's non-destructive copy.
 *
 * Between 304 and the deploy of the Base Personal Goals router, the old Cordel
 * router could still add System rows to `personal_goals`. `INSERT IGNORE` keyed
 * on the preserved id adds those and never overwrites a Base row, so a re-run is
 * safe. From this stage on the router mirrors every write, so nothing is missed.
 */
exports.up = async (knex) => {
  await knex.raw(`
    INSERT IGNORE INTO base_personal_goals
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
    INSERT IGNORE INTO base_personal_goal_translations
      (base_personal_goal_id, locale, name, description, created_at, modified_at)
    SELECT t.personal_goal_id, t.locale, t.name, t.description, t.created_at, t.modified_at
    FROM personal_goal_translations t
    JOIN personal_goals g ON g.id = t.personal_goal_id AND g.gym_id IS NULL
  `);
  const [[row]] = await knex.raw('SELECT COALESCE(MAX(id), 0) + 1 AS next FROM personal_goals');
  const [[own]] = await knex.raw('SELECT COALESCE(MAX(id), 0) + 1 AS next FROM base_personal_goals');
  await knex.raw(`ALTER TABLE base_personal_goals AUTO_INCREMENT = ${Math.max(Number(row.next), Number(own.next))}`);
};

exports.down = async () => {};
