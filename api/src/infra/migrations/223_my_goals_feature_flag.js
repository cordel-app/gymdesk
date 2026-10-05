/**
 * #1036 §1 — **My Goals** is a Members App section, so it needs the
 * `member_web.*` flag every other one has (`member_web.my_training_plan`,
 * `…my_nutrition`, `…my_bookings`, `…my_membership`, `…profile`, migration 127).
 *
 * Seeded **enabled**, per the thread's `Q2` answer ("this is a global feature
 * flag (not gym based). By default is enabled") — which is also migration 127's
 * own convention for a section that ships live. There is no predecessor flag to
 * take a value from the way migration 211 does, because the section is new.
 *
 * A key with no row already counts as enabled, so the row exists to make the
 * flag **listable and switchable** on Cordel → Feature Flags, where it lands in
 * the Members App tab by itself: #1068 derives that split from the key, so no
 * list anywhere needs this name.
 *
 * It gates the section's *visibility and its own routes* only. The gym-side
 * `nutrition.personal_goals` flag still gates the catalogue the section reads
 * from, and `/me/personal-goals` requires **both**: a gym that hid Personal
 * Goals did not mean "and let members assign them anyway".
 */

exports.up = async (knex) => {
  await knex.raw(
    'INSERT IGNORE INTO feature_flags (feature_key, enabled, updated_at) VALUES (?, 1, UTC_TIMESTAMP())',
    ['member_web.my_goals'],
  );
};

exports.down = async (knex) => {
  await knex.raw("DELETE FROM feature_flags WHERE feature_key = 'member_web.my_goals'");
};
