/**
 * #3485 — Cancel discards a Workout Template's edit session (gym and Base).
 *
 * #3482's device, one entity over: a template's blocks and their exercises are
 * written at once by their own sub-routes, so Cancel cannot be a client-side
 * "forget the draft". Entering Edit mode stores the template's block and
 * exercise rows as they stand (read by the server from its own rows, never sent
 * by the client); Cancel rewrites them from it and Save drops it. One row per
 * template: re-entering Edit mode replaces the checkpoint.
 *
 * `gym_id` is nullable because a Base Workout Template (`gym_id IS NULL`) has
 * an edit session too. A new table, so no rebuild of an existing one.
 */
exports.up = async (knex) => {
  if (await knex.schema.hasTable('workout_template_edit_checkpoints')) return;
  await knex.raw(`
    CREATE TABLE workout_template_edit_checkpoints (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      gym_id CHAR(36) NULL,
      workout_template_id INT UNSIGNED NOT NULL,
      content JSON NOT NULL,
      created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
      UNIQUE KEY wtec_template_unique (workout_template_id),
      KEY wtec_gym_idx (gym_id),
      CONSTRAINT wtec_gym_fk FOREIGN KEY (gym_id) REFERENCES gyms(id) ON DELETE CASCADE,
      CONSTRAINT wtec_template_fk FOREIGN KEY (workout_template_id)
        REFERENCES workout_templates(id) ON DELETE CASCADE
    )
  `);
};

exports.down = async (knex) => {
  await knex.raw('DROP TABLE IF EXISTS workout_template_edit_checkpoints');
};
