/**
 * #144: Add is_system_default to themes.
 *
 * Marks exactly one base theme (gym_id IS NULL) as the factory default
 * assigned to new organizations. Only meaningful on base themes.
 * Seeds Black as the initial system default per product decision.
 */

exports.up = async (knex) => {
  const hasCol = await knex.schema.hasColumn('themes', 'is_system_default');
  if (!hasCol) {
    await knex.raw(`
      ALTER TABLE themes
        ADD COLUMN is_system_default TINYINT(1) NOT NULL DEFAULT 0 AFTER gym_id
    `);
  }

  // Ensure exactly one base theme is the system default: Black.
  await knex.raw(`UPDATE themes SET is_system_default = 0 WHERE gym_id IS NULL`);
  await knex.raw(`UPDATE themes SET is_system_default = 1 WHERE gym_id IS NULL AND name = 'Black' AND deleted_at IS NULL LIMIT 1`);
};

exports.down = async (knex) => {
  const hasCol = await knex.schema.hasColumn('themes', 'is_system_default');
  if (hasCol) {
    await knex.raw(`ALTER TABLE themes DROP COLUMN is_system_default`);
  }
};
