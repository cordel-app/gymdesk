/**
 * #367: Member Web Feature Flags.
 *
 * Extends the existing feature_flags infrastructure (migration 110) with a
 * dedicated `member_web.*` namespace, kept deliberately separate from the
 * Admin App's navigation flags (`membership.*`, `calendar.*`, etc.) so toggling
 * one never affects the other. All five sections already exist and are live
 * today, so they are seeded enabled=1 (same convention as migration 110).
 */
exports.up = async (knex) => {
  const keys = [
    'member_web.my_training_plan',
    'member_web.my_nutrition',
    'member_web.my_bookings',
    'member_web.my_membership',
    'member_web.profile',
  ];

  for (const feature_key of keys) {
    await knex.raw(
      'INSERT IGNORE INTO feature_flags (feature_key, enabled, updated_at) VALUES (?, 1, UTC_TIMESTAMP())',
      [feature_key],
    );
  }
};

exports.down = async (knex) => {
  await knex.raw("DELETE FROM feature_flags WHERE feature_key LIKE 'member\\_web.%'");
};
