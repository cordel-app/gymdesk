/**
 * #68: Wire gyms to themes. Adds theme_id FK on gyms, points each gym at its
 * existing preset's seeded theme row, then drops the old theme_key column and
 * its CHECK constraint so the codebase has a single source of truth.
 */

// Must match the name strings seeded in 056_themes.
const PRESET_NAMES = { indigo: 'Indigo', emerald: 'Emerald', crimson: 'Crimson', amber: 'Amber' };

exports.up = async (knex) => {
  // Add theme_id FK if not already present.
  if (!(await knex.schema.hasColumn('gyms', 'theme_id'))) {
    await knex.schema.alterTable('gyms', (t) => {
      t.specificType('theme_id', "char(36) collate utf8mb4_unicode_ci").nullable().references('id').inTable('themes').onDelete('SET NULL');
    });
  }

  // Point each gym at the theme that matches its old theme_key.
  for (const [key, name] of Object.entries(PRESET_NAMES)) {
    await knex.raw(
      `UPDATE gyms g
       JOIN themes t ON t.name = ? AND t.deleted_at IS NULL
       SET g.theme_id = t.id
       WHERE g.theme_key = ?`,
      [name, key],
    );
  }

  // Remove the old preset-key column and its CHECK constraint.
  const [checkRows] = await knex.raw(
    "SELECT 1 FROM information_schema.CHECK_CONSTRAINTS " +
    "WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'gyms_theme_check'",
  );
  if (checkRows.length > 0) {
    await knex.raw('ALTER TABLE gyms DROP CHECK gyms_theme_check').catch(() => {});
  }

  if (await knex.schema.hasColumn('gyms', 'theme_key')) {
    await knex.schema.alterTable('gyms', (t) => t.dropColumn('theme_key'));
  }
};

exports.down = async (knex) => {
  const THEMES = ['indigo', 'emerald', 'crimson', 'amber'];

  // Restore theme_key column with its CHECK constraint.
  if (!(await knex.schema.hasColumn('gyms', 'theme_key'))) {
    await knex.schema.alterTable('gyms', (t) => {
      t.string('theme_key', 40).notNullable().defaultTo('indigo');
    });
    await knex.raw(
      `ALTER TABLE gyms ADD CONSTRAINT gyms_theme_check ` +
      `CHECK (theme_key IN (${THEMES.map((v) => `'${v}'`).join(',')}))`,
    );
  }

  // Best-effort: map theme names back to theme_key values.
  for (const [key, name] of Object.entries(PRESET_NAMES)) {
    await knex.raw(
      `UPDATE gyms g
       JOIN themes t ON t.id = g.theme_id AND t.name = ?
       SET g.theme_key = ?`,
      [name, key],
    );
  }

  // Drop theme_id FK and column.
  if (await knex.schema.hasColumn('gyms', 'theme_id')) {
    await knex.schema.alterTable('gyms', (t) => t.dropColumn('theme_id'));
  }
};
