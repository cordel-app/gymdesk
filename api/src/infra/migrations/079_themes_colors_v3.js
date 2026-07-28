/**
 * #188: Theme model v3.
 *
 * 1. Add `inactive` to the status CHECK constraint (draft | active | inactive | deleted).
 * 2. Rename three color token keys in every existing row:
 *      appBackground              → pageBackground
 *      sidebarSelectedBackground  → sidebarSelectedItemBackground
 *      sidebarSelectedText        → sidebarSelectedItemText
 * 3. Add 16 new color fields to every row with sensible defaults derived from
 *    the existing palette where possible.
 * 4. Bump token v to 2.
 */

exports.up = async (knex) => {
  // ── 1. Widen status CHECK constraint ────────────────────────────────────────
  const [rows] = await knex.raw(`
    SELECT CONSTRAINT_NAME
    FROM information_schema.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'themes'
      AND CONSTRAINT_TYPE = 'CHECK'
      AND CONSTRAINT_NAME = 'themes_status_check'
  `);
  if (rows.length > 0) {
    await knex.raw('ALTER TABLE themes DROP CHECK themes_status_check');
  }
  await knex.raw(`
    ALTER TABLE themes
      ADD CONSTRAINT themes_status_check
        CHECK (status IN ('draft','active','inactive','deleted'))
  `);

  // ── 2. Rename existing color keys ───────────────────────────────────────────
  await knex.raw(`
    UPDATE themes
    SET tokens = JSON_SET(
      JSON_REMOVE(tokens,
        '$.colors.appBackground',
        '$.colors.sidebarSelectedBackground',
        '$.colors.sidebarSelectedText'
      ),
      '$.colors.pageBackground',
        COALESCE(JSON_UNQUOTE(JSON_EXTRACT(tokens, '$.colors.appBackground')), '#f5f5f5'),
      '$.colors.sidebarSelectedItemBackground',
        COALESCE(JSON_UNQUOTE(JSON_EXTRACT(tokens, '$.colors.sidebarSelectedBackground')), '#6c63ff'),
      '$.colors.sidebarSelectedItemText',
        COALESCE(JSON_UNQUOTE(JSON_EXTRACT(tokens, '$.colors.sidebarSelectedText')), '#ffffff')
    )
    WHERE JSON_EXTRACT(tokens, '$.colors.appBackground') IS NOT NULL
       OR JSON_EXTRACT(tokens, '$.colors.sidebarSelectedBackground') IS NOT NULL
       OR JSON_EXTRACT(tokens, '$.colors.sidebarSelectedText') IS NOT NULL
  `);

  // ── 3. Add new color fields and bump v ──────────────────────────────────────
  // primaryButton and linkColor derive from the (already renamed) sidebarSelectedItemBackground.
  await knex.raw(`
    UPDATE themes
    SET tokens = JSON_SET(
      tokens,
      '$.v', 2,
      '$.colors.cardBackground',        '#ffffff',
      '$.colors.cardBorder',            '#e5e7eb',
      '$.colors.sidebarHoverBackground',
        COALESCE(JSON_UNQUOTE(JSON_EXTRACT(tokens, '$.colors.sidebarBackground')), '#1a1a2e'),
      '$.colors.dropdownBackground',    '#ffffff',
      '$.colors.dropdownText',          '#111827',
      '$.colors.dropdownHoverBackground', '#f5f5f5',
      '$.colors.primaryButton',
        COALESCE(JSON_UNQUOTE(JSON_EXTRACT(tokens, '$.colors.sidebarSelectedItemBackground')), '#6c63ff'),
      '$.colors.primaryButtonText',     '#ffffff',
      '$.colors.secondaryButton',       '#ffffff',
      '$.colors.secondaryButtonText',   '#374151',
      '$.colors.statusSuccess',         '#059669',
      '$.colors.statusWarning',         '#d97706',
      '$.colors.statusError',           '#dc2626',
      '$.colors.statusInfo',            '#2563eb',
      '$.colors.linkColor',
        COALESCE(JSON_UNQUOTE(JSON_EXTRACT(tokens, '$.colors.sidebarSelectedItemBackground')), '#6c63ff'),
      '$.colors.linkHoverColor',        '#5a52d5'
    )
  `);
};

exports.down = async (knex) => {
  // Demote any 'inactive' rows so the narrower constraint can be re-added without error
  await knex.raw(`UPDATE themes SET status = 'deleted' WHERE status = 'inactive'`);
  await knex.raw('ALTER TABLE themes DROP CHECK themes_status_check').catch(() => {});
  await knex.raw(`
    ALTER TABLE themes
      ADD CONSTRAINT themes_status_check
        CHECK (status IN ('draft','active','deleted'))
  `);

  // Reverse key renames and remove new fields
  await knex.raw(`
    UPDATE themes
    SET tokens = JSON_SET(
      JSON_REMOVE(tokens,
        '$.colors.pageBackground',
        '$.colors.sidebarSelectedItemBackground',
        '$.colors.sidebarSelectedItemText',
        '$.colors.cardBackground',
        '$.colors.cardBorder',
        '$.colors.sidebarHoverBackground',
        '$.colors.dropdownBackground',
        '$.colors.dropdownText',
        '$.colors.dropdownHoverBackground',
        '$.colors.primaryButton',
        '$.colors.primaryButtonText',
        '$.colors.secondaryButton',
        '$.colors.secondaryButtonText',
        '$.colors.statusSuccess',
        '$.colors.statusWarning',
        '$.colors.statusError',
        '$.colors.statusInfo',
        '$.colors.linkColor',
        '$.colors.linkHoverColor'
      ),
      '$.v', 1,
      '$.colors.appBackground',            '#f5f5f5',
      '$.colors.sidebarSelectedBackground', '#6c63ff',
      '$.colors.sidebarSelectedText',       '#ffffff'
    )
  `);
};
