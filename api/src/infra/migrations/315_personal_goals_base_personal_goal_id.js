/**
 * #1850 — Import System Personal Goals: the provenance of a gym's Personal Goal.
 *
 * `personal_goals.base_personal_goal_id` names the `base_personal_goals` template
 * a gym-owned goal was created from (gym creation or the Import System Personal
 * Goals action). It is the one record of "already imported", and
 * `UNIQUE (gym_id, base_personal_goal_id)` is what makes a repeated or concurrent
 * import a no-op at the database (NULLs — every goal the gym wrote itself, and
 * every legacy System row with `gym_id IS NULL` — never collide). Deleting a
 * template sets it to NULL: the goal is the gym's own and stays.
 *
 * No `is_system` column: `gym_id IS NULL` still marks the legacy System rows and
 * an imported copy is gym-owned, so the API derives `is_system` from this column.
 *
 * Nothing is backfilled and no row is created, changed or deleted: existing gyms
 * keep reading the System rows (`gym_id IS NULL`) and their member assignments
 * keep pointing at those ids.
 */

const TABLE = 'personal_goals';

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn(TABLE, 'base_personal_goal_id'))) {
    await knex.raw(`
      ALTER TABLE ${TABLE}
        ADD COLUMN base_personal_goal_id INT UNSIGNED NULL,
        ADD UNIQUE KEY personal_goals_gym_base_goal_unique (gym_id, base_personal_goal_id),
        ADD CONSTRAINT personal_goals_base_personal_goal_foreign
          FOREIGN KEY (base_personal_goal_id) REFERENCES base_personal_goals (id) ON DELETE SET NULL
    `);
  }
};

exports.down = async () => {};
