/**
 * #1390 — the feature flag that switches "Send Communication" on the Members
 * page on and off. Seeded enabled like every other flag (a missing row already
 * counts as enabled; the row makes it visible on Cordel → Feature Flags).
 * No schema change: `staff_message` is migration 270's.
 */
const FLAG_KEY = 'membership.staff_communications';

exports.up = async (knex) => {
  await knex.raw(
    `INSERT IGNORE INTO feature_flags (feature_key, enabled, modified_at)
     VALUES (?, 1, UTC_TIMESTAMP())`,
    [FLAG_KEY],
  );
};

exports.down = async (knex) => {
  await knex.raw('DELETE FROM feature_flags WHERE feature_key = ?', [FLAG_KEY]);
};
