/**
 * #97: Theme Management v2.
 *
 * Changes:
 * 1. Add `gym_id` to `themes` — NULL means platform/base theme; non-NULL means
 *    a customer theme owned by that gym.
 * 2. Add `theme_id` to `centers` — optional per-center theme override.
 * 3. Seed the "Black" base theme (gym_id = NULL).
 */

const BLACK_TOKENS = {
  v: 1,
  typography: {
    h1:    { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#FFFFFF' },
    h2:    { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#FFFFFF' },
    h3:    { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#CFCFCF' },
    body:  { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#CFCFCF' },
    small: { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#CFCFCF' },
  },
  colors: {
    appBackground:             '#000000',
    headerBackground:          '#121212',
    headerText:                '#FFFFFF',
    headerSeparatorColor:      '#2A2A2A',
    headerSeparatorHeight:     2,
    sidebarBackground:         '#121212',
    sidebarText:               '#CFCFCF',
    sidebarSelectedBackground: '#2A2A2A',
    sidebarSelectedText:       '#FFFFFF',
  },
};

exports.up = async (knex) => {
  const hasCols = await knex.schema.hasColumn('themes', 'gym_id');
  if (!hasCols) {
    // gyms.id uses the default table collation (utf8mb4_0900_ai_ci); match it
    // here so the FK constraint can be established without a collation mismatch.
    await knex.raw(`
      ALTER TABLE themes
        ADD COLUMN gym_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id,
        ADD CONSTRAINT fk_themes_gym FOREIGN KEY (gym_id) REFERENCES gyms (id)
    `);
  }

  const hasCenterTheme = await knex.schema.hasColumn('centers', 'theme_id');
  if (!hasCenterTheme) {
    // themes.id uses utf8mb4_unicode_ci; match it here to satisfy the FK constraint.
    await knex.raw(`
      ALTER TABLE centers
        ADD COLUMN theme_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
        ADD CONSTRAINT fk_centers_theme FOREIGN KEY (theme_id) REFERENCES themes (id)
    `);
  }

  // Seed Black base theme (gym_id = NULL → platform-owned).
  await knex.raw(
    `INSERT IGNORE INTO themes (id, gym_id, name, status, tokens, created_at)
     VALUES (UUID(), NULL, 'Black', 'active', ?, UTC_TIMESTAMP())`,
    [JSON.stringify(BLACK_TOKENS)],
  );
};

exports.down = async (knex) => {
  await knex.raw(`
    ALTER TABLE centers
      DROP FOREIGN KEY fk_centers_theme,
      DROP COLUMN theme_id
  `).catch(() => {});

  await knex.raw(`
    ALTER TABLE themes
      DROP FOREIGN KEY fk_themes_gym,
      DROP COLUMN gym_id
  `).catch(() => {});

  await knex.raw(`DELETE FROM themes WHERE name = 'Black' AND gym_id IS NULL`);
};
