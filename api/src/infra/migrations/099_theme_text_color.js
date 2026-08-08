/**
 * #246: Add textColor to the Application section of the Theme token model.
 * Bumps token version from 2 to 3.
 */

exports.up = async (knex) => {
  await knex.raw(`
    UPDATE themes
    SET tokens = JSON_SET(
      tokens,
      '$.v', 3,
      '$.colors.textColor', '#111827'
    )
    WHERE JSON_EXTRACT(tokens, '$.colors.textColor') IS NULL
  `);
};

exports.down = async (knex) => {
  await knex.raw(`
    UPDATE themes
    SET tokens = JSON_SET(
      JSON_REMOVE(tokens, '$.colors.textColor'),
      '$.v', 2
    )
    WHERE JSON_EXTRACT(tokens, '$.v') = 3
  `);
};
