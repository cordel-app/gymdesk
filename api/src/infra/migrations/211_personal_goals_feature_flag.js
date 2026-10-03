/**
 * #948 §3/§8/§9: Personal Goals is its own admin section now, not a tab of the
 * Nutrition Library, so it needs its own feature flag — `/personal-goals` was
 * mounted behind `nutrition.nutrition_library` because the tab lived on that page,
 * and leaving it there would 403 a section the ticket is explicit is a separate
 * domain the moment a gym hid Foods.
 *
 * Seeded from the Nutrition Library's **current** value rather than a flat 1
 * (migration 160's `financials.taxes` device), so a platform that has the Library
 * switched off keeps Personal Goals off too and nothing changes on deploy. The
 * group flag `nutrition` still gates both, since `isFeatureEnabled()` checks every
 * ancestor key.
 *
 * `INSERT IGNORE` + the `COALESCE` default of 1 keeps this re-runnable: a missing
 * key already counts as enabled, so the row exists only to make the flag visible
 * and switchable on Cordel → Feature Flags.
 */

exports.up = async (knex) => {
  await knex.raw(
    `INSERT IGNORE INTO feature_flags (feature_key, enabled, updated_at)
     SELECT 'nutrition.personal_goals',
            COALESCE((SELECT enabled FROM feature_flags WHERE feature_key = 'nutrition.nutrition_library'), 1),
            UTC_TIMESTAMP()`,
  );
};

exports.down = async (knex) => {
  await knex.raw("DELETE FROM feature_flags WHERE feature_key = 'nutrition.personal_goals'");
};
