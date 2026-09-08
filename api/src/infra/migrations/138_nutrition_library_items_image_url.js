/**
 * #417 stage 3: nutrition meal images. Mirrors exercises.image_url — populated
 * via POST /storage/uploads/nutrition-image, gym-owned items only (system
 * items have no gym storage folder to upload into, so this stays null for them).
 */
exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('nutrition_library_items', 'image_url'))) {
    await knex.schema.alterTable('nutrition_library_items', (t) => {
      t.string('image_url', 500).nullable();
    });
  }
};

exports.down = async (knex) => {
  if (await knex.schema.hasColumn('nutrition_library_items', 'image_url')) {
    await knex.schema.alterTable('nutrition_library_items', (t) => t.dropColumn('image_url'));
  }
};
