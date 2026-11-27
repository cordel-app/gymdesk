/**
 * #3482 — Cancel discards a Nutrition Plan Template's edit session.
 *
 * The template's content (days → meals → meal items, restrictions, goals) is
 * written immediately by its own sub-routes, so Cancel cannot be a client-side
 * "forget the draft". Entering Edit mode stores the content as it stands in one
 * checkpoint row (written by the server from its own rows, never by the client);
 * Cancel rewrites the content from it and Save drops it. One row per template:
 * re-entering Edit mode replaces the checkpoint.
 *
 * A new table, so no rebuild of an existing one.
 */
exports.up = async (knex) => {
  if (await knex.schema.hasTable('nutrition_plan_template_edit_checkpoints')) return;
  await knex.raw(`
    CREATE TABLE nutrition_plan_template_edit_checkpoints (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      gym_id CHAR(36) NOT NULL,
      nutrition_plan_template_id INT UNSIGNED NOT NULL,
      content JSON NOT NULL,
      created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
      UNIQUE KEY nptec_template_unique (nutrition_plan_template_id),
      KEY nptec_gym_idx (gym_id),
      CONSTRAINT nptec_gym_fk FOREIGN KEY (gym_id) REFERENCES gyms(id) ON DELETE CASCADE,
      CONSTRAINT nptec_template_fk FOREIGN KEY (nutrition_plan_template_id)
        REFERENCES nutrition_plan_templates(id) ON DELETE CASCADE
    )
  `);
};

exports.down = async (knex) => {
  await knex.raw('DROP TABLE IF EXISTS nutrition_plan_template_edit_checkpoints');
};
