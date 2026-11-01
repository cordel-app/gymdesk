/**
 * #2240: the header asset is chosen explicitly ("Use this in header").
 *
 * `themes.logo_contains_gym_name` keeps its column but now means "the header
 * shows the full logo" (1) or "the header shows the logo symbol plus the gym
 * name as text" (0). No new column: the existing Theme setting is reused.
 * Default and backfill are 1, because the full logo is the default selection
 * when nothing was saved. Which asset is used when only one exists is decided
 * by the readers (headerLogoChoice), not stored.
 */
exports.up = async (knex) => {
  await knex.raw('ALTER TABLE themes MODIFY COLUMN logo_contains_gym_name TINYINT(1) NOT NULL DEFAULT 1');
  await knex.raw('UPDATE themes SET logo_contains_gym_name = 1 WHERE logo_contains_gym_name = 0');
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE themes MODIFY COLUMN logo_contains_gym_name TINYINT(1) NOT NULL DEFAULT 0');
};
