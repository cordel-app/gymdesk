/**
 * #674: Payments → Dashboard is gated by its own `payments.dashboard` flag.
 *
 * A missing key counts as enabled (see `api/src/infra/featureFlags.ts`), so the
 * row has to exist for the Dashboard to be switchable from Cordel → Feature
 * Flags at all. Seeded enabled so the page is visible on deploy, matching how
 * every other page flag was introduced.
 *
 * It is deliberately its own key rather than a reuse of `payments.transactions`
 * or `payments.billing_events`: the Dashboard must survive either of those
 * pages being switched off, and must be switchable off on its own.
 */

exports.up = async (knex) => {
  await knex.raw(
    `INSERT IGNORE INTO feature_flags (feature_key, enabled, updated_at)
     VALUES ('payments.dashboard', 1, UTC_TIMESTAMP())`,
  );
};

exports.down = async (knex) => {
  await knex.raw("DELETE FROM feature_flags WHERE feature_key = 'payments.dashboard'");
};
