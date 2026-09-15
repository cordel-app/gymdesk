/**
 * #488: Add logo_contains_gym_name to themes.
 *
 * Single source of truth, shared by Base Themes and Custom Themes (both
 * live in the `themes` table), for whether the configured logo already
 * contains the gym name. Admin, Member Web, and the Payment app read this
 * flag to decide whether to render the gym name next to the logo.
 */

exports.up = async (knex) => {
  const hasCol = await knex.schema.hasColumn('themes', 'logo_contains_gym_name');
  if (!hasCol) {
    await knex.raw(`
      ALTER TABLE themes
        ADD COLUMN logo_contains_gym_name TINYINT(1) NOT NULL DEFAULT 0 AFTER logo_updated_at
    `);
  }
};

exports.down = async (knex) => {
  const hasCol = await knex.schema.hasColumn('themes', 'logo_contains_gym_name');
  if (hasCol) {
    await knex.raw(`ALTER TABLE themes DROP COLUMN logo_contains_gym_name`);
  }
};
