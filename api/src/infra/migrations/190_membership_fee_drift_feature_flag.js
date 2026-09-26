/**
 * #635 stage 14: Payments → Membership Fee Drift is gated by its own
 * `payments.membership_fee_drift` flag.
 *
 * Stage 12 shipped the impact report as an API endpoint gated by
 * `payments.transactions`, because it had no page of its own. It has one now,
 * and a page needs a key that can be switched independently: the report must
 * survive Transactions being switched off, and must be switchable off on its
 * own once `billing.date_aware_membership_fee` is on and the report is empty by
 * construction.
 *
 * A missing key counts as *enabled* (`api/src/infra/featureFlags.ts`), so the
 * row has to exist for the page to be switchable from Cordel → Feature Flags at
 * all. It is seeded from `payments.transactions`' current value rather than a
 * flat 1 — migration 160's rule for splitting a key out from under another, not
 * migration 171's for a brand-new page: this endpoint was already gated, so a
 * gym that had switched Transactions off must not find per-assignment pricing
 * deltas newly reachable on deploy. Where Transactions is on (and where the key
 * is absent, which reads as enabled) the page ships visible.
 */

exports.up = async (knex) => {
  await knex.raw(
    `INSERT IGNORE INTO feature_flags (feature_key, enabled, updated_at)
     SELECT 'payments.membership_fee_drift',
            COALESCE((SELECT enabled FROM feature_flags WHERE feature_key = 'payments.transactions'), 1),
            UTC_TIMESTAMP()`,
  );
};

exports.down = async (knex) => {
  await knex.raw("DELETE FROM feature_flags WHERE feature_key = 'payments.membership_fee_drift'");
};
