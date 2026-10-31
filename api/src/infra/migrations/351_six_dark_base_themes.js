/**
 * #2158 — six dark Base Themes: Midnight, Obsidian, Forest, Ember, Solaris and
 * Crimson.
 *
 * A Base Theme is a `themes` row with `gym_id IS NULL` (the same row
 * `POST /platform/themes` writes), so this is a data seed and changes no schema.
 * Each theme carries a complete, independent `colors` palette (every key
 * `defaultTokens()` declares, so none falls back to the light defaults) and its
 * own typography colours. `membersApp` is left absent on purpose: the Members
 * App settings inherit from these admin colours (#833), so the palette reaches
 * both apps with no override stored.
 *
 * Logos are deliberately not seeded (the issue's follow-up comment: the symbol
 * logo is #2157's and the assets are supplied later); a theme with no logo uses
 * the default favicon.
 *
 * Idempotent and non-destructive: a theme is inserted only while no non-deleted
 * Base Theme of that name exists, so an existing Base Theme is never modified
 * and a re-run adds nothing. `down` removes only the rows this migration
 * created (matched by name and `created_by = 'System'`, never a theme a
 * superadmin has since taken over).
 */
const { randomUUID } = require('crypto');

const FONT = 'system-ui, -apple-system, sans-serif';
const ACTOR = 'System';

// bg: page; panel: sidebar/header/dropdown; card: surfaces/inputs; line: borders;
// accent / accentHover / onAccent: primary action and its text; soft: secondary
// accent used for the calendar's selection and the info status.
const THEMES = [
  { name: 'Midnight', description: 'Dark navy with electric blue accents.',
    bg: '#070d1a', panel: '#0b1426', card: '#101c33', raised: '#16253f', line: '#25375a',
    accent: '#2563eb', accentHover: '#5a9bff', onAccent: '#ffffff', soft: '#7fb0ff',
    text: '#f1f5ff', text2: '#c3cde3', muted: '#8d9ab8' },
  { name: 'Obsidian', description: 'Charcoal black with rich violet accents.',
    bg: '#0b0a10', panel: '#121118', card: '#1a1922', raised: '#232231', line: '#33313f',
    accent: '#7c3aed', accentHover: '#a883f8', onAccent: '#ffffff', soft: '#b79df5',
    text: '#f5f4fa', text2: '#cbc9d6', muted: '#938fa3' },
  { name: 'Forest', description: 'Deep forest green with emerald accents.',
    bg: '#07110d', panel: '#0c1a14', card: '#12241c', raised: '#193027', line: '#274537',
    accent: '#10b981', accentHover: '#34d399', onAccent: '#04130d', soft: '#6ee7b7',
    text: '#f1f8f4', text2: '#c4d6cc', muted: '#8aa396' },
  { name: 'Ember', description: 'Charcoal with vibrant fiery orange accents.',
    bg: '#0e0b09', panel: '#16120f', card: '#1f1a16', raised: '#2a231d', line: '#3b322a',
    accent: '#f97316', accentHover: '#fb923c', onAccent: '#1a0a00', soft: '#fdba74',
    text: '#f8f4f0', text2: '#d3c9bf', muted: '#9c9087' },
  { name: 'Solaris', description: 'Charcoal with golden yellow accents.',
    bg: '#0d0c08', panel: '#15130d', card: '#1e1b13', raised: '#29251a', line: '#3a3524',
    accent: '#facc15', accentHover: '#fde047', onAccent: '#1a1400', soft: '#d9b84a',
    text: '#faf8ee', text2: '#d6d1bb', muted: '#9f9a82' },
  { name: 'Crimson', description: 'Charcoal with intense crimson red accents.',
    bg: '#0e090a', panel: '#171011', card: '#211718', raised: '#2d2021', line: '#40302f',
    accent: '#dc2626', accentHover: '#ef4444', onAccent: '#ffffff', soft: '#f87171',
    text: '#f9f3f3', text2: '#d6c9c9', muted: '#a09090' },
];

function tokensFor(t) {
  return {
    v: 2,
    typography: {
      h1: { fontFamily: FONT, color: t.text },
      h2: { fontFamily: FONT, color: t.text },
      h3: { fontFamily: FONT, color: t.text2 },
      body: { fontFamily: FONT, color: t.text2 },
      small: { fontFamily: FONT, color: t.muted },
    },
    colors: {
      pageBackground: t.bg,
      textColor: t.text,
      secondaryTextColor: t.text2,
      mutedTextColor: t.muted,
      sectionHeadingTextColor: t.muted,
      cardBackground: t.card,
      cardBorder: t.line,
      separatorColor: t.line,
      inputBorderColor: t.line,
      inputBackgroundColor: t.raised,
      headerBackground: t.panel,
      headerText: t.text,
      headerSeparatorColor: t.accent,
      headerSeparatorHeight: 2,
      sidebarBackground: t.panel,
      sidebarText: t.text2,
      sidebarSelectedItemBackground: t.accent,
      sidebarSelectedItemText: t.onAccent,
      sidebarHoverBackground: t.raised,
      dropdownBackground: t.card,
      dropdownText: t.text,
      dropdownHoverBackground: t.raised,
      primaryButton: t.accent,
      primaryButtonText: t.onAccent,
      secondaryButton: t.raised,
      secondaryButtonText: t.text,
      statusSuccess: '#34d399',
      statusWarning: '#fbbf24',
      statusError: '#f87171',
      statusInfo: t.soft,
      linkColor: t.accentHover,
      linkHoverColor: t.soft,
      calendarBackground: t.bg,
      calendarSurfaceBackground: t.card,
      calendarHeaderBackground: t.panel,
      calendarHeaderText: t.text,
      calendarDayText: t.text,
      calendarMutedDayText: t.muted,
      calendarTodayBackground: t.raised,
      calendarSelectionBackground: t.raised,
      calendarGridBorder: t.line,
      calendarTimeAxisBackground: t.panel,
      calendarTimeAxisText: t.muted,
      calendarWeekendBackground: t.card,
      calendarActiveAreaBackground: t.card,
      calendarDisabledSlotBackground: t.bg,
      calendarEventBackground: t.accent,
      calendarEventBorder: t.accent,
      calendarEventText: t.onAccent,
      calendarNavButtonBackground: t.raised,
      calendarNavButtonText: t.text,
    },
  };
}

exports.up = async (knex) => {
  for (const t of THEMES) {
    const existing = await knex.raw(
      'SELECT id FROM themes WHERE gym_id IS NULL AND name = ? AND deleted_at IS NULL',
      [t.name],
    );
    if (existing[0].length > 0) continue;
    await knex.raw(
      `INSERT INTO themes (id, gym_id, is_system_default, name, description, status,
         logo_contains_gym_name, tokens, created_at, created_by)
       VALUES (?, NULL, 0, ?, ?, 'active', 0, ?, UTC_TIMESTAMP(), ?)`,
      [randomUUID(), t.name, t.description, JSON.stringify(tokensFor(t)), ACTOR],
    );
  }
};

exports.down = async (knex) => {
  for (const t of THEMES) {
    // Only a theme still untouched since the seed and not assigned to a gym.
    await knex.raw(
      `DELETE FROM themes WHERE gym_id IS NULL AND name = ? AND created_by = ?
         AND modified_by IS NULL
         AND id NOT IN (SELECT theme_id FROM gyms WHERE theme_id IS NOT NULL)
         AND id NOT IN (SELECT theme_id FROM centers WHERE theme_id IS NOT NULL)`,
      [t.name, ACTOR],
    );
  }
};

exports.THEMES = THEMES;
exports.tokensFor = tokensFor;
