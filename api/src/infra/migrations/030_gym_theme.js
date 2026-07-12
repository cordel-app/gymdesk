/**
 * #51: per-gym theme selection. Named CHECK so the preset set can evolve
 * without an ALTER TYPE dance. Default 'indigo' matches the pre-theming
 * chrome so existing gyms don't visually change until an admin edits them.
 */
const THEMES = ['indigo', 'emerald', 'crimson', 'amber'];

exports.up = async (knex) => {
  if (!(await knex.schema.hasColumn('gyms', 'theme_key'))) {
    await knex.schema.alterTable('gyms', (t) => {
      t.string('theme_key', 40).notNullable().defaultTo('indigo');
    });
  }
  const [checkRows] = await knex.raw(
    "SELECT 1 FROM information_schema.CHECK_CONSTRAINTS " +
    "WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'gyms_theme_check'",
  );
  if (checkRows.length === 0) {
    await knex.raw(
      `ALTER TABLE gyms ADD CONSTRAINT gyms_theme_check ` +
      `CHECK (theme_key IN (${THEMES.map((v) => `'${v}'`).join(',')}))`,
    );
  }
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE gyms DROP CHECK gyms_theme_check').catch(() => {});
  if (await knex.schema.hasColumn('gyms', 'theme_key')) {
    await knex.schema.alterTable('gyms', (t) => t.dropColumn('theme_key'));
  }
};
