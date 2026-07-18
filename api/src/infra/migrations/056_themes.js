/**
 * #68: Introduce first-class Theme entity. Themes carry a JSON `tokens` blob
 * (CSS design tokens for header, sidebar, typography), an optional logo
 * (MEDIUMBLOB, max 512 KB enforced at the API layer), and a status lifecycle
 * (draft → active; soft-deleted via deleted_at). This migration creates the
 * table and seeds the four legacy preset colors as Active themes so migration
 * 057 can point existing gyms at them.
 *
 * We use raw CREATE TABLE rather than knex schema builder to control
 * `ON UPDATE CURRENT_TIMESTAMP` on the DATETIME modified_at column precisely —
 * knex's .timestamp() helper would emit TIMESTAMP (32-bit) rather than DATETIME.
 */

const DEFAULT_TOKENS = {
  v: 1,
  typography: {
    h1:    { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#111827' },
    h2:    { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#111827' },
    h3:    { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#374151' },
    body:  { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#374151' },
    small: { fontFamily: 'system-ui, -apple-system, sans-serif', color: '#6b7280' },
  },
  colors: {
    appBackground:            '#f5f5f5',
    headerBackground:         '#1a1a2e',
    headerText:               '#ffffff',
    headerSeparatorColor:     '#6c63ff',
    headerSeparatorHeight:    2,
    sidebarBackground:        '#1a1a2e',
    sidebarText:              '#e5e7eb',
    sidebarSelectedBackground:'#6c63ff',
    sidebarSelectedText:      '#ffffff',
  },
};

// Legacy preset colors — mirrors the THEMES map in apps/admin/src/lib/themes.ts.
// brand → sidebarSelectedBackground + headerSeparatorColor
// chrome → headerBackground + sidebarBackground
// accent is mapped to the separator to carry some of the original accent energy.
const PRESETS = {
  indigo: {
    name: 'Indigo',
    colors: {
      ...DEFAULT_TOKENS.colors,
      headerBackground:          '#1a1a2e',
      sidebarBackground:         '#1a1a2e',
      sidebarSelectedBackground: '#6c63ff',
      headerSeparatorColor:      '#6c63ff',
    },
  },
  emerald: {
    name: 'Emerald',
    colors: {
      ...DEFAULT_TOKENS.colors,
      headerBackground:          '#134e4a',
      sidebarBackground:         '#134e4a',
      sidebarSelectedBackground: '#10b981',
      headerSeparatorColor:      '#10b981',
    },
  },
  crimson: {
    name: 'Crimson',
    colors: {
      ...DEFAULT_TOKENS.colors,
      headerBackground:          '#3b0d0d',
      sidebarBackground:         '#3b0d0d',
      sidebarSelectedBackground: '#dc2626',
      headerSeparatorColor:      '#dc2626',
    },
  },
  amber: {
    name: 'Amber',
    colors: {
      ...DEFAULT_TOKENS.colors,
      headerBackground:          '#431407',
      sidebarBackground:         '#431407',
      sidebarSelectedBackground: '#f59e0b',
      headerSeparatorColor:      '#f59e0b',
    },
  },
};

exports.up = async (knex) => {
  const hasTable = await knex.schema.hasTable('themes');
  if (!hasTable) {
    await knex.raw(`
      CREATE TABLE themes (
        id            CHAR(36)     NOT NULL,
        name          VARCHAR(120) NOT NULL,
        status        VARCHAR(20)  NOT NULL DEFAULT 'draft',
        logo_mime     VARCHAR(64)  NULL,
        logo_bytes    MEDIUMBLOB   NULL,
        logo_updated_at DATETIME   NULL,
        tokens        JSON         NOT NULL,
        created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        modified_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at    DATETIME     NULL,
        PRIMARY KEY (id),
        CONSTRAINT themes_status_check CHECK (status IN ('draft','active','deleted'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  // Seed the four legacy preset themes as Active themes.
  // Use INSERT IGNORE so reruns (e.g. seeding a fresh dev DB after the table
  // was dropped and recreated) don't error on duplicate names.
  for (const [, preset] of Object.entries(PRESETS)) {
    const tokens = JSON.stringify({ ...DEFAULT_TOKENS, colors: preset.colors });
    await knex.raw(
      `INSERT IGNORE INTO themes (id, name, status, tokens, created_at)
       VALUES (UUID(), ?, 'active', ?, UTC_TIMESTAMP())`,
      [preset.name, tokens],
    );
  }
};

exports.down = async (knex) => {
  await knex.schema.dropTableIfExists('themes');
};
