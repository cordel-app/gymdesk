/**
 * #558: Add sectionHeadingTextColor to the Text section of the Theme token
 * model — makes the theme card's section headings (e.g. "APLICACIÓN")
 * configurable. Prior to this, the color was a hardcoded CSS fallback
 * (#888888, see apps/admin/.../themes/page.tsx and ThemeTokensEditor.tsx);
 * this migration promotes that same value into tokens so it stops being
 * a separate hardcoded literal in three places. Bumps token version 3 to 4.
 */

exports.up = async (knex) => {
  await knex.raw(`
    UPDATE themes
    SET tokens = JSON_SET(
      tokens,
      '$.v', 4,
      '$.colors.sectionHeadingTextColor', '#888888'
    )
    WHERE JSON_EXTRACT(tokens, '$.colors.sectionHeadingTextColor') IS NULL
  `);
};

exports.down = async (knex) => {
  await knex.raw(`
    UPDATE themes
    SET tokens = JSON_SET(
      JSON_REMOVE(tokens, '$.colors.sectionHeadingTextColor'),
      '$.v', 3
    )
    WHERE JSON_EXTRACT(tokens, '$.v') = 4
  `);
};
