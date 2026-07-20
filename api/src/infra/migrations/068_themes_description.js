/**
 * #121: Add description column to themes for rich list display.
 */

exports.up = async (knex) => {
  const has = await knex.schema.hasColumn('themes', 'description');
  if (!has) {
    await knex.raw('ALTER TABLE themes ADD COLUMN description TEXT NULL AFTER name');
  }
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE themes DROP COLUMN description').catch(() => {});
};
