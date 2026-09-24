/**
 * #635 stage 12: `billing.date_aware_membership_fee` — the switch for the
 * corrected Membership Fee pricing.
 *
 * Stage 12 makes one rule decide what the Membership Fee costs on a date: an
 * applied Promotion's Membership Fee Benefit lives inside the Promotion's own
 * Free/Paid/Bonus timeline and ends with it. `POST /billing/run` charged
 * `user_memberships.final_price` — a number with no date in it — so a Promotion
 * whose promotional months had elapsed kept discounting every later cycle.
 *
 * Correcting that raises what some members are charged (correctly, after their
 * agreed promotional months ran out), and the #635 thread asked for that impact
 * to be surfaced before it moves money. So unlike every other flag introduced so
 * far this one is seeded **disabled**: while it is off the run and
 * `computeFinalPrice` behave exactly as before, and the drift is reported by the
 * run's `drift` counter and
 * `GET /user-memberships/reports/membership-fee-drift`. Switch it on from
 * Cordel → Feature Flags once that report has been reviewed.
 *
 * A missing key counts as *enabled* (see `api/src/infra/featureFlags.ts`), so the
 * row must exist for the corrected behaviour to stay off at all. That also makes
 * the row, not its absence, the safe state — which is why this migration differs
 * from every other flag seed in two ways: the upsert asserts `enabled = 0` rather
 * than `INSERT IGNORE`-ing an existing row (a row left at 1 by a partial apply or
 * a hand-edit would keep the money-moving path switched on while the migration
 * reported success), and `down()` deliberately leaves the row in place.
 *
 * `billing` here is a behaviour namespace, not a navigation group:
 * `isFeatureEnabled()` walks every ancestor key, so a `billing` parent flag seeded
 * disabled would silently force this one off. Do not add one.
 */

exports.up = async (knex) => {
  await knex.raw(
    `INSERT INTO feature_flags (feature_key, enabled, updated_at)
     VALUES ('billing.date_aware_membership_fee', 0, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE enabled = 0, updated_at = UTC_TIMESTAMP()`,
  );
};

exports.down = async () => {
  // Deliberately NOT a DELETE. A missing key counts as enabled, so dropping the
  // row would switch the corrected Membership Fee pricing *on* during a rollback
  // and move real money on the next nightly run — the opposite of restoring the
  // pre-stage-12 state. The row at `enabled = 0` *is* that state, so a rollback
  // has nothing to undo. Remove the row only together with the stage-12 code.
};
